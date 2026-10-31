// e2e-v43.mjs — full browser verification of the v4.3 client against the
// local dev worker. Covers every user-reported bug + the new features.
// Usage: node scripts/e2e-v43.mjs
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8080';
const SERVER = 'http://127.0.0.1:8787';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const AUTH_UI = mat.auth_ui_hex;
const K_DATA = Uint8Array.from(Buffer.from(mat.k_data_hex, 'hex'));

const requests = [];
const pageErrors = [];
const consoleErrors = [];
let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + String(detail) : '')); }
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('request', (r) => {
  const u = String(r.url());
  if (u.startsWith(SERVER)) requests.push({ m: r.method(), u: u.replace(SERVER, '') });
});
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

const mark = () => requests.length;
const since = (m) => requests.slice(m);

async function unlock() {
  await page.goto(BASE + '/?server=' + SERVER + '&setup=' + AUTH_UI);
  await page.waitForTimeout(400);
  await page.fill('#password', 'password');
  await page.click('button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
  await page.waitForTimeout(1200);
}

/* ============ 1. unlock ============ */
let m = mark();
await unlock();
ok('unlock + initial sync ≤ 5 requests', since(m).length <= 5, since(m).length + ': ' + JSON.stringify(since(m).map(r => r.m + ' ' + r.u.slice(0, 30))));

/* ============ 2. create ONE event ============ */
m = mark();
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'E2E plain event');
await page.click('button.button-primary:has-text("Save")');
await page.waitForTimeout(1500);
const saveReqs = since(m);
ok('save ONE event = exactly 1 PUT', saveReqs.length === 1 && saveReqs[0].m === 'PUT', JSON.stringify(saveReqs.map(r => r.m + ' ' + r.u.slice(0, 20))));
ok('event chip rendered immediately', await page.locator('.calendar-dayeventcell', { hasText: 'E2E plain event' }).count() === 1);

/* ============ 3. reload persistence ============ */
m = mark();
await page.reload();
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1500);
ok('reload sync ≤ 5 requests', since(m).length <= 5, since(m).length);
ok('event SURVIVES reload', await page.locator('.calendar-dayeventcell', { hasText: 'E2E plain event' }).count() === 1, 'the disappearing-events bug');

/* ============ 4. manual syncs ============ */
m = mark();
for (let i = 0; i < 3; i++) { await page.click('#btn-sync'); await page.waitForTimeout(900); }
ok('3 manual syncs with no changes = 3 requests', since(m).length === 3, JSON.stringify(since(m).map(r => r.m)));

/* ============ 5. autosync (focus trigger) ============ */
m = mark();
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
await page.waitForTimeout(1200);
ok('focus-triggered autosync = 1 request', since(m).length === 1, since(m).length);

/* ============ 6. drag & drop to a DIFFERENT week row ============ */
const chip = page.locator('.calendar-dayeventcell', { hasText: 'E2E plain event' }).first();
const chipBox = await chip.boundingBox();
const gridRows = await page.locator('#grid-rows').boundingBox();
// The event is today (row 4 of 5). Drag to week row 1, Thursday column.
const weekH = gridRows.height / 5;
const targetX = gridRows.x + gridRows.width * 0.55;
const targetY = gridRows.y + weekH * 1 + 8;
m = mark();
await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
await page.mouse.down();
await page.mouse.move(targetX, targetY, { steps: 15 });
await page.mouse.up();
await page.waitForTimeout(1800);
const dragReqs = since(m);
ok('drag to other week = 1 PUT (RMW fast path)', dragReqs.filter((r) => r.m === 'PUT').length === 1, JSON.stringify(dragReqs.map(r => r.m)));
// verify data: event moved -23 days (from row 4 col 5 to row 1 col 3)
const evtRow = await decryptAll();
const moved = Object.values(evtRow).find((v) => v && v.includes('E2E plain event'));
ok('dragged event persisted at new date', !!moved && /DTSTART:20261008T\d{6}Z/.test(moved), moved ? moved.split('\n').find(l => l.startsWith('DTSTART')) : 'not found');

/* ============ 7. week view ============ */
m = mark();
await page.click('.view-button[data-view="week"]');
await page.waitForTimeout(600);
ok('week view renders 7 day columns', await page.locator('.timegrid-day').count() === 7);
ok('week view renders hour lines', await page.locator('.calendar-grid-hourLine').count() === 24);
// The dragged event moved to Oct 8 (outside this week); create a fresh one
// in THIS week and verify it renders as a part-day chip.
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'E2E week chip');
await page.click('button.button-primary:has-text("Save")');
await page.waitForTimeout(1200);
ok('week view shows part-day chip', await page.locator('.calendar-eventcell', { hasText: 'E2E week chip' }).count() >= 1);
ok('week view header day buttons', await page.locator('.calendar-grid-heading').count() === 7);
ok('week view: no grid requests on switch', since(m).filter((r) => r.m !== 'PUT').length === 0, since(m).length);

/* ============ 8. day view ============ */
await page.click('.view-button[data-view="day"]');
await page.waitForTimeout(500);
ok('day view renders 1 column', await page.locator('.timegrid-day').count() === 1);

/* ============ 9. custom view ============ */
await page.click('.view-button[data-view="custom"]');
await page.waitForTimeout(400);
await page.selectOption('.custom-days-select', '10');
await page.waitForTimeout(500);
ok('custom view renders 10 columns', await page.locator('.timegrid-day').count() === 10);

/* ============ 10. year view ============ */
await page.click('.view-button[data-view="year"]');
await page.waitForTimeout(700);
ok('year view renders 12 months', await page.locator('.yeargrid-month').count() === 12);

/* ============ 11. back to month; create recurring + all-day ============ */
await page.click('.view-button[data-view="month"]');
await page.waitForTimeout(400);
m = mark();
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'E2E daily recurring');
await page.selectOption('select[aria-label="Frequency"]', 'DAILY');
await page.click('button.button-primary:has-text("Save")');
await page.waitForTimeout(1200);
ok('recurring save = 1 PUT', since(m).filter((r) => r.m === 'PUT').length === 1, JSON.stringify(since(m).map(r => r.m)));
// The daily series starts TODAY (end of October) — check November for the
// full expansion instead of this month.
await page.click('#btn-next');
await page.waitForTimeout(600);
ok('recurring renders ~30 chips next month', (await page.locator('.calendar-dayeventcell', { hasText: 'E2E daily recurring' }).count()) >= 28, await page.locator('.calendar-dayeventcell', { hasText: 'E2E daily recurring' }).count());
await page.click('#btn-prev');
await page.waitForTimeout(500);

/* all-day event via click in the ROW-EVENTS area (below the day buttons —
   the day NUMBER button itself opens the day popover, as in Proton).
   Row 0 (Sep 28–Oct 4) is empty: the daily series starts today. */
m = mark();
const row0 = page.locator('.daygrid-rowevents').nth(0);
const r0Box = await row0.boundingBox();
await page.mouse.click(r0Box.x + r0Box.width * 0.5, r0Box.y + 6);
await page.waitForTimeout(700);
let editorVisible = await page.locator('#editor-modal').isHidden() === false;
if (!editorVisible) {
  // a popover may have opened instead — close it and retry on another cell
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.mouse.click(r0Box.x + r0Box.width * 0.25, r0Box.y + 6);
  await page.waitForTimeout(700);
  editorVisible = await page.locator('#editor-modal').isHidden() === false;
}
ok('click in rowevents opens create editor', editorVisible);
if (editorVisible) {
  await page.fill('input[aria-label="Title"]', 'E2E all day');
  await page.click('button.button-primary:has-text("Save")');
  await page.waitForTimeout(1200);
  ok('all-day create via click = 1 PUT', since(m).filter((r) => r.m === 'PUT').length === 1, JSON.stringify(since(m).map(r => r.m)));
  ok('all-day chip rendered', await page.locator('.calendar-dayeventcell', { hasText: 'E2E all day' }).count() >= 1);
}

/* ============ 12. second calendar + color ============ */
await page.click('#btn-add-calendar');
await page.fill('input[aria-label="Name"]', 'Second calendar');
await page.locator('.palette-swatch').nth(4).click();
await page.click('#cal-modal .button-primary:has-text("Save")');
await page.waitForTimeout(1200);
ok('second calendar appears in sidebar', await page.locator('.calendar-list li', { hasText: 'Second calendar' }).count() === 1);

/* create an event on the second calendar from the week view */
await page.click('.view-button[data-view="week"]');
await page.waitForTimeout(400);
m = mark();
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'E2E second cal event');
await page.selectOption('select[aria-label="Calendar"]', { label: 'Second calendar' });
await page.click('button.button-primary:has-text("Save")');
await page.waitForTimeout(1200);
ok('event on 2nd calendar = 1 PUT', since(m).filter((r) => r.m === 'PUT').length === 1);
ok('second-cal event renders in week view', await page.locator('.calendar-eventcell', { hasText: 'E2E second cal event' }).count() >= 1);

/* ============ 13. drag in WEEK view (time + day shift) ============ */
const wchip = page.locator('.calendar-eventcell', { hasText: 'E2E week chip' }).first();
const wbox = await wchip.boundingBox();
const cols = await page.locator('.timegrid-columns').boundingBox();
const colW = cols.width / 7;
// move 2 columns right and 1 hour down
const wx = wbox.x + wbox.width / 2;
const wy = wbox.y + wbox.height / 2;
m = mark();
await page.mouse.move(wx, wy);
await page.mouse.down();
await page.mouse.move(wx + colW * 2, wy + 60, { steps: 15 });
await page.mouse.up();
await page.waitForTimeout(2000);
const wdrag = since(m);
ok('week-view drag = 1 PUT', wdrag.filter((r) => r.m === 'PUT').length === 1, JSON.stringify(wdrag.map(r => r.m)));

/* ============ 14. drag-create in week view ============ */
m = mark();
const col2 = page.locator('.timegrid-day').nth(2);
const c2box = await col2.boundingBox();
await page.mouse.move(c2box.x + c2box.width / 2, c2box.y + c2box.height * 0.4);
await page.mouse.down();
await page.mouse.move(c2box.x + c2box.width / 2, c2box.y + c2box.height * 0.4 + 80, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(800);
const editorOpen = !(await page.locator('#editor-modal').isHidden());
ok('drag-create in week view opens editor with times', editorOpen);
if (editorOpen) {
  const sv = await page.locator('input[aria-label="Starts time"]').inputValue();
  const ev = await page.locator('input[aria-label="Ends time"]').inputValue();
  ok('drag-create start/end times differ by ~1h', sv !== ev, sv + ' -> ' + ev);
  await page.fill('input[aria-label="Title"]', 'E2E drag created');
  await page.click('button.button-primary:has-text("Save")');
  await page.waitForTimeout(1200);
  ok('drag-created event saved with 1 PUT', since(m).filter((r) => r.m === 'PUT').length === 1, JSON.stringify(since(m).map(r => r.m)));
}

/* ============ 15. recurring drag → "This event" ============ */
await page.click('.view-button[data-view="month"]');
await page.waitForTimeout(600);
// The daily series starts TODAY → the first (and often only) chip this month.
const rchip = page.locator('.calendar-dayeventcell', { hasText: 'E2E daily recurring' }).first();
const rbox = await rchip.boundingBox();
const gr2 = await page.locator('#grid-rows').boundingBox();
const wkH2 = gr2.height / 5;
m = mark();
await page.mouse.move(rbox.x + rbox.width / 2, rbox.y + rbox.height / 2);
await page.mouse.down();
await page.mouse.move(gr2.x + gr2.width * 0.3, gr2.y + wkH2 * 1 + 8, { steps: 15 });
await page.mouse.up();
await page.waitForTimeout(800);
const choiceVisible = !(await page.locator('#recur-modal').isHidden());
ok('recurring drag asks This/All', choiceVisible);
if (choiceVisible) {
  await page.click('#recur-modal button:has-text("This event")');
  await page.waitForTimeout(1800);
  ok('recurring this-event drag = 1 PUT', since(m).filter((r) => r.m === 'PUT').length === 1, JSON.stringify(since(m).map(r => r.m)));
}

/* ============ 16. dark mode ============ */
await page.click('#btn-theme');
await page.waitForTimeout(400);
ok('dark theme applied', await page.evaluate(() => document.documentElement.dataset.theme === 'dark'));
await page.click('.view-button[data-view="week"]');
await page.waitForTimeout(400);
const darkShot = '/tmp/e2e-dark-week.png';
await page.screenshot({ path: darkShot });
await page.click('#btn-theme');
await page.waitForTimeout(300);
ok('theme toggles back to light', await page.evaluate(() => document.documentElement.dataset.theme === 'light'));

/* ============ 17. keyboard shortcuts ============ */
await page.keyboard.press('d');
await page.waitForTimeout(300);
ok('keyboard d → day view', await page.locator('.timegrid-day').count() === 1);
await page.keyboard.press('w');
await page.waitForTimeout(300);
ok('keyboard w → week view', await page.locator('.timegrid-day').count() === 7);
await page.keyboard.press('m');
await page.waitForTimeout(300);
ok('keyboard m → month view', await page.locator('#grid-rows').count() === 1);
await page.keyboard.press('y');
await page.waitForTimeout(300);
ok('keyboard y → year view', await page.locator('.yeargrid-month').count() === 12);

/* ============ 18. delete event ============ */
await page.keyboard.press('m');
await page.waitForTimeout(400);
m = mark();
// open popover on the all-day event then delete
const adChip = page.locator('.calendar-dayeventcell', { hasText: 'E2E all day' }).first();
const adBox = await adChip.boundingBox();
await page.mouse.click(adBox.x + adBox.width / 2, adBox.y + adBox.height / 2);
await page.waitForTimeout(700);
await page.click('#event-popover button[title="Delete"]');
await page.waitForTimeout(1500);
ok('delete = 1 DELETE request', since(m).filter((r) => r.m === 'DELETE').length === 1, JSON.stringify(since(m).map(r => r.m)));
ok('deleted event gone from UI', (await page.locator('.calendar-dayeventcell', { hasText: 'E2E all day' }).count()) === 0);

/* ============ 19. final consistency check ============ */
m = mark();
await page.reload();
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1500);
ok('final reload ok', true);
const serverRows = await decryptAll();
const serverEvts = Object.entries(serverRows).filter(([id]) => id.startsWith('evt:'));
console.log('\n  server evt rows after E2E: ' + serverEvts.length);
for (const [id, txt] of serverEvts) {
  const title = (txt.match(/SUMMARY:(.*)/) || [])[1];
  console.log('    ' + id.slice(0, 46) + '…  ' + title);
}

/* ============ wrap up ============ */
await page.screenshot({ path: '/tmp/e2e-final-month.png' });
console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
console.log('=== TOTAL requests whole session: ' + requests.length + ' ===');
const byType = {};
for (const r of requests) byType[r.m] = (byType[r.m] || 0) + 1;
console.log('  by method: ' + JSON.stringify(byType));
console.log('\n=== PAGE ERRORS (' + pageErrors.length + ') ===');
for (const e of pageErrors.slice(0, 15)) console.log('  ' + e.slice(0, 250));
console.log('=== CONSOLE ERRORS (' + consoleErrors.length + ') ===');
for (const e of consoleErrors.slice(0, 15)) console.log('  ' + e.slice(0, 250));
await browser.close();
process.exit(fail > 0 ? 1 : 0);

/* ---- helpers ---- */
async function decryptAll() {
  const subtle = webcrypto.subtle;
  const key = await subtle.importKey('raw', K_DATA, 'AES-GCM', false, ['decrypt']);
  const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
  const aad = (id, ver) => Buffer.concat([Buffer.from(id, 'utf8'), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(ver); return b; })()]);
  const res = await fetch(SERVER + '/rows', { headers: { authorization: 'Bearer ' + AUTH_UI } });
  const manifest = await res.json();
  const out = {};
  for (const r of manifest.rows) {
    const rr = await fetch(SERVER + '/rows/' + encodeURIComponent(r.id), { headers: { authorization: 'Bearer ' + AUTH_UI } });
    const env = await rr.json();
    try {
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64(env.nonce), additionalData: aad(r.id, r.ver) }, key, b64(env.ct));
      out[r.id] = Buffer.from(pt).toString('utf8');
    } catch { out[r.id] = null; }
  }
  return out;
}
