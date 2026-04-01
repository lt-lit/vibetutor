/**
 * api.js — Calls to the Worker middleware
 * Handles EDHREC proxy and LLM proxy via Cloudflare Worker.
 */

/** Worker base URL — update this when deployed */
const WORKER_URL = 'https://vibetutor-worker.YOUR_SUBDOMAIN.workers.dev';

/**
 * Fetch and parse EDHREC data for a commander.
 * Extracts card recommendations with synergy scores and inclusion rates.
 * @param {string} commanderSlug — e.g. 'zedruu-the-greathearted'
 * @returns {Promise<{cardRecs: Array, loaded: boolean, lastFetched: number}|null>}
 */
export async function fetchEdhrec(commanderSlug) {
  try {
    const resp = await fetch(`${WORKER_URL}/edhrec/commanders/${commanderSlug}`);
    if (!resp.ok) return null;
    const raw = await resp.json();
    return parseEdhrecData(raw);
  } catch (e) {
    // Graceful degradation — EDHREC is optional
    console.warn('EDHREC fetch failed:', e.message);
    return null;
  }
}

/**
 * Parse raw EDHREC JSON into structured card recommendations.
 * EDHREC's JSON has a `cardlists` array with sections like
 * "newcards", "topCards", "creatures", "instants", etc.
 * Each section contains card objects with synergy and inclusion data.
 * @param {object} raw — raw EDHREC JSON response
 * @returns {{cardRecs: Array, loaded: boolean, lastFetched: number}}
 */
function parseEdhrecData(raw) {
  const cardRecs = [];
  const seen = new Set();

  // EDHREC structures data in cardlists
  const cardlists = raw.cardlists || raw.container?.json_dict?.cardlists || [];

  for (const section of cardlists) {
    const cards = section.cardviews || section.cards || [];
    for (const card of cards) {
      const name = card.name || card.names?.[0];
      if (!name || seen.has(name)) continue;
      seen.add(name);

      cardRecs.push({
        name,
        synergy: card.synergy ?? card.synergy_score ?? null,
        inclusion: card.inclusion ?? card.num_decks_percent ?? null,
        numDecks: card.num_decks ?? null,
        salt: card.salt ?? null,
        label: section.header || section.tag || '',
      });
    }
  }

  return {
    cardRecs,
    loaded: true,
    lastFetched: Date.now(),
  };
}

/**
 * Generate a commander slug from a card name.
 * E.g. "Zedruu the Greathearted" -> "zedruu-the-greathearted"
 * @param {string} name
 * @returns {string}
 */
export function commanderToSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Send a chat completion request to OpenRouter via the Worker proxy.
 * @param {Array} messages — OpenAI-format message array
 * @param {string} model — model ID (e.g. 'anthropic/claude-sonnet-4')
 * @returns {Promise<object>} — parsed response
 * @throws {Error} on failure
 */
export async function fetchLLM(messages, model) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('API key required. Add your OpenRouter key in Strategy settings.');
  }

  const resp = await fetch(`${WORKER_URL}/llm/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-API-Key': apiKey,
    },
    body: JSON.stringify({
      model,
      messages,
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `LLM request failed (${resp.status})`);
  }

  return resp.json();
}

/**
 * Get the current API key from localStorage.
 * @returns {string|null}
 */
export function getApiKey() {
  return localStorage.getItem('vibetutor_api_key');
}

/**
 * Save the API key to localStorage.
 * @param {string} key
 */
export function setApiKey(key) {
  localStorage.setItem('vibetutor_api_key', key);
}
