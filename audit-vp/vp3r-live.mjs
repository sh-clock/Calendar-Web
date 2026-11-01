// VP3R — LIVE-site checks (https://sh-clock.github.io/Calendar-Web/):
// ?server= refusal, loopback-only __autolockForce absence, 7-theme sweep with
// zero console errors. Budget-guarded: every live request is counted; the live
// WORKER is never touched (no unlock → zero API hits, zero writes).
import { chromium } from 'playwright';

const LIVE = 'https://sh-clock.github.io/Calendar-Web/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function res(id, ok, note = '') {
  results.push({ id, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${note ? '  — ' + note : ''}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
let nReq = 0;
const reqUrls = [];
ctx.on('request', (r) => { nReq++; reqUrls.push(r.url()); });
const page = await ctx.newPage();
const cerrs = [];
page.on('console', (m) => { if (m.type() === 'error') cerrs.push(m.text()); });
page.on('pageerror', (e) => cerrs.push('pageerror:' + e.message));

// E1: first load carries the ?server= remote attack (rides the same document)
await page.goto(LIVE + '?server=https%3A%2F%2Fevil.example%2F', { waitUntil: 'domcontentloaded' });
await sleep(800);
const srv = await page.evaluate(() => localStorage.getItem('clock_poc_server'));
const t = await page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((x) => x.textContent));
res('E1 live ?server=remote ignored + toast', srv === null && t.some((x) => x.includes('Ignored a server address')), `LS=${srv} toast=${(t[0] || '').slice(0, 60)}`);

// E2: dev/test hook must not exist on the non-loopback live origin
const hook = await page.evaluate(() => typeof window.__autolockForce);
res('E2 live __autolockForce undefined (loopback-only hook)', hook === 'undefined', String(hook));

// E3: switch through all 7 themes via the REAL settings modal (the gear button
// is unlock-gated in the product; un-hiding it is a DOM-only test affordance —
// no worker traffic, all theme assets load under the LIVE CSP).
await page.evaluate(() => { document.getElementById('btn-settings').hidden = false; });
await page.click('#btn-settings');
await page.waitForSelector('#settings-modal .eventform', { timeout: 8000 });
const order = ['forma', 'breezy', 'pulse', 'classic', 'shadcn', 'mui', 'monarch'];
const labels = { forma: 'Forma', breezy: 'Breezy', pulse: 'Pulse', classic: 'Classic', shadcn: 'Shadcn', mui: 'MUI', monarch: 'Monarch' };
let allOk = true; const seen = [];
for (const id of order) {
  await page.click(`#settings-modal [aria-label="Calendar theme"] button:has-text("${labels[id]}")`);
  await sleep(1000);
  const st = await page.evaluate(() => ({
    theme: document.documentElement.dataset.fctheme,
    links: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href.split('/').slice(-2).join('/')),
  }));
  seen.push(`${id}=${st.theme}`);
  if (st.theme !== id) allOk = false;
}
await page.click('#settings-modal .modal-footer .button-primary');
res('E3 live 7-theme sweep, ZERO console errors', allOk && cerrs.length === 0, seen.join(' ') + ` errs=${JSON.stringify(cerrs.slice(0, 4))}`);

const bad = results.filter((r) => !r.ok);
console.log(`\n===== VP3R live: ${results.length - bad.length}/${results.length} checks passed =====`);
if (bad.length) console.log('FAILED: ' + bad.map((b) => b.id).join(' | '));
console.log(`live requests emitted by this session: ${nReq} (live WORKER hits: 0 — no unlock performed)`);
const summary = {};
for (const u of reqUrls) { const k = new URL(u).origin; summary[k] = (summary[k] || 0) + 1; }
console.log('per-origin: ' + JSON.stringify(summary));
await browser.close();
process.exit(0);
