/**
 * scryfall.js — Scryfall API integration
 * Card search, autocomplete, bulk lookup, and decklist parsing.
 * Includes rate limiting (100ms between requests) and in-session cache.
 */

const API_BASE = 'https://api.scryfall.com';

/** In-session cache: Map<string, any> */
const cache = new Map();

/** Rate limit queue — ensures sequential execution with 100ms spacing */
const requestQueue = [];
let isProcessingQueue = false;
const MIN_INTERVAL = 100; // ms

/**
 * Rate-limited fetch wrapper using a sequential queue.
 * Prevents concurrent calls from bypassing the rate limit.
 */
function rateLimitedFetch(url, options) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ url, options, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (requestQueue.length > 0) {
    const { url, options, resolve, reject } = requestQueue.shift();
    try {
      const resp = await fetch(url, options);
      resolve(resp);
    } catch (e) {
      reject(e);
    }
    // Wait between requests to respect Scryfall rate limits
    if (requestQueue.length > 0) {
      await new Promise(r => setTimeout(r, MIN_INTERVAL));
    }
  }

  isProcessingQueue = false;
}

/**
 * Search cards with a Scryfall query string.
 * Returns first page of results (up to 175 cards). For the engine's purposes
 * this is plenty — the LLM selects 3-5 from the pool anyway.
 * @param {string} query — Scryfall search syntax
 * @returns {Promise<Array>} — parsed card objects
 */
export async function searchCards(query) {
  const cacheKey = `search:${query}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const resp = await rateLimitedFetch(
      `${API_BASE}/cards/search?q=${encodeURIComponent(query)}&order=edhrec`
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
 * @param {Array<string|{name:string, set?:string, collectorNumber?:string}>} names — card identifiers (names or objects with printing info)
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
          identifiers: batch.map(item => {
            if (typeof item === 'object' && item.set && item.collectorNumber) {
              return { set: item.set, collector_number: item.collectorNumber };
            }
            const name = typeof item === 'string' ? item : item.name;
            return { name };
          }),
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
 * Fuzzy lookup: validates brainstormed card names that may not be exact.
 * First tries bulkLookup for exact matches, then falls back to quoted-phrase
 * search for misses (e.g. "Sandy Cheeks" → "Sandy Cheeks, Martial Astronaut").
 * @param {Array<string>} names — card names to validate
 * @returns {Promise<{found: Array<object>, failures: Array<string>}>}
 */
export async function fuzzyLookup(names) {
  if (names.length === 0) return { found: [], failures: [] };

  // Step 1: batch exact match
  const exactResults = await bulkLookup(names);
  const foundNames = new Set(exactResults.map(c => c.name));

  // Step 2: identify misses
  const misses = names.filter(n => !foundNames.has(n));

  // Step 3: quoted-phrase search for each miss
  const fuzzyResults = [];
  const resolvedMisses = new Set();
  for (const name of misses) {
    const results = await searchCards(`"${name}"`);
    if (results.length > 0) {
      fuzzyResults.push(results[0]);
      resolvedMisses.add(name);
    }
  }

  // Failures: misses that fuzzy search also couldn't resolve
  const failures = misses.filter(n => !resolvedMisses.has(n));

  return {
    found: [...exactResults, ...fuzzyResults],
    failures,
  };
}

/**
 * Parse a raw Scryfall card into a printing summary for the printing selector.
 */
function parsePrinting(raw) {
  const face = raw.card_faces?.[0] || raw;
  return {
    scryfallData: parseCard(raw),
    setName: raw.set_name || '',
    setCode: (raw.set || '').toUpperCase(),
    collectorNumber: raw.collector_number || '',
    rarity: raw.rarity || '',
    year: (raw.released_at || '').slice(0, 4),
    priceUsd: raw.prices?.usd || null,
    priceFoil: raw.prices?.usd_foil || null,
    imageNormal: (raw.image_uris || face.image_uris || {}).normal || '',
  };
}

/**
 * Fetch all printings of a card by exact name.
 * @param {string} cardName
 * @returns {Promise<Array<object>>}
 */
export async function fetchAllPrintings(cardName) {
  const cacheKey = `printings:${cardName.toLowerCase()}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const results = [];
  let url = `${API_BASE}/cards/search?q=${encodeURIComponent('!"' + cardName + '"')}+unique%3Aprints&order=released`;

  try {
    while (url) {
      const resp = await rateLimitedFetch(url);
      if (!resp.ok) break;
      const data = await resp.json();
      for (const raw of (data.data || [])) {
        results.push(parsePrinting(raw));
      }
      url = data.has_more ? data.next_page : null;
    }
  } catch (e) {
    console.warn('Scryfall fetchAllPrintings failed:', e.message);
  }

  cache.set(cacheKey, results);
  return results;
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
    setName: raw.set_name || '',
    rarity: raw.rarity || '',
    artist: face.artist || raw.artist || '',
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
