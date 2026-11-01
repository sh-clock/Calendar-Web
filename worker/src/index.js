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
    // v4.3 §9c/§9d: conditional headers (If-Match/If-None-Match) are part of
    // the protocol surface — the browser preflight must allow them, and the
    // front door forwards them to the DO.
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type, If-Match, If-None-Match',
    // sec-S1-2: ETag is not a CORS-safelisted response header, so without
    // an explicit expose the browser cannot read the §9d 304's ETag at all
    // (the client's echo fallback was load-bearing). Nothing else is exposed.
    'access-control-expose-headers': 'ETag',
    'access-control-max-age': '86400',
  };
}

/** Headers stamped on EVERY response leaving the worker (sec-S1-1/S1-3):
 *  - `vary: Origin` — the response legitimately differs by Origin (CORS
 *    decoration present or not); an intermediary cache that keys by URL
 *    alone must never store the undecorated variant and serve it to the
 *    allowlisted origin (CORS failure → sync breakage).
 *  - HSTS (https responses; ignored by browsers on cleartext, harmless there)
 *    — no max-age on workers.dev subdomain takeover surfaces, includeSubDomains
 *    deliberately omitted: this host's siblings belong to other workers. */
const BASE_HEADERS = {
  vary: 'Origin',
  'strict-transport-security': 'max-age=31536000',
};

/** Copy a DO response, adding CORS headers for allowlisted origins. */
function decorate(res, origin) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(BASE_HEADERS)) out.headers.set(k, v);
  if (origin) {
    for (const [k, v] of Object.entries(corsHeaders(origin))) out.headers.set(k, v);
  }
  return out;
}

export default {
  async fetch(req, env) {
    // sec-S8-F4: the §4 law (an internal failure must look EXACTLY like an
    // unknown route, not a 500) now holds at the front door too — a thrown
    // worker error previously surfaced as a runtime 500 (seen on CONNECT in
    // dev; the production edge answers those first, but the law is the law).
    // The drop carries the same BASE_HEADERS a relayed silent drop would.
    try {
      return await handle(req, env);
    } catch {
      return new Response(null, { status: 404, headers: { ...BASE_HEADERS } });
    }
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

async function handle(req, env) {
  const url = new URL(req.url);

  // sec-S1-1: the worker used to answer bearer-authenticated requests over
  // cleartext HTTP (token + full CORS decoration on http://…workers.dev) with
  // no redirect and no HSTS. Now every non-localhost http request is upgraded
  // with a permanent 308 BEFORE any auth/CORS logic runs (localhost/127.0.0.1
  // /::1 are exempt: `wrangler dev` and the local stacks are http by design).
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    url.protocol = 'https:';
    // Manually built 308 (Response.redirect's headers are immutable, so the
    // BASE_HEADERS stamp below would throw on it).
    return new Response(null, {
      status: 308,
      headers: { location: url.toString(), ...BASE_HEADERS },
    });
  }

  const origin = allowedOrigin(req.headers.get('origin'), env);

  // CORS preflight. Browsers never send Authorization on preflight, so the
  // bearer gate cannot apply here; the origin allowlist is the gate. A
  // non-allowlisted origin gets the silent drop (no CORS headers at all).
  if (req.method === 'OPTIONS') {
    if (!origin) return new Response(null, { status: 404, headers: { ...BASE_HEADERS } });
    return new Response(null, { status: 204, headers: { ...corsHeaders(origin), ...BASE_HEADERS } });
  }

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
}

/** Dev-stack exemption for the http→https upgrade (wrangler dev serves http).
 * IPv6 loopback arrives bracketed from URL.hostname ([::1]). */
function isLocalHost(h) {
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}
