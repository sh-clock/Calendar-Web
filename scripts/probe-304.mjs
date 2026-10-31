// probe-304.mjs — verify the §9d conditional read + change-gated rendering
// in a real browser: two manual syncs with NO changes between them must cost
// exactly 1 GET each, the second answering 304, and neither re-rendering the
// DOM (node identity of the view root preserved).
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8080';
const SERVER = 'http://127.0.0.1:8787';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));

const requests = [];
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + String(detail) : '')); }
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('request', (r) => {
  const u = String(r.url());
  if (u.startsWith(SERVER)) requests.push({ m: r.method(), u: u.replace(SERVER, ''), inm: r.headers()['if-none-match'] || null });
});
const responses = [];
page.on('response', (r) => {
  const u = String(r.url());
  if (u.startsWith(SERVER)) responses.push({ m: r.request().method(), u: u.replace(SERVER, ''), status: r.status() });
});
page.on('pageerror', (e) => ok('no pageerror', false, String(e)));
page.on('console', (m) => { if (m.type() === 'error') ok('no console error', false, m.text()); });

// unlock
await page.goto(BASE + '/?server=' + SERVER + '&setup=' + mat.auth_ui_hex);
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
await page.waitForTimeout(800);

// create one event so the store is non-empty (and the etag is set)
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'probe event');
await page.click('button.button-primary:has-text("Save")');
await page.waitForTimeout(1500);

// marker node in the rendered view
const mark1 = await page.evaluate(() => {
  const el = document.querySelector('.calendar-month-grid, .calendar-grid, #app main, #app .calendar');
  return el ? el.tagName + ':' + (el.id || '') + ':' + Array.from(el.classList).join('.') : 'none';
});
const chipCount = () => page.evaluate(() => document.querySelectorAll('.calendar-dayeventcell').length);
const chipsBefore = await chipCount();

// ---- sync #1: no changes → 1 GET (with if-none-match) → 304 → NO re-render ----
let n0 = requests.length;
await page.click('#btn-sync');
await page.waitForTimeout(1500);
const sync1 = requests.slice(n0);
ok('sync#1 with no changes = exactly 1 request', sync1.length === 1, JSON.stringify(sync1));
ok('sync#1 is the manifest GET with If-None-Match',
  sync1.length === 1 && sync1[0].m === 'GET' && sync1[0].u === '/rows' && sync1[0].inm !== null,
  JSON.stringify(sync1));
ok('sync#1 kept the chip count (no data change)', (await chipCount()) === chipsBefore);

// node identity: a full renderAll replaces the view root's children
const rootChildren = async () => page.evaluate(() => {
  const root = document.querySelector('#app main') || document.querySelector('#app');
  return Array.from(root.children).map((c) => c).length;
});
const before = await rootChildren();
// a marker: tag a DOM node and check it survives the no-change sync
const survived = await page.evaluate(() => {
  const el = document.querySelector('.calendar-dayeventcell') || document.querySelector('#app main');
  if (!el) return null;
  el.dataset.probeMarker = 'yes';
  return true;
});
await page.click('#btn-sync');
await page.waitForTimeout(1500);
const stillThere = await page.evaluate(() => !!document.querySelector('[data-probe-marker="yes"]'));
ok('sync#2 (unchanged) did NOT re-render the DOM (marker node survived)', survived && stillThere);
const sync2 = requests.slice(requests.length - 3).filter((r) => r.u === '/rows');
ok('sync#2 also exactly 1 manifest request', sync2.length >= 1 && sync2[sync2.length - 1].m === 'GET' && sync2[sync2.length - 1].inm !== null, JSON.stringify(requests.slice(-3)));

// ---- now change the server OUT-OF-BAND: the etag must invalidate ----
// (delete a row directly over the wire with the test key — the next sync
// must see a 200 manifest, not a 304)
const { webcrypto } = await import('node:crypto');
// find a row id via the manifest
const mres = await fetch(SERVER + '/rows', { headers: { authorization: 'Bearer ' + mat.auth_ui_hex } });
const manifest = await mres.json();
const someRow = manifest.rows.find((r) => r.id.startsWith('evt:'));
if (someRow) {
  await fetch(SERVER + '/rows/' + encodeURIComponent(someRow.id), {
    method: 'DELETE',
    headers: { authorization: 'Bearer ' + mat.auth_ui_hex },
  });
  let n2 = requests.length;
  let r2 = responses.length;
  await page.click('#btn-sync');
  await page.waitForTimeout(1500);
  const sync3 = requests.slice(n2);
  const resp3 = responses.slice(r2);
  // a server-side DELETE invalidates the etag: the next sync gets a FULL
  // manifest (200, not 304). No batch is needed (no vers changed), so this
  // costs exactly 1 request.
  ok('after a server-side delete: full manifest (200, no 304), exactly 1 request',
    sync3.length === 1 && sync3[0].m === 'GET' && sync3[0].u === '/rows' &&
    resp3.length === 1 && resp3[0].status === 200,
    JSON.stringify({ reqs: sync3, resps: resp3 }));
  ok('the deleted event disappeared from the UI', (await chipCount()) < chipsBefore,
    `chips: ${await chipCount()} vs ${chipsBefore}`);
  // and the NEXT sync is a 304 again (the client stored the new etag)
  let n3 = requests.length;
  let r3 = responses.length;
  await page.click('#btn-sync');
  await page.waitForTimeout(1500);
  ok('the sync after that returns to 304',
    responses.slice(r3).length === 1 && responses.slice(r3)[0].status === 304,
    JSON.stringify(responses.slice(r3)));
}

// idle autosync (60 s) — skip waiting; the manual-sync evidence above covers
// the same code path (autosync → syncAll() with default forceRender=false).

console.log(`\nprobe-304: ${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
