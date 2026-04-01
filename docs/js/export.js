/**
 * export.js — Deck export format utilities
 * Supports Plain, Moxfield (grouped by tag), and Arena formats.
 * Stub for Session 1 — implemented in Session 4.
 */

/**
 * Export deck in plain format: "1 Card Name" per line.
 * @param {object} deckState
 * @returns {string}
 */
export function exportPlain(deckState) {
  return deckState.cards.map(c => `1 ${c.name}`).join('\n');
}

/**
 * Export deck in Moxfield format: grouped by tag with // headers.
 * @param {object} deckState
 * @returns {string}
 */
export function exportMoxfield(deckState) {
  const grouped = {};
  for (const card of deckState.cards) {
    const tag = card.tag || 'Untagged';
    if (!grouped[tag]) grouped[tag] = [];
    grouped[tag].push(card);
  }
  return Object.entries(grouped)
    .map(([tag, cards]) => {
      const header = tag.charAt(0).toUpperCase() + tag.slice(1);
      return `// ${header}\n${cards.map(c => `1 ${c.name}`).join('\n')}`;
    })
    .join('\n\n');
}

/**
 * Export deck in Arena format: "1 Card Name (SET) NUM".
 * @param {object} deckState
 * @returns {string}
 */
export function exportArena(deckState) {
  return deckState.cards.map(c => {
    const set = c.scryfallData?.set?.toUpperCase() || '';
    const num = c.scryfallData?.collectorNumber || '';
    return `1 ${c.name}${set ? ` (${set}) ${num}` : ''}`;
  }).join('\n');
}
