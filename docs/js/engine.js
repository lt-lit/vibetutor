/**
 * engine.js — Multi-source card pool injection engine
 * Orchestrates the AI recommendation and cuts logic.
 *
 * Recommendations use a 3-layer pipeline (5 LLM calls):
 *   Layer A (parallel): A1 search-based + A2 knowledge-based discovery
 *   Layer B (parallel): B1 search iteration + B2 gap-fill & prune
 *   Layer C: Final selection — pick ~10 cards with elevator pitches
 *
 * Plus suggestCuts (1 LLM call) and autoTag (1 LLM call).
 */

import { fetchLLM } from './api.js';
import { searchCards, searchCardsWithStatus, lookupCard, bulkLookup, fuzzyLookup } from './scryfall.js';
import { findCombos } from './spellbook.js';

// ============================================================
// SYSTEM PROMPT (shared across all calls)
// ============================================================

const SYSTEM_PROMPT = `You are VibeTutor, an expert MTG Commander/EDH deck building assistant.

RULES:
1. NEVER invent card names. ONLY pick from the candidate pool provided.
2. Account for deck state: cards present, skipped, kept.
3. Pitches must be punchy, deck-specific elevator sells — explain what the card DOES for THIS deck's strategy. Never quote synergy percentages, inclusion rates, or other statistics in pitches — the UI already shows those. Focus on interactions, combos, and strategic fit.
4. Always mention combo completions from Spellbook data.
5. If a budget cap is set, avoid cards above that price.
6. When recommending cards, include a suggested tag. Reuse existing tags in the deck where appropriate. Tags should be contextual to the deck's strategy (e.g., "wheel", "gift", "defence" — not generic categories like "creature" or "instant").

Scryfall syntax (for query composition):
ci:wur | t:creature | o:"phrase" | cmc<=3 | f:commander
order:edhrec | order:random | OR, AND, -, ()
-t:creature (NOT) | r:rare | c:w (white cards)

IMPORTANT: Always respond with valid JSON only. No markdown, no code fences, no extra text.`;

const SYSTEM_PROMPT_A2 = `You are VibeTutor, an expert MTG Commander/EDH deck building assistant with encyclopedic knowledge of every Magic: The Gathering card ever printed.

Your job: brainstorm real Magic card names that match a user's query. Think laterally and creatively:
- Characters, flavor, and lore connections (e.g. "Texas themed" → Sandy Cheeks, Martial Astronaut because Sandy is from Texas)
- Universes Beyond and Secret Lair crossovers
- Art and visual themes
- Mechanical flavor (cards that FEEL like the theme even if not literally about it)
- Alternate printings and special editions
- Cultural references and real-world connections

RULES:
1. Only suggest card names you are confident actually exist. If unsure, include it anyway — validation will filter out mistakes.
2. Think broadly. Go beyond the obvious. The user wants deep, surprising finds.
3. Consider cards from ALL sets, including supplemental products, Secret Lair, Universes Beyond, Un-sets, etc.
4. Include a brief reasoning for each card so the refinement step can evaluate your logic.
5. If a budget cap is set, try to avoid suggesting cards you know to be very expensive.

IMPORTANT: Always respond with valid JSON only. No markdown, no code fences, no extra text.`;

const SYSTEM_PROMPT_B1 = `You are VibeTutor, an expert MTG search strategist reviewing and improving Scryfall search queries.

You are given:
- The user's original query
- The Scryfall queries that were attempted in the first search pass, with per-query results (card count and any errors)
- The current card pool assembled so far

Your job: critique the search strategy and produce improved or entirely new Scryfall queries to fill gaps.

Consider:
- Queries that returned errors — fix the syntax
- Queries that returned 0-2 results — probably too narrow, loosen or rethink
- Queries that returned 100+ generic results — probably too broad, add filters
- Angles not yet explored (flavor text search with ft:, different type combinations, specific set codes, etc.)
- Whether the pool already has good coverage for the user's query (if so, fewer new queries needed)

Scryfall syntax:
ci:wur | t:creature | o:"phrase" | ft:"flavor text" | cmc<=3 | f:commander
order:edhrec | order:random | OR, AND, -, ()
-t:creature (NOT) | r:rare | c:w (white cards) | s:setcode

RULES:
1. Always include f:commander and the color identity filter in every query.
2. Generate 0-4 new queries. If the pool already looks great, return 0.
3. Focus on angles the first pass missed entirely.

IMPORTANT: Always respond with valid JSON only. No markdown, no code fences, no extra text.`;

const SYSTEM_PROMPT_B2 = `You are VibeTutor, an expert MTG deck building assistant reviewing a card pool for quality and completeness.

You are given:
- The user's original query
- The current card pool (assembled from search results and knowledge-based brainstorming)
- The brainstormed card names from the first pass (which ones were found, which failed validation)

Your TWO jobs:

1. GAP-FILL: Brainstorm additional card names from your knowledge that the pool is missing. Consider what the failed brainstorm names were reaching for — maybe there are similar real cards. Think about angles not yet covered.

2. PRUNE: Identify cards in the pool that clearly do NOT match the user's query and should be removed. Be conservative — only prune cards you're confident are off-theme. When in doubt, keep the card (the final selection step will sort it out).

RULES:
1. For additions, include brief reasoning so validation failures can inform future iterations.
2. For removals, include a reason so the logic is transparent.
3. If the pool already looks great, return empty additions and removals.

IMPORTANT: Always respond with valid JSON only. No markdown, no code fences, no extra text.`;

// ============================================================
// RECOMMENDATIONS (Three-Layer Pipeline)
// ============================================================

/**
 * Suggest card recommendations using a 3-layer pipeline.
 *
 * Layer A (parallel): A1 search-based discovery + A2 knowledge-based brainstorm
 * Layer B (parallel): B1 search iteration + B2 knowledge gap-fill & prune
 * Layer C: Final selection — pick ~10 cards, write elevator pitches
 *
 * @param {object} deckState — full deck state
 * @param {string} userPrompt — user's request (may be empty)
 * @param {function} onStatus — optional callback for progress updates
 * @returns {Promise<Array<{name, tag, pitch, sources, edhrecSynergy, combosUnlocked}>>}
 */
export async function suggestRecommendations(deckState, userPrompt, onStatus = () => {}) {
  const model = deckState.settings?.model || 'anthropic/claude-sonnet-4';

  // ============================================================
  // LAYER A — Initial Discovery (parallel: A1 search + A2 brainstorm)
  // ============================================================
  onStatus('Searching for cards...');

  // A1: Search-based discovery
  async function runA1() {
    const queryPrompt = buildQueryPrompt(deckState, userPrompt);
    const queryResponse = await callLLM(model, SYSTEM_PROMPT, queryPrompt);
    const queries = parseJSON(queryResponse);

    if (!queries || !queries.scryfallQueries) {
      throw new Error('AI failed to generate search queries.');
    }

    const [scryfallResult, edhrecResult, spellbookResult] = await Promise.allSettled([
      fetchScryfallPoolWithDiagnostics(queries.scryfallQueries),
      filterEdhrecPool(deckState.edhrecData, queries.edhrecFilter || ''),
      fetchSpellbookNearMiss(deckState),
    ]);

    const { cards: scryfallCards, diagnostics } = scryfallResult.status === 'fulfilled'
      ? scryfallResult.value : { cards: [], diagnostics: [] };
    const edhrecCards = edhrecResult.status === 'fulfilled' ? edhrecResult.value : [];
    const spellbookCards = spellbookResult.status === 'fulfilled' ? spellbookResult.value : [];

    return { scryfallCards, edhrecCards, spellbookCards, diagnostics };
  }

  // A2: Knowledge-based brainstorm
  async function runA2() {
    const brainstormPrompt = buildBrainstormPrompt(deckState, userPrompt);
    const brainstormResponse = await callLLM(model, SYSTEM_PROMPT_A2, brainstormPrompt);
    const brainstorm = parseJSON(brainstormResponse);

    if (!brainstorm?.cards?.length) {
      return { found: [], failures: [], originalBrainstorm: [] };
    }

    const names = brainstorm.cards.map(c => c.name);
    const { found, failures } = await fuzzyLookup(names);

    // Convert found cards to pool card format
    const poolCards = found.map(c => ({
      name: c.name,
      scryfallData: c,
      sources: ['brainstorm'],
      edhrecSynergy: null,
      edhrecInclusion: null,
      salt: null,
      combosUnlocked: [],
      comboDescription: '',
    }));

    return { found: poolCards, failures, originalBrainstorm: brainstorm.cards };
  }

  const [a1Result, a2Result] = await Promise.allSettled([runA1(), runA2()]);

  // A1 is required; A2 is optional
  if (a1Result.status === 'rejected') {
    throw new Error(a1Result.reason?.message || 'Search failed. Try again.');
  }

  const a1 = a1Result.value;
  const a2 = a2Result.status === 'fulfilled'
    ? a2Result.value
    : { found: [], failures: [], originalBrainstorm: [] };

  // Merge Layer A results into pool
  const poolMap = new Map();
  const initialPool = mergeCardPool(a1.scryfallCards, a1.edhrecCards, a1.spellbookCards, deckState);
  for (const card of initialPool) {
    poolMap.set(card.name, card);
  }
  mergeIntoPool(poolMap, a2.found, deckState);

  if (poolMap.size === 0) {
    throw new Error('No cards found. Try a different prompt.');
  }

  // ============================================================
  // LAYER B — Pool Refinement (parallel: B1 search iteration + B2 gap-fill & prune)
  // ============================================================
  onStatus('Refining search results...');

  const poolArray = () => [...poolMap.values()];

  // B1: Search iteration — critique and improve A1's queries
  async function runB1() {
    const pool = poolArray();
    const prompt = buildSearchIterationPrompt(userPrompt, pool, a1.diagnostics, deckState);
    const response = await callLLM(model, SYSTEM_PROMPT_B1, prompt);
    const result = parseJSON(response);

    if (!result?.scryfallQueries?.length) return { newCards: [] };

    // Cap at 4 queries to bound latency
    const queries = result.scryfallQueries.slice(0, 4);
    const { cards } = await fetchScryfallPoolWithDiagnostics(queries);
    return { newCards: cards };
  }

  // B2: Knowledge gap-fill + prune
  async function runB2() {
    const pool = poolArray();
    const prompt = buildGapFillPrompt(userPrompt, pool, a2, deckState);
    const response = await callLLM(model, SYSTEM_PROMPT_B2, prompt);
    const result = parseJSON(response);

    let newCards = [];
    if (result?.additions?.length) {
      const names = result.additions.map(a => a.name).slice(0, 15);
      const { found } = await fuzzyLookup(names);
      newCards = found.map(c => ({
        name: c.name,
        scryfallData: c,
        sources: ['brainstorm'],
        edhrecSynergy: null,
        edhrecInclusion: null,
        salt: null,
        combosUnlocked: [],
        comboDescription: '',
      }));
    }

    const removals = (result?.removals || []).map(r => r.name);
    return { newCards, removals };
  }

  const [b1Result, b2Result] = await Promise.allSettled([runB1(), runB2()]);

  // Both B1 and B2 are optional — proceed with existing pool if either fails
  if (b1Result.status === 'fulfilled' && b1Result.value.newCards.length > 0) {
    mergeIntoPool(poolMap, b1Result.value.newCards, deckState);
  }
  if (b2Result.status === 'fulfilled') {
    if (b2Result.value.newCards.length > 0) {
      mergeIntoPool(poolMap, b2Result.value.newCards, deckState);
    }
    // Apply prune list
    for (const name of b2Result.value.removals) {
      poolMap.delete(name);
    }
  }

  const finalPool = poolArray();
  if (finalPool.length === 0) {
    throw new Error('No cards remained after refinement. Try a different prompt.');
  }

  // ============================================================
  // LAYER C — Final Selection
  // ============================================================
  onStatus('AI is selecting the best cards...');

  const selectionPrompt = buildSelectionPrompt(deckState, userPrompt, finalPool);
  const selectionResponse = await callLLM(model, SYSTEM_PROMPT, selectionPrompt);
  const selection = parseJSON(selectionResponse);

  if (!selection?.cards?.length) {
    throw new Error('AI failed to select cards. Try again.');
  }

  // Validate card names against pool
  const poolNames = new Set(finalPool.map(c => c.name));
  const validated = selection.cards
    .filter(c => poolNames.has(c.name))
    .map(c => {
      const poolCard = finalPool.find(p => p.name === c.name);
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

function buildDeckContext(deckState) {
  const cardSummary = deckState.cards
    .map(c => `${c.name} (${c.scryfallData?.typeLine || ''}, CMC ${c.scryfallData?.cmc ?? '?'}) [${c.tag || 'untagged'}]`)
    .join('\n');

  // Tag distribution
  const tagCounts = {};
  for (const c of deckState.cards) {
    const t = c.tag || 'untagged';
    tagCounts[t] = (tagCounts[t] || 0) + 1;
  }
  const tagSummary = Object.entries(tagCounts).map(([t, n]) => `${t}: ${n}`).join(', ');

  // Mana curve
  const nonLands = deckState.cards.filter(c => !c.scryfallData?.typeLine?.toLowerCase().includes('land'));
  const cmcBuckets = [0, 0, 0, 0, 0, 0, 0, 0]; // 0-7+
  for (const c of nonLands) {
    cmcBuckets[Math.min(7, Math.floor(c.scryfallData?.cmc ?? 0))]++;
  }
  const avgCmc = nonLands.length > 0
    ? (nonLands.reduce((sum, c) => sum + (c.scryfallData?.cmc ?? 0), 0) / nonLands.length).toFixed(2)
    : '0.00';

  const existingTags = [...new Set(deckState.cards.map(c => c.tag).filter(Boolean))];
  const skipped = deckState.skippedRecommendations.map(c => c.name || c).join(', ') || 'None';
  const considering = (deckState.considering || []).map(c => c.name || c).join(', ') || 'None';

  return { cardSummary, tagSummary, cmcBuckets, avgCmc, existingTags, skipped, considering };
}

function buildQueryPrompt(deckState, userPrompt) {
  const commander = deckState.commander;
  const ci = commander?.colorIdentity?.join('') || '';
  const ctx = buildDeckContext(deckState);

  let instruction;
  if (userPrompt) {
    instruction = `The user's query is the PRIMARY DIRECTIVE: "${userPrompt}"
If the query specifies a hard constraint (set, rarity, price, card type, etc.), ALL generated Scryfall queries MUST include the corresponding filter. Do not generate queries that ignore the user's constraint.
Translate this into creative Scryfall queries. Approach the concept from multiple angles while always respecting the constraint.`;
  } else {
    instruction = `The user left the prompt empty. Analyze the deck holistically and decide what it needs most. Consider mana curve gaps, card draw density, removal count, win conditions, and synergy gaps.`;
  }

  return `Commander: ${commander?.name || 'Unknown'} (color identity: ${ci})
Strategy notes: ${deckState.strategy?.notes || 'None'}
Budget cap: ${deckState.strategy?.budgetCap ? '$' + deckState.strategy.budgetCap + ' per card' : 'None'}
Existing tags: ${ctx.existingTags.join(', ') || 'None'}
Tag distribution: ${ctx.tagSummary || 'None'}
Mana curve (0/1/2/3/4/5/6/7+): ${ctx.cmcBuckets.join('/')} — avg CMC: ${ctx.avgCmc}

Current deck (${deckState.cards.length}/99):
${ctx.cardSummary || 'Empty deck'}

Cards under review (not yet added — these may hint at directions the user is exploring, but the committed deck list above is the primary signal for the deck's identity): ${ctx.considering}

Cards previously suggested and passed on (do NOT re-suggest these, but don't assume the user rejects the entire category — they may have passed for budget, preference, or redundancy reasons): ${ctx.skipped}

${instruction}

Respond with JSON:
{
  "type": "queries",
  "reasoning": "brief explanation of your search strategy",
  "scryfallQueries": ["query1 f:commander", "query2 f:commander"],
  "edhrecFilter": "conceptual description for filtering EDHREC data"
}

Generate 2-4 Scryfall queries. Always include f:commander and color identity (ci:${ci || 'c'}).
If the user specifies a set name, determine the correct Scryfall set code and include it (e.g., s:dsk) in EVERY query.`;
}

function buildSelectionPrompt(deckState, userPrompt, pool) {
  const commander = deckState.commander;
  const ctx = buildDeckContext(deckState);

  const poolSummary = pool.map(c => {
    let info = `${c.name} — ${c.scryfallData?.typeLine || ''}, CMC ${c.scryfallData?.cmc ?? '?'}`;
    if (c.scryfallData?.prices?.usd) info += `, $${c.scryfallData.prices.usd}`;
    if (c.edhrecSynergy != null) info += `, EDHREC synergy: ${(c.edhrecSynergy * 100).toFixed(0)}%`;
    if (c.edhrecInclusion != null) info += `, in ${(c.edhrecInclusion * 100).toFixed(0)}% of decks`;
    if (c.salt != null) info += `, salt: ${c.salt.toFixed(1)}`;
    if (c.combosUnlocked.length > 0) {
      info += `, COMPLETES COMBO with: ${c.combosUnlocked.join(', ')}`;
      if (c.comboDescription) info += ` (produces: ${c.comboDescription})`;
    }
    if (c.scryfallData?.setName) info += `, set: ${c.scryfallData.setName}`;
    if (c.scryfallData?.rarity) info += `, rarity: ${c.scryfallData.rarity}`;
    if (c.scryfallData?.artist) info += `, artist: ${c.scryfallData.artist}`;
    const sources = c.sources.join(', ');
    info += ` [sources: ${sources}]`;
    return info;
  }).join('\n');

  return `Commander: ${commander?.name || 'Unknown'}
Strategy: ${deckState.strategy?.notes || 'None'}
Budget cap: ${deckState.strategy?.budgetCap ? '$' + deckState.strategy.budgetCap + ' per card' : 'None'}
Existing tags: ${ctx.existingTags.join(', ') || 'None'}
Tag distribution: ${ctx.tagSummary || 'None'}
Mana curve (0/1/2/3/4/5/6/7+): ${ctx.cmcBuckets.join('/')} — avg CMC: ${ctx.avgCmc}

Current deck (${deckState.cards.length}/99):
${ctx.cardSummary || 'Empty deck'}

Cards under review (not yet added — these may hint at directions the user is exploring, but the committed deck list above is the primary signal for the deck's identity): ${ctx.considering}
Cards previously suggested and passed on (don't assume the user rejects the entire category — they may have passed for budget, preference, or redundancy reasons): ${ctx.skipped}
${userPrompt ? `PRIMARY DIRECTIVE — the user is looking for: "${userPrompt}"
This query takes top priority. If it specifies a hard constraint (set, rarity, price, card type, theme, etc.), EXCLUDE any card from the pool that does not satisfy it, even if the card would otherwise be excellent for the deck. Strategy notes and deck composition are secondary context for evaluating cards that already meet the query.` : 'User wants general recommendations for what the deck needs most.'}

CANDIDATE POOL (pick ONLY from these cards):
${poolSummary}

Pick up to 10 cards from the pool above. For each, include a suggested tag (reuse existing tags where appropriate) and a 1-2 sentence pitch that sells the card for THIS deck. Focus on specific interactions with cards already in the deck, how it advances the strategy, or what gap it fills. Do NOT quote synergy percentages, inclusion rates, or other statistics — the UI already shows those.

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

Cards user has chosen to KEEP (do NOT suggest cutting these): ${kept}

Current deck (${deckState.cards.length} cards):
${cardSummary}

Identify up to 10 cards that are the weakest performers in this deck. Consider: synergy with the commander/strategy, mana curve efficiency, EDHREC inclusion rates, and whether the card's role is redundant.

Respond with JSON:
{
  "type": "cuts",
  "cards": [
    {"name": "Exact Card Name", "reason": "1-2 sentence explanation of why to cut this card."}
  ]
}`;
}

function buildBrainstormPrompt(deckState, userPrompt) {
  const commander = deckState.commander;
  const ci = commander?.colorIdentity?.join('') || '';
  const skipped = (deckState.skippedRecommendations || []).map(c => c.name || c).join(', ') || 'None';
  const considering = (deckState.considering || []).map(c => c.name || c).join(', ') || 'None';

  return `Commander: ${commander?.name || 'Unknown'} (color identity: ${ci})
Strategy notes: ${deckState.strategy?.notes || 'None'}
Budget cap: ${deckState.strategy?.budgetCap ? '$' + deckState.strategy.budgetCap + ' per card' : 'None'}

Cards previously suggested and passed on (do NOT suggest these): ${skipped}
Cards under consideration (already being evaluated): ${considering}

USER QUERY: "${userPrompt || 'general recommendations for this commander'}"

Brainstorm 15-30 real Magic: The Gathering card names that match this query and are legal in Commander with color identity ${ci || 'colorless'}. Think laterally — flavor, characters, cultural references, Universes Beyond, Secret Lair, art themes, mechanical flavor. Go beyond the obvious.

Respond with JSON:
{
  "type": "brainstorm",
  "cards": [
    {"name": "Exact Card Name", "reasoning": "brief reason this matches the query"}
  ]
}`;
}

function buildSearchIterationPrompt(userPrompt, pool, a1Diagnostics, deckState) {
  const commander = deckState.commander;
  const ci = commander?.colorIdentity?.join('') || '';

  const diagnosticsSummary = a1Diagnostics.map(d =>
    `  Query: ${d.query} → ${d.error ? `ERROR: ${d.error}` : `${d.cardCount} cards found`}`
  ).join('\n');

  const poolSummary = pool.map(c =>
    `${c.name} — ${c.scryfallData?.typeLine || '?'} [${c.sources.join(', ')}]`
  ).join('\n');

  return `USER QUERY: "${userPrompt || 'general recommendations'}"
Commander: ${commander?.name || 'Unknown'} (color identity: ${ci})

FIRST-PASS SEARCH DIAGNOSTICS:
${diagnosticsSummary}

CURRENT POOL (${pool.length} cards):
${poolSummary}

Review the search strategy above. Are there errors to fix? Queries that were too narrow or too broad? Angles not yet explored (flavor text, specific sets, different card types)?

Generate 0-4 improved or new Scryfall queries. Always include f:commander and ci:${ci || 'c'}.
If the pool already has strong coverage for the user's query, return an empty array.

Respond with JSON:
{
  "type": "search-iteration",
  "reasoning": "what you're fixing or exploring",
  "scryfallQueries": ["query1 f:commander ci:${ci || 'c'}", ...]
}`;
}

function buildGapFillPrompt(userPrompt, pool, a2Results, deckState) {
  const commander = deckState.commander;
  const ci = commander?.colorIdentity?.join('') || '';

  const poolSummary = pool.map(c =>
    `${c.name} — ${c.scryfallData?.typeLine || '?'} [${c.sources.join(', ')}]`
  ).join('\n');

  const brainstormSummary = a2Results.originalBrainstorm.map(b => {
    const found = !a2Results.failures.includes(b.name);
    return `  ${b.name} — ${found ? 'FOUND' : 'NOT FOUND'} (reasoning: ${b.reasoning})`;
  }).join('\n');

  return `USER QUERY: "${userPrompt || 'general recommendations'}"
Commander: ${commander?.name || 'Unknown'} (color identity: ${ci})

CURRENT POOL (${pool.length} cards):
${poolSummary}

FIRST-PASS BRAINSTORM RESULTS:
${brainstormSummary}

TWO TASKS:

1. GAP-FILL: Brainstorm up to 15 additional card names from your knowledge that the pool is missing. Look at what the failed brainstorm names were reaching for — maybe similar real cards exist. Consider angles not yet covered.

2. PRUNE: List any cards currently in the pool that clearly do NOT match the user's query "${userPrompt || 'general recommendations'}". Be conservative — only prune cards you're confident are off-theme.

Respond with JSON:
{
  "type": "gap-fill",
  "additions": [
    {"name": "Exact Card Name", "reasoning": "why this matches the query"}
  ],
  "removals": [
    {"name": "Exact Card Name", "reason": "why this doesn't match the query"}
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
    salt: null,
    combosUnlocked: [],
    comboDescription: '',
  }));
}

/**
 * Run multiple Scryfall queries with per-query diagnostics.
 * Returns both the card pool and diagnostics for B1 to review.
 */
async function fetchScryfallPoolWithDiagnostics(queries) {
  const diagnostics = [];
  const cards = [];

  for (const q of queries) {
    const { cards: found, error } = await searchCardsWithStatus(q);
    diagnostics.push({ query: q, cardCount: found.length, error });
    for (const c of found) {
      cards.push({
        name: c.name,
        scryfallData: c,
        sources: ['scryfall'],
        edhrecSynergy: null,
        edhrecInclusion: null,
        salt: null,
        combosUnlocked: [],
        comboDescription: '',
      });
    }
  }

  return { cards, diagnostics };
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
      salt: rec.salt,
      combosUnlocked: [],
      comboDescription: '',
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
    salt: null,
    combosUnlocked: combo.cards.filter(c => c !== combo.missingCard),
    comboDescription: combo.description || '',
  }));
}

/**
 * Merge cards from all sources, deduplicate by name, and filter out deck/skipped cards.
 */
function mergeCardPool(scryfallCards, edhrecCards, spellbookCards, deckState) {
  const merged = new Map();
  const deckNames = new Set(deckState.cards.map(c => c.name));
  const skippedNames = new Set((deckState.skippedRecommendations || []).map(c => c.name || c));
  const consideringNames = new Set((deckState.considering || []).map(c => c.name || c));

  // Process in order: scryfall first (has full data), then enrich with edhrec/spellbook
  for (const card of [...scryfallCards, ...edhrecCards, ...spellbookCards]) {
    if (deckNames.has(card.name) || skippedNames.has(card.name) || consideringNames.has(card.name)) continue;

    if (merged.has(card.name)) {
      const existing = merged.get(card.name);
      // Merge sources
      for (const s of card.sources) {
        if (!existing.sources.includes(s)) existing.sources.push(s);
      }
      // Merge metadata (prefer non-null values)
      if (card.edhrecSynergy != null) existing.edhrecSynergy = card.edhrecSynergy;
      if (card.edhrecInclusion != null) existing.edhrecInclusion = card.edhrecInclusion;
      if (card.salt != null) existing.salt = card.salt;
      if (card.combosUnlocked.length > 0) existing.combosUnlocked = card.combosUnlocked;
      if (card.comboDescription) existing.comboDescription = card.comboDescription;
      if (card.scryfallData && !existing.scryfallData) existing.scryfallData = card.scryfallData;
    } else {
      merged.set(card.name, { ...card });
    }
  }

  return [...merged.values()];
}

/**
 * Merge new cards into an existing pool Map. Applies dedup and deck/skipped/considering exclusion.
 * Mutates the pool Map in place.
 * @param {Map<string, object>} pool — existing pool keyed by card name
 * @param {Array<object>} newCards — new pool cards to merge in
 * @param {object} deckState — for exclusion lists
 */
function mergeIntoPool(pool, newCards, deckState) {
  const deckNames = new Set(deckState.cards.map(c => c.name));
  const skippedNames = new Set((deckState.skippedRecommendations || []).map(c => c.name || c));
  const consideringNames = new Set((deckState.considering || []).map(c => c.name || c));

  for (const card of newCards) {
    if (deckNames.has(card.name) || skippedNames.has(card.name) || consideringNames.has(card.name)) continue;

    if (pool.has(card.name)) {
      const existing = pool.get(card.name);
      for (const s of card.sources) {
        if (!existing.sources.includes(s)) existing.sources.push(s);
      }
      if (card.edhrecSynergy != null) existing.edhrecSynergy = card.edhrecSynergy;
      if (card.edhrecInclusion != null) existing.edhrecInclusion = card.edhrecInclusion;
      if (card.salt != null) existing.salt = card.salt;
      if (card.combosUnlocked.length > 0) existing.combosUnlocked = card.combosUnlocked;
      if (card.comboDescription) existing.comboDescription = card.comboDescription;
      if (card.scryfallData && !existing.scryfallData) existing.scryfallData = card.scryfallData;
    } else {
      pool.set(card.name, { ...card });
    }
  }
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
