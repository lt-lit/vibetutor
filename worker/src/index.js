/**
 * Cloudflare Worker — VibeTutor Middleware
 * Routes:
 *   GET  /edhrec/commanders/{slug} — proxy to json.edhrec.com, cache 24h in KV
 *   GET  /health                  — status check
 *   OPTIONS *                     — CORS preflight
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Route handling
    if (url.pathname.startsWith('/edhrec/')) {
      return handleEdhrec(url, env);
    }
    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    return new Response('Not found', { status: 404 });
  },
};

/**
 * Proxy EDHREC requests with KV caching (24h TTL).
 */
async function handleEdhrec(url, env) {
  const path = url.pathname.replace('/edhrec', '');
  const cacheKey = `edhrec:${path}`;

  // Check KV cache
  const cached = await env.CACHE.get(cacheKey);
  if (cached) {
    return jsonResponse(JSON.parse(cached));
  }

  // Fetch from EDHREC
  const resp = await fetch(`https://json.edhrec.com/pages${path}.json`);
  if (!resp.ok) {
    return jsonResponse({ error: 'unavailable' }, 502);
  }

  const data = await resp.text();

  // Cache for 24 hours
  await env.CACHE.put(cacheKey, data, { expirationTtl: 86400 });

  return new Response(data, {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

/**
 * Create a JSON response with CORS headers.
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

/**
 * CORS headers — allow all origins for v1.
 */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
