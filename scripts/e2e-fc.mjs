// e2e-fc.mjs — full browser verification of the FullCalendar-based client
// against the local dev worker. Covers every e2e-v43 scenario on the new
// UI + resize + settings (the rework's new surfaces).
// Usage: node scripts/e2e-fc.mjs  (run-e2e.sh boots the stack)
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
const R = (n) => Math.round(n);

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
const puts = (arr) => arr.filter((r) => r.m === 'PUT').length;

async function unlock() {
  await page.goto(BASE + '/?server=' + SERVER + '&setup=' + AUTH_UI);
  await page.waitForTimeout(400);
  await page.fill('#password', 'password');
  await page.click('button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
  await page.waitForTimeout(1200);
}

const monthBtn = () => page.click('.fc-dayGridMonth-button');
const weekBtn = () => page.click('.fc-timeGridWeek-button');

/* ============ 1. unlock ============ */
let m = mark();
await unlock();
ok('unlock + initial sync ≤ 5 requests', since(m).length <= 5, since(m).length + ': ' + JSON.stringify(since(m).map(r => r.m + ' ' + r.u.slice(0, 26))));

/* ============ 2. create ONE event (all-day default from month click? No — New event button = timed) ============ */
m = mark();
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'E2E plain event');
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1500);
const saveReqs = since(m);
ok('save ONE event = exactly 1 PUT', saveReqs.length === 1 && saveReqs[0].m === 'PUT', JSON.stringify(saveReqs.map(r => r.m + ' ' + r.u.slice(0, 20))));
ok('event chip rendered immediately', await page.locator('.fc-event', { hasText: 'E2E plain event' }).count() === 1);

/* ============ 3. reload persistence ============ */
m = mark();
await page.reload();
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1500);
ok('reload sync ≤ 5 requests', since(m).length <= 5, since(m).length);
ok('event SURVIVES reload', await page.locator('.fc-event', { hasText: 'E2E plain event' }).count() === 1, 'the disappearing-events bug');

/* ============ 4. manual syncs ============ */
m = mark();
for (let i = 0; i < 3; i++) { await page.click('#btn-sync'); await page.waitForTimeout(900); }
ok('3 manual syncs with no changes = 3 requests', since(m).length === 3, JSON.stringify(since(m).map(r => r.m)));

/* ============ 5. autosync (focus trigger) ============ */
m = mark();
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
await page.waitForTimeout(1200);
ok('focus-triggered autosync = 1 request', since(m).length === 1, since(m).length);

/* ============ 6. month-grid drag to a DIFFERENT week row ============ */
const chip = page.locator('.fc-event', { hasText: 'E2E plain event' }).first();
const chipBox = await chip.boundingBox();
const anyDay = page.locator('.fc-daygrid-day').nth(21); // a middle cell of the grid
const dayBox = await anyDay.boundingBox();
m = mark();
await page.mouse.move(R(chipBox.x + chipBox.width / 2), R(chipBox.y + chipBox.height / 2));
await page.mouse.down();
await page.mouse.move(R(dayBox.x + dayBox.width / 2), R(dayBox.y + 12), { steps: 20 });
await page.mouse.up();
await page.waitForTimeout(1800);
const dragReqs = since(m);
ok('month drag to other week = 1 PUT (RMW fast path)', puts(dragReqs) === 1, JSON.stringify(dragReqs.map(r => r.m)));
// verify data: the event moved to the target day
const evtRow1 = await decryptAll();
const moved1 = Object.values(evtRow1).find((v) => v && v.includes('E2E plain event'));
const targetDay = await page.evaluate((idx) => {
  const d = document.querySelectorAll('.fc-daygrid-day')[idx];
  return d ? d.getAttribute('data-date') : null;
}, 21);
ok('dragged event persisted at target date', !!moved1 && !!targetDay && moved1.includes('DTSTART:' + targetDay.replaceAll('-', '')),
  'target=' + targetDay + ' row=' + (moved1 ? moved1.split('\n').find(l => l.startsWith('DTSTART')) : 'not found'));

/* ============ 7. week view ============ */
m = mark();
await weekBtn();
await page.waitForTimeout(700);
ok('week view renders 7 day columns (+axis)', await page.locator('.fc-timegrid-col').count() === 8);
ok('week view renders 48 half-hour slots', await page.locator('.fc-timegrid-slot-lane').count() === 48);
ok('week view: plain event (moved to Oct 19 by §6) correctly absent', await page.locator('.fc-event', { hasText: 'E2E plain event' }).count() === 0);
ok('week view: no grid requests on switch', since(m).filter((r) => r.m !== 'PUT').length === 0, since(m).length);
ok('now indicator visible', await page.locator('.fc-timegrid-now-indicator-line').count() >= 1);

/* ============ 8. day view ============ */
await page.click('.fc-timeGridDay-button');
await page.waitForTimeout(500);
ok('day view renders 1 column (+axis)', await page.locator('.fc-timegrid-col').count() === 2);

/* ============ 9. custom view (settings-driven day count) ============ */
await page.click('#btn-settings');
await page.waitForTimeout(400);
await page.selectOption('#set-customdays', '10');
await page.waitForTimeout(600);
await page.click('#settings-modal .button-primary'); // Done
await page.waitForTimeout(400);
await page.click('.fc-custom-button');
await page.waitForTimeout(700);
ok('custom view renders 10 columns (+axis)', await page.locator('.fc-timegrid-col').count() === 11);

/* ============ 10. year view ============ */
await page.click('.fc-multiMonthYear-button');
await page.waitForTimeout(900);
ok('year view renders 12 months', await page.locator('.fc-multimonth-month').count() === 12);

/* ============ 11. agenda (list) view ============ */
await page.click('.fc-listYear-button');
await page.waitForTimeout(700);
ok('agenda lists saved events', await page.locator('.fc-list-event', { hasText: 'E2E plain event' }).count() >= 1);

/* ============ 12. back to month; recurring + all-day ============ */
await monthBtn();
await page.waitForTimeout(500);
m = mark();
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'E2E daily recurring');
await page.selectOption('select[aria-label="Frequency"]', 'DAILY');
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1200);
ok('recurring save = 1 PUT', puts(since(m)) === 1, JSON.stringify(since(m).map(r => r.m)));
// The daily series starts today — next month must show the full expansion.
await page.click('.fc-next-button');
await page.waitForTimeout(800);
ok('recurring renders ~30 chips next month', (await page.locator('.fc-event', { hasText: 'E2E daily recurring' }).count()) >= 28, await page.locator('.fc-event', { hasText: 'E2E daily recurring' }).count());
await page.click('.fc-prev-button');
await page.waitForTimeout(600);

/* all-day event via click on an empty day cell (dateClick → editor) */
m = mark();
const emptyDay = page.locator('.fc-daygrid-day').nth(8);
const edBox = await emptyDay.boundingBox();
await page.mouse.click(R(edBox.x + edBox.width / 2), R(edBox.y + 30));
await page.waitForTimeout(700);
const editorVisible = await page.locator('#editor-modal').isVisible();
ok('click on day cell opens create editor (all-day)', editorVisible);
if (editorVisible) {
  await page.fill('input[aria-label="Title"]', 'E2E all day');
  await page.click('#editor-modal .button-primary');
  await page.waitForTimeout(1200);
  ok('all-day create via click = 1 PUT', puts(since(m)) === 1, JSON.stringify(since(m).map(r => r.m)));
  ok('all-day chip rendered', await page.locator('.fc-event', { hasText: 'E2E all day' }).count() >= 1);
}

/* ============ 13. second calendar + colour ============ */
await page.click('#btn-add-calendar');
await page.fill('input[aria-label="Name"]', 'Second calendar');
await page.locator('.palette-swatch').nth(4).click();
await page.click('#cal-modal .button-primary');
await page.waitForTimeout(1200);
ok('second calendar appears in sidebar', await page.locator('.calendar-list li', { hasText: 'Second calendar' }).count() === 1);

/* create an event on the second calendar from the week view.
 * NOTE: §12's next/prev leaves the calendar date at the month START
 * (native FC month navigation semantics) — go to today first. */
await page.click('.minicalendar-day.today'); // gotoDate(today) — the FC today button is disabled (this month already contains today)
await page.waitForTimeout(500);
await weekBtn();
await page.waitForTimeout(500);
m = mark();
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'E2E second cal event');
await page.selectOption('select[aria-label="Calendar"]', { label: 'Second calendar' });
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1200);
ok('event on 2nd calendar = 1 PUT', puts(since(m)) === 1);
const secondCalCount = await page.locator('.fc-event', { hasText: 'E2E second cal event' }).count();
ok('second-cal event renders in week view', secondCalCount >= 1,
  'count=' + secondCalCount + ' DOM=' + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.fc-event')].map(e => e.textContent.trim().slice(0, 30)))).slice(0, 300));

/* ============ 14. timed drag in WEEK view (day + time shift) ============ */
const wchip = page.locator('.fc-timegrid-event', { hasText: 'E2E second cal event' }).first();
const wbox = await wchip.boundingBox();
const colsBox = await page.locator('.fc-timegrid-cols').first().boundingBox();
const colW = (colsBox ? colsBox.width : 1188) / 7;
m = mark();
const wx = R(wbox.x + wbox.width / 2);
const wy = R(wbox.y + wbox.height / 2);
// The event is on Saturday (today = last column of the week) — drag LEFT
// two columns (+2 would leave the 1440px viewport; FC then reverts silently).
await page.mouse.move(wx, wy);
await page.mouse.down();
await page.mouse.move(wx - R(colW * 2), wy + 60, { steps: 20 });
await page.mouse.up();
await page.waitForTimeout(2000);
const wdrag = since(m);
ok('week-view drag = 1 PUT', puts(wdrag) === 1, JSON.stringify(wdrag.map(r => r.m)));

/* ============ 15. drag-create in week view (select) ============ */
m = mark();
// §14's drag moved 'E2E second cal event' TWO columns left — find a point
// guaranteed NOT covered by any event (a select starting on an event is an
// event-drag, never a create-select).
const point = await page.evaluate(() => {
  const scr = [...document.querySelectorAll('.fc-scroller')].reduce((a, e) => {
    const r = e.getBoundingClientRect();
    return r.height > (a ? a.h : 0) ? { x: r.x, y: r.y, h: r.height } : a;
  }, null);
  const cols = [...document.querySelectorAll('.fc-timegrid-col[data-date]')];
  const evs = [...document.querySelectorAll('.fc-timegrid-event')].map(e => e.getBoundingClientRect());
  for (const c of cols) {
    const r = c.getBoundingClientRect();
    const cx = r.x + Math.min(30, r.width / 2);
    for (let fy = 0.25; fy <= 0.75; fy += 0.125) {
      const cy = scr.y + scr.h * fy;
      if (!evs.some(ev => cx >= ev.x - 2 && cx <= ev.x + ev.width + 2 && cy >= ev.y - 2 && cy <= ev.y + ev.height + 2)) {
        return { x: Math.round(cx), y: Math.round(cy) };
      }
    }
  }
  return null;
});
if (point) {
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y + 80, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(800);
}
const editorOpen = await page.locator('#editor-modal').isVisible();
ok('drag-create in week view opens editor with times', editorOpen);
if (editorOpen) {
  const sv = await page.locator('input[aria-label="Starts time"]').inputValue();
  const ev = await page.locator('input[aria-label="Ends time"]').inputValue();
  ok('drag-create start/end times differ', sv !== ev, sv + ' -> ' + ev);
  await page.fill('input[aria-label="Title"]', 'E2E drag created');
  await page.click('#editor-modal .button-primary');
  await page.waitForTimeout(1200);
  ok('drag-created event saved with 1 PUT', puts(since(m)) === 1, JSON.stringify(since(m).map(r => r.m)));
}

/* ============ 16. RESIZE (new in the FullCalendar UI) ============ */
m = mark();
const rchip = page.locator('.fc-timegrid-event', { hasText: 'E2E second cal event' }).first();
const rbox = await rchip.boundingBox();
await page.mouse.move(R(rbox.x + rbox.width / 2), R(rbox.y + rbox.height / 2));
await page.waitForTimeout(400); // hover → FullCalendar shows the resizer
const rz = await page.evaluate(() => {
  for (const e of document.querySelectorAll('.fc-timegrid-event')) {
    if (e.textContent.includes('E2E second cal event')) {
      const z = e.querySelector('.fc-event-resizer');
      return z ? z.getBoundingClientRect().toJSON() : null;
    }
  }
  return null;
});
if (rz && rz.height > 0) {
  const mx = R(rz.x + rz.width / 2);
  const my = R(rz.y + rz.height / 2);
  await page.mouse.move(mx, my);
  await page.mouse.down();
  await page.mouse.move(mx, my + 60, { steps: 20 }); // +2h on the 30-min grid
  await page.mouse.up();
  await page.waitForTimeout(2000);
  ok('resize = 1 PUT', puts(since(m)) === 1, JSON.stringify(since(m).map(r => r.m)));
  const rowsR = await decryptAll();
  const resized = Object.entries(rowsR).find(([id, v]) => v && v.includes('E2E second cal event'));
  const dtend = resized ? (resized[1].match(/DTEND:(\d{8})T(\d{6})Z?/) || [])[0] : null;
  const dtstart = resized ? (resized[1].match(/DTSTART:(\d{8})T(\d{6})Z?/) || [])[0] : null;
  ok('resize persisted new DTEND', !!dtend && !!dtstart && dtend !== dtstart, dtstart + ' -> ' + dtend);
} else {
  ok('resize handle present after hover', false, 'no resizer rect');
}

/* ============ 17. recurring drag → "This event" ============ */
await monthBtn();
await page.waitForTimeout(700);
const rchip2 = page.locator('.fc-event', { hasText: 'E2E daily recurring' }).first();
const rbox2 = await rchip2.boundingBox();
const dest = page.locator('.fc-daygrid-day').nth(14);
const dbox = await dest.boundingBox();
m = mark();
await page.mouse.move(R(rbox2.x + rbox2.width / 2), R(rbox2.y + rbox2.height / 2));
await page.mouse.down();
await page.mouse.move(R(dbox.x + dbox.width / 2), R(dbox.y + 12), { steps: 20 });
await page.mouse.up();
await page.waitForTimeout(800);
const choiceVisible = await page.locator('#recur-modal').isVisible();
ok('recurring drag asks This/All', choiceVisible);
if (choiceVisible) {
  await page.click('#recur-modal button:has-text("This event")');
  await page.waitForTimeout(1800);
  ok('recurring this-event drag = 1 PUT', puts(since(m)) === 1, JSON.stringify(since(m).map(r => r.m)));
}

/* ============ 18. settings: theme + accent + first day + 24h ============ */
m = mark();
await page.click('#btn-settings');
await page.waitForTimeout(400);
ok('settings modal opens', await page.locator('#settings-modal').isVisible());
await page.click('.settings-segment-button:has-text("Dark")');
await page.waitForTimeout(400);
ok('dark theme applied from settings', await page.evaluate(() => document.documentElement.dataset.theme === 'dark'));
await page.click('.settings-segment-button:has-text("Light")');
await page.waitForTimeout(300);
ok('theme toggles back to light', await page.evaluate(() => document.documentElement.dataset.theme === 'light'));
// accent colour
await page.locator('#settings-modal .palette-swatch').nth(2).click();
await page.waitForTimeout(300);
const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--interaction-norm').trim());
ok('accent colour applied', accent.toLowerCase() === '#f78400', accent);
await page.locator('#settings-modal .palette-swatch').first().click(); // back to default
// first day of week
await page.selectOption('#set-firstday', '0'); // Sunday
await page.waitForTimeout(600);
const firstCol = await page.locator('.fc-daygrid-day').first().getAttribute('data-date');
ok('first day of week applied (grid starts Sunday)', new Date(firstCol + 'T00:00:00').getDay() === 0, firstCol);
await page.selectOption('#set-firstday', '1'); // back to Monday
await page.waitForTimeout(500);
// 24-hour time format
await page.selectOption('#set-hour12', '24');
await page.waitForTimeout(600);
const slotLabel = await page.locator('.fc-timegrid-slot-label').first().textContent().catch(() => null);
await page.selectOption('#set-hour12', '');
await page.waitForTimeout(400);
await page.click('#settings-modal .button-primary'); // Done
await page.waitForTimeout(400);
ok('settings persist + close', await page.locator('#settings-modal').isHidden());
// settings survive reload
await page.reload();
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1200);
const persisted = await page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('clock_poc_settings_v44') || 'null'); } catch { return null; }
});
ok('settings persisted across reload', !!persisted && persisted.firstDay === 1 && persisted.accent === '#6d4aff', JSON.stringify(persisted));

/* ============ 19. keyboard shortcuts ============ */
await page.keyboard.press('d');
await page.waitForTimeout(300);
ok('keyboard d → day view', await page.locator('.fc-timegrid-col').count() === 2);
await page.keyboard.press('w');
await page.waitForTimeout(300);
ok('keyboard w → week view', await page.locator('.fc-timegrid-col').count() === 8);
await page.keyboard.press('m');
await page.waitForTimeout(300);
ok('keyboard m → month view', await page.locator('.fc-daygrid-day').count() === 42);
await page.keyboard.press('y');
await page.waitForTimeout(400);
ok('keyboard y → year view', await page.locator('.fc-multimonth-month').count() === 12);
await page.keyboard.press('a');
await page.waitForTimeout(300);
ok('keyboard a → agenda view', await page.locator('.fc-list-event').count() >= 1);
await page.keyboard.press('m');
await page.waitForTimeout(300);

/* ============ 20. delete event ============ */
m = mark();
const adChip = page.locator('.fc-event', { hasText: 'E2E all day' }).first();
const adBox = await adChip.boundingBox();
await page.mouse.click(R(adBox.x + adBox.width / 2), R(adBox.y + adBox.height / 2));
await page.waitForTimeout(700);
await page.click('#event-popover button[title="Delete"]');
await page.waitForTimeout(1500);
ok('delete = 1 DELETE request', since(m).filter((r) => r.m === 'DELETE').length === 1, JSON.stringify(since(m).map(r => r.m)));
ok('deleted event gone from UI', (await page.locator('.fc-event', { hasText: 'E2E all day' }).count()) === 0);

/* ============ 21. calendar visibility toggle ============ */
await weekBtn();
await page.waitForTimeout(500);
const beforeCount = await page.locator('.fc-event').count();
await page.locator('.calendar-list input.cal-check').first().uncheck();
await page.waitForTimeout(700);
const afterCount = await page.locator('.fc-event').count();
ok('unchecking a calendar hides its events', afterCount < beforeCount, beforeCount + ' -> ' + afterCount);
await page.locator('.calendar-list input.cal-check').first().check();
await page.waitForTimeout(700);

/* ============ 22. final consistency check ============ */
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
await monthBtn();
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/e2e-fc-final.png' });
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
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64(env.nonce), additionalData: aad(r.id, env.ver) }, key, b64(env.ct));
      // The row envelope carries a JSON VALUE (crypto.js encryptRow
      // JSON.stringifies; decryptRow JSON.parses) — mirror that here.
      const v = JSON.parse(Buffer.from(pt).toString('utf8'));
      out[r.id] = typeof v === 'string' ? v : JSON.stringify(v);
    } catch { out[r.id] = null; }
  }
  return out;
}
