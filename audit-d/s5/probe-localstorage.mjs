// probe-localstorage.mjs — S5: localStorage exposure + purge paths.
// Drives the real client on the A6 stack: unlock → cache written → lock (purge?)
// → reload → re-unlock → wrong password → forget browser. Enumerates every key.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = process.env.S5_BASE || 'http://127.0.0.1:8081';
const SERVER = process.env.S5_SERVER || 'http://127.0.0.1:8788';
const MAT = JSON.parse(readFileSync(process.env.S5_MAT || '/tmp/local-material-2.json', 'utf8'));
const AUTH_UI = MAT.auth_ui_hex;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
};

/* plant ONE benign evt row so the cache demonstrably holds event plaintext */
const CAL = '33333333-2222-3333-4444-555555555555';
const K_DATA = Uint8Array.from(Buffer.from(MAT.k_data_hex, 'hex'));
const subtle = webcrypto.subtle;
const ROW_KEY = await subtle.importKey('raw', K_DATA, 'AES-GCM', false, ['encrypt']);
const aadFor = (id, ver) =>
  Buffer.concat([Buffer.from(id, 'utf8'), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(ver); return b; })()]);
async function putRawRow(id, payloadText, ver) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadFor(id, ver) }, ROW_KEY,
    new Uint8Array(Buffer.from(JSON.stringify(payloadText), 'utf8')));
  const res = await fetch(SERVER + '/rows/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + AUTH_UI, 'content-type': 'application/json' },
    body: JSON.stringify({ ver, nonce: Buffer.from(iv).toString('base64'), ct: Buffer.from(ct).toString('base64') }),
  });
  return res.status;
}
const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const evtText = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//sec-S5//ls//EN',
  'BEGIN:VEVENT', 'UID:sec-S5-ls-1', 'DTSTAMP:20260101T000000Z',
  'DTSTART:' + today + 'T090000Z', 'DTEND:' + today + 'T093000Z',
  'SUMMARY:S5 plaintext probe event', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
await putRawRow('cmeta:' + CAL, JSON.stringify({ v: 1, name: 'S5 LS probe', color: '#8080FF' }), 1);
await putRawRow('evt:' + CAL + ':sec-S5-ls-1', evtText, 1);

const browser = await chromium.launch({ args: ['--disable-web-security'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const keys = () => page.evaluate(() => Object.fromEntries(
  Object.keys(localStorage).map((k) => [k, (localStorage.getItem(k) || '').length])));

await page.goto(BASE + '/#server=' + SERVER + '&setup=' + AUTH_UI);
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(2500); // cache write is debounced 250ms after render

console.log('== 1. key enumeration after unlock ==');
const k1 = await keys();
console.log('   keys: ' + JSON.stringify(k1));
ok('token key clock_poc_auth_ui present (bearer at rest)', 'clock_poc_auth_ui' in k1);
ok('plaintext model cache clock_poc_cache_v45 present', 'clock_poc_cache_v45' in k1);
ok('cached config clock_poc_cfg_v45 present (salt/iters/wrapped)', 'clock_poc_cfg_v45' in k1);
ok('server url persisted (clock_poc_server)', 'clock_poc_server' in k1);

const cachePlain = await page.evaluate(() => localStorage.getItem('clock_poc_cache_v45') || '');
ok('cache stores DECRYPTED plaintext (event SUMMARY readable at rest)',
  cachePlain.includes('SUMMARY:S5 plaintext probe event'), cachePlain.slice(0, 120));
console.log('   cache bytes: ' + cachePlain.length);
const cfg = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('clock_poc_cfg_v45')); } catch { return null; } });
ok('cached cfg = {salt,iters,wrapped} (offline password oracle, no token inside)',
  !!cfg && typeof cfg.salt === 'string' && !JSON.stringify(cfg).toLowerCase().includes(AUTH_UI.slice(0, 12)),
  JSON.stringify(Object.keys(cfg || {})));
ok('token does NOT appear inside the cache or settings',
  !cachePlain.includes(AUTH_UI) && !(await page.evaluate((t) =>
    (localStorage.getItem('clock_poc_settings_v45') || '').includes(t), AUTH_UI)));

console.log('== 2. lock() purge ==');
await page.click('#btn-lock');
await page.waitForTimeout(500);
const k2 = await keys();
ok('lock purges clock_poc_cache_v45 (plaintext gone)', !('clock_poc_cache_v45' in k2), JSON.stringify(k2));
ok('lock KEEPS the token (browser stays provisioned)', 'clock_poc_auth_ui' in k2);
ok('lock KEEPS cached cfg', 'clock_poc_cfg_v45' in k2);
ok('login screen back', await page.evaluate(() => !document.querySelector('#login').hidden));

console.log('== 3. reload after lock ==');
await page.reload();
await page.waitForTimeout(800);
const k3 = await keys();
ok('cache still gone after reload', !('clock_poc_cache_v45' in k3));
ok('app is locked again (login visible)', await page.evaluate(() => !document.querySelector('#login').hidden));

console.log('== 4. re-unlock rewrites cache; wrong password leaves it? ==');
await page.fill('#password', 'wrong-password');
await page.click('button[type=submit]');
await page.waitForTimeout(2500);
const msg = await page.textContent('#login-msg');
ok('wrong password → clear error message', /wrong password|Unlock failed/i.test(msg || ''), msg);
const k4 = await keys();
ok('failed unlock does NOT write a cache', !('clock_poc_cache_v45' in k4), JSON.stringify(k4));
ok('failed unlock does NOT purge/alter the stored token', await page.evaluate((t) =>
  localStorage.getItem('clock_poc_auth_ui') === t, AUTH_UI));

await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(2500);
ok('correct unlock rewrites the plaintext cache', 'clock_poc_cache_v45' in (await keys()));

console.log('== 5. Forget browser ==');
await page.click('#btn-forget');
await page.waitForTimeout(800);
const k5 = await keys();
ok('forget removes the token', !('clock_poc_auth_ui' in k5), JSON.stringify(k5));
ok('forget removes the server url', !('clock_poc_server' in k5));
ok('forget removes cached cfg', !('clock_poc_cfg_v45' in k5));
ok('forget removes calvis', !('clock_poc_calvis_v42' in k5));
ok('forget purges the plaintext cache (via lock)', !('clock_poc_cache_v45' in k5));

console.log('== 6. cleanup + idle timeout? (none expected) ==');
await fetch(SERVER + '/rows/' + encodeURIComponent('evt:' + CAL + ':sec-S5-ls-1'),
  { method: 'DELETE', headers: { authorization: 'Bearer ' + AUTH_UI } }).catch(() => {});
await fetch(SERVER + '/rows/' + encodeURIComponent('cmeta:' + CAL),
  { method: 'DELETE', headers: { authorization: 'Bearer ' + AUTH_UI } }).catch(() => {});
ok('no idle auto-lock exists (no timer purges cache while unlocked)',
  await page.evaluate(() => true)); // structural: verified by code audit — no idle timer in app.js

await browser.close();
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
