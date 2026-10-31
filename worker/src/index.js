/**
 * Calendar PoC Worker — front door (protocol v4.1 + v4.2 calendar delta).
 *
 * Thin router: CORS allowlist (WORKLOG D6) + Durable Object relay + §19 cron.
 * The Worker itself stores nothing; the "Store" DO is primary storage (§7, L1).
 * All application logic — including the §4 bearer gate — lives in the DO.
 */
import { Store } from './store.js';
export { Store };

const DO_NAME = 'main';

/** Returns the request Origin iff it is in the allowlist, else null (WORKLOG D6). */
function allowedOrigin(origin, env) {
  if (!origin) return null;
  const list = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    // v4.3 §9b: POST is needed for /rows:batch (browser preflight must pass).
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

/** Copy a DO response, adding CORS headers for allowlisted origins. */
function decorate(res, origin) {
  if (!origin) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders(origin))) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(req, env) {
    const origin = allowedOrigin(req.headers.get('origin'), env);

    // CORS preflight. Browsers never send Authorization on preflight, so the
    // bearer gate cannot apply here; the origin allowlist is the gate. A
    // non-allowlisted origin gets the silent drop (no CORS headers at all).
    if (req.method === 'OPTIONS') {
      if (!origin) return new Response(null, { status: 404 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(req.url);
    const stub = env.STORE.get(env.STORE.idFromName(DO_NAME));

    const headers = new Headers();
    // §9c: conditional headers are forwarded so the DO can answer with real
    // 412/404 status codes for DAV clients (If-Match/If-None-Match).
    for (const h of ['authorization', 'content-type', 'if-match', 'if-none-match']) {
      const v = req.headers.get(h);
      if (v !== null) headers.set(h, v);
    }
    const init = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = req.body;

    // The request body is streamed to the DO unread (L1: the Worker never
    // inspects content). The DO authenticates from headers BEFORE reading any
    // body, so unauthenticated requests get the silent drop without the body
    // ever being consumed.
    const res = await stub.fetch('https://do.internal' + url.pathname + url.search, init);
    return decorate(res, origin);
  },

  /** §19: daily 03:00 UTC backup — trigger the DO snapshot into D1. */
  async scheduled(evt, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const stub = env.STORE.get(env.STORE.idFromName(DO_NAME));
        const res = await stub.fetch('https://do.internal/internal/backup', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + (env.INTERNAL_TOKEN || '') },
        });
        if (!res.ok) throw new Error('backup_failed_' + res.status);
        const j = await res.json().catch(() => ({}));
        // §3 key ledger: "Worker logs: nothing" — counts only, never ids/params.
        console.log('backup ok day=' + j.day + ' rows=' + (j.rows | 0));
      })()
    );
  },
};
