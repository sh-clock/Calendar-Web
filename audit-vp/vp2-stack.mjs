#!/usr/bin/env node
/**
 * VP2 — crypto/auth re-attack harness (private local stack, port 8794).
 * Phases:
 *   A. S7-F2 bootstrap iters matrix (reject 99999/10000001, accept 100000/600000, coercion)
 *   B. CLI bootstrap (operator path) + CLI rewrap (Type A with iters)
 *   C. rewrap iters coercion matrix + non-admin iters attempts (class matrix)
 *   D. rewrap/PUT races — torn (salt,iters,wrapped) triple hunt via GET /config
 *   E. stale-cfg residual simulation (offline unlock trade-off, fp pinning)
 * Never prints full hex material — statuses, booleans and 8-char prefixes only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const URL_ = 'http://127.0.0.1:8794';
const ADMIN = readFileSync('/tmp/vp2-admin.txt', 'utf8').trim();
let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + String(detail) : '')); }
}
const red8 = (s) => (typeof s === 'string' ? s.slice(0, 8) + '…' : String(s));
async function jf(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  let payload;
  if (raw !== undefined) { payload = raw; headers['content-type'] = 'application/json'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const res = await fetch(URL_ + path, { method, headers, body: payload, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, text, json, len: text.length };
}
const t0 = Date.now();
const phase = (s) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

/* minimal local material builder (avoids CLI process spawn for the matrix phases) */
import { buildBootstrapMaterial, deriveClientKeys, buildRewrapMaterial } from '../cli/bootstrap.mjs';

/* ---------- Phase A: bootstrap iters matrix ---------- */
console.log('\n== A. S7-F2: bootstrap iters range (fresh unbootstrapped stack) ==');
phase('A start');
{
  // unbootstrapped: any non-admin token -> silent drop
  const pre = await jf('GET', '/config', { token: '0'.repeat(64) });
  check('A0 unbootstrapped GET /config unknown token -> 404 empty', pre.status === 404 && pre.len === 0);

  const mat100k = buildBootstrapMaterial('vp2-pw-a', 100000);
  const base = { salt: mat100k.saltHex, wrapped: mat100k.wrappedB64, auth_ui: mat100k.authUiHex, auth_clock: mat100k.authClockHex };

  for (const iters of [99999, 10000001, 0, -1, 100000.5, '100000', '600000', null, 1e9, 99999.0000001]) {
    const r = await jf('PUT', '/bootstrap', { token: ADMIN, body: { ...base, iters } });
    check(`A1 bootstrap iters=${JSON.stringify(iters)} (${typeof iters}) -> 400 bad_iters`, r.status === 400 && r.json && r.json.error === 'bad_iters', r.status + ' ' + r.text.slice(0, 40));
  }
  // raw JSON NaN (JSON.stringify({iters:NaN}) -> null covered; send literal NaN text)
  {
    const raw = JSON.stringify({ ...base }).replace('"iters":100000', '"iters":NaN');
    const r = await jf('PUT', '/bootstrap', { token: ADMIN, raw });
    check('A1b bootstrap iters=NaN (raw JSON) -> 400', r.status === 400, r.status + ' ' + r.text.slice(0, 40));
  }
  // accepted: 100000
  {
    const r = await jf('PUT', '/bootstrap', { token: ADMIN, body: { ...base, iters: 100000 } });
    check('A2 bootstrap iters=100000 -> 200 {ver:1}', r.status === 200 && r.json && r.json.ver === 1, r.status + ' ' + r.text.slice(0, 40));
    const cfg = await jf('GET', '/config', { token: mat100k.authUiHex });
    check('A3 GET /config reports iters=100000 + exactly the clear params', cfg.status === 200 && cfg.json.iters === 100000 && cfg.json.salt === mat100k.saltHex && cfg.json.wrapped === mat100k.wrappedB64 && Object.keys(cfg.json).sort().join(',') === 'iters,salt,ver,wrapped', JSON.stringify(Object.keys(cfg.json || {})));
  }
  // accepted: 600000 (force)
  {
    const mat600k = buildBootstrapMaterial('vp2-pw-a2', 600000);
    const r = await jf('PUT', '/bootstrap', { token: ADMIN, body: { salt: mat600k.saltHex, iters: 600000, wrapped: mat600k.wrappedB64, auth_ui: mat600k.authUiHex, auth_clock: mat600k.authClockHex, force: true } });
    check('A4 force bootstrap iters=600000 -> 200', r.status === 200 && r.json && r.json.ver === 1, r.status + ' ' + r.text.slice(0, 60));
    const cfg = await jf('GET', '/config', { token: mat600k.authUiHex });
    check('A5 GET /config reports iters=600000', cfg.json && cfg.json.iters === 600000, JSON.stringify(cfg.json && cfg.json.iters));
  }
}

/* ---------- Phase B: CLI operator path (bootstrap + rewrap w/ iters) ---------- */
console.log('\n== B. CLI bootstrap + Type-A rewrap with iters (operator path) ==');
phase('B start');
{
  const { execFileSync } = await import('node:child_process');
  const out = '/tmp/vp2-mat.json';
  let ok = true, log = '';
  try {
    log = execFileSync('node', ['cli/bootstrap.mjs', '--url', URL_, '--admin', ADMIN, '--password', 'vp2-cli-pw', '--force', '--out', out], { cwd: '/home/z/my-project/calendar-web', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { ok = false; log = (e.stdout || '') + (e.stderr || ''); }
  check('B1 CLI bootstrap (600k default) succeeded', ok, log.slice(0, 200));
  const mat = JSON.parse(readFileSync(out, 'utf8'));
  check('B2 CLI material iters=600000, wrapped 60B (80 b64 chars), salt hex32', mat.iters === 600000 && typeof mat.wrapped_b64 === 'string' && mat.wrapped_b64.length === 80 && /^[0-9a-f]{32}$/.test(mat.salt));
  const cfg = await jf('GET', '/config', { token: mat.auth_ui_hex });
  check('B3 server cfg == CLI material (salt/wrapped/iters 600000)', cfg.json && cfg.json.salt === mat.salt && cfg.json.wrapped === mat.wrapped_b64 && cfg.json.iters === 600000, 'iters=' + (cfg.json && cfg.json.iters));
  const st = (await import('node:fs')).statSync(out);
  check('B4 CLI wrote material mode 0600', (st.mode & 0o777) === 0o600, (st.mode & 0o777).toString(8));

  // CLI rewrap: new password, same AES1, iters 600000
  let ok2 = true, log2 = '';
  try {
    log2 = execFileSync('node', ['cli/bootstrap.mjs', '--rewrap', '--url', URL_, '--admin', ADMIN, '--password', 'vp2-cli-pw', '--new-password', 'vp2-cli-pw2', '--material', out, '--out', out], { cwd: '/home/z/my-project/calendar-web', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { ok2 = false; log2 = (e.stdout || '') + (e.stderr || ''); }
  check('B5 CLI rewrap succeeded', ok2, log2.slice(0, 200));
  const mat2 = JSON.parse(readFileSync(out, 'utf8'));
  const cfg2 = await jf('GET', '/config', { token: mat2.auth_ui_hex });
  check('B6 post-rewrap cfg: new salt+wrapped, iters still 600000, ver bumped', cfg2.json && cfg2.json.salt === mat2.salt && cfg2.json.wrapped === mat2.wrapped_b64 && cfg2.json.iters === 600000 && cfg2.json.ver === (cfg.json.ver + 1), 'ver=' + (cfg2.json && cfg2.json.ver));
  check('B7 AUTH tokens unchanged across rewrap (HKDF of same AES1)', mat2.auth_ui_hex === mat.auth_ui_hex && mat2.auth_clock_hex === mat.auth_clock_hex && mat2.aes1_hex === mat.aes1_hex);
  // new password derives the same AES1; old password fails
  const nk = deriveClientKeys('vp2-cli-pw2', mat2.salt, mat2.iters, mat2.wrapped_b64);
  check('B8 new password unwraps the SAME AES1', nk.aes1.equals(Buffer.from(mat2.aes1_hex, 'hex')));
  let oldThrew = false;
  try { deriveClientKeys('vp2-cli-pw', mat2.salt, mat2.iters, mat2.wrapped_b64); } catch { oldThrew = true; }
  check('B9 OLD password fails against the rewrapped config', oldThrew);
}

/* ---------- Phase C: rewrap coercion + non-admin matrix ---------- */
console.log('\n== C. rewrap iters coercion + non-admin attempts ==');
phase('C start');
{
  const mat = JSON.parse(readFileSync('/tmp/vp2-mat.json', 'utf8'));
  const aes1 = Buffer.from(mat.aes1_hex, 'hex');
  const mk = (iters) => buildRewrapMaterial(aes1, 'vp2-rw-pw-' + randomBytes(4).toString('hex'), 600000);

  // coercion matrix — every malformed iters must 400 and leave config UNTOUCHED
  const before = await jf('GET', '/config', { token: mat.auth_ui_hex });
  for (const iters of [99999, 10000001, 0, -5, 600000.5, '600000', '100000', null, true, 1e12, 99999.9]) {
    const re = mk();
    const r = await jf('PUT', '/bootstrap/rewrap', { token: ADMIN, body: { wrapped: re.wrappedB64, salt: re.saltHex, iters } });
    check(`C1 rewrap iters=${JSON.stringify(iters)} -> 400 bad_iters`, r.status === 400 && r.json && r.json.error === 'bad_iters', r.status + ' ' + r.text.slice(0, 40));
  }
  {
    const re = mk();
    const raw = JSON.stringify({ wrapped: re.wrappedB64, salt: re.saltHex, iters: 600000 }).replace('600000', 'NaN');
    const r = await jf('PUT', '/bootstrap/rewrap', { token: ADMIN, raw });
    check('C1b rewrap iters=NaN (raw JSON) -> 400', r.status === 400, r.status + ' ' + r.text.slice(0, 40));
  }
  const afterBad = await jf('GET', '/config', { token: mat.auth_ui_hex });
  check('C2 config byte-identical after all rejected rewraps (no partial write)', JSON.stringify(before.json) === JSON.stringify(afterBad.json), JSON.stringify(before.json) + ' vs ' + JSON.stringify(afterBad.json));

  // boundary acceptance: 100000 (floor) and 10000000 (ceiling)
  for (const iters of [100000, 10000000]) {
    const re = buildRewrapMaterial(aes1, 'vp2-rw-ok-' + iters, iters);
    const r = await jf('PUT', '/bootstrap/rewrap', { token: ADMIN, body: { wrapped: re.wrappedB64, salt: re.saltHex, iters } });
    const cfg = await jf('GET', '/config', { token: mat.auth_ui_hex });
    check(`C3 rewrap iters=${iters} accepted + atomically visible (salt,wrapped,iters all from THIS rewrap)`, r.status === 200 && cfg.json.iters === iters && cfg.json.salt === re.saltHex && cfg.json.wrapped === re.wrappedB64, r.status + ' iters=' + (cfg.json && cfg.json.iters));
    // the wrap must actually derive at the new iters (self-consistent triple)
    const k = deriveClientKeys('vp2-rw-ok-' + iters, re.saltHex, iters, re.wrappedB64);
    check(`C4 rewrap iters=${iters}: triple self-consistent (derivation succeeds, same AES1)`, k.aes1.equals(aes1));
  }

  // non-admin iters attempts: ui/clock/internal/unknown on BOTH admin routes
  const re = buildRewrapMaterial(aes1, 'vp2-x', 600000);
  for (const [label, tok] of [['auth_ui', mat.auth_ui_hex], ['auth_clock', mat.auth_clock_hex], ['internal', randomBytes(32).toString('hex')], ['unknown', 'f'.repeat(64)], ['none', null]]) {
    const r1 = await jf('PUT', '/bootstrap', { token: tok, body: { salt: re.saltHex, iters: 100000, wrapped: re.wrappedB64, auth_ui: mat.auth_ui_hex, auth_clock: mat.auth_clock_hex } });
    const r2 = await jf('PUT', '/bootstrap/rewrap', { token: tok, body: { wrapped: re.wrappedB64, salt: re.saltHex, iters: 100000 } });
    check(`C5 non-admin (${label}) bootstrap+rewrap -> 404 empty (can NEVER set iters)`, r1.status === 404 && r1.len === 0 && r2.status === 404 && r2.len === 0, r1.status + '/' + r2.status + ' len=' + r1.len + '/' + r2.len);
  }
  // app-route class matrix spot-checks on the same universe
  {
    const v = await jf('GET', '/version', { token: mat.auth_ui_hex });
    check('C6 ui GET /version -> 200 proto 4.3', v.status === 200 && v.json && v.json.proto === '4.3');
    const a = await jf('GET', '/version', { token: ADMIN });
    check('C7 admin on app route -> 404 empty (no class bleed)', a.status === 404 && a.len === 0);
    const put = await jf('PUT', '/rows/vp2-probe', { token: mat.auth_clock_hex, body: { ver: 1, nonce: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAAAA' } });
    check('C8 clock PUT row -> 403 empty (capability)', put.status === 403 && put.len === 0);
    const uiPut12 = await jf('PUT', '/rows/vp2-probe', { token: mat.auth_ui_hex, body: { ver: 2, nonce: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAA' } });
    check('C9 ui PUT 12-byte ct (sub-tag) -> 400 bad_ct (sec-S7-F5 floor)', uiPut12.status === 400 && uiPut12.json && uiPut12.json.error === 'bad_ct', uiPut12.status + ' ' + uiPut12.text.slice(0, 40));
    const uiPut18 = await jf('PUT', '/rows/vp2-probe', { token: mat.auth_ui_hex, body: { ver: 2, nonce: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAAAA' } });
    check('C10 ui PUT 18-byte junk ct -> 200 accepted (relay stores junk rows by design; client AEAD will reject)', uiPut18.status === 200 && uiPut18.json && uiPut18.json.ver === 2, uiPut18.status + ' ' + uiPut18.text.slice(0, 40));
    await jf('DELETE', '/rows/vp2-probe', { token: mat.auth_ui_hex });
  }
}

/* ---------- Phase D: rewrap/row-PUT races ---------- */
console.log('\n== D. rewrap races vs row PUTs (torn triple hunt) ==');
phase('D start');
{
  const mat = JSON.parse(readFileSync('/tmp/vp2-mat.json', 'utf8'));
  const aes1 = Buffer.from(mat.aes1_hex, 'hex');
  const kData = Buffer.from(mat.k_data_hex, 'hex');
  const cfgBefore = await jf('GET', '/config', { token: mat.auth_ui_hex });

  // build K distinct rewrap proposals, alternating with/without iters
  const K = 12;
  const props = [];
  for (let i = 0; i < K; i++) {
    const withIters = i % 2 === 0;
    const re = buildRewrapMaterial(aes1, 'vp2-race-' + i, 100000 + i * 1000);
    props.push({ wrapped: re.wrappedB64, salt: re.saltHex, ...(withIters ? { iters: 100000 + i * 1000 } : {}) });
  }
  // valid post-states: cfgBefore + every prefix-consistent application of the proposals
  // (order unknown — the final triple must equal (salt_i, wrapped_i [, iters_i]) of the
  // LAST APPLIED rewrap, with iters = iters_i if that rewrap carried one, else inherited)
  // also fire concurrent row PUTs (valid envelopes) at the same time
  const { encryptRow } = await import('../cli/bootstrap.mjs');
  const putReqs = [];
  for (let i = 0; i < 8; i++) {
    const enc = encryptRow(kData, 'vp2:race:' + i, 1, { events: [] });
    putReqs.push(jf('PUT', '/rows/vp2:race:' + i, { token: mat.auth_ui_hex, body: { ver: 1, nonce: enc.nonce.toString('base64'), ct: enc.ct.toString('base64') } }));
  }
  const rewrapReqs = props.map((p) => jf('PUT', '/bootstrap/rewrap', { token: ADMIN, body: p }));
  const cfgReqs = [];
  for (let i = 0; i < 10; i++) cfgReqs.push(jf('GET', '/config', { token: mat.auth_ui_hex }));
  const all = await Promise.all([...rewrapReqs, ...putReqs, ...cfgReqs]);
  const rewrapResults = all.slice(0, K);
  const putResults = all.slice(K, K + 8);
  const cfgSnapshots = all.slice(K + 8);

  check('D1 all 12 concurrent rewraps -> 200 {}', rewrapResults.every((r) => r.status === 200 && r.text === '{}'), rewrapResults.map((r) => r.status).join(','));
  check('D2 all 8 concurrent row PUTs -> 200', putResults.every((r) => r.status === 200), putResults.map((r) => r.status).join(','));

  // every mid-race config snapshot must be a CONSISTENT triple (some prefix of applications)
  let tornMid = 0, classified = 0;
  for (const c of cfgSnapshots) {
    if (c.status !== 200) { tornMid++; continue; }
    const j = c.json;
    const consistent = props.some((p) => j.salt === p.salt && j.wrapped === p.wrapped && (p.iters === undefined ? true : j.iters === p.iters)) ||
      (j.salt === cfgBefore.json.salt && j.wrapped === cfgBefore.json.wrapped);
    if (consistent) classified++; else tornMid++;
  }
  check('D3 all mid-race GET /config snapshots are consistent triples (no torn salt/wrapped/iters)', tornMid === 0, tornMid + ' torn of ' + cfgSnapshots.length + ' (classified=' + classified + ')');

  const final = await jf('GET', '/config', { token: mat.auth_ui_hex });
  const fj = final.json;
  const lastApplied = props.find((p) => p.salt === fj.salt && p.wrapped === fj.wrapped);
  check('D4 final config = exactly one proposal\'s (salt,wrapped) pair', !!lastApplied, red8(fj.salt) + ' / ' + red8(fj.wrapped));
  check('D5 final iters consistent with the last applied rewrap', lastApplied && (lastApplied.iters === undefined ? true : fj.iters === lastApplied.iters), 'iters=' + fj.iters + ' propIters=' + (lastApplied && lastApplied.iters));
  check('D6 config.ver == before + 12 (each rewrap bumps exactly once)', fj.ver === cfgBefore.json.ver + K, fj.ver + ' vs ' + (cfgBefore.json.ver + K));
  // rows untouched by rewrap race: all 8 still present, ver 1, decryptable
  const manifest = await jf('GET', '/rows', { token: mat.auth_ui_hex });
  const got = manifest.json.rows.filter((r) => String(r.id).startsWith('vp2:race:'));
  check('D7 rewrap race did not touch rows (8 vp2:race rows, ver 1 each)', got.length === 8 && got.every((r) => r.ver === 1), JSON.stringify(got.map((r) => r.ver)));
  // cleanup race rows
  for (let i = 0; i < 8; i++) await jf('DELETE', '/rows/vp2:race:' + i, { token: mat.auth_ui_hex });
}

/* ---------- Phase E: stale-cfg residual simulation ---------- */
console.log('\n== E. stale-cfg residual (offline unlock trade-off + fp pinning) ==');
phase('E start');
{
  const mat = JSON.parse(readFileSync('/tmp/vp2-mat.json', 'utf8'));
  const aes1 = Buffer.from(mat.aes1_hex, 'hex');
  // E1: current live cfg (post race) — password unknown (race proposals) -> rewrap to a known one
  const re = buildRewrapMaterial(aes1, 'vp2-final-pw', 600000);
  const r = await jf('PUT', '/bootstrap/rewrap', { token: ADMIN, body: { wrapped: re.wrappedB64, salt: re.saltHex, iters: 600000 } });
  check('E0 settle rewrap -> 200', r.status === 200);
  const cfgFresh = (await jf('GET', '/config', { token: mat.auth_ui_hex })).json;

  // simulate the CLIENT's LS_CFG/LS_CACHE mechanics exactly as js/app.js does
  const LS = { cfg: null, cache: null }; // stand-in for localStorage
  const cfgFpOf = (c) => String(c.salt) + '|' + String(c.wrapped);
  const hydrate = () => {
    const o = LS.cache;
    if (!o || typeof o !== 'object' || o.v !== 1) return false;
    if (!LS.cfgFp || o.fp !== LS.cfgFp) return false;   // app.js:588
    return o.rows > 0;
  };
  const purge = () => { LS.cache = null; };

  // phase 1: online unlock under cfgFresh with correct pw — caches cfg + model with fp
  const kNew = deriveClientKeys('vp2-final-pw', cfgFresh.salt, cfgFresh.iters, cfgFresh.wrapped);
  check('E1 fresh cfg + fresh password unwrap the SAME AES1 (Type A)', kNew.aes1.equals(aes1));
  LS.cfg = cfgFresh; LS.cfgFp = cfgFpOf(cfgFresh); LS.cache = { v: 1, fp: LS.cfgFp, rows: 5 };

  // phase 2: server rewraps again (password rotated away) while browser is offline
  const re2 = buildRewrapMaterial(aes1, 'vp2-final-pw-2', 600000);
  const r2 = await jf('PUT', '/bootstrap/rewrap', { token: ADMIN, body: { wrapped: re2.wrappedB64, salt: re2.saltHex, iters: 600000 } });
  check('E2 second rewrap -> 200', r2.status === 200);
  const cfgAfter = (await jf('GET', '/config', { token: mat.auth_ui_hex })).json;

  // phase 3: OFFLINE unlock with the stale cached cfg + REVOKED password (documented trade-off)
  const kStale = deriveClientKeys('vp2-final-pw', LS.cfg.salt, LS.cfg.iters, LS.cfg.wrapped);
  check('E3 (documented trade-off) stale cfg + revoked pw still unwraps AES1 OFFLINE', kStale.aes1.equals(aes1));
  check('E4 offline hydration paints the stale universe (fp matches stale cfg)', hydrate() === true);

  // phase 5: ONLINE unlock with revoked pw — purge BEFORE derivation (app.js:724-728,733,753)
  const cachedCfg = LS.cfg;
  const changed = cachedCfg.salt !== cfgAfter.salt || cachedCfg.wrapped !== cfgAfter.wrapped;
  check('E5 online unlock detects cfg change (salt/wrapped differ)', changed === true);
  if (changed) purge();                                  // app.js:726
  LS.cfg = cfgAfter; LS.cfgFp = cfgFpOf(cfgAfter);       // app.js:733,753
  let revokedThrew = false;
  try { deriveClientKeys('vp2-final-pw', cfgAfter.salt, cfgAfter.iters, cfgAfter.wrapped); } catch { revokedThrew = true; }
  check('E6 revoked password FAILS online (fresh cfg)', revokedThrew === true);
  check('E7 stale cache REFUSED after purge + fresh fp (no ghost paint)', hydrate() === false);
  const kNew2 = deriveClientKeys('vp2-final-pw-2', cfgAfter.salt, cfgAfter.iters, cfgAfter.wrapped);
  check('E8 new password unlocks, same AES1/K_data', kNew2.aes1.equals(aes1) && Buffer.from(kNew2.kData).equals(Buffer.from(mat.k_data_hex, 'hex')));

  // phase 6: can a stale cfg+cache POISON a fresh universe (force re-bootstrap)?
  const mat2 = buildBootstrapMaterial('vp2-u2-pw', 600000);       // brand-new universe
  const rb = await jf('PUT', '/bootstrap', { token: ADMIN, body: { salt: mat2.saltHex, iters: 600000, wrapped: mat2.wrappedB64, auth_ui: mat2.authUiHex, auth_clock: mat2.authClockHex, force: true } });
  check('E9 force re-bootstrap to a fresh universe -> 200', rb.status === 200);
  const cfgU2 = (await jf('GET', '/config', { token: mat2.authUiHex })).json;
  // client still holds cfgAfter-cache; online unlock sees cfgU2:
  const changed2 = LS.cfg.salt !== cfgU2.salt || LS.cfg.wrapped !== cfgU2.wrapped;
  check('E10 fresh-universe cfg differs from cached -> purge fires', changed2 === true);
  if (changed2) purge();
  LS.cfg = cfgU2; LS.cfgFp = cfgFpOf(cfgU2);
  check('E11 old-universe cache cannot hydrate under the new universe fp', hydrate() === false);
  // fp collision would need salt|wrapped equality: 16-byte fresh salt + fresh wrap
  check('E12 fp is salt|wrapped (fresh random salt => fp collision infeasible)', cfgFpOf(cfgAfter) !== cfgFpOf(cfgU2));
  // cross-universe key isolation: old K_data cannot read new-universe rows
  const { encryptRow, decryptRow } = await import('../cli/bootstrap.mjs');
  const kDataU2 = Buffer.from(mat2.kDataHex, 'hex');
  const enc = encryptRow(kDataU2, 'vp2:u2:probe', 1, { events: [{ id: 'w:x', title: 'u2' }] });
  let crossOk = false;
  try { decryptRow(Buffer.from(mat.k_data_hex, 'hex'), 'vp2:u2:probe', 1, enc.nonce.toString('base64'), enc.ct.toString('base64')); } catch { crossOk = true; }
  check('E13 old-universe K_data CANNOT decrypt new-universe rows', crossOk === true);

  // restore MY universe for the record (rewrap back) — actually leave U2; stack is disposable.
}

console.log(`\nvp2-stack: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
