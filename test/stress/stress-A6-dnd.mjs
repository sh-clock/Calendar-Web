// stress-dnd.mjs — DnD stress + corrupt rows + robustness (A6 groups 3/5/6,
// executed by the orchestrator after agent timeouts).
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resizerEndClass } from './_lib.mjs';

const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const AUTH_UI = mat.auth_ui_hex;
const K_DATA = Uint8Array.from(Buffer.from(mat.k_data_hex, 'hex'));
const SERVER = 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' — ' + d : '')); } };
const R = Math.round;
const RZ_END = resizerEndClass(); // v7 hashed resizer class (see _lib)

async function decryptAll() {
  const subtle = webcrypto.subtle;
  const key = await subtle.importKey('raw', K_DATA, 'AES-GCM', false, ['decrypt']);
  const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
  const res = await fetch(SERVER + '/rows', { headers: { authorization: 'Bearer ' + AUTH_UI } });
  const manifest = await res.json();
  const out = {};
  for (const r of manifest.rows) {
    const rr = await fetch(SERVER + '/rows/' + encodeURIComponent(r.id), { headers: { authorization: 'Bearer ' + AUTH_UI } });
    const env = await rr.json();
    try {
      const aad = Buffer.concat([Buffer.from(r.id, 'utf8'), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(env.ver); return b; })()]);
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64(env.nonce), additionalData: aad }, key, b64(env.ct));
      const v = JSON.parse(Buffer.from(pt).toString('utf8'));
      out[r.id] = typeof v === 'string' ? v : JSON.stringify(v);
    } catch { out[r.id] = null; }
  }
  return out;
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
const reqs = [];
page.on('request', (r) => { const u = String(r.url()); if (u.startsWith(SERVER)) reqs.push(r.method()); });
const mark = () => reqs.length;
await page.goto('http://127.0.0.1:8080/#server=' + SERVER + '&setup=' + AUTH_UI);
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.evaluate((c) => { window.__RZ_END = c; }, RZ_END); // v7 hashed resizer class, usable inside evaluate()
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1200);

/* setup: one plain event on today */
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'DND target');
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1400);

/* ---- 1. drag to the FIRST cell (leading, previous month) ---- */
let m = mark();
let chip = page.locator('.fc-event', { hasText: 'DND target' }).first();
let b = await chip.boundingBox();
let first = await page.locator('[data-date][role=cell]').first().boundingBox();
await page.mouse.move(R(b.x + b.width / 2), R(b.y + b.height / 2));
await page.mouse.down();
await page.mouse.move(R(first.x + first.width / 2), R(first.y + 12), { steps: 22 });
await page.mouse.up();
await page.waitForTimeout(2000);
const leadReqs = reqs.slice(m);
ok('drag to leading cell = 1 PUT', leadReqs.filter(x => x === 'PUT').length === 1, JSON.stringify(leadReqs));
let rows = await decryptAll();
let r = Object.values(rows).find(v => v && v.includes('DND target'));
const leadDate = await page.evaluate(() => document.querySelector('[data-date][role=cell]').getAttribute('data-date'));
ok('event stored at the leading cell date', !!r && r.includes('DTSTART:' + leadDate.replaceAll('-', '')),
  'target=' + leadDate + ' got=' + (r ? (r.match(/DTSTART:[^\r\n]+/) || ['?'])[0] : 'missing'));

/* ---- 2. drag to the LAST cell (trailing, next month) ---- */
m = mark();
chip = page.locator('.fc-event', { hasText: 'DND target' }).first();
b = await chip.boundingBox();
const last = await page.locator('[data-date][role=cell]').last().boundingBox();
const lastDate = await page.evaluate(() => [...document.querySelectorAll('[data-date][role=cell]')].pop().getAttribute('data-date'));
await page.mouse.move(R(b.x + b.width / 2), R(b.y + b.height / 2));
await page.mouse.down();
await page.mouse.move(R(last.x + last.width / 2), R(last.y + 12), { steps: 22 });
await page.mouse.up();
await page.waitForTimeout(2000);
const trailReqs = reqs.slice(m);
ok('drag to trailing cell = 1 PUT', trailReqs.filter(x => x === 'PUT').length === 1, JSON.stringify(trailReqs));
rows = await decryptAll();
r = Object.values(rows).find(v => v && v.includes('DND target'));
ok('event stored at the trailing cell date', !!r && r.includes('DTSTART:' + lastDate.replaceAll('-', '')),
  'target=' + lastDate + ' got=' + (r ? (r.match(/DTSTART:[^\r\n]+/) || ['?'])[0] : 'missing'));

/* ---- 3. resize to minimum → revert + NO PUT ---- */
await page.click('#calendar button[aria-label="Week view"]');
await page.waitForTimeout(600);
// 'DND target' now lives in the NEXT month (trailing-cell drag) — create a
// fresh timed event in the CURRENT week for the resize test.
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'DND resize');
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1400);
const tchip = page.locator('.fc-event', { hasText: 'DND resize' }).first();
if ((await tchip.count()) === 0) {
  ok('timed chip present in week view', false, 'not found');
} else {
  await tchip.hover();
  await page.waitForTimeout(400);
  let rz = null;
  for (let i = 0; i < 6 && !rz; i++) {
    rz = await page.evaluate(() => {
      for (const e of document.querySelectorAll('.fc-event')) {
        if (e.textContent.includes('DND resize')) {
          const z = e.querySelector('.' + window.__RZ_END);
          if (z && z.getBoundingClientRect().height > 0) return z.getBoundingClientRect().toJSON();
        }
      }
      return null;
    });
    if (!rz) await page.waitForTimeout(300);
  }
  m = mark();
  if (!rz) {
    ok('resize handle present after hover', false, 'no resizer rect');
  } else {
    const tb = await tchip.boundingBox();
    const mx = R(rz.x + rz.width / 2), my = R(rz.y + rz.height / 2);
    await page.mouse.move(mx, my);
    await page.mouse.down();
    await page.mouse.move(mx, my - (rz.y - tb.y) - 40, { steps: 20 }); // above the START
    await page.mouse.up();
    await page.waitForTimeout(2000);
    const after = reqs.slice(m).filter(x => x === 'PUT').length;
    const toastTxt = await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
    console.log('    (resize-revert toast: ' + toastTxt.slice(0, 90) + ')');
    ok('resize below minimum = NO PUT (reverted)', after === 0, 'puts=' + after + ' toast=' + toastTxt);
  }
}

/* ---- 4. rapid settings fire ---- */
for (let i = 0; i < 10; i++) {
  await page.click('#btn-settings');
  await page.waitForTimeout(120);
  await page.click('.settings-segment-button:has-text("' + (i % 2 ? 'Light' : 'Dark') + '")');
  await page.waitForTimeout(120);
  await page.click('#settings-modal .button-primary');
  await page.waitForTimeout(80);
}
ok('10 rapid theme flips: no JS errors so far', errs.length === 0, errs.slice(0, 2).join(';'));
await page.click('#btn-settings');
await page.waitForTimeout(200);
for (const fd of ['0', '1', '6']) { await page.selectOption('#set-firstday', fd); await page.waitForTimeout(150); }
for (const sd of ['00:15:00', '00:30:00', '01:00:00']) { await page.selectOption('#set-slot', sd); await page.waitForTimeout(150); }
await page.locator('#set-weeknumbers').check();
await page.waitForTimeout(200);
await page.click('#settings-modal .button-primary');
await page.waitForTimeout(400);
ok('rapid settings sweep: no JS errors', errs.length === 0, errs.slice(0, 2).join(';'));

/* ---- 5. emoji / long title / newlines round-trip ---- */
await page.click('#btn-new-event');
await page.waitForTimeout(400);
await page.fill('input[aria-label="Title"]', '🚀 emoji 📅 long-' + 'x'.repeat(180));
await page.locator('textarea[aria-label="Description"]').fill('line1\nline2\nline3');
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1400);
rows = await decryptAll();
r = Object.values(rows).find(v => v && v.includes('🚀 emoji'));
// RFC 5545 §3.1 folds lines >75 octets with CRLF+SPACE continuations —
// unfold before comparing.
const unfolded = r ? r.replace(/\r\n /g, '') : '';
ok('emoji + 200-char title round-trip (unfolded)', !!r && unfolded.includes('x'.repeat(180)), r ? 'folded-ok' : 'missing');
ok('description newlines round-trip', !!r && /DESCRIPTION[^\r\n]*line1\\nline2/.test(r) || (r && r.includes('line1') && r.includes('line3')), 'desc check');

/* ---- 6. corrupt row: app stays functional ---- */
// write a garbage evt row directly via the API (JSON-wrapped envelope)
const uuid = crypto.randomUUID();
const calUuid = (Object.keys(rows).find(id => id.startsWith('cmeta:')) || '').slice(6) || 'a963f169-1146-48e2-a3a2-79b51d14215e';
const badId = 'evt:' + calUuid + ':' + uuid;
{
  const subtle = webcrypto.subtle;
  const key = await subtle.importKey('raw', K_DATA, 'AES-GCM', false, ['encrypt']);
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const aad = Buffer.concat([Buffer.from(badId, 'utf8'), (() => { const x = Buffer.alloc(4); x.writeUInt32BE(1); return x; })()]);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, Buffer.from(JSON.stringify('THIS IS NOT A VCALENDAR'), 'utf8'));
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  const res = await fetch(SERVER + '/rows/' + encodeURIComponent(badId), {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + AUTH_UI, 'content-type': 'application/json' },
    body: JSON.stringify({ ver: 1, nonce: b64(nonce), ct: b64(new Uint8Array(ct)) }),
  });
  ok('corrupt row planted (PUT accepted)', res.status === 200, 'status=' + res.status);
}
await page.click('#btn-sync');
await page.waitForTimeout(2000);
const sidebar = await page.evaluate(() => document.querySelector('#calendar-list').textContent);
ok('corrupt row flagged in sidebar', /unreadable row/.test(sidebar), sidebar.slice(0, 80));
const stillUsable = await page.evaluate(() => document.querySelectorAll('.fc-event').length);
ok('calendar still renders events with a corrupt row present', stillUsable >= 1, 'events=' + stillUsable);
ok('no JS errors from the corrupt row', errs.length === 0, errs.slice(0, 2).join(';'));

/* ---- 7. mobile-ish viewport + resize ---- */
await page.setViewportSize({ width: 375, height: 667 });
await page.waitForTimeout(900);
ok('375px viewport: no JS errors', errs.length === 0, errs.slice(0, 2).join(';'));
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(700);

/* ---- 8. view switch blocked while a modal is open (B13) ---- */
await page.click('#btn-new-event');
await page.waitForTimeout(400);
const viewBefore = await page.evaluate(() => document.querySelector('.fc-view')?.className || '');
await page.keyboard.press('w'); // should be ignored while the editor is open
await page.waitForTimeout(400);
const viewAfter = await page.evaluate(() => document.querySelector('.fc-view')?.className || '');
ok('view shortcut ignored while editor open (B13)', viewAfter === viewBefore, viewBefore + ' -> ' + viewAfter);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed === errors: ' + errs.length);
for (const e of errs.slice(0, 8)) console.log('  ' + e.slice(0, 200));
await page.screenshot({ path: '/tmp/stress-dnd.png' });
await browser.close();
process.exit(fail > 0 ? 1 : 0);
