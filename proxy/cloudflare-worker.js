/* ============================================================================
 * Income Lense – FMP proxy (Cloudflare Worker)
 * ----------------------------------------------------------------------------
 * Keeps the Financial Modeling Prep API key secret: the static app calls this
 * worker, the worker appends the key server-side and forwards to FMP.
 *
 * Deploy: see ./README.md. Set the key as a secret:
 *   wrangler secret put FMP_API_KEY
 *
 * Request shape (from the app):
 *   GET https://<worker-url>/?path=v3/profile/AAPL
 *   GET https://<worker-url>/?path=v3/cash-flow-statement/KO?period=annual&limit=1
 * Only an allow-list of dividend/fundamental paths is permitted.
 * ==========================================================================*/

const ALLOWED_PREFIXES = [
  'v3/historical-price-full/stock_dividend/',
  'v3/ratios-ttm/',
  'v3/cash-flow-statement/',
  'v3/profile/',
  'v3/key-metrics-ttm/',
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, cors);

    const url = new URL(request.url);
    const path = url.searchParams.get('path') || '';
    if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
      return json({ error: 'path not allowed' }, 400, cors);
    }
    if (!env.FMP_API_KEY) return json({ error: 'server missing FMP_API_KEY' }, 500, cors);

    const sep = path.includes('?') ? '&' : '?';
    const target = `https://financialmodelingprep.com/api/${path}${sep}apikey=${env.FMP_API_KEY}`;

    const upstream = await fetch(target, { cf: { cacheTtl: 3600, cacheEverything: true } });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
    });
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}
