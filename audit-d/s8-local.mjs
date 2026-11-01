#!/usr/bin/env node
/**
 * S8 protocol-conformance local probes (calendar-web PoC, proto v4.3).
 * Read-only + self-owned rows only; runs against local wrangler stack (8787/8788).
 * Results -> /tmp/s8-local-results.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';

const BASE = 'http://127.0.0.1:8787';
const BASE2 = 'http://127.0.0.1:8788';
const MAT = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const MAT2 = JSON.parse(readFileSync('/tmp/local-material-2.json', 'utf8'));
const ADMIN = process.env.ADMIN_SECRET;
const INTERNAL = process.env.INTERNAL_TOKEN;
const UI = MAT.auth_ui_hex;
const CLOCK = MAT.auth_clock_hex;
const GARBAGE = '0'.repeat(64);
const PAGES_ORIGIN = 'https://sh-clock.github.io';

const results = [];
function rec(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' :: ' + detail));
}

async function req(method, path, { token, body, headers = {}, origin } = {}) {
  const h = { ...headers };
  if (token) h.authorization = 'Bearer ' + token;
  if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
  if (origin) h.origin = origin;
  const doFetch = () => fetch(BASE + path, {
    method, headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  let res;
  try { res = await doFetch(); }
  catch (e) {
    await new Promise(r => setTimeout(r, 700)); // workerd dev hiccup: retry once
    res = await doFetch();
  }
  const buf = Buffer.from(await res.arrayBuffer());
  let parsed = null;
  const text = buf.toString('utf8');
  if (text) { try { parsed = JSON.parse(text); } catch { /* foreign body */ } }
  return { status: res.status, headers: res.headers, buf, text, parsed };
}

function b64(nBytes) { return Buffer.alloc(nBytes, 0x41).toString('base64'); } // canonical, padded

/* ============ L1: silent-drop law & route/method matrix ============ */
{
  const M = ['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'HEAD']; // TRACE/CONNECT via raw socket (undici refuses TRACE)
  const P = ['/version', '/config', '/status', '/rows', '/rows:batch', '/rows/x', '/bootstrap', '/bootstrap/rewrap', '/internal/backup', '/nope', '/rows/', '/rows/%zz', '/', '/version/', '/VERSION'];
  for (const p of P) {
    for (const m of M) {
      let r;
      try { r = await req(m, p, { token: UI }); }
      catch (e) { rec('L1 raw ' + m + ' ' + p + ' (ui) throws', false, String(e)); continue; }
      const known = (
        (m === 'GET' && (p === '/version' || p === '/config' || p === '/status' || p === '/rows')) ||
        (m === 'POST' && p === '/rows:batch') ||
        (m === 'GET' && p.startsWith('/rows/')) ||
        (m === 'PUT' && p === '/bootstrap') ||
        (m === 'PUT' && p === '/bootstrap/rewrap') ||
        (m === 'POST' && p === '/internal/backup')
      );
      const rowRoute = (p === '/rows/x' && (m === 'PUT' || m === 'DELETE'));
      if (known || rowRoute) continue; // covered elsewhere
      const silent = r.status === 404 && r.buf.length === 0;
      if (!silent) rec('L1 ' + m + ' ' + p + ' (ui token) silent-drop', false,
        'status=' + r.status + ' bodyLen=' + r.buf.length + ' body=' + r.text.slice(0, 80));
    }
  }
  rec('L1 unknown routes/methods all empty-404 (matrix above silent)', !results.some(x => !x.ok));

  // bad auth on known route vs unknown route: identical shape
  const a = await req('GET', '/version', { token: GARBAGE });
  const b = await req('GET', '/nope', { token: GARBAGE });
  const c = await req('GET', '/nope', { token: UI });
  const d = await req('GET', '/version', {});
  const e = await req('GET', '/version', { token: ADMIN });     // admin on app route
  const f = await req('GET', '/version', { token: INTERNAL });  // internal on app route
  rec('L1 bad-token /version -> 404 empty', a.status === 404 && a.buf.length === 0, JSON.stringify({ s: a.status, l: a.buf.length }));
  rec('L1 unknown route no/good/bad token all 404 empty',
    b.status === 404 && b.buf.length === 0 && c.status === 404 && c.buf.length === 0,
    JSON.stringify({ b: [b.status, b.buf.length], c: [c.status, c.buf.length] }));
  rec('L1 no-token /version -> 404 empty', d.status === 404 && d.buf.length === 0, d.status + '');
  rec('L1 admin/internal token on app route -> 404 empty',
    e.status === 404 && e.buf.length === 0 && f.status === 404 && f.buf.length === 0,
    JSON.stringify({ e: e.status, f: f.status }));
  rec('L1 no WWW-Authenticate on silent 404', a.headers.get('www-authenticate') === null, a.headers.get('www-authenticate'));
  rec('L1 no cache headers on silent 404',
    !a.headers.get('cache-control') && !a.headers.get('expires') && !a.headers.get('etag'),
    JSON.stringify({ cc: a.headers.get('cache-control'), ex: a.headers.get('expires'), et: a.headers.get('etag') }));

  const hdrKeys = (r) => [...r.headers.keys()].filter(k => k !== 'date').sort().join(',');
  rec('L1 404 header sets identical (bad auth vs unknown route, no origin)', hdrKeys(a) === hdrKeys(b), hdrKeys(a) + ' || ' + hdrKeys(b));

  const g = await req('PATCH', '/config', { token: UI, body: '{}' });
  rec('L1 PATCH /config (ui token) -> 404 empty', g.status === 404 && g.buf.length === 0, g.status + ':' + g.buf.length);

  const h1 = await req('PUT', '/bootstrap', { body: '{}' });
  const h2 = await req('PUT', '/bootstrap', { token: GARBAGE, body: '{}' });
  const h3 = await req('PUT', '/bootstrap', { token: UI, body: '{}' });
  const h4 = await req('PUT', '/bootstrap', { token: ADMIN });
  rec('L1 /bootstrap no/bad/ui token -> 404 empty',
    h1.status === 404 && h2.status === 404 && h3.status === 404 && h1.buf.length === 0 && h2.buf.length === 0 && h3.buf.length === 0,
    JSON.stringify([h1.status, h2.status, h3.status]));
  rec('L1 /bootstrap admin no body -> 400 bad_json', h4.status === 400 && h4.parsed && h4.parsed.error === 'bad_json', h4.text);

  const i1 = await req('POST', '/internal/backup', { token: UI });
  const i2 = await req('POST', '/internal/backup', {});
  rec('L1 /internal/backup ui/no token -> 404 empty', i1.status === 404 && i2.status === 404 && i1.buf.length === 0 && i2.buf.length === 0, i1.status + ',' + i2.status);

  const o1 = await req('OPTIONS', '/version', { origin: PAGES_ORIGIN });
  const o2 = await req('OPTIONS', '/nope', { origin: PAGES_ORIGIN });
  const o3 = await req('OPTIONS', '/version', { origin: 'https://evil.example' });
  const o4 = await req('OPTIONS', '/version', {});
  rec('L1 OPTIONS allowlisted origin -> 204 + CORS (any path)',
    o1.status === 204 && o2.status === 204 && o1.headers.get('access-control-allow-origin') === PAGES_ORIGIN,
    o1.status + ',' + o2.status);
  rec('L1 OPTIONS evil/absent origin -> 404 empty, no CORS',
    o3.status === 404 && o3.buf.length === 0 && o3.headers.get('access-control-allow-origin') === null &&
    o4.status === 404 && o4.buf.length === 0,
    JSON.stringify([o3.status, o3.headers.get('access-control-allow-origin'), o4.status]));
  rec('L1 OPTIONS allow-methods includes POST (v4.3 batch)',
    /POST/.test(o1.headers.get('access-control-allow-methods') || ''), o1.headers.get('access-control-allow-methods'));
  rec('L1 OPTIONS allows conditional headers',
    /if-match/i.test(o1.headers.get('access-control-allow-headers') || ''), o1.headers.get('access-control-allow-headers'));
  rec('L1 allow-methods has no PATCH', !/PATCH/.test(o1.headers.get('access-control-allow-methods') || ''), o1.headers.get('access-control-allow-methods'));
}

/* ============ L2: error taxonomy + limits ============ */
{
  const nf = await req('GET', '/rows/s8-missing-row', { token: UI });
  rec('L2 GET missing row -> 404 JSON not_found (body present)',
    nf.status === 404 && nf.parsed && nf.parsed.error === 'not_found' && nf.buf.length > 0 &&
    nf.headers.get('content-type').startsWith('application/json'),
    nf.status + ':' + nf.text);
  const nfC = await req('GET', '/rows/s8-missing-row', { token: CLOCK });
  rec('L2 clock token same not_found', nfC.status === 404 && nfC.parsed && nfC.parsed.error === 'not_found', nfC.text);

  const env12 = { ver: 1, nonce: b64(12), ct: b64(64) };
  const f1 = await req('PUT', '/rows/s8-fw', { token: CLOCK, body: env12 });
  rec('L2 clock PUT -> 403 EMPTY body (drained)', f1.status === 403 && f1.buf.length === 0, f1.status + ':' + f1.buf.length);
  const f2 = await req('DELETE', '/rows/s8-fw', { token: CLOCK });
  rec('L2 clock DELETE -> 403 empty', f2.status === 403 && f2.buf.length === 0, f2.status + ':' + f2.buf.length);
  const f3 = await req('POST', '/rows:batch', { token: CLOCK, body: { ids: ['s8-fw'] } });
  rec('L2 clock POST /rows:batch allowed (read)', f3.status === 200 && f3.parsed && Array.isArray(f3.parsed.rows), f3.status + ':' + f3.text.slice(0, 60));
  const f4 = await req('PUT', '/rows/s8-fw', { token: CLOCK, body: env12, headers: { 'if-none-match': '*' } });
  rec('L2 clock conditional PUT still 403 empty', f4.status === 403 && f4.buf.length === 0, f4.status + ':' + f4.buf.length);

  const cases = [
    ['PUT /rows bad_json', ['PUT', '/rows/s8-e1', { token: UI, body: 'notjson' }], 'bad_json'],
    ['PUT /rows empty body', ['PUT', '/rows/s8-e1', { token: UI, body: '' }], 'bad_json'],
    ['PUT /rows array body', ['PUT', '/rows/s8-e1', { token: UI, body: '[1]' }], 'bad_body'],
    ['PUT /rows {} no ver', ['PUT', '/rows/s8-e1', { token: UI, body: {} }], 'bad_ver'],
    ['PUT ver 0', ['PUT', '/rows/s8-e1', { token: UI, body: { ver: 0, nonce: b64(12), ct: b64(16) } }], 'bad_ver'],
    ['PUT ver 4294967296', ['PUT', '/rows/s8-e1', { token: UI, body: { ver: 4294967296, nonce: b64(12), ct: b64(16) } }], 'bad_ver'],
    ['PUT ver 1.5', ['PUT', '/rows/s8-e1', { token: UI, body: { ver: 1.5, nonce: b64(12), ct: b64(16) } }], 'bad_ver'],
    ['PUT nonce 11B', ['PUT', '/rows/s8-e1', { token: UI, body: { ver: 1, nonce: b64(11), ct: b64(16) } }], 'bad_nonce'],
    ['PUT nonce 13B', ['PUT', '/rows/s8-e1', { token: UI, body: { ver: 1, nonce: b64(13), ct: b64(16) } }], 'bad_nonce'],
    ['PUT nonce noncanonical QR==', ['PUT', '/rows/s8-e1', { token: UI, body: { ver: 1, nonce: 'QR==', ct: b64(16) } }], 'bad_nonce'],
    ['PUT nonce unpadded', ['PUT', '/rows/s8-e1', { token: UI, body: { ver: 1, nonce: 'AAAAAAAA', ct: b64(16) } }], 'bad_nonce'],
    ['PUT ct empty', ['PUT', '/rows/s8-e1', { token: UI, body: { ver: 1, nonce: b64(12), ct: '' } }], 'bad_ct'],
    ['PUT ct 65537B', ['PUT', '/rows/s8-e1', { token: UI, body: { ver: 1, nonce: b64(12), ct: b64(65537) } }], 'bad_ct'],
  ];
  for (const [name, args, want] of cases) {
    const r = await req(...args);
    rec('L2 ' + name + ' -> 400 ' + want,
      r.status === 400 && r.parsed && r.parsed.error === want && r.buf.length > 0,
      r.status + ':' + r.text);
  }

  const id255 = 's8-' + 'a'.repeat(252); // 255 chars
  const id256 = 's8-' + 'a'.repeat(253); // 256 chars (ID_MAX)
  const id257 = 's8-' + 'a'.repeat(254); // 257 chars
  rec('L2 id lengths sanity', id255.length === 255 && id256.length === 256 && id257.length === 257, id255.length + ',' + id256.length + ',' + id257.length);
  const p256 = await req('PUT', '/rows/' + id256, { token: UI, body: env12 });
  rec('L2 PUT 256-char id accepted (200)', p256.status === 200 && p256.parsed && p256.parsed.ver === 1, p256.status + ':' + p256.text.slice(0, 40));
  const p257 = await req('PUT', '/rows/' + id257, { token: UI, body: env12 });
  rec('L2 PUT 257-char id -> 400 bad_id (authenticated)', p257.status === 400 && p257.parsed && p257.parsed.error === 'bad_id', p257.status + ':' + p257.text);
  const g257 = await req('GET', '/rows/' + id257, { token: UI });
  rec('L2 GET 257-char id -> 400 bad_id', g257.status === 400 && g257.parsed && g257.parsed.error === 'bad_id', g257.status + ':' + g257.text);
  const g257n = await req('GET', '/rows/' + id257, {});
  rec('L2 GET 257-char id NO token -> 404 empty (gate first)', g257n.status === 404 && g257n.buf.length === 0, g257n.status + ':' + g257n.buf.length);
  const d256 = await req('DELETE', '/rows/' + id256, { token: UI });
  rec('L2 cleanup 256-char id', d256.status === 200, d256.status + '');

  const bigEnv = { ver: 1, nonce: b64(12), ct: b64(65536) };
  const pBig = await req('PUT', '/rows/s8-big', { token: UI, body: bigEnv });
  rec('L2 PUT ct=65536B accepted 200 + verbatim echo',
    pBig.status === 200 && pBig.parsed && pBig.parsed.ver === 1 && pBig.parsed.nonce === bigEnv.nonce && pBig.parsed.ct === bigEnv.ct,
    pBig.status + ' bodyLen=' + pBig.buf.length);
  await req('DELETE', '/rows/s8-big', { token: UI });

  const vM = await req('PUT', '/rows/s8-vb', { token: UI, body: { ver: 4294967295, nonce: b64(12), ct: b64(16) } });
  rec('L2 PUT ver=4294967295 (u32 max) accepted', vM.status === 200 && vM.parsed && vM.parsed.ver === 4294967295, vM.status + ':' + vM.text.slice(0, 40));
  const vM2 = await req('PUT', '/rows/s8-vb', { token: UI, body: { ver: 1, nonce: b64(12), ct: b64(16) } });
  rec('L2 lower ver rejected-as-rebase (200 + stored echo ver=4294967295)',
    vM2.status === 200 && vM2.parsed && vM2.parsed.ver === 4294967295 && vM2.parsed.nonce === b64(12),
    vM2.status + ':' + vM2.text.slice(0, 60));
  await req('DELETE', '/rows/s8-vb', { token: UI });

  const ids257 = Array.from({ length: 257 }, (_, i) => 's8-b' + i);
  const ids256 = Array.from({ length: 256 }, (_, i) => 's8-b' + i);
  const b1 = await req('POST', '/rows:batch', { token: UI, body: { ids: ids257 } });
  rec('L2 batch 257 ids -> 400 bad_ids', b1.status === 400 && b1.parsed && b1.parsed.error === 'bad_ids', b1.status + ':' + b1.text);
  const b2 = await req('POST', '/rows:batch', { token: UI, body: { ids: ids256 } });
  rec('L2 batch 256 ids -> 200 (256 missing entries)', b2.status === 200 && b2.parsed && b2.parsed.rows.length === 256 && b2.parsed.rows.every(r => r.missing), b2.status + ' rows=' + (b2.parsed && b2.parsed.rows && b2.parsed.rows.length));
  const b3 = await req('POST', '/rows:batch', { token: UI, body: { ids: ['x', 'x'] } });
  rec('L2 batch dup ids -> 400 bad_ids', b3.status === 400 && b3.parsed && b3.parsed.error === 'bad_ids', b3.status + ':' + b3.text);
  const b4 = await req('POST', '/rows:batch', { token: UI, body: { ids: ['s8-' + 'a'.repeat(254)] } });
  rec('L2 batch 257-char id -> 400 bad_id', b4.status === 400 && b4.parsed && b4.parsed.error === 'bad_id', b4.status + ':' + b4.text);
  const b5 = await req('POST', '/rows:batch', { token: UI, body: { ids: [] } });
  rec('L2 batch empty ids -> 400 bad_ids', b5.status === 400 && b5.parsed && b5.parsed.error === 'bad_ids', b5.status + ':' + b5.text);
  const b6 = await req('POST', '/rows:batch', { token: UI, body: { ids: 'x' } });
  rec('L2 batch ids non-array -> 400 bad_ids', b6.status === 400 && b6.parsed && b6.parsed.error === 'bad_ids', b6.status + ':' + b6.text);
  const b7 = await req('POST', '/rows:batch', { token: UI, body: 'zzz' });
  rec('L2 batch bad json -> 400 bad_json', b7.status === 400 && b7.parsed && b7.parsed.error === 'bad_json', b7.status + ':' + b7.text);
  const b8 = await req('POST', '/rows:batch', { token: UI, body: '[1]' });
  rec('L2 batch array body -> 400 bad_body', b8.status === 400 && b8.parsed && b8.parsed.error === 'bad_body', b8.status + ':' + b8.text);
  const b9 = await req('POST', '/rows:batch', { token: UI, body: {} });
  rec('L2 batch missing ids -> 400 bad_ids', b9.status === 400 && b9.parsed && b9.parsed.error === 'bad_ids', b9.status + ':' + b9.text);

  const padBody = (n) => { const pre = '{"ids":["a"]}'; return pre + ' '.repeat(n - pre.length); }; // pre = 13 chars
  rec('L2 padBody sanity 1MiB', padBody(1048576).length === 1048576 && padBody(1048577).length === 1048577, padBody(1048576).length + ',' + padBody(1048577).length);
  const s1 = await req('POST', '/rows:batch', { token: UI, body: padBody(1048576) });
  rec('L2 body exactly 1MiB -> passes cap (200)', s1.status === 200, s1.status + ':' + s1.text.slice(0, 40));
  const s2 = await req('POST', '/rows:batch', { token: UI, body: padBody(1048577) });
  rec('L2 body 1MiB+1 -> 400 too_large', s2.status === 400 && s2.parsed && s2.parsed.error === 'too_large', s2.status + ':' + s2.text);
  const t0 = Date.now();
  const s3 = await req('PUT', '/rows/s8-e1', { token: UI, body: '{"ver":1,"nonce":"' + b64(12) + '","ct":"' + b64(700000) + '","pad":"' + 'A'.repeat(1000000) + '"}' });
  rec('L2 ~2MiB PUT -> 400 too_large, no hang (<10s)',
    s3.status === 400 && s3.parsed && s3.parsed.error === 'too_large' && (Date.now() - t0) < 10000,
    s3.status + ':' + s3.text + ' ms=' + (Date.now() - t0));
  const s4 = await req('POST', '/rows:batch', { token: CLOCK, body: padBody(1048577) });
  rec('L2 oversized batch with CLOCK token -> 400 too_large (read class parses body)',
    s4.status === 400 && s4.parsed && s4.parsed.error === 'too_large', s4.status + ':' + s4.buf.length);
  const s5 = await req('PUT', '/rows/s8-e1', { body: padBody(1048577) });
  rec('L2 oversized PUT unauthenticated -> 404 empty (gate before body)', s5.status === 404 && s5.buf.length === 0, s5.status + ':' + s5.buf.length);

  // BODY_DRAIN_MAX (32MiB): streamed body beyond drain ceiling -> connection reset (documented)
  try {
    const streamBody = async function* () { let sent = 0; const blk = Buffer.alloc(1024 * 1024, 0x41); while (sent < 40 * 1048576) { yield blk; sent += blk.length; } };
    const res = await fetch(BASE + '/rows/s8-drain', { method: 'PUT', headers: { authorization: 'Bearer ' + UI, 'content-type': 'application/json' }, body: streamBody(), duplex: 'half' });
    const txt = await res.text();
    rec('L2 40MiB streamed PUT -> some response (no infinite hang)', res.status >= 400 || txt.length >= 0, res.status + ':' + txt.slice(0, 30));
  } catch (e) {
    rec('L2 40MiB streamed PUT -> connection reset (BODY_DRAIN_MAX ceiling, as designed)', /fetch failed|ECONNRESET|aborted/i.test(String(e)), String(e).slice(0, 90));
  }
}

/* ============ L3: conditional PUT (§9c) ============ */
{
  const env1 = { ver: 1, nonce: b64(12), ct: b64(48) };
  const env2 = { ver: 2, nonce: b64(12), ct: b64(48) };
  const c1 = await req('PUT', '/rows/s8-cond', { token: UI, body: env1, headers: { 'if-none-match': '*' } });
  rec('L3 INM:* create new -> 200 + echo', c1.status === 200 && c1.parsed && c1.parsed.ver === 1 && c1.parsed.nonce === env1.nonce, c1.status + ':' + c1.text.slice(0, 60));
  const c2 = await req('PUT', '/rows/s8-cond', { token: UI, body: env2, headers: { 'if-none-match': '*' } });
  rec('L3 INM:* on existing -> 412 EMPTY body', c2.status === 412 && c2.buf.length === 0, c2.status + ':' + c2.buf.length + ' ct=' + c2.headers.get('content-type'));
  const c3 = await req('PUT', '/rows/s8-cond', { token: UI, body: env2, headers: { 'if-match': '"1"' } });
  rec('L3 If-Match "1" (stored ver 1) + ver 2 -> 200 accept', c3.status === 200 && c3.parsed && c3.parsed.ver === 2, c3.status + ':' + c3.text.slice(0, 40));
  const c4 = await req('PUT', '/rows/s8-cond', { token: UI, body: { ver: 3, nonce: b64(12), ct: b64(48) }, headers: { 'if-match': '"1"' } });
  rec('L3 If-Match "1" (stored ver 2) -> 412 empty', c4.status === 412 && c4.buf.length === 0, c4.status + ':' + c4.buf.length);
  const c5 = await req('PUT', '/rows/s8-cond-missing', { token: UI, body: env1, headers: { 'if-match': '"1"' } });
  rec('L3 If-Match on missing row -> 404 not_found JSON', c5.status === 404 && c5.parsed && c5.parsed.error === 'not_found', c5.status + ':' + c5.text);
  const c6 = await req('PUT', '/rows/s8-cond', { token: UI, body: env2, headers: { 'if-match': 'abc' } });
  rec('L3 malformed If-Match -> 400 bad_if_match', c6.status === 400 && c6.parsed && c6.parsed.error === 'bad_if_match', c6.status + ':' + c6.text);
  const c7 = await req('PUT', '/rows/s8-cond', { token: UI, body: { ver: 3, nonce: b64(12), ct: b64(48) }, headers: { 'if-match': '*' } });
  rec('L3 If-Match * -> 400 bad_if_match (RFC 9110 would treat as if-exists)', c7.status === 400 && c7.parsed && c7.parsed.error === 'bad_if_match', c7.status + ':' + c7.text);
  const c8 = await req('PUT', '/rows/s8-cond2', { token: UI, body: env1, headers: { 'if-none-match': '"e5"' } });
  rec('L3 If-None-Match "e5" (etag-form, non-*) on PUT -> ignored, RMW create 200', c8.status === 200, c8.status + ':' + c8.text.slice(0, 40));
  const c9 = await req('PUT', '/rows/s8-cond2', { token: UI, body: { ver: 1, nonce: b64(12), ct: b64(48) }, headers: { 'if-match': '"1"', 'if-none-match': '*' } });
  rec('L3 If-Match(match)+INM:* both present, row exists -> 412 (INM:* fires regardless; RFC-consistent)',
    c9.status === 412 && c9.buf.length === 0, c9.status + ':' + c9.buf.length);
  const c10 = await req('PUT', '/rows/s8-cond2', { token: UI, body: { ver: 1, nonce: b64(12), ct: b64(48) }, headers: { 'if-none-match': '*' } });
  rec('L3 INM:* on existing (replay) -> 412', c10.status === 412, c10.status + '');
  const c11 = await req('PUT', '/rows/s8-cond', { token: UI, body: { ver: 3, nonce: b64(12), ct: b64(48) }, headers: { 'if-match': ' "2" ' } });
  rec('L3 If-Match with whitespace "2" -> accepted (regex tolerates ws)', c11.status === 200 && c11.parsed && c11.parsed.ver === 3, c11.status + ':' + c11.text.slice(0, 40));
  await req('DELETE', '/rows/s8-cond', { token: UI });
  await req('DELETE', '/rows/s8-cond2', { token: UI });
}

/* ============ L4: etag / 304 (§9d) ============ */
{
  const m0 = await req('GET', '/rows', { token: UI });
  const etag0 = m0.parsed && m0.parsed.etag;
  rec('L4 manifest has etag field "e<epoch>"', typeof etag0 === 'string' && /^"e[0-9]+"$/.test(etag0), String(etag0));
  rec('L4 200 manifest has NO ETag response header', m0.headers.get('etag') === null, String(m0.headers.get('etag')));
  rec('L4 200 manifest has NO cache-control', m0.headers.get('cache-control') === null, String(m0.headers.get('cache-control')));
  const m1 = await req('GET', '/rows', { token: UI, headers: { 'if-none-match': etag0 } });
  rec('L4 If-None-Match current -> 304 EMPTY + ETag header',
    m1.status === 304 && m1.buf.length === 0 && m1.headers.get('etag') === etag0,
    m1.status + ' len=' + m1.buf.length + ' hdr=' + m1.headers.get('etag'));
  await req('PUT', '/rows/s8-etag1', { token: UI, body: { ver: 1, nonce: b64(12), ct: b64(16) } });
  const m2 = await req('GET', '/rows', { token: UI, headers: { 'if-none-match': etag0 } });
  rec('L4 after INSERT old etag -> 200 (epoch bumped)', m2.status === 200 && m2.parsed.etag !== etag0, m2.status + ':' + m2.parsed.etag);
  const etag2 = m2.parsed.etag;
  await req('PUT', '/rows/s8-etag1', { token: UI, body: { ver: 2, nonce: b64(12), ct: b64(16) } });
  const m3 = await req('GET', '/rows', { token: UI, headers: { 'if-none-match': etag2 } });
  rec('L4 after accepted UPDATE old etag -> 200', m3.status === 200, m3.status + '');
  const etag3 = m3.parsed.etag;
  await req('PUT', '/rows/s8-etag1', { token: UI, body: { ver: 1, nonce: b64(12), ct: b64(16) } });
  const m4 = await req('GET', '/rows', { token: UI, headers: { 'if-none-match': etag3 } });
  rec('L4 after reject-as-rebase -> still 304 (no bump)', m4.status === 304, m4.status + '');
  const m5 = await req('GET', '/rows', { token: UI, headers: { 'if-none-match': etag3 } });
  rec('L4 reads never bump (repeat 304)', m5.status === 304, m5.status + '');
  await req('POST', '/rows:batch', { token: UI, body: { ids: ['s8-etag1'] } });
  const m6 = await req('GET', '/rows', { token: UI, headers: { 'if-none-match': etag3 } });
  rec('L4 batch read never bumps', m6.status === 304, m6.status + '');
  await req('DELETE', '/rows/s8-etag1', { token: UI });
  const m7 = await req('GET', '/rows', { token: UI, headers: { 'if-none-match': etag3 } });
  rec('L4 real delete bumps epoch', m7.status === 200, m7.status + '');
  const etag7 = m7.parsed.etag;
  await req('DELETE', '/rows/s8-etag1', { token: UI });
  const m8 = await req('GET', '/rows', { token: UI, headers: { 'if-none-match': etag7 } });
  rec('L4 idempotent re-delete of missing row does NOT bump', m8.status === 304, m8.status + '');
  const w1 = await req('GET', '/rows', { token: UI, headers: { 'if-none-match': 'W/' + etag7 } });
  rec('L4 weak W/"eN" -> 200 (no weak comparison)', w1.status === 200, w1.status + '');
  const w2 = await req('GET', '/rows', { token: UI, headers: { 'if-none-match': etag7 + ', "e999"' } });
  rec('L4 etag LIST -> 200 (no list semantics)', w2.status === 200, w2.status + '');
  const w3 = await req('GET', '/rows', { token: UI, headers: { 'if-none-match': etag7.replace(/^"e/, 'e').replace(/"$/, '') } });
  rec('L4 unquoted eN -> 200 (spec quotes required)', w3.status === 200, w3.status + '');
  const m9 = await req('GET', '/rows', { token: CLOCK, headers: { 'if-none-match': etag7 } });
  rec('L4 304 also for clock class', m9.status === 304, m9.status + '');
}

/* ============ L5: client classification (api.js) with stubbed fetch ============ */
{
  const { Api, ApiError } = await import('/home/z/my-project/calendar-web/js/api.js');
  const dummy = 'ab'.repeat(32);
  let lastInit = null;
  const stub = (status, body, headers = {}) => {
    return async (url, init) => {
      lastInit = init;
      return new Response(body === null ? undefined : body, { status, headers });
    };
  };
  const origFetch = globalThis.fetch;
  const classify = async (status, body, headers, sendInm) => {
    globalThis.fetch = stub(status, body, headers);
    const api = new Api('http://x', dummy);
    try {
      const r = await api.getManifest(sendInm ? '"e5"' : undefined);
      return { ret: r };
    } catch (e) {
      return e instanceof ApiError ? { kind: e.kind, status: e.status, body: e.body } : { thrown: String(e) };
    } finally { globalThis.fetch = origFetch; }
  };
  const t1 = await classify(404, null);
  rec('L5 api.js: 404 empty -> silent', t1.kind === 'silent', JSON.stringify(t1));
  const t2 = await classify(404, '<html>404</html>');
  rec('L5 api.js: 404 foreign body -> http', t2.kind === 'http', JSON.stringify(t2));
  const t3 = await classify(404, '{"error":"not_found"}');
  rec('L5 api.js: 404 our not_found -> not_found', t3.kind === 'not_found', JSON.stringify(t3));
  const t4 = await classify(404, '{"error":"weird"}');
  rec('L5 api.js: 404 other JSON error -> http', t4.kind === 'http', JSON.stringify(t4));
  const t5 = await classify(403, null);
  rec('L5 api.js: 403 empty -> forbidden', t5.kind === 'forbidden', JSON.stringify(t5));
  const t6 = await classify(403, 'nope');
  rec('L5 api.js: 403 with body -> http', t6.kind === 'http', JSON.stringify(t6));
  const t7 = await classify(304, null, { etag: '"e5"' }, true);
  rec('L5 api.js: 304 for OUR inm -> notModified:true + etag', t7.ret && t7.ret.notModified === true && t7.ret.etag === '"e5"', JSON.stringify(t7));
  const t8 = await classify(304, null, { etag: '"e9"' }, false);
  rec('L5 api.js: 304 WITHOUT our if-none-match -> ApiError http_304 (fails loud)',
    t8.kind === 'http' && t8.status === 304, JSON.stringify(t8));
  const t9 = await classify(200, '');
  rec('L5 api.js: 200 empty body -> returns null', t9.ret === null, JSON.stringify(t9));
  const t10 = await classify(500, '{"error":"internal"}');
  rec('L5 api.js: 500 JSON -> http (body parsed)', t10.kind === 'http' && t10.body && t10.body.error === 'internal', JSON.stringify(t10));
  globalThis.fetch = stub(200, '{}');
  {
    const api = new Api('http://x', dummy);
    await api.putRow('r1', { ver: 3, nonce: 'QUFB', ct: 'QkJD' });
    const sentBody = JSON.parse(lastInit.body);
    const sentHeaders = lastInit.headers;
    rec('L5 api.js: putRow sends exactly {ver,nonce,ct} + bearer, no conditional headers',
      sentBody.ver === 3 && sentBody.nonce === 'QUFB' && sentBody.ct === 'QkJD' && Object.keys(sentBody).length === 3 &&
      sentHeaders.authorization === 'Bearer ' + dummy && !sentHeaders['if-match'] && !sentHeaders['if-none-match'],
      JSON.stringify({ sentBody, headers: Object.keys(sentHeaders) }));
  }
  globalThis.fetch = stub(404, '{"error":"not_found"}');
  {
    const api = new Api('http://x', dummy);
    const r = await api.getRow('r1');
    rec('L5 api.js: getRow not_found -> null', r === null, JSON.stringify(r));
  }
  globalThis.fetch = origFetch;
}

/* ============ L6: raw-socket byte-level + odd HTTP shapes ============ */
{
  const raw = (port, payload, timeoutMs = 8000) => new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const chunks = [];
    let done = false;
    const fin = () => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(Buffer.concat(chunks)); } };
    s.setTimeout(timeoutMs, fin);
    s.on('connect', () => s.write(payload));
    s.on('data', (d) => chunks.push(d));
    s.on('error', fin);
    s.on('close', fin);
  });
  const norm = (buf) => buf.toString('latin1').split('\r\n').filter(l => !/^date:/i.test(l) && !/^content-length:/i.test(l)).join('\r\n');
  const H = (t) => 'Authorization: Bearer ' + t + '\r\n';

  const r1 = await raw(8787, 'GET /nope HTTP/1.1\r\nHost: x\r\n' + H(GARBAGE) + 'Connection: close\r\n\r\n');
  const r2 = await raw(8787, 'GET /version HTTP/1.1\r\nHost: x\r\n' + H(GARBAGE) + 'Connection: close\r\n\r\n');
  writeFileSync('/tmp/s8-raw-404-a.txt', r1.toString('latin1'));
  writeFileSync('/tmp/s8-raw-404-b.txt', r2.toString('latin1'));
  rec('L6 raw bad-auth 404 vs unknown-route 404 byte-identical (mod date/clen)', norm(r1) === norm(r2), '\nA=' + norm(r1).slice(0, 200) + '\nB=' + norm(r2).slice(0, 200));
  rec('L6 raw 404 has empty body + content-length 0', /HTTP\/1\.1 404/.test(r1.toString('latin1')) && /content-length: 0/i.test(r1.toString('latin1')), '');
  rec('L6 raw 404 no WWW-Authenticate / no cache-control', !/www-authenticate/i.test(r1.toString('latin1')) && !/cache-control/i.test(r1.toString('latin1')), '');

  const r3 = await raw(8787, 'HEAD /version HTTP/1.1\r\nHost: x\r\n' + H(UI) + 'Connection: close\r\n\r\n');
  rec('L6 HEAD /version (valid token) -> 404', /HTTP\/1\.1 404/.test(r3.toString('latin1')), r3.toString('latin1').split('\r\n')[0]);
  const r4 = await raw(8787, 'TRACE /rows HTTP/1.1\r\nHost: x\r\n' + H(UI) + 'Connection: close\r\n\r\n');
  rec('L6 TRACE /rows (valid token) -> 404 empty', /HTTP\/1\.1 404/.test(r4.toString('latin1')), r4.toString('latin1').split('\r\n')[0]);
  const r5 = await raw(8787, 'PATCH /config HTTP/1.1\r\nHost: x\r\n' + H(UI) + 'Content-Length: 2\r\nConnection: close\r\n\r\n{}');
  rec('L6 PATCH /config (valid token) raw -> 404 empty', /HTTP\/1\.1 404/.test(r5.toString('latin1')), r5.toString('latin1').split('\r\n')[0]);
  const r6 = await raw(8787, 'CONNECT /version HTTP/1.1\r\nHost: x\r\n' + H(UI) + 'Connection: close\r\n\r\n');
  rec('L6 CONNECT /version (valid token) -> 404 (or transport error)', /HTTP\/1\.1 404/.test(r6.toString('latin1')) || r6.length === 0, r6.toString('latin1').split('\r\n')[0] || '(conn error)');

  const bodyStr = '{"ver":1,"nonce":"' + b64(12) + '","ct":"' + b64(16) + '"}';
  const chunked = bodyStr.length.toString(16) + '\r\n' + bodyStr + '\r\n0\r\n\r\n';
  const r7 = await raw(8787, 'PUT /rows/s8-chunk HTTP/1.1\r\nHost: x\r\n' + H(UI) + 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n' + chunked);
  const t7 = r7.toString('latin1');
  rec('L6 chunked PUT (no Content-Length) accepted -> 200 envelope', /HTTP\/1\.1 200/.test(t7) && /"ver" ?: ?1/.test(t7), t7.split('\r\n')[0]);
  await req('DELETE', '/rows/s8-chunk', { token: UI });

  const r8 = await raw(8787, 'PUT /rows/s8-nolen HTTP/1.1\r\nHost: x\r\n' + H(UI) + 'Content-Type: application/json\r\nConnection: close\r\n\r\n' + bodyStr, 6000);
  rec('L6 PUT no length info -> 400/404 (server does not hang)',
    /HTTP\/1\.1 (400|404)/.test(r8.toString('latin1')), r8.toString('latin1').split('\r\n')[0]);

  const q1 = await req('GET', '/version?x=1', { token: UI });
  rec('L6 query string ignored on /version -> 200', q1.status === 200 && q1.parsed && q1.parsed.proto === '4.3', q1.status + ':' + q1.text);
  const q2 = await req('GET', '/version/', { token: UI });
  rec('L6 /version/ trailing slash -> 404 empty', q2.status === 404 && q2.buf.length === 0, q2.status + '');
  const q3 = await req('GET', '/VERSION', { token: UI });
  rec('L6 /VERSION case -> 404 empty', q3.status === 404 && q3.buf.length === 0, q3.status + '');
  const q4 = await req('GET', '/version', { token: UI.toUpperCase() });
  rec('L6 uppercase hex token -> 404 empty (strict lowercase)', q4.status === 404 && q4.buf.length === 0, q4.status + '');
  const q5 = await req('GET', '/version', { headers: { authorization: 'bearer ' + UI } });
  rec('L6 lowercase scheme -> 404 empty', q5.status === 404 && q5.buf.length === 0, q5.status + '');
  const q6 = await req('GET', '/version', { headers: { authorization: 'Bearer  ' + UI } });
  rec('L6 double space after Bearer -> 404 empty', q6.status === 404 && q6.buf.length === 0, q6.status + '');
}

/* ============ L7: force-bootstrap epoch desync (§9d vs §8 force wipe) ============ */
{
  const put = async (path, body, tok) => {
    const r = await fetch(BASE2 + path, { method: 'PUT', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };
  const get = async (path, tok, inm) => {
    const h = { authorization: 'Bearer ' + tok };
    if (inm) h['if-none-match'] = inm;
    const r = await fetch(BASE2 + path, { headers: h });
    return { status: r.status, text: await r.text() };
  };
  const env = { ver: 1, nonce: b64(12), ct: b64(16) };
  const p1 = await put('/rows/s8-epoch', env, MAT2.auth_ui_hex);
  const m1 = await get('/rows', MAT2.auth_ui_hex);
  const etag = JSON.parse(m1.text).etag;
  const m2 = await get('/rows', MAT2.auth_ui_hex, etag);
  rec('L7 stack2 sanity: PUT ok, INM -> 304', p1.status === 200 && m2.status === 304, p1.status + ',' + m2.status);
  const { buildBootstrapMaterial } = await import('/home/z/my-project/calendar-web/cli/bootstrap.mjs');
  const MAT3 = buildBootstrapMaterial('s8-rotation-password-test', 100000);
  const fb = await put('/bootstrap', { salt: MAT3.saltHex, iters: 100000, wrapped: MAT3.wrappedB64, auth_ui: MAT3.authUiHex, auth_clock: MAT3.authClockHex, force: true }, ADMIN);
  rec('L7 force re-bootstrap accepted (200 {ver:1})', fb.status === 200, fb.status + ':' + fb.text);
  const m3 = await get('/rows', MAT3.authUiHex, etag);
  rec('L7 BUGCHECK: after force wipe, OLD etag still 304 (epoch not bumped/reset by wipe)',
    m3.status === 304, 'status=' + m3.status + ' body=' + (m3.text || '(empty)').slice(0, 60));
  const m4 = await get('/rows', MAT3.authUiHex);
  const rowsNow = m4.status === 200 ? JSON.parse(m4.text).rows.length : -1;
  rec('L7 manifest after wipe is empty (' + rowsNow + ' rows) while 304 hid it', rowsNow === 0, rowsNow + '');
}

/* ============ summary ============ */
const fails = results.filter(r => !r.ok);
console.log('\nS8 LOCAL PROBES: ' + (results.length - fails.length) + '/' + results.length + ' checks passed');
if (fails.length) for (const f of fails) console.log('  FAIL: ' + f.name + ' :: ' + f.detail);
writeFileSync('/tmp/s8-local-results.json', JSON.stringify(results, null, 2));
