/**
 * front-door-unit.mjs — direct unit tests for worker/src/index.js (sec-S1-1,
 * S1-2, S1-3, S8-F4). These behaviours are NOT observable through `wrangler
 * dev` (the dev host is always localhost, which the http→https upgrade
 * deliberately exempts), so the worker module is imported and driven with a
 * stubbed DO binding in-process.
 */

import assert from 'node:assert/strict';

const mod = await import('../worker/src/index.js');
const worker = mod.default;

/** Records what the DO received; replies with a canned response. */
function makeEnv({ reply = () => new Response('{"ok":true}', { status: 200 }), throwOn = null } = {}) {
  const seen = [];
  const stub = {
    fetch: async (url, init) => {
      seen.push({ url, init });
      if (throwOn) throw new Error('boom');
      return reply();
    },
  };
  return {
    env: {
      STORE: { get: () => stub, idFromName: () => 'main' },
      ALLOWED_ORIGIN: 'https://sh-clock.github.io',
    },
    seen,
  };
}

let pass = 0;
function ok(name, cond, extra) {
  if (!cond) {
    console.error('  FAIL ' + name + (extra !== undefined ? ' — ' + String(extra) : ''));
    process.exitCode = 1;
  } else {
    pass++;
  }
}

// ---- fd.1: http on a NON-localhost host → 308 upgrade (sec-S1-1) ----
{
  const { env } = makeEnv();
  const res = await worker.fetch(new Request('http://calendar-poc.sh-clock.workers.dev/rows?x=1', {
    headers: { authorization: 'Bearer ' + '11'.repeat(32) },
  }), env);
  ok('fd.1 http→308 with https Location (query preserved)',
    res.status === 308 &&
    res.headers.get('location') === 'https://calendar-poc.sh-clock.workers.dev/rows?x=1',
    res.status + ' ' + res.headers.get('location'));
  ok('fd.1b redirect carries vary+HSTS',
    res.headers.get('vary') === 'Origin' && res.headers.get('strict-transport-security') === 'max-age=31536000');
}

// ---- fd.2: http on localhost hosts → passed through (dev stacks) ----
for (const host of ['localhost:8787', '127.0.0.1:8788', '[::1]:8787', 'sub.localhost:8787']) {
  const { env, seen } = makeEnv();
  const res = await worker.fetch(new Request(`http://${host}/rows`), env);
  ok(`fd.2 http://${host} NOT redirected (dev exemption)`, res.status === 200 && seen.length === 1 && seen[0].url === `https://do.internal/rows`);
}

// ---- fd.3: https passes through; only 4 headers forwarded ----
{
  const { env, seen } = makeEnv();
  const res = await worker.fetch(new Request('https://calendar-poc.sh-clock.workers.dev/rows', {
    headers: {
      authorization: 'Bearer ' + '11'.repeat(32),
      'content-type': 'application/json',
      'if-match': '"5"',
      'if-none-match': '"e46"',
      'x-evil': '1',
      cookie: 'a=b',
      'x-forwarded-for': '9.9.9.9',
    },
  }), env);
  ok('fd.3 DO reached, body untouched', res.status === 200 && seen.length === 1);
  const h = seen[0].init.headers;
  ok('fd.3b exactly the 4 protocol headers forwarded',
    h.get('authorization') !== null && h.get('content-type') !== null &&
    h.get('if-match') === '"5"' && h.get('if-none-match') === '"e46"' &&
    h.get('x-evil') === null && h.get('cookie') === null && h.get('x-forwarded-for') === null);
}

// ---- fd.4: an internal DO error → silent 404, §4 law (sec-S8-F4) ----
{
  const { env } = makeEnv({ throwOn: true });
  const res = await worker.fetch(new Request('https://calendar-poc.sh-clock.workers.dev/rows', {
    headers: { authorization: 'Bearer ' + '11'.repeat(32) },
  }), env);
  ok('fd.4 DO exception → empty 404 (no 500 leak)', res.status === 404 && (await res.text()) === '');
}

// ---- fd.5: OPTIONS preflight gates on the origin allowlist ----
{
  const { env, seen } = makeEnv();
  const res = await worker.fetch(new Request('https://x/anything', {
    method: 'OPTIONS',
    headers: { origin: 'https://sh-clock.github.io' },
  }), env);
  ok('fd.5 allowlisted preflight → 204 + CORS + expose ETag + vary',
    res.status === 204 &&
    res.headers.get('access-control-allow-origin') === 'https://sh-clock.github.io' &&
    res.headers.get('access-control-expose-headers') === 'ETag' &&
    res.headers.get('vary') === 'Origin' &&
    seen.length === 0);
  const { env: env2 } = makeEnv();
  const res2 = await worker.fetch(new Request('https://x/anything', {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example' },
  }), env2);
  ok('fd.5b foreign origin preflight → bare 404 (still vary+HSTS)',
    res2.status === 404 && res2.headers.get('access-control-allow-origin') === null &&
    res2.headers.get('vary') === 'Origin');
}

// ---- fd.6: EVERY response carries vary+HSTS, CORS only for allowed ----
{
  const { env } = makeEnv();
  const decorated = await worker.fetch(new Request('https://x/rows', {
    headers: { origin: 'https://sh-clock.github.io' },
  }), env);
  ok('fd.6 decorated: vary+HSTS+ACAO',
    decorated.headers.get('vary') === 'Origin' &&
    decorated.headers.get('strict-transport-security') === 'max-age=31536000' &&
    decorated.headers.get('access-control-allow-origin') === 'https://sh-clock.github.io');
  const { env: env2 } = makeEnv();
  const bare = await worker.fetch(new Request('https://x/rows'), env2);
  ok('fd.6b undecorated: vary+HSTS, NO ACAO (sec-S1-3)',
    bare.headers.get('vary') === 'Origin' &&
    bare.headers.get('strict-transport-security') === 'max-age=31536000' &&
    bare.headers.get('access-control-allow-origin') === null);
}

// ---- fd.7: a 304 DO response is relayed with status + etag intact ----
{
  const { env } = makeEnv({ reply: () => new Response(null, { status: 304, headers: { etag: '"e46"' } }) });
  const res = await worker.fetch(new Request('https://x/rows', {
    headers: { origin: 'https://sh-clock.github.io', 'if-none-match': '"e46"' },
  }), env);
  ok('fd.7 304 relayed intact (empty body, etag, CORS)',
    res.status === 304 && res.headers.get('etag') === '"e46"' &&
    res.headers.get('access-control-allow-origin') === 'https://sh-clock.github.io' &&
    (await res.text()) === '');
}

console.log(`front-door-unit: ${pass} passed${process.exitCode ? ', FAILURES' : ''}`);
