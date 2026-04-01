/**
 * api.js — Calls to the Worker middleware
 * Handles EDHREC proxy and LLM proxy via Cloudflare Worker.
 */

/** Worker base URL — update this when deployed */
const WORKER_URL = 'https://vibetutor-worker.YOUR_SUBDOMAIN.workers.dev';

/**
 * Fetch EDHREC data for a commander.
 * @param {string} commanderSlug — e.g. 'zedruu-the-greathearted'
 * @returns {Promise<object|null>} — parsed EDHREC data or null on failure
 */
export async function fetchEdhrec(commanderSlug) {
  try {
    const resp = await fetch(`${WORKER_URL}/edhrec/commanders/${commanderSlug}`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    // Graceful degradation — EDHREC is optional
    console.warn('EDHREC fetch failed:', e.message);
    return null;
  }
}

/**
 * Send a chat completion request to OpenRouter via the Worker proxy.
 * @param {Array} messages — OpenAI-format message array
 * @param {string} model — model ID (e.g. 'anthropic/claude-sonnet-4')
 * @returns {Promise<object>} — parsed response
 * @throws {Error} on failure
 */
export async function fetchLLM(messages, model) {
  const apiKey = localStorage.getItem('vibetutor_api_key');
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
