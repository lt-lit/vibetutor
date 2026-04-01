/**
 * engine.js — Multi-source card pool injection engine
 * Orchestrates the AI recommendation and cuts logic.
 *
 * Two exported functions for recommendations (2 LLM calls) and cuts (1 LLM call).
 * Plus autoTag for bulk-tagging the deck.
 */

import { fetchLLM } from './api.js';
import { searchCards, lookupCard, bulkLookup } from './scryfall.js';
import { findCombos } from './spellbook.js';

// ============================================================
// SYSTEM PROMPT (shared across all calls)
// ============================================================

const SYSTEM_PROMPT = `You are VibeTutor, an expert MTG Commander/EDH deck building assistant.

RULES:
1. NEVER invent card names. ONLY pick from the candidate pool provided.
2. Account for deck state: cards present, skipped, kept.
3. Concise pitches: 1-2 sentences.
4. Reference EDHREC data when available.
5. Always mention combo completions from Spellbook data.
6. If a budget cap is set, avoid cards above that price.
7. When recommending cards, include a suggested tag. Reuse existing tags in the deck where appropriate. Tags should be contextual to the deck's strategy (e.g., "wheel", "gift", "defence" — not generic categories like "creature" or "instant").

Scryfall syntax (for query composition):
ci:wur | t:creature | o:"phrase" | cmc<=3 | f:commander
order:edhrec | order:random | OR, AND, -, ()
-t:creature (NOT) | r:rare | c:w (white cards)

IMPORTANT: Always respond with valid JSON only. No markdown, no code fences, no extra text.`;

// ============================================================
// RECOMMENDATIONS (Two-Call Pattern)
// ============================================================

/**
 * Suggest card recommendations.
 * Call 1: LLM composes Scryfall queries + EDHREC filter
 * Parallel: fetch from Scryfall, EDHREC, Spellbook
 * Call 2: LLM picks 3-5 cards from the merged pool
 *
 * @param {object} deckState — full deck state
 * @param {string} userPrompt — user's request (may be empty)
 * @returns {Promise<Array<{name, tag, pitch, sources, edhrecSynergy, combosUnlocked}>>}
 */
export async function suggestRecommendations(deckState, userPrompt) {
  const model = deckState.settings?.model || 'anthropic/claude-sonnet-4';

  // --- LLM Call #1: Query Composition ---
  const queryPrompt = buildQueryPrompt(deckState, userPrompt);
  const queryResponse = await callLLM(model, SYSTEM_PROMPT, queryPrompt);
  const queries = parseJSON(queryResponse);

  if (!queries || !queries.scryfallQueries) {
    throw new Error('AI failed to generate search queries. Try again.');
  }

  // --- Parallel Fetch ---
  const [scryfallResults, edhrecResults, spellbookResults] = await Promise.allSettled([
    fetchScryfallPool(queries.scryfallQueries),
    filterEdhrecPool(deckState.edhrecData, queries.edhrecFilter || ''),
    fetchSpellbookNearMiss(deckState),
  ]);

  const scryfallCards = scryfallResults.status === 'fulfilled' ? scryfallResults.value : [];
  const edhrecCards = edhrecResults.status === 'fulfilled' ? edhrecResults.value : [];
  const spellbookCards = spellbookResults.status === 'fulfilled' ? spellbookResults.value : [];

  // --- Merge + Deduplicate ---
  const pool = mergeCardPool(scryfallCards, edhrecCards, spellbookCards, deckState);

  if (pool.length === 0) {
    throw new Error('No cards found. Try a different prompt.');
  }

  // --- LLM Call #2: Selection ---
  const selectionPrompt = buildSelectionPrompt(deckState, userPrompt, pool);
  const selectionResponse = await callLLM(model, SYSTEM_PROMPT, selectionPrompt);
  const selection = parseJSON(selectionResponse);

  if (!selection || !selection.cards || !Array.isArray(selection.cards)) {
    throw new Error('AI failed to select cards. Try again.');
  }

  // Validate card names against pool
  const poolNames = new Set(pool.map(c => c.name));
  const validated = selection.cards
    .filter(c => poolNames.has(c.name))
    .map(c => {
      const poolCard = pool.find(p => p.name === c.name);
      return {
        name: c.name,
        tag: c.tag || null,
        pitch: c.pitch || '',
        sources: poolCard?.sources || [],
        edhrecSynergy: poolCard?.edhrecSynergy ?? null,
        edhrecInclusion: poolCard?.edhrecInclusion ?? null,
        combosUnlocked: poolCard?.combosUnlocked || [],
        scryfallData: poolCard?.scryfallData || null,
      };
    });

  if (validated.length === 0) {
    throw new Error('AI suggested cards not in the search pool. Try again.');
  }

  // Hydrate any cards missing Scryfall data (e.g. from EDHREC/Spellbook sources)
  const needsHydration = validated.filter(c => !c.scryfallData);
  if (needsHydration.length > 0) {
    const hydrated = await bulkLookup(needsHydration.map(c => c.name));
    const hydratedMap = new Map(hydrated.map(c => [c.name, c]));
    for (const card of needsHydration) {
      card.scryfallData = hydratedMap.get(card.name) || null;
    }
  }

  return validated;
}

// ============================================================
// CUTS (Single LLM Call)
// ============================================================

/**
 * Suggest cards to cut from the deck.
 * @param {object} deckState
 * @returns {Promise<Array<{name, reason, edhrecInclusion}>>}
 */
export async function suggestCuts(deckState) {
  const model = deckState.settings?.model || 'anthropic/claude-sonnet-4';

  const prompt = buildCutsPrompt(deckState);
  const response = await callLLM(model, SYSTEM_PROMPT, prompt);
  const result = parseJSON(response);

  if (!result || !result.cards || !Array.isArray(result.cards)) {
    throw new Error('AI failed to suggest cuts. Try again.');
  }

  // Validate card names against deck
  const deckNames = new Set(deckState.cards.map(c => c.name));
  const validated = result.cards
    .filter(c => deckNames.has(c.name))
    .map(c => {
      const deckCard = deckState.cards.find(d => d.name === c.name);
      const edhrecRec = deckState.edhrecData?.cardRecs?.find(r => r.name === c.name);
      return {
        name: c.name,
        reason: c.reason || '',
        edhrecInclusion: edhrecRec?.inclusion ?? null,
        scryfallData: deckCard?.scryfallData || null,
      };
    });

  return validated;
}

// ============================================================
// AUTO-TAG
// ============================================================

/**
 * Auto-tag all cards in the deck via a single LLM call.
 * @param {object} deckState
 * @returns {Promise<Array<{name: string, tag: string}>>}
 */
export async function autoTag(deckState) {
  const model = deckState.settings?.model || 'anthropic/claude-sonnet-4';

  const cardList = deckState.cards.map(c => c.name).join('\n');
  const commanderName = deckState.commander?.name || 'Unknown';
  const notes = deckState.strategy?.notes || '';

  const prompt = `Commander: ${commanderName}
Strategy notes: ${notes || 'None'}

Cards in deck:
${cardList}

Organize this deck into tags that reflect the deck's strategy. Tags should be short, descriptive, and specific to this deck — not generic card types. Examples: for a Zedruu deck you might use 'gift', 'defence', 'ramp', 'sharing', 'too good', 'wild'. For a Nekusar deck: 'wheel', 'draw punish', 'discard punish'. Assign exactly one tag to each card. Try to use 5-10 distinct tags.

Respond with JSON: {"type":"auto-tag","tags":[{"name":"Card Name","tag":"tagname"},...]}`;

  const response = await callLLM(model, SYSTEM_PROMPT, prompt);
  const result = parseJSON(response);

  if (!result || !result.tags || !Array.isArray(result.tags)) {
    throw new Error('Auto-tag failed — bad response from AI.');
  }

  return result.tags;
}

// ============================================================
// PROMPT BUILDERS
// ============================================================

function buildQueryPrompt(deckState, userPrompt) {
  const commander = deckState.commander;
  const ci = commander?.colorIdentity?.join('') || '';
  const cardSummary = deckState.cards
    .map(c => `${c.name} (${c.scryfallData?.typeLine || ''}, CMC ${c.scryfallData?.cmc ?? '?'})`)
    .join('\n');
  const existingTags = [...new Set(deckState.cards.map(c => c.tag).filter(Boolean))];
  const skipped = deckState.skippedRecommendations.join(', ') || 'None';

  let instruction;
  if (userPrompt) {
    instruction = `The user is looking for: "${userPrompt}"
Translate this into creative Scryfall queries. Approach the concept from multiple angles.`;
  } else {
    instruction = `The user left the prompt empty. Analyze the deck holistically and decide what it needs most. Consider mana curve gaps, card draw density, removal count, win conditions, and synergy gaps.`;
  }

  return `Commander: ${commander?.name || 'Unknown'} (color identity: ${ci})
Power level: ${deckState.strategy?.powerLevel || 'mid'}
Strategy notes: ${deckState.strategy?.notes || 'None'}
Budget cap: ${deckState.strategy?.budgetCap ? '$' + deckState.strategy.budgetCap + ' per card' : 'None'}
Existing tags: ${existingTags.join(', ') || 'None'}

Current deck (${deckState.cards.length}/99):
${cardSummary || 'Empty deck'}

Skipped cards (do NOT suggest these): ${skipped}

${instruction}

Respond with JSON:
{
  "type": "queries",
  "reasoning": "brief explanation of your search strategy",
  "scryfallQueries": ["query1 f:commander", "query2 f:commander"],
  "edhrecFilter": "conceptual description for filtering EDHREC data"
}

Generate 2-4 Scryfall queries. Always include f:commander and color identity (ci:${ci || 'c'}).`;
}

function buildSelectionPrompt(deckState, userPrompt, pool) {
  const commander = deckState.commander;
  const existingTags = [...new Set(deckState.cards.map(c => c.tag).filter(Boolean))];
  const deckNames = deckState.cards.map(c => c.name).join(', ');

  const poolSummary = pool.map(c => {
    let info = `${c.name} — ${c.scryfallData?.typeLine || ''}, CMC ${c.scryfallData?.cmc ?? '?'}`;
    if (c.edhrecSynergy != null) info += `, EDHREC synergy: ${(c.edhrecSynergy * 100).toFixed(0)}%`;
    if (c.edhrecInclusion != null) info += `, in ${(c.edhrecInclusion * 100).toFixed(0)}% of decks`;
    if (c.combosUnlocked.length > 0) info += `, COMPLETES COMBO with: ${c.combosUnlocked.join(', ')}`;
    const sources = c.sources.join(', ');
    info += ` [sources: ${sources}]`;
    return info;
  }).join('\n');

  return `Commander: ${commander?.name || 'Unknown'}
Strategy: ${deckState.strategy?.notes || 'None'}
Power level: ${deckState.strategy?.powerLevel || 'mid'}
Budget cap: ${deckState.strategy?.budgetCap ? '$' + deckState.strategy.budgetCap : 'None'}
Current deck: ${deckNames}
Existing tags in deck: ${existingTags.join(', ') || 'None'}
${userPrompt ? `User is looking for: "${userPrompt}"` : 'User wants general recommendations for what the deck needs most.'}

CANDIDATE POOL (pick ONLY from these cards):
${poolSummary}

Pick 3-5 cards from the pool above. For each, include a suggested tag (reuse existing tags where appropriate) and a 1-2 sentence pitch explaining why this card is good for this deck.

Respond with JSON:
{
  "type": "recommendations",
  "cards": [
    {"name": "Exact Card Name", "tag": "tagname", "pitch": "Why this card is great here."}
  ]
}`;
}

function buildCutsPrompt(deckState) {
  const commander = deckState.commander;
  const kept = deckState.keptCards.join(', ') || 'None';

  const cardSummary = deckState.cards.map(c => {
    let info = `${c.name} — ${c.scryfallData?.typeLine || ''}, CMC ${c.scryfallData?.cmc ?? '?'}`;
    const edhrecRec = deckState.edhrecData?.cardRecs?.find(r => r.name === c.name);
    if (edhrecRec?.inclusion != null) info += `, in ${(edhrecRec.inclusion * 100).toFixed(0)}% of ${commander?.name} decks`;
    if (edhrecRec?.synergy != null) info += `, synergy: ${(edhrecRec.synergy * 100).toFixed(0)}%`;
    if (c.tag) info += ` [tag: ${c.tag}]`;
    return info;
  }).join('\n');

  return `Commander: ${commander?.name || 'Unknown'}
Strategy: ${deckState.strategy?.notes || 'None'}
Power level: ${deckState.strategy?.powerLevel || 'mid'}

Cards user has chosen to KEEP (do NOT suggest cutting these): ${kept}

Current deck (${deckState.cards.length} cards):
${cardSummary}

Identify 3-5 cards that are the weakest performers in this deck. Consider: synergy with the commander/strategy, mana curve efficiency, EDHREC inclusion rates, and whether the card's role is redundant.

Respond with JSON:
{
  "type": "cuts",
  "cards": [
    {"name": "Exact Card Name", "reason": "1-2 sentence explanation of why to cut this card."}
  ]
}`;
}

// ============================================================
// DATA FETCHING HELPERS
// ============================================================

/**
 * Run multiple Scryfall queries and combine results.
 */
async function fetchScryfallPool(queries) {
  const results = await Promise.allSettled(
    queries.map(q => searchCards(q))
  );
  const cards = [];
  for (const r of results) {
    if (r.status === 'fulfilled') cards.push(...r.value);
  }
  return cards.map(c => ({
    name: c.name,
    scryfallData: c,
    sources: ['scryfall'],
    edhrecSynergy: null,
    edhrecInclusion: null,
    combosUnlocked: [],
  }));
}

/**
 * Filter EDHREC data by keyword matching against the AI's conceptual description.
 */
function filterEdhrecPool(edhrecData, filterDescription) {
  if (!edhrecData?.loaded || !edhrecData.cardRecs?.length) return [];
  if (!filterDescription) return [];

  const keywords = filterDescription.toLowerCase().split(/[\s,]+/).filter(k => k.length > 2);
  if (keywords.length === 0) return [];

  return edhrecData.cardRecs
    .filter(rec => {
      const text = `${rec.name} ${rec.label}`.toLowerCase();
      return keywords.some(kw => text.includes(kw));
    })
    .slice(0, 30)
    .map(rec => ({
      name: rec.name,
      scryfallData: null, // Will be hydrated if selected
      sources: ['edhrec'],
      edhrecSynergy: rec.synergy,
      edhrecInclusion: rec.inclusion,
      combosUnlocked: [],
    }));
}

/**
 * Get "add 1 card" near-miss combos from Spellbook and return as candidate cards.
 */
async function fetchSpellbookNearMiss(deckState) {
  const cardNames = deckState.cards.map(c => c.name);
  const { nearMiss } = await findCombos(cardNames);

  return nearMiss.map(combo => ({
    name: combo.missingCard,
    scryfallData: null,
    sources: ['spellbook'],
    edhrecSynergy: null,
    edhrecInclusion: null,
    combosUnlocked: combo.cards.filter(c => c !== combo.missingCard),
  }));
}

/**
 * Merge cards from all sources, deduplicate by name, and filter out deck/skipped cards.
 */
function mergeCardPool(scryfallCards, edhrecCards, spellbookCards, deckState) {
  const merged = new Map();
  const deckNames = new Set(deckState.cards.map(c => c.name));
  const skippedNames = new Set(deckState.skippedRecommendations || []);

  // Process in order: scryfall first (has full data), then enrich with edhrec/spellbook
  for (const card of [...scryfallCards, ...edhrecCards, ...spellbookCards]) {
    if (deckNames.has(card.name) || skippedNames.has(card.name)) continue;

    if (merged.has(card.name)) {
      const existing = merged.get(card.name);
      // Merge sources
      for (const s of card.sources) {
        if (!existing.sources.includes(s)) existing.sources.push(s);
      }
      // Merge metadata (prefer non-null values)
      if (card.edhrecSynergy != null) existing.edhrecSynergy = card.edhrecSynergy;
      if (card.edhrecInclusion != null) existing.edhrecInclusion = card.edhrecInclusion;
      if (card.combosUnlocked.length > 0) existing.combosUnlocked = card.combosUnlocked;
      if (card.scryfallData && !existing.scryfallData) existing.scryfallData = card.scryfallData;
    } else {
      merged.set(card.name, { ...card });
    }
  }

  return [...merged.values()];
}

// ============================================================
// LLM CALL HELPER
// ============================================================

/**
 * Call the LLM and extract the assistant's text content.
 * Retries once on bad JSON.
 */
async function callLLM(model, systemPrompt, userMessage) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const response = await fetchLLM(messages, model);
  const content = response?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from AI');
  return content;
}

/**
 * Parse JSON from LLM response, stripping markdown code fences if present.
 * Retries the parse after cleanup.
 */
function parseJSON(text) {
  // Strip markdown code fences
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract JSON from the response
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}
