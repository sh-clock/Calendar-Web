#!/usr/bin/env node
/**
 * S8 LIVE probes — https://calendar-poc.sh-clock.workers.dev (proto 4.3).
 * Read-only + at most a couple of conditional PUTs on OWN row evt:sec-S8:* (deleted after).
 * Tokens are read from /home/z/my-project/.secrets/credentials.json and NEVER printed.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const CREDS = JSON.parse(readFileSync('/home/z/my-project/.secrets/credentials.json', 'utf8'));
const BASE = CREDS.server.replace(/\/+$/, '');
const UI = CREDS.auth_ui_hex;
const GARBAGE = '0'.repeat(64);
const out = [];
const rec = (name, cond, detail) => { out.push({ name, ok: !!cond, detail }); };

async function req(method, path, { token, body, headers = {}, origin } = {}) {
  const h = { ...headers };
  if (token) h.authorization = 'Bearer ' + token;
  if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  const res = await fetch(BASE + path, {
    method, headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let parsed = null;
  if (text) { try { parsed = JSON.parse(text); } catch { /* */ } }
  return { status: res.status, headers: res.headers, buf, text, parsed };
}

// ---------- V1: version + basic shapes ----------
{
  const v = await req('GET', '/version', { token: UI });
  rec('V1 /version (ui) -> 200 proto 4.3', v.status === 200 && v.parsed && v.parsed.proto === '4.3', v.status + ':' + v.text);
  rec('V1 /version content-type json', (v.headers.get('content-type') || '').startsWith('application/json'), v.headers.get('content-type'));
  rec('V1 /version NO cache-control/expires', !v.headers.get('cache-control') && !v.headers.get('expires'), JSON.stringify({ cc: v.headers.get('cache-control') }));
  const v404a = await req('GET', '/version', { token: GARBAGE });
  const v404b = await req('GET', '/nope', { token: GARBAGE });
  const v404c = await req('GET', '/nope', { token: UI });
  const v404d = await req('GET', '/version', {});
  rec('V1 bad-auth /version -> 404 empty', v404a.status === 404 && v404a.buf.length === 0, v404a.status + ':' + v404a.buf.length);
  rec('V1 unknown route (bad token) -> 404 empty', v404b.status === 404 && v404b.buf.length === 0, v404b.status + ':' + v404b.buf.length);
  rec('V1 unknown route (GOOD token) -> 404 empty', v404c.status === 404 && v404c.buf.length === 0, v404c.status + ':' + v404c.buf.length);
  rec('V1 no token /version -> 404 empty', v404d.status === 404 && v404d.buf.length === 0, v404d.status + ':' + v404d.buf.length);
  const keys = (r) => [...r.headers.keys()].filter(k => !['date', 'cf-ray', 'cf-cache-status', 'age', 'report-to', 'nel', 'server', 'alt-svc', 'vary'].includes(k)).sort().join(',');
  const identical = keys(v404a) === keys(v404b) && v404a.buf.length === v404b.buf.length && v404a.status === v404b.status;
  rec('V1 indistinguishable: bad-auth-known-route vs unknown-route (same status, body, header set)', identical, keys(v404a) + ' || ' + keys(v404b));
  rec('V1 no WWW-Authenticate on 404', v404a.headers.get('www-authenticate') === null, String(v404a.headers.get('www-authenticate')));
  rec('V1 no cache-control on 404', v404a.headers.get('cache-control') === null, String(v404a.headers.get('cache-control')));
  rec('V1 404 content-length 0', v404a.headers.get('content-length') === '0', String(v404a.headers.get('content-length')));

  const p = await req('PATCH', '/config', { token: UI, body: '{}' });
  rec('V1 PATCH /config (valid token) -> 404 empty', p.status === 404 && p.buf.length === 0, p.status + ':' + p.buf.length);
  const h = await req('HEAD', '/version', { token: UI });
  rec('V1 HEAD /version (valid token) -> 404', h.status === 404 && h.buf.length === 0, h.status + ':' + h.buf.length);

  const o1 = await req('OPTIONS', '/version', { origin: 'https://sh-clock.github.io' });
  const o2 = await req('OPTIONS', '/version', { origin: 'https://evil.example' });
  const o3 = await req('OPTIONS', '/version', {});
  rec('V1 OPTIONS allowlisted origin -> 204 + CORS',
    o1.status === 204 && o1.headers.get('access-control-allow-origin') === 'https://sh-clock.github.io', o1.status + ':' + o1.headers.get('access-control-allow-origin'));
  rec('V1 OPTIONS allow-methods GET,POST,PUT,DELETE,OPTIONS',
    /POST/.test(o1.headers.get('access-control-allow-methods') || '') && !/PATCH/.test(o1.headers.get('access-control-allow-methods') || ''), o1.headers.get('access-control-allow-methods'));
  rec('V1 OPTIONS evil origin -> 404 empty no CORS',
    o2.status === 404 && o2.buf.length === 0 && o2.headers.get('access-control-allow-origin') === null, o2.status + ':' + o2.buf.length);
  rec('V1 OPTIONS no origin -> 404 empty', o3.status === 404 && o3.buf.length === 0, o3.status + ':' + o3.buf.length);

  // CORS decorate on error responses for allowlisted origin
  const c404 = await req('GET', '/nope', { token: UI, origin: 'https://sh-clock.github.io' });
  rec('V1 CORS headers decorate even the silent 404 for allowlisted origin',
    c404.status === 404 && c404.buf.length === 0 && c404.headers.get('access-control-allow-origin') === 'https://sh-clock.github.io',
    c404.status + ':' + c404.headers.get('access-control-allow-origin'));
}

// ---------- V2: config / status / manifest / etag ----------
{
  const c = await req('GET', '/config', { token: UI });
  const wrappedLen = c.parsed ? Buffer.from(c.parsed.wrapped || '', 'base64').length : -1;
  rec('V2 /config -> 200 {salt,iters,wrapped,ver} only', c.status === 200 && c.parsed && c.parsed.salt && c.parsed.iters === 100000 && typeof c.parsed.wrapped === 'string', c.status + ':' + c.text.slice(0, 120));
  rec('V2 /config wrapped decodes to 60 bytes (v4.1 §8 "48B" text is wrong)', wrappedLen === 60, String(wrappedLen));
  rec('V2 /config omits private columns', c.parsed && !('auth_ui' in c.parsed) && !('auth_clock' in c.parsed), Object.keys(c.parsed || {}).join(','));
  rec('V2 /config NO cache-control (browser could cache bootstrap params)', !c.headers.get('cache-control'), String(c.headers.get('cache-control')));
  const s = await req('GET', '/status', { token: UI });
  rec('V2 /status -> 200 {"photo_pending":N}', s.status === 200 && s.parsed && typeof s.parsed.photo_pending === 'number', s.status + ':' + s.text);
  const m = await req('GET', '/rows', { token: UI });
  rec('V2 /rows -> 200 manifest + etag', m.status === 200 && m.parsed && Array.isArray(m.parsed.rows) && typeof m.parsed.etag === 'string', m.status + ' rows=' + (m.parsed && m.parsed.rows && m.parsed.rows.length) + ' etag=' + (m.parsed && m.parsed.etag));
  rec('V2 /rows 200 has NO ETag header (field only in body)', m.headers.get('etag') === null, String(m.headers.get('etag')));
  rec('V2 /rows 200 has NO cache-control', m.headers.get('cache-control') === null, String(m.headers.get('cache-control')));
  const m2 = await req('GET', '/rows', { token: UI, headers: { 'if-none-match': m.parsed.etag } });
  rec('V2 If-None-Match -> 304 empty + ETag header', m2.status === 304 && m2.buf.length === 0 && m2.headers.get('etag') === m.parsed.etag, m2.status + ' len=' + m2.buf.length + ' hdr=' + m2.headers.get('etag'));
  const nf = await req('GET', '/rows/evt:sec-S8:probe1', { token: UI });
  rec('V2 GET own not-yet-existing row -> 404 not_found JSON', nf.status === 404 && nf.parsed && nf.parsed.error === 'not_found', nf.status + ':' + nf.text);
}

// ---------- V3: conditional PUTs on OWN row evt:sec-S8:probe1 (then delete) ----------
{
  const b64 = (n) => Buffer.alloc(n, 0x41).toString('base64');
  const env = { ver: 1, nonce: b64(12), ct: b64(48) };
  const p1 = await req('PUT', '/rows/evt:sec-S8:probe1', { token: UI, body: env, headers: { 'if-none-match': '*' } });
  rec('V3 INM:* create own row -> 200 echo', p1.status === 200 && p1.parsed && p1.parsed.ver === 1 && p1.parsed.nonce === env.nonce, p1.status + ':' + p1.text.slice(0, 80));
  const p2 = await req('PUT', '/rows/evt:sec-S8:probe1', { token: UI, body: { ver: 2, nonce: b64(12), ct: b64(48) }, headers: { 'if-none-match': '*' } });
  rec('V3 INM:* again -> 412 EMPTY', p2.status === 412 && p2.buf.length === 0, p2.status + ':' + p2.buf.length);
  const p3 = await req('PUT', '/rows/evt:sec-S8:probe1', { token: UI, body: { ver: 2, nonce: b64(12), ct: b64(48) }, headers: { 'if-match': '"999"' } });
  rec('V3 If-Match "999" mismatch -> 412 EMPTY', p3.status === 412 && p3.buf.length === 0, p3.status + ':' + p3.buf.length);
  const g = await req('GET', '/rows/evt:sec-S8:probe1', { token: UI });
  rec('V3 row still ver 1 (no mutation from 412s)', g.status === 200 && g.parsed && g.parsed.ver === 1, g.status + ':' + g.text.slice(0, 60));
  const d = await req('DELETE', '/rows/evt:sec-S8:probe1', { token: UI });
  rec('V3 DELETE own row -> 200 {}', d.status === 200, d.status + ':' + d.text);
  const g2 = await req('GET', '/rows/evt:sec-S8:probe1', { token: UI });
  rec('V3 row gone -> 404 not_found', g2.status === 404 && g2.parsed && g2.parsed.error === 'not_found', g2.status + ':' + g2.text);
  const d2 = await req('DELETE', '/rows/evt:sec-S8:probe1', { token: UI });
  rec('V3 idempotent re-delete -> 200 {}', d2.status === 200, d2.status + ':' + d2.text);
}

writeFileSync('/home/z/my-project/calendar-web/audit-d/s8-live-results.json', JSON.stringify(out, null, 2));
for (const r of out) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : ' :: ' + r.detail));
const fails = out.filter(r => !r.ok);
console.log('\nS8 LIVE: ' + (out.length - fails.length) + '/' + out.length + ' passed');
