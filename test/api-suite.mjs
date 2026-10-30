#!/usr/bin/env node
/**
 * api-suite.mjs — FULL HTTP conformance matrix for the calendar PoC server
 * (protocol v4.1). This is NOT a smoke test: every route, every §5 error
 * shape, the §4 silent-drop law, §9 RMW arbitration, §6 AAD binding, §13
 * dual-writer ownership merge, §8 bootstrap/rewrap (Type A rotation), CORS
 * (WORKLOG D6), and §19 backup are exercised.
 *
 * Usage:  node test/api-suite.mjs [--url http://127.0.0.1:8787]
 * Env:    ADMIN_SECRET, INTERNAL_TOKEN (hex64) — required.
 * NOTE:   DESTRUCTIVE — force-bootstraps the target with fresh test material.
 */
import {
  buildBootstrapMaterial,
  buildRewrapMaterial,
  deriveClientKeys,
  encryptRow,
  decryptRow,
  rowAad,
} from '../cli/bootstrap.mjs';
import { capEvents } from '../js/calendar-core.js';
import { randomBytes, randomUUID } from 'node:crypto';

/* ---------------- config ---------------- */

let BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
let MATERIAL_OUT = null;
{
  const i = process.argv.indexOf('--url');
  if (i !== -1 && process.argv[i + 1]) BASE = process.argv[i + 1];
  const m = process.argv.indexOf('--material-out');
  if (m !== -1 && process.argv[m + 1]) MATERIAL_OUT = process.argv[m + 1];
}
BASE = BASE.replace(/\/+$/, '');
const ADMIN = process.env.ADMIN_SECRET;
const INTERNAL = process.env.INTERNAL_TOKEN;
if (!ADMIN || !INTERNAL) {
  console.error('FATAL: ADMIN_SECRET and INTERNAL_TOKEN env vars are required');
  process.exit(2);
}

const PAGES_ORIGIN = 'https://sh-clock.github.io';
const EVIL_ORIGIN = 'https://evil.example';
const PW = 'password'; // user-designated test password

let pass = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ok  ' + name);
  } else {
    fails.push(name + (detail !== undefined ? ' — ' + String(detail) : ''));
    console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + String(detail) : ''));
  }
}
function jparse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
async function raw(method, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.token !== undefined) {
    headers.authorization =
      typeof opts.token === 'string' && opts.token.startsWith('Bearer ')
        ? opts.token
        : 'Bearer ' + opts.token;
  }
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.body !== undefined || opts.rawBody !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body:
      opts.rawBody !== undefined
        ? opts.rawBody
        : opts.body !== undefined
          ? JSON.stringify(opts.body)
          : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}
async function silentShape(method, path, opts) {
  const r = await raw(method, path, opts);
  return {
    status: r.status,
    body: r.text,
    wwwAuth: r.headers.get('www-authenticate'),
    ct: r.headers.get('content-type'),
    cacheControl: r.headers.get('cache-control'),
    etag: r.headers.get('etag'),
    expires: r.headers.get('expires'),
    lastMod: r.headers.get('last-modified'),
  };
}

/* ---------------- material ---------------- */

const MAT = buildBootstrapMaterial(PW); // primary test universe
const MAT2 = buildBootstrapMaterial(PW + '-rotated'); // for Type A rewrap test
const UNKNOWN_TOKEN = 'f'.repeat(64);
const b64 = (b) => Buffer.from(b).toString('base64');
const hx = (b) => Buffer.from(b).toString('hex');

/* ================================================================ */
console.log('PHASE B — bootstrap (§8)');
/* ================================================================ */

{
  const r = await raw('PUT', '/bootstrap', {
    token: 'Bearer ' + ADMIN,
    body: { salt: 'zz', iters: 1, wrapped: 'AAAA', auth_ui: 'x', auth_clock: 'y' },
  });
  check('b4 bad salt -> 400 bad_salt', r.status === 400 && jparse(r.text)?.error === 'bad_salt', r.text);
}
{
  const r = await raw('PUT', '/bootstrap', {
    token: ADMIN,
    body: {
      salt: MAT.saltHex, iters: 999, wrapped: MAT.wrappedB64,
      auth_ui: MAT.authUiHex, auth_clock: MAT.authClockHex,
    },
  });
  check('b5 bad iters -> 400 bad_iters', r.status === 400 && jparse(r.text)?.error === 'bad_iters', r.text);
}
{
  const wrapped48 = b64(randomBytes(48));
  const r = await raw('PUT', '/bootstrap', {
    token: ADMIN,
    body: {
      salt: MAT.saltHex, iters: 100000, wrapped: wrapped48,
      auth_ui: MAT.authUiHex, auth_clock: MAT.authClockHex,
    },
  });
  check('b6 wrapped 48B -> 400 bad_wrapped (D2: 60B required)', r.status === 400 && jparse(r.text)?.error === 'bad_wrapped', r.text);
}
{
  const r = await raw('PUT', '/bootstrap', {
    token: ADMIN,
    body: {
      salt: MAT.saltHex, iters: 100000, wrapped: MAT.wrappedB64,
      auth_ui: MAT.authUiHex.toUpperCase(), auth_clock: MAT.authClockHex,
    },
  });
  check('b7 uppercase auth_ui -> 400', r.status === 400, r.text);
}
{
  const r = await raw('PUT', '/bootstrap', { token: ADMIN, rawBody: '' });
  const r2 = await raw('PUT', '/bootstrap', { token: ADMIN, rawBody: '{not json' });
  const r3 = await raw('PUT', '/bootstrap', { token: ADMIN, rawBody: '"str"' });
  const r4 = await raw('PUT', '/bootstrap', { token: ADMIN, rawBody: '[1]' });
  check(
    'b8 empty / bad-json / non-object body -> 400 (bad_json / bad_body)',
    r.status === 400 &&
      jparse(r.text)?.error === 'bad_json' &&
      r2.status === 400 &&
      jparse(r2.text)?.error === 'bad_json' &&
      r3.status === 400 &&
      jparse(r3.text)?.error === 'bad_body' &&
      r4.status === 400 &&
      jparse(r4.text)?.error === 'bad_body',
    JSON.stringify([r.text, r2.text, r3.text, r4.text])
  );
}

{
  const r = await raw('PUT', '/bootstrap', {
    token: ADMIN,
    body: {
      salt: MAT.saltHex, iters: 100000, wrapped: MAT.wrappedB64,
      auth_ui: MAT.authUiHex, auth_clock: MAT.authClockHex, force: true,
    },
  });
  check('b1 force bootstrap -> 200 {ver:1}', r.status === 200 && jparse(r.text)?.ver === 1, r.text);
}
{
  const r = await raw('PUT', '/bootstrap', {
    token: ADMIN,
    body: {
      salt: MAT.saltHex, iters: 100000, wrapped: MAT.wrappedB64,
      auth_ui: MAT.authUiHex, auth_clock: MAT.authClockHex,
    },
  });
  check('b2 re-bootstrap w/o force -> 409 exists', r.status === 409 && jparse(r.text)?.error === 'exists', r.text);
}

/* ================================================================ */
console.log('PHASE S — silent drop (§4) + uniformity');
/* ================================================================ */

const shapes = [];
{
  const s = await silentShape('GET', '/rows', {});
  shapes.push(['no token', s]);
  check(
    's1 no token -> 404 empty, no WWW-Authenticate, no cache headers',
    s.status === 404 &&
      s.body === '' &&
      s.wwwAuth === null &&
      s.cacheControl === null &&
      s.etag === null &&
      s.expires === null &&
      s.lastMod === null
  );
}
{
  const s = await silentShape('GET', '/rows', { token: 'Bearer not-hex-at-all' });
  shapes.push(['bad hex token', s]);
  check('s2 malformed bearer -> silent 404', s.status === 404 && s.body === '');
}
{
  const s = await silentShape('GET', '/rows', { token: UNKNOWN_TOKEN });
  shapes.push(['unknown token', s]);
  check('s3 unknown token -> silent 404', s.status === 404 && s.body === '');
}
{
  const s = await silentShape('GET', '/nope', { token: MAT.authUiHex });
  shapes.push(['unknown route', s]);
  check('s4 unknown route + valid token -> silent 404', s.status === 404 && s.body === '');
}
{
  const s = await silentShape('PUT', '/bootstrap', { token: UNKNOWN_TOKEN, body: {} });
  shapes.push(['wrong admin secret', s]);
  check('s5 wrong ADMIN_SECRET on /bootstrap -> silent 404', s.status === 404 && s.body === '');
}
{
  const s = await silentShape('GET', '/config', {});
  shapes.push(['no token on /config', s]);
  check('s6 GET /config unauthenticated -> silent 404', s.status === 404 && s.body === '');
}
{
  const s = await silentShape('GET', '/rows', { token: MAT.authUiHex.toUpperCase() });
  shapes.push(['uppercase token', s]);
  check('s7 uppercase hex token -> silent 404', s.status === 404 && s.body === '');
}
{
  const s = await silentShape('GET', '/rows', { token: ADMIN });
  shapes.push(['admin token on app route', s]);
  check('s9 ADMIN token on GET /rows -> silent 404 (not an app bearer)', s.status === 404 && s.body === '');
}
{
  const r = await raw('POST', '/rows', { token: MAT.authUiHex });
  check('s8 POST /rows (unknown route-method) -> silent 404', r.status === 404 && r.text === '');
}
{
  const r = await raw('PUT', '/bootstrap', { token: MAT.authUiHex, body: {} });
  check('s10 app token on /bootstrap ("wrong-secret") -> silent 404', r.status === 404 && r.text === '');
}
{
  const r = await raw('GET', '/rows', { headers: { authorization: 'bearer ' + MAT.authUiHex } });
  check('s12 lowercase "bearer" scheme -> silent 404 (strict scheme)', r.status === 404 && r.text === '');
}
{
  const ref = shapes[0][1];
  const uniform = shapes.every(([, s]) => JSON.stringify(s) === JSON.stringify(ref));
  check('s11 silent-drop uniformity across all gates', uniform, JSON.stringify(shapes.map(([n, s]) => [n, s])));
}

/* ================================================================ */
console.log('PHASE S2 — token-class × route matrix (WORKLOG D15)');
/* ================================================================ */

{
  const cases = [
    // [name, method, path, token, body, expectStatus, expectBody]
    ['ADMIN on PUT row', 'PUT', '/rows/cal:20990401', ADMIN, { ver: 1, nonce: b64(randomBytes(12)), ct: b64(randomBytes(64)) }, 404, ''],
    ['ADMIN on DELETE row', 'DELETE', '/rows/cal:20990401', ADMIN, undefined, 404, ''],
    ['ADMIN on GET /rows', 'GET', '/rows', ADMIN, undefined, 404, ''],
    ['INTERNAL on GET /rows', 'GET', '/rows', INTERNAL, undefined, 404, ''],
    ['INTERNAL on PUT row', 'PUT', '/rows/cal:20990401', INTERNAL, { ver: 1, nonce: b64(randomBytes(12)), ct: b64(randomBytes(64)) }, 404, ''],
    ['INTERNAL on /bootstrap', 'PUT', '/bootstrap', INTERNAL, {}, 404, ''],
    ['no token /version', 'GET', '/version', undefined, undefined, 404, ''],
    ['no token /status', 'GET', '/status', undefined, undefined, 404, ''],
    ['no token /rows/{id}', 'GET', '/rows/cal:20261105', undefined, undefined, 404, ''],
    ['no token DELETE row', 'DELETE', '/rows/cal:20261105', undefined, undefined, 404, ''],
  ];
  let all = true;
  const details = [];
  for (const [name, method, path, token, body, st, bd] of cases) {
    const r = await raw(method, path, { token, body });
    const ok = r.status === st && r.text === bd && r.headers.get('www-authenticate') === null;
    if (!ok) {
      all = false;
      details.push(`${name}: ${r.status}/${JSON.stringify(r.text)}`);
    }
  }
  check('s2 class matrix (10 cases) all silent-404', all, details.join(' | '));
}

/* ================================================================ */
console.log('PHASE C — config + rewrap (§8, §20 Type A)');
/* ================================================================ */

let CFG;
{
  const r = await raw('GET', '/config', { token: MAT.authUiHex });
  CFG = jparse(r.text);
  check(
    'c1 GET /config (UI) -> clear params only',
    r.status === 200 && CFG && CFG.salt === MAT.saltHex && CFG.iters === 100000 &&
      CFG.wrapped === MAT.wrappedB64 && CFG.ver === 1 && !('auth_ui' in CFG) && !('auth_clock' in CFG),
    r.text
  );
}
{
  const r = await raw('GET', '/config', { token: MAT.authClockHex });
  check('c2 GET /config (CLOCK) -> 200', r.status === 200, r.text);
}
{
  const r = await raw('PUT', '/bootstrap/rewrap', { token: UNKNOWN_TOKEN, body: { wrapped: MAT2.wrappedB64 } });
  check('c3 rewrap wrong secret -> silent 404', r.status === 404 && r.text === '');
}
{
  const r = await raw('PUT', '/bootstrap/rewrap', {
    token: ADMIN,
    body: { wrapped: MAT2.wrappedB64, salt: MAT2.saltHex },
  });
  check('c4 rewrap -> 200 {}', r.status === 200 && jparse(r.text) && Object.keys(jparse(r.text)).length === 0, r.text);
}
{
  const r = await raw('GET', '/config', { token: MAT.authUiHex });
  const c = jparse(r.text);
  check('c5 config reflects rewrap (ver=2, new wrapped+salt)', c.wrapped === MAT2.wrappedB64 && c.salt === MAT2.saltHex && c.ver === 2, r.text);
  let oldFails = false;
  try {
    deriveClientKeys(PW, c.salt, c.iters, c.wrapped);
  } catch {
    oldFails = true;
  }
  check('c6 OLD password no longer unwraps', oldFails);
  const d2 = deriveClientKeys(PW + '-rotated', c.salt, c.iters, c.wrapped);
  check('c7 NEW password unwraps to AES1 (MAT2)', d2.aes1.equals(MAT2.aes1));
  const r2 = await raw('GET', '/rows', { token: MAT.authUiHex });
  check('c8 AUTH_UI still valid after rewrap (private column untouched)', r2.status === 200, r2.text);
}
{
  const r = await raw('PUT', '/bootstrap/rewrap', {
    token: ADMIN,
    body: { wrapped: MAT.wrappedB64, salt: MAT.saltHex },
  });
  check('c9 rewrap back to primary material', r.status === 200);
  const c = jparse((await raw('GET', '/config', { token: MAT.authUiHex })).text);
  check('c10 config back to original (ver=3)', c.wrapped === MAT.wrappedB64 && c.salt === MAT.saltHex && c.ver === 3, JSON.stringify(c));
}
{
  const r = await raw('PUT', '/bootstrap/rewrap', { token: ADMIN, body: { wrapped: b64(randomBytes(59)) } });
  check('c11 rewrap 59B wrapped -> 400', r.status === 400, r.text);
}
{
  // §20 Type A with the SAME AES1 (the spec invariant: "re-wrap AES1 … No data
  // re-encryption anywhere … AES1 unchanged").
  const re = buildRewrapMaterial(MAT.aes1, PW + '-typea');
  const r = await raw('PUT', '/bootstrap/rewrap', { token: ADMIN, body: { wrapped: re.wrappedB64, salt: re.saltHex } });
  check('c12 Type A rewrap (same AES1) -> 200 {}', r.status === 200 && r.text === '{}', r.text);
  const c = jparse((await raw('GET', '/config', { token: MAT.authUiHex })).text);
  check('c13 config reflects Type A material', c.wrapped === re.wrappedB64 && c.salt === re.saltHex, JSON.stringify(c));
  const k = deriveClientKeys(PW + '-typea', re.saltHex, 100000, re.wrappedB64);
  check('c14 INVARIANT: AES1 unchanged across Type A', k.aes1.equals(MAT.aes1));
  check('c15 INVARIANT: AUTH tokens unchanged (HKDF of same AES1)', hx(k.authUi) === MAT.authUiHex && hx(k.authClock) === MAT.authClockHex);
  const r2 = await raw('GET', '/rows', { token: MAT.authUiHex });
  check('c16 AUTH_UI still valid after Type A (private column untouched)', r2.status === 200, r2.text);
  // Rotate back to the primary material for the remaining phases.
  const back = await raw('PUT', '/bootstrap/rewrap', { token: ADMIN, body: { wrapped: MAT.wrappedB64, salt: MAT.saltHex } });
  check('c17 rotate back to primary material', back.status === 200, back.text);
}

/* ================================================================ */
console.log('PHASE R — row sync RMW (§9)');
/* ================================================================ */

const KEYS = deriveClientKeys(PW, MAT.saltHex, 100000, MAT.wrappedB64);
const K = KEYS.kData;
const DAY = '2026-11-05';
const RID = 'cal:' + DAY.replaceAll('-', '');

{
  const r = await raw('GET', '/rows', { token: MAT.authUiHex });
  const m = jparse(r.text);
  check('r1 manifest shape {rows:[]}', r.status === 200 && m && Array.isArray(m.rows) && m.rows.length === 0, r.text);
}

let envA;
{
  const enc = encryptRow(K, RID, 1, { events: [{ id: 'w:' + randomUUID(), date: DAY, hh: 8, mm: 0, title: 'Alpha', priority: 1 }] });
  envA = { ver: 1, nonce: b64(enc.nonce), ct: b64(enc.ct) };
  const r = await raw('PUT', '/rows/' + encodeURIComponent(RID), { token: MAT.authUiHex, body: envA });
  const b = jparse(r.text);
  check(
    'r2 PUT new row ver1 -> 200 echo envelope',
    r.status === 200 && b.id === RID && b.ver === 1 && b.nonce === envA.nonce && b.ct === envA.ct,
    r.text
  );
}
{
  const r = await raw('GET', '/rows/' + encodeURIComponent(RID), { token: MAT.authClockHex });
  const b = jparse(r.text);
  check('r3 GET row (CLOCK) -> envelope roundtrip', r.status === 200 && b.ver === 1 && b.nonce === envA.nonce && b.ct === envA.ct, r.text);
  const payload = decryptRow(K, RID, b.ver, b.nonce, b.ct);
  check('r3b decrypts to original payload', payload.events.length === 1 && payload.events[0].title === 'Alpha');
}
{
  const m = jparse((await raw('GET', '/rows', { token: MAT.authUiHex })).text);
  check('r4 manifest lists row', m.rows.some((x) => x.id === RID && x.ver === 1));
}
{
  // Same envelope again (ver 1 == stored 1): rejected-as-rebase returns stored —
  // which equals the submission here, so identity check still matches (accepted view).
  const r = await raw('PUT', '/rows/' + encodeURIComponent(RID), { token: MAT.authUiHex, body: envA });
  const b = jparse(r.text);
  check('r5 PUT identical envelope at same ver -> 200 stored envelope', r.status === 200 && b.nonce === envA.nonce);
}
{
  // DIFFERENT envelope at same ver: must get back the STORED one (D14 rebase detection).
  const enc = encryptRow(K, RID, 1, { events: [] });
  const envB = { ver: 1, nonce: b64(enc.nonce), ct: b64(enc.ct) };
  const r = await raw('PUT', '/rows/' + encodeURIComponent(RID), { token: MAT.authUiHex, body: envB });
  const b = jparse(r.text);
  check(
    'r6 PUT competing envelope at same ver -> returns STORED (nonce echo differs)',
    r.status === 200 && b.ver === 1 && b.nonce === envA.nonce && b.nonce !== envB.nonce,
    r.text
  );
}
let envC;
{
  const enc = encryptRow(K, RID, 2, { events: [{ id: 'w:' + randomUUID(), date: DAY, hh: 9, mm: 0, title: 'Beta', priority: 0 }] });
  envC = { ver: 2, nonce: b64(enc.nonce), ct: b64(enc.ct) };
  const r = await raw('PUT', '/rows/' + encodeURIComponent(RID), { token: MAT.authUiHex, body: envC });
  const b = jparse(r.text);
  check('r7 PUT ver2 -> accepted (echo identity)', r.status === 200 && b.ver === 2 && b.nonce === envC.nonce, r.text);
}
{
  const r = await raw('PUT', '/rows/' + encodeURIComponent(RID), { token: MAT.authUiHex, body: envA });
  const b = jparse(r.text);
  check('r8 PUT stale ver1 -> 200 CURRENT stored (ver2)', r.status === 200 && b.ver === 2 && b.nonce === envC.nonce, r.text);
}
{
  const r = await raw('GET', '/rows/missing-id', { token: MAT.authUiHex });
  check('r9 GET missing row -> 404 not_found WITH body (§5 asymmetry)', r.status === 404 && jparse(r.text)?.error === 'not_found', r.text);
}
{
  const r = await raw('PUT', '/rows/' + encodeURIComponent(RID), { token: MAT.authClockHex, body: envA });
  check('r12 AUTH_CLOCK PUT row -> 403 EMPTY body', r.status === 403 && r.text === '', r.status + ' ' + r.text);
  const r2 = await raw('DELETE', '/rows/' + encodeURIComponent(RID), { token: MAT.authClockHex });
  check('r13 AUTH_CLOCK DELETE row -> 403 EMPTY body', r2.status === 403 && r2.text === '');
}
{
  const big = b64(randomBytes(65537));
  const r = await raw('PUT', '/rows/cal:20990101', { token: MAT.authUiHex, body: { ver: 1, nonce: b64(randomBytes(12)), ct: big } });
  check('r14 ct 65537B -> 400 bad_ct', r.status === 400 && jparse(r.text)?.error === 'bad_ct', r.text);
}
{
  const exact = b64(randomBytes(65536));
  const r = await raw('PUT', '/rows/cal:20990102', { token: MAT.authUiHex, body: { ver: 1, nonce: b64(randomBytes(12)), ct: exact } });
  check('r15 ct exactly 65536B -> 200 (<= ROW_CT_MAX)', r.status === 200, r.text);
}
{
  const r = await raw('PUT', '/rows/cal:20990103', { token: MAT.authUiHex, body: { ver: 1, nonce: b64(randomBytes(11)), ct: b64(randomBytes(64)) } });
  check('r16 nonce 11B -> 400 bad_nonce', r.status === 400 && jparse(r.text)?.error === 'bad_nonce', r.text);
}
for (const [name, ver] of [['ver 0', 0], ['ver -1', -1], ['ver 1.5', 1.5], ['ver "2"', '2'], ['ver 2^32', 4294967296]]) {
  const r = await raw('PUT', '/rows/cal:20990104', { token: MAT.authUiHex, body: { ver, nonce: b64(randomBytes(12)), ct: b64(randomBytes(64)) } });
  check(`r17 ${name} -> 400 bad_ver`, r.status === 400 && jparse(r.text)?.error === 'bad_ver', r.text);
}
{
  const r = await raw('PUT', '/rows/cal:20990105', { token: MAT.authUiHex, body: { ver: 1, nonce: '!!not-base64!!', ct: b64(randomBytes(64)) } });
  check('r18 nonce non-base64 -> 400 bad_nonce', r.status === 400 && jparse(r.text)?.error === 'bad_nonce', r.text);
  // Genuinely unpadded base64: strip ALL '=' padding (length no longer %4).
  const r2 = await raw('PUT', '/rows/cal:20990105', { token: MAT.authUiHex, body: { ver: 1, nonce: b64(randomBytes(12)), ct: b64(randomBytes(64)).replace(/=+$/, '') } });
  check('r18b unpadded ct -> 400 (padded base64 required)', r2.status === 400, r2.status + ' ' + r2.text);
}
{
  const enc = encryptRow(K, 'cal:20990106', 1, { events: [] });
  const r = await raw('PUT', '/rows/cal:20990106', {
    token: MAT.authUiHex,
    body: { ver: 1, nonce: b64(enc.nonce), ct: b64(enc.ct), junk_field: { ignored: true } },
  });
  check('r19 unspecified fields ignored -> 200', r.status === 200, r.text);
}
{
  const enc = encryptRow(K, 'cal:20990107', 7, { events: [] });
  const r = await raw('PUT', '/rows/cal:20990107', { token: MAT.authUiHex, body: { ver: 7, nonce: b64(enc.nonce), ct: b64(enc.ct) } });
  check('r20 new row with ver 7 -> 200 (D8: §19 restore drill)', r.status === 200 && jparse(r.text)?.ver === 7, r.text);
}
{
  const ID = 'cal:20991225';
  const enc = encryptRow(K, ID, 1, { events: [] });
  const body = { ver: 1, nonce: b64(enc.nonce), ct: b64(enc.ct) };
  await raw('PUT', '/rows/' + encodeURIComponent(ID), { token: MAT.authUiHex, body });
  const g1 = await raw('GET', '/rows/' + encodeURIComponent(ID), { token: MAT.authUiHex });
  const g2 = await raw('GET', '/rows/' + ID, { token: MAT.authUiHex }); // raw colon in path
  check('r21 id roundtrip (encoded + raw colon)', g1.status === 200 && g2.status === 200 && jparse(g1.text).id === ID);
}
{
  const ID = 'cal:🎄';
  const enc = encryptRow(K, ID, 1, { events: [] });
  const r = await raw('PUT', '/rows/' + encodeURIComponent(ID), { token: MAT.authUiHex, body: { ver: 1, nonce: b64(enc.nonce), ct: b64(enc.ct) } });
  const g = await raw('GET', '/rows/' + encodeURIComponent(ID), { token: MAT.authUiHex });
  check('r22 unicode id roundtrip', r.status === 200 && g.status === 200 && jparse(g.text).id === ID, r.status + '/' + g.status);
}
{
  const r = await raw('GET', '/rows/', { token: MAT.authUiHex });
  check('r23 empty id -> silent 404', r.status === 404 && r.text === '');
  const enc = encryptRow(K, 'we/ird', 1, { events: [] });
  const r2 = await raw('PUT', '/rows/' + encodeURIComponent('we/ird'), { token: MAT.authUiHex, body: { ver: 1, nonce: b64(enc.nonce), ct: b64(enc.ct) } });
  const g = await raw('GET', '/rows/' + encodeURIComponent('we/ird'), { token: MAT.authUiHex });
  check('r23b slash-in-id roundtrip (opaque ids)', r2.status === 200 && g.status === 200);
}
{
  const r = await raw('DELETE', '/rows/cal:20990101', { token: MAT.authUiHex });
  check('r10 DELETE -> 200 {}', r.status === 200 && jparse(r.text) && Object.keys(jparse(r.text)).length === 0, r.text);
  const m = jparse((await raw('GET', '/rows', { token: MAT.authUiHex })).text);
  check('r10b row gone from manifest', !m.rows.some((x) => x.id === 'cal:20990101'));
  const r2 = await raw('DELETE', '/rows/cal:20990101', { token: MAT.authUiHex });
  check('r11 DELETE idempotent -> 200 {}', r2.status === 200 && r2.text === '{}');
}

/* ================================================================ */
console.log('PHASE R2 — size/encoding edges (§21, D9, D16)');
/* ================================================================ */

{
  const r = await raw('PUT', '/rows/cal:20990501', { token: MAT.authUiHex, body: { ver: 1, nonce: b64(randomBytes(12)), ct: b64(randomBytes(4)) } });
  check('r2.1 4-byte ct -> 200 (D16: no minimum)', r.status === 200, r.text);
  const r2 = await raw('PUT', '/rows/cal:20990502', { token: MAT.authUiHex, body: { ver: 1, nonce: b64(randomBytes(12)), ct: b64(randomBytes(17)) } });
  check('r2.2 17-byte ct -> 200', r2.status === 200, r2.text);
  const id257 = 'cal:' + 'a'.repeat(253); // 257 chars total
  const r3 = await raw('PUT', '/rows/' + encodeURIComponent(id257), { token: MAT.authUiHex, body: { ver: 1, nonce: b64(randomBytes(12)), ct: b64(randomBytes(64)) } });
  check('r2.3 257-char id (authed) -> 400 bad_id', r3.status === 400 && jparse(r3.text)?.error === 'bad_id', r3.text);
  const id256 = 'cal:' + 'a'.repeat(252); // 256 chars total
  const enc256 = encryptRow(K, id256, 1, { events: [] });
  const r4 = await raw('PUT', '/rows/' + encodeURIComponent(id256), { token: MAT.authUiHex, body: { ver: 1, nonce: b64(enc256.nonce), ct: b64(enc256.ct) } });
  const g4 = await raw('GET', '/rows/' + encodeURIComponent(id256), { token: MAT.authUiHex });
  check('r2.4 256-char id -> 200 + roundtrip', r4.status === 200 && g4.status === 200 && jparse(g4.text).id === id256);
  const r5 = await raw('PUT', '/rows/' + encodeURIComponent(id257), {});
  check('r2.5 257-char id UNAUTH -> silent 404 (bearer gate precedes validation)', r5.status === 404 && r5.text === '');
  const big = b64(randomBytes(1100000)); // ~1.47 MiB JSON body
  const r6 = await raw('PUT', '/rows/cal:20990503', { token: MAT.authUiHex, body: { ver: 1, nonce: b64(randomBytes(12)), ct: big } });
  check('r2.6 >1MiB body -> 400 too_large', r6.status === 400 && jparse(r6.text)?.error === 'too_large', r6.text);
  const r7 = await raw('PUT', '/rows/cal:20990504', { token: MAT.authUiHex, body: { ver: 1, nonce: b64(randomBytes(12)), ct: 'QR==' } });
  check('r2.7 non-canonical ct ("QR==") -> 400 bad_ct', r7.status === 400 && jparse(r7.text)?.error === 'bad_ct', r7.text);
}

/* ================================================================ */
console.log('PHASE E — crypto E2E, AAD binding, dual-writer merge (§6/§13)');
/* ================================================================ */

{
  const keys = deriveClientKeys(PW, MAT.saltHex, 100000, MAT.wrappedB64);
  check('e5 derived AUTH_UI == registered token (HKDF path)', Buffer.from(keys.authUi).toString('hex') === MAT.authUiHex);
  check('e5b derived AUTH_CLOCK == registered token', Buffer.from(keys.authClock).toString('hex') === MAT.authClockHex);
}
{
  let threw = false;
  try {
    deriveClientKeys('wrong-password', MAT.saltHex, 100000, MAT.wrappedB64);
  } catch {
    threw = true;
  }
  check('e4 wrong password -> unwrap throws', threw);
}
{
  const aad = rowAad(RID, 2);
  check('e0 AAD = ascii(id)||u32be(ver) length', aad.length === RID.length + 4 && aad[RID.length] === 0 && aad[RID.length + 3] === 2);
}
{
  // e2: tampered ciphertext fails AEAD client-side.
  const g = jparse((await raw('GET', '/rows/' + encodeURIComponent(RID), { token: MAT.authUiHex })).text);
  const ct = Buffer.from(g.ct, 'base64');
  ct[0] ^= 0xff;
  let threw = false;
  try {
    decryptRow(K, RID, g.ver, g.nonce, ct.toString('base64'));
  } catch {
    threw = true;
  }
  check('e2 tampered ct -> decrypt throws', threw);
}
{
  // e3: §6 rollback defense — replaying an OLD authenticated envelope under a
  // NEWER ver is accepted by the content-blind server but FAILS client-side
  // because the AAD binds the ver.
  const g = jparse((await raw('GET', '/rows/' + encodeURIComponent(RID), { token: MAT.authUiHex })).text); // ver2
  const r = await raw('PUT', '/rows/' + encodeURIComponent(RID), { token: MAT.authUiHex, body: { ver: 3, nonce: g.nonce, ct: g.ct } });
  check('e3a server accepts replayed envelope at ver3 (content-blind)', r.status === 200 && jparse(r.text)?.ver === 3, r.text);
  const m3 = jparse((await raw('GET', '/rows', { token: MAT.authUiHex })).text);
  check('e3a2 manifest reflects ver 3 after the replay', m3.rows.find((x) => x.id === RID)?.ver === 3);
  const g3 = jparse((await raw('GET', '/rows/' + encodeURIComponent(RID), { token: MAT.authUiHex })).text);
  let threw = false;
  try {
    decryptRow(K, RID, 3, g3.nonce, g3.ct); // ct was bound to ver2
  } catch {
    threw = true;
  }
  check('e3b client-side decrypt of ver-bound ct at wrong ver FAILS', threw);
}

/* e6 — dual-writer ownership merge (§13) */
{
  const day = '2026-11-15';
  const id = 'cal:' + day.replaceAll('-', '');
  const w1 = { id: 'w:' + randomUUID(), date: day, hh: 7, mm: 0, title: 'W1 morning', priority: 1 };
  const w1b = { id: 'w:' + randomUUID(), date: day, hh: 7, mm: 30, title: 'W1 second', priority: 1 };
  const d1 = { id: 'd:' + randomUUID(), date: day, hh: 12, mm: 0, title: 'DAVx5 sync', priority: 2 };

  // W1 creates the bucket with two own events.
  let enc = encryptRow(K, id, 1, { events: [w1, w1b] });
  let r = await raw('PUT', '/rows/' + encodeURIComponent(id), { token: MAT.authUiHex, body: { ver: 1, nonce: b64(enc.nonce), ct: b64(enc.ct) } });
  check('e6a W1 creates bucket ver1', r.status === 200 && jparse(r.text).ver === 1);

  // W2 reads the union and adds its own d: entry (never touching w: entries).
  let g = jparse((await raw('GET', '/rows/' + encodeURIComponent(id), { token: MAT.authUiHex })).text);
  let payload = decryptRow(K, id, g.ver, g.nonce, g.ct);
  const union = [...payload.events, d1];
  enc = encryptRow(K, id, 2, { events: union });
  const w2env = { ver: 2, nonce: b64(enc.nonce), ct: b64(enc.ct) };
  r = await raw('PUT', '/rows/' + encodeURIComponent(id), { token: MAT.authUiHex, body: w2env });
  check('e6b W2 union write ver2 accepted', r.status === 200 && jparse(r.text).nonce === w2env.nonce);

  // W1 (stale, still believes ver1) submits its own ver2: server must return
  // the STORED envelope (rebase) — detectable via nonce echo (WORKLOG D14).
  const w1c = { id: 'w:' + randomUUID(), date: day, hh: 18, mm: 0, title: 'W1 evening', priority: 3 };
  enc = encryptRow(K, id, 2, { events: [w1, w1b, w1c] });
  const staleEnv = { ver: 2, nonce: b64(enc.nonce), ct: b64(enc.ct) };
  r = await raw('PUT', '/rows/' + encodeURIComponent(id), { token: MAT.authUiHex, body: staleEnv });
  const rb = jparse(r.text);
  check(
    'e6c stale ver2 write rebased (stored envelope returned, nonce differs)',
    r.status === 200 && rb.ver === 2 && rb.nonce === w2env.nonce && rb.nonce !== staleEnv.nonce,
    r.text
  );

  // W1 rebases: re-read current, apply own change on the union, ver3.
  g = jparse((await raw('GET', '/rows/' + encodeURIComponent(id), { token: MAT.authUiHex })).text);
  payload = decryptRow(K, id, g.ver, g.nonce, g.ct);
  enc = encryptRow(K, id, 3, { events: [...payload.events, w1c] });
  const env3 = { ver: 3, nonce: b64(enc.nonce), ct: b64(enc.ct) };
  r = await raw('PUT', '/rows/' + encodeURIComponent(id), { token: MAT.authUiHex, body: env3 });
  check('e6d W1 rebased write ver3 accepted', r.status === 200 && jparse(r.text).nonce === env3.nonce);

  // Final state: 4 events; the foreign d: entry is byte-identical.
  g = jparse((await raw('GET', '/rows/' + encodeURIComponent(id), { token: MAT.authUiHex })).text);
  payload = decryptRow(K, id, g.ver, g.nonce, g.ct);
  check('e6e final bucket has 4 events', payload.events.length === 4, JSON.stringify(payload));
  check(
    'e6f foreign entry preserved byte-for-byte',
    JSON.stringify(payload.events.find((e) => e.id === d1.id)) === JSON.stringify(d1)
  );
  check('e6g all own entries present', [w1.id, w1b.id, w1c.id].every((x) => payload.events.some((e) => e.id === x)));
}

/* e7 — 16/day cap end-to-end */
{
  const day = '2026-11-16';
  const id = 'cal:' + day.replaceAll('-', '');
  const events = Array.from({ length: 20 }, (_, i) => ({
    id: 'w:' + randomUUID(), date: day, hh: i % 24, mm: 0, title: 'Cap ' + i, priority: i % 5,
  }));
  // Apply the same client-side rule the app uses, then write.
  const capped = capEvents(events, 'w');
  check('e7a capEvents drops 4 of 20 own', capped.events.length === 16 && capped.dropped.length === 4);
  const enc = encryptRow(K, id, 1, { events: capped.events });
  const r = await raw('PUT', '/rows/' + encodeURIComponent(id), { token: MAT.authUiHex, body: { ver: 1, nonce: b64(enc.nonce), ct: b64(enc.ct) } });
  // Read the row BACK from the server and decrypt it — the cap must be
  // visible in the STORED ciphertext, not just in the local construction.
  const g = jparse((await raw('GET', '/rows/' + encodeURIComponent(id), { token: MAT.authUiHex })).text);
  const storedPayload = decryptRow(K, id, g.ver, g.nonce, g.ct);
  check(
    'e7b capped bucket stored + decrypts to exactly 16 events',
    r.status === 200 && g.ver === 1 && storedPayload.events.length === 16,
    'events=' + storedPayload.events.length
  );
}

/* ================================================================ */
console.log('PHASE E2 — truly parallel RMW (§9 linearizability)');
/* ================================================================ */

{
  const id = 'cal:20261117';
  const e1 = encryptRow(K, id, 1, { events: [] });
  await raw('PUT', '/rows/' + encodeURIComponent(id), { token: MAT.authUiHex, body: { ver: 1, nonce: b64(e1.nonce), ct: b64(e1.ct) } });
  const encA = encryptRow(K, id, 2, { events: [{ id: 'w:' + randomUUID(), date: '2026-11-17', hh: 8, mm: 0, title: 'A', priority: 0 }] });
  const encB = encryptRow(K, id, 2, { events: [{ id: 'w:' + randomUUID(), date: '2026-11-17', hh: 9, mm: 0, title: 'B', priority: 0 }] });
  const [ra, rb] = await Promise.all([
    raw('PUT', '/rows/' + encodeURIComponent(id), { token: MAT.authUiHex, body: { ver: 2, nonce: b64(encA.nonce), ct: b64(encA.ct) } }),
    raw('PUT', '/rows/' + encodeURIComponent(id), { token: MAT.authUiHex, body: { ver: 2, nonce: b64(encB.nonce), ct: b64(encB.ct) } }),
  ]);
  const aAccepted = jparse(ra.text)?.nonce === b64(encA.nonce) && jparse(ra.text)?.ct === b64(encA.ct);
  const bAccepted = jparse(rb.text)?.nonce === b64(encB.nonce) && jparse(rb.text)?.ct === b64(encB.ct);
  check(
    'e2.1 exactly ONE writer accepted (envelope identity), both got 200',
    ra.status === 200 && rb.status === 200 && (aAccepted ? 1 : 0) + (bAccepted ? 1 : 0) === 1,
    `a=${aAccepted} b=${bAccepted}`
  );
  const g = jparse((await raw('GET', '/rows/' + encodeURIComponent(id), { token: MAT.authUiHex })).text);
  const winner = aAccepted ? 'A' : 'B';
  const loserText = aAccepted ? rb.text : ra.text;
  check('e2.2 rebased writer received the STORED envelope', jparse(loserText).nonce === g.nonce, loserText);
  check('e2.3 final state = winner at ver 2', g.ver === 2 && g.nonce === (aAccepted ? b64(encA.nonce) : b64(encB.nonce)));
  const payload = decryptRow(K, id, g.ver, g.nonce, g.ct);
  check('e2.4 winner payload decrypts', payload.events.length === 1 && payload.events[0].title === winner);
}

/* ================================================================ */
console.log('PHASE X — CORS allowlist (WORKLOG D6)');
/* ================================================================ */

{
  const r = await raw('OPTIONS', '/rows', { origin: PAGES_ORIGIN, headers: { 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization, content-type' } });
  check(
    'x1 preflight from Pages origin -> 204 + CORS headers',
    r.status === 204 &&
      r.headers.get('access-control-allow-origin') === PAGES_ORIGIN &&
      (r.headers.get('access-control-allow-methods') || '').includes('PUT') &&
      (r.headers.get('access-control-allow-methods') || '').includes('DELETE') &&
      (r.headers.get('access-control-allow-headers') || '').toLowerCase().includes('authorization'),
    r.status + ' ' + JSON.stringify(Object.fromEntries(r.headers))
  );
}
{
  const r = await raw('OPTIONS', '/rows', { origin: EVIL_ORIGIN });
  check('x2 preflight from foreign origin -> silent (no CORS headers)', r.status === 404 && r.headers.get('access-control-allow-origin') === null);
}
{
  const r = await raw('GET', '/rows', { origin: PAGES_ORIGIN, token: MAT.authUiHex });
  check('x3 authed GET with Pages origin -> 200 + ACAO', r.status === 200 && r.headers.get('access-control-allow-origin') === PAGES_ORIGIN);
}
{
  const r = await raw('GET', '/rows', { origin: EVIL_ORIGIN, token: MAT.authUiHex });
  check('x4 authed GET with foreign origin -> 200 but NO ACAO (browser blocks)', r.status === 200 && r.headers.get('access-control-allow-origin') === null);
}
{
  const r = await raw('GET', '/rows', { origin: PAGES_ORIGIN });
  check('x6 silent 404 still carries ACAO for allowed origin (client must see 404)', r.status === 404 && r.headers.get('access-control-allow-origin') === PAGES_ORIGIN && r.text === '');
}
{
  const r = await raw('OPTIONS', '/rows', {});
  check('x7 OPTIONS with no Origin -> silent 404', r.status === 404 && r.text === '');
}
{
  const r = await raw('OPTIONS', '/nonsense', { origin: PAGES_ORIGIN });
  check('x5 preflight for unknown path -> 204 + ACAO (uniform)', r.status === 204 && r.headers.get('access-control-allow-origin') === PAGES_ORIGIN);
}

/* ================================================================ */
console.log('PHASE X2 — CORS decorate on ERROR statuses (D6)');
/* ================================================================ */

{
  const o = { origin: PAGES_ORIGIN };
  const r1 = await raw('PUT', '/rows/cal:20261105', { ...o, token: MAT.authClockHex, body: {} });
  check(
    'x8 403 carries ACAO (client must read the capability error)',
    r1.status === 403 && r1.headers.get('access-control-allow-origin') === PAGES_ORIGIN,
    r1.status + ' ' + r1.text
  );
  const r2 = await raw('GET', '/rows/none', { ...o, token: MAT.authUiHex });
  check(
    'x9 404 not_found carries ACAO + body',
    r2.status === 404 && jparse(r2.text)?.error === 'not_found' && r2.headers.get('access-control-allow-origin') === PAGES_ORIGIN
  );
  const r3 = await raw('PUT', '/rows/cal:20990601', { ...o, token: MAT.authUiHex, body: { ver: 1, nonce: 'AAA', ct: 'AAA' } });
  check('x10 400 carries ACAO', r3.status === 400 && r3.headers.get('access-control-allow-origin') === PAGES_ORIGIN);
  const r4 = await raw('PUT', '/bootstrap', {
    ...o,
    token: ADMIN,
    body: { salt: MAT.saltHex, iters: 100000, wrapped: MAT.wrappedB64, auth_ui: MAT.authUiHex, auth_clock: MAT.authClockHex },
  });
  check('x11 409 carries ACAO', r4.status === 409 && r4.headers.get('access-control-allow-origin') === PAGES_ORIGIN);
}

/* ================================================================ */
console.log('PHASE V — version & status (§22, §10)');
/* ================================================================ */

{
  const r = await raw('GET', '/version', { token: MAT.authUiHex });
  check('v1 GET /version -> {"proto":"4.1"}', r.status === 200 && jparse(r.text)?.proto === '4.1', r.text);
  const r2 = await raw('GET', '/version', { token: MAT.authClockHex });
  check('v1b /version with CLOCK token', r2.status === 200);
}
{
  const r = await raw('GET', '/status', { token: MAT.authUiHex });
  check('v2 GET /status -> {"photo_pending":0}', r.status === 200 && jparse(r.text)?.photo_pending === 0, r.text);
}

/* ================================================================ */
console.log('PHASE I — internal backup (§19)');
/* ================================================================ */

{
  const r = await raw('POST', '/internal/backup', {});
  check('i1 backup unauthenticated -> silent 404', r.status === 404 && r.text === '');
  const r2 = await raw('POST', '/internal/backup', { token: MAT.authUiHex });
  check('i2 backup with app token -> silent 404 (internal capability)', r2.status === 404 && r2.text === '');
}
{
  const r = await raw('POST', '/internal/backup', { token: INTERNAL });
  const b = jparse(r.text);
  const today = new Date().toISOString().slice(0, 10);
  check('i3 backup with INTERNAL_TOKEN -> 200 {ok, day, rows}', r.status === 200 && b?.ok === true && b?.day === today && typeof b?.rows === 'number' && b.rows >= 1, r.text);
}

/* ================================================================ */
console.log('PHASE M — misc shapes');
/* ================================================================ */

{
  const r = await raw('PUT', '/rows/cal:20990301', { token: MAT.authUiHex, body: { ver: 1, nonce: 'AAAA', ct: 'AAAA' } });
  check('m1 400 carries JSON content-type', r.status === 400 && (r.headers.get('content-type') || '').includes('application/json'));
  const r2 = await raw('PUT', '/rows/cal:20990301', { token: MAT.authClockHex, body: {} });
  check('m2 403 empty body, no content-type', r2.status === 403 && r2.text === '' && r2.headers.get('content-type') === null);
  const r3 = await raw('GET', '/rows/none', { token: MAT.authUiHex });
  check('m3 not_found 404 has JSON body', r3.status === 404 && jparse(r3.text)?.error === 'not_found');
  const r4 = await raw('HEAD', '/rows', { token: MAT.authUiHex });
  check('m4 HEAD /rows -> silent 404 (not a route)', r4.status === 404);
}

/* ================================================================ */
console.log('PHASE B2 — §8 force re-bootstrap destructive wipe (final, destructive)');
/* ================================================================ */

{
  for (const day of ['2026-12-01', '2026-12-02']) {
    const id = 'cal:' + day.replaceAll('-', '');
    const enc = encryptRow(K, id, 1, { events: [] });
    await raw('PUT', '/rows/' + encodeURIComponent(id), { token: MAT.authUiHex, body: { ver: 1, nonce: b64(enc.nonce), ct: b64(enc.ct) } });
  }
  const before = jparse((await raw('GET', '/rows', { token: MAT.authUiHex })).text);
  check('b2.1 rows seeded before force wipe', before.rows.length >= 2, JSON.stringify(before));
  const r = await raw('PUT', '/bootstrap', {
    token: ADMIN,
    body: {
      salt: MAT.saltHex, iters: 100000, wrapped: MAT.wrappedB64,
      auth_ui: MAT.authUiHex, auth_clock: MAT.authClockHex, force: true,
    },
  });
  check('b2.2 force re-bootstrap -> 200 {ver:1}', r.status === 200 && jparse(r.text)?.ver === 1, r.text);
  const after = jparse((await raw('GET', '/rows', { token: MAT.authUiHex })).text);
  check('b2.3 wipe: manifest EMPTY', after.rows.length === 0, JSON.stringify(after));
  const gone = await raw('GET', '/rows/cal:20261201', { token: MAT.authUiHex });
  check('b2.4 wiped row -> 404 not_found', gone.status === 404 && jparse(gone.text)?.error === 'not_found', gone.text);
  const cfg = jparse((await raw('GET', '/config', { token: MAT.authUiHex })).text);
  check('b2.5 config re-created (ver=1, same material)', cfg.ver === 1 && cfg.salt === MAT.saltHex, JSON.stringify(cfg));
}

/* Re-seed deterministic content for the orchestrator's §19 D1 fidelity and
   restore-drill verification (run-local.mjs wipes today's D1 snapshot first,
   re-triggers the cron, then compares byte-for-byte). */
{
  const seeds = [
    ['2026-11-01', 8, 'Standup'],
    ['2026-11-02', 13, 'Lunch'],
    ['2026-11-03', 19, 'Gym'],
  ];
  for (const [day, hh, title] of seeds) {
    const id = 'cal:' + day.replaceAll('-', '');
    const ev = { id: 'w:' + randomUUID(), date: day, hh, mm: 0, title, priority: 1 };
    const enc = encryptRow(K, id, 1, { events: [ev] });
    const r = await raw('PUT', '/rows/' + encodeURIComponent(id), { token: MAT.authUiHex, body: { ver: 1, nonce: b64(enc.nonce), ct: b64(enc.ct) } });
    if (r.status !== 200) check('seed ' + day, false, r.text);
  }
  const r = await raw('POST', '/internal/backup', { token: INTERNAL });
  const b = jparse(r.text);
  check('seed backup snapshot -> {ok, rows:3}', r.status === 200 && b?.ok === true && b?.rows === 3, r.text);
}

if (MATERIAL_OUT) {
  const fs = await import('node:fs');
  fs.writeFileSync(
    MATERIAL_OUT,
    JSON.stringify(
      {
        server: BASE,
        salt: MAT.saltHex,
        iters: 100000,
        wrapped_b64: MAT.wrappedB64,
        aes1_hex: MAT.aes1Hex,
        k_data_hex: MAT.kDataHex,
        auth_ui_hex: MAT.authUiHex,
        auth_clock_hex: MAT.authClockHex,
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );
}

/* ================================================================ */

console.log(`\napi-suite: ${pass} passed, ${fails.length} failed (target ${BASE})`);
if (fails.length) {
  for (const f of fails) console.error('  FAIL ' + f);
  process.exit(1);
}
