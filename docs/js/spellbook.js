/**
 * spellbook.js — Commander Spellbook API integration
 * Find combos present in the deck and "add 1 card" near-miss combos.
 * Bracket estimation.
 */

import { WORKER_URL } from './api.js';

const API_BASE = `${WORKER_URL}/spellbook`;

/**
 * Find combos in the given card list.
 * @param {Array<string>} cardNames — list of card names in the deck
 * @returns {Promise<{present: Array, nearMiss: Array}>}
 *   present: combos fully present in the deck
 *   nearMiss: combos that need 1 more card, with the missing card name(s)
 */
export async function findCombos(cardNames) {
  if (!cardNames || cardNames.length === 0) {
    return { present: [], nearMiss: [] };
  }

  try {
    const resp = await fetch(`${API_BASE}/find-my-combos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commanders: [], main: cardNames.map(n => ({ card: n })) }),
    });
    if (!resp.ok) return { present: [], nearMiss: [] };

    const data = await resp.json();
    const results = data.results || {};

    const present = [];
    const nearMiss = [];

    // Parse "included" combos (fully present in deck)
    for (const combo of results.included || []) {
      const cards = combo.uses?.map(u => u.card?.name).filter(Boolean) || [];
      present.push({
        id: combo.id,
        cards,
        description: combo.produces?.map(p => p.feature?.name).filter(Boolean).join(', ') || '',
      });
    }

    // Parse "almostIncluded" combos (1 card away)
    for (const combo of results.almostIncluded || []) {
      const cards = combo.uses?.map(u => u.card?.name).filter(Boolean) || [];
      const missing = cards.filter(c => !cardNames.includes(c));
      if (missing.length === 1) {
        nearMiss.push({
          id: combo.id,
          cards,
          description: combo.produces?.map(p => p.feature?.name).filter(Boolean).join(', ') || '',
          missingCard: missing[0],
        });
      }
    }

    return { present, nearMiss };
  } catch (e) {
    console.warn('Commander Spellbook failed:', e.message);
    return { present: [], nearMiss: [] };
  }
}

/**
 * Estimate the bracket for a set of cards.
 * @param {Array<string>} cardNames
 * @returns {Promise<number|null>} — bracket number or null on failure
 */
export async function estimateBracket(cardNames) {
  if (!cardNames || cardNames.length === 0) return null;

  try {
    const resp = await fetch(`${API_BASE}/estimate-bracket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commanders: [], main: cardNames.map(n => ({ card: n })) }),
    });
    if (!resp.ok) return null;

    const data = await resp.json();
    return data.bracketTag ?? null;
  } catch (e) {
    console.warn('Bracket estimation failed:', e.message);
    return null;
  }
}
