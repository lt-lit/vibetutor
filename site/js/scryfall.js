/**
 * scryfall.js — Scryfall API integration
 * Card search, autocomplete, bulk lookup, and decklist parsing.
 * Includes rate limiting (100ms between requests) and in-session cache.
 */

const API_BASE = 'https://api.scryfall.com';

/** In-session cache: Map<string, any> */
const cache = new Map();

/** Rate limit queue */
let lastRequestTime = 0;
const MIN_INTERVAL = 100; // ms

/**
 * Rate-limited fetch wrapper.
 */
async function rateLimitedFetch(url, options) {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL - (now - lastRequestTime));
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
  }
  lastRequestTime = Date.now();
  return fetch(url, options);
}

/**
 * Search cards with a Scryfall query string.
 * @param {string} query — Scryfall search syntax
 * @returns {Promise<Array>} — parsed card objects
 */
export async function searchCards(query) {
  const cacheKey = `search:${query}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const resp = await rateLimitedFetch(
      `${API_BASE}/cards/search?q=${encodeURIComponent(query)}`
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    const cards = (data.data || []).map(parseCard);
    cache.set(cacheKey, cards);
    return cards;
  } catch (e) {
    console.warn('Scryfall search failed:', e.message);
    return [];
  }
}

/**
 * Look up a card by exact name.
 * @param {string} name
 * @returns {Promise<object|null>}
 */
export async function lookupCard(name) {
  const cacheKey = `named:${name.toLowerCase()}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const resp = await rateLimitedFetch(
      `${API_BASE}/cards/named?exact=${encodeURIComponent(name)}`
    );
    if (!resp.ok) return null;
    const card = parseCard(await resp.json());
    cache.set(cacheKey, card);
    return card;
  } catch (e) {
    console.warn('Scryfall lookup failed:', e.message);
    return null;
  }
}

/**
 * Bulk lookup cards via POST /cards/collection.
 * @param {Array<string>} names — card name list
 * @returns {Promise<Array>} — found cards
 */
export async function bulkLookup(names) {
  if (names.length === 0) return [];

  // Scryfall allows max 75 per request
  const batches = [];
  for (let i = 0; i < names.length; i += 75) {
    batches.push(names.slice(i, i + 75));
  }

  const results = [];
  for (const batch of batches) {
    try {
      const resp = await rateLimitedFetch(`${API_BASE}/cards/collection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifiers: batch.map(name => ({ name })),
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        results.push(...(data.data || []).map(parseCard));
      }
    } catch (e) {
      console.warn('Scryfall bulk lookup failed:', e.message);
    }
  }
  return results;
}

/**
 * Autocomplete card names.
 * @param {string} input
 * @returns {Promise<Array<string>>}
 */
export async function autocomplete(input) {
  if (!input || input.length < 2) return [];

  const cacheKey = `auto:${input.toLowerCase()}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const resp = await rateLimitedFetch(
      `${API_BASE}/cards/autocomplete?q=${encodeURIComponent(input)}`
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    const names = data.data || [];
    cache.set(cacheKey, names);
    return names;
  } catch (e) {
    console.warn('Scryfall autocomplete failed:', e.message);
    return [];
  }
}

/**
 * Parse a Scryfall card object into our simplified format.
 * @param {object} raw
 * @returns {object}
 */
function parseCard(raw) {
  // Handle double-faced cards
  const face = raw.card_faces?.[0] || raw;
  const imageUris = raw.image_uris || face.image_uris || {};

  return {
    name: raw.name,
    oracleText: face.oracle_text || '',
    cmc: raw.cmc ?? 0,
    manaCost: face.mana_cost || '',
    typeLine: raw.type_line || '',
    colorIdentity: raw.color_identity || [],
    imageUris: {
      small: imageUris.small || '',
      normal: imageUris.normal || '',
      art_crop: imageUris.art_crop || '',
    },
    prices: raw.prices || {},
    set: raw.set || '',
    collectorNumber: raw.collector_number || '',
    scryfallId: raw.id || '',
    legalities: raw.legalities || {},
    keywords: raw.keywords || [],
  };
}

/**
 * Parse a plain-text decklist into card names + quantities.
 * Handles: "1 Card Name", "1x Card Name", "Card Name",
 * Arena format with set codes, // comment headers, blank lines.
 * @param {string} text
 * @returns {Array<{name: string, quantity: number}>}
 */
export function parseDecklistText(text) {
  const lines = text.split('\n');
  const entries = [];

  for (const raw of lines) {
    const line = raw.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;

    // Try to parse "Nx Card Name" or "N Card Name" or just "Card Name"
    const match = line.match(/^(\d+)x?\s+(.+?)(?:\s+\([A-Z0-9]+\)\s+\d+.*)?$/i);
    if (match) {
      entries.push({ name: match[2].trim(), quantity: parseInt(match[1], 10) });
    } else {
      // Bare card name (no quantity)
      const nameOnly = line.replace(/\s+\([A-Z0-9]+\)\s+\d+.*$/i, '').trim();
      if (nameOnly) {
        entries.push({ name: nameOnly, quantity: 1 });
      }
    }
  }

  return entries;
}
