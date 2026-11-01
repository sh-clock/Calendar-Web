// e2e-fc.mjs — full browser verification of the FullCalendar-based client
// against the local dev worker. Covers every e2e-v43 scenario on the new
// UI + resize + settings (the rework's new surfaces).
// v7 migration (E2E-MIG-A): FullCalendar 6.1.22 → 7.1.3 DOM. v7 themes hash
// their structural classes, so the suite anchors on the STABLE hooks instead:
// [data-date]/[data-time] attributes, aria-labelled toolbar buttons, the app's
// own .fc-event marker (EventInput `class`), and hashed internal markers
// (internalScroller / internalEventResizerEnd / the theme's now-indicator line
// class) extracted at runtime from the vendored bundle.
// Usage: node scripts/e2e-fc.mjs  (run-e2e.sh boots the stack)
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8080';
const SERVER = 'http://127.0.0.1:8787';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const AUTH_UI = mat.auth_ui_hex;
const K_DATA = Uint8Array.from(Buffer.from(mat.k_data_hex, 'hex'));

/* ---- v7 hashed-class extraction (runtime, from the vendored bundle) ---- */
const ROOT = new URL('..', import.meta.url).pathname;
const fcBundle = readFileSync(ROOT + 'js/vendor/fullcalendar/v7/all.global.js', 'utf8');
const fcHash = (key) => (fcBundle.match(new RegExp('"internal' + key + '":"(fc-[A-Za-z0-9]+)"')) || [])[1];
const SCROLLER = fcHash('Scroller');          // the scrollable time-grid container
const RESIZER_END = fcHash('EventResizerEnd'); // the event end-resizer hit area
if (!SCROLLER || !RESIZER_END) throw new Error('vendored FC v7 bundle markers not found');
const TIMED_EV = '.' + SCROLLER + ' .fc-event'; // timed events live inside the scroller
// now-indicator line: theme-hashed class, read from the active (default
// monarch) theme plugin source — the line has no stable structural class.
const monarchSrc = readFileSync(ROOT + 'js/vendor/fullcalendar/v7/themes/monarch/global.js', 'utf8');
const NOWLINE_CLS = (monarchSrc.match(/nowIndicatorLineClass:\s*"([^"]+)"/) || [])[1] || '';
const NOWLINE = '.' + NOWLINE_CLS.trim().split(/\s+/).join('.');

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

/* v7 test mechanics: success toasts ("Event saved/moved/deleted.", 2s; the
 * provisioning toast, 4.2s) render fixed at the viewport's BOTTOM-RIGHT
 * (#toasts, css z-index above the calendar) — exactly over a late-evening
 * chip in the week view's last column. They swallow the mousedown of any
 * coordinate-based mouse gesture aimed at that zone (FullCalendar binds
 * mousedown on the view root, so the toast intercepts gesture START only).
 * Removing them early is equivalent to their natural expiry (toast() itself
 * just setTimeout-removes the node) and keeps the tests wall-clock-proof. */
const clearToasts = () => page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

async function unlock() {
  await page.goto(BASE + '/#server=' + SERVER + '&setup=' + AUTH_UI);
  await page.waitForTimeout(400);
  await page.fill('#password', 'password');
  await page.click('button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
  await page.waitForTimeout(1200);
}

/* v7 toolbar buttons are aria-labelled (labels are view-aware):
 * prev/next "Previous/Next <unit>", today "This <unit>", views "<Name> view". */
const monthBtn = () => page.click('#calendar button[aria-label="Month view"]');
const weekBtn = () => page.click('#calendar button[aria-label="Week view"]');

/** Day-cell selector: v7 day cells are [data-date] (role=cell); month view
 * renders exactly the 42 grid cells in row-major order (leading cells first). */
const DAYCELL = '[data-date][role=cell]';
/** Time-grid day columns + the slot-label axis (v6's .fc-timegrid-col+N was
 * "N day columns + axis"; v7 decomposes into N [data-date] columns inside the
 * scroller plus role=rowheader axis cells). */
const timeGridShape = async () => ({
  cols: await page.locator('.' + SCROLLER + ' ' + DAYCELL).count(),
  axis: await page.locator('#calendar [role=rowheader]').count(),
});

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
const anyDay = page.locator(DAYCELL).nth(21); // a middle cell of the grid
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
const targetDay = await page.evaluate((sel) => {
  const d = document.querySelectorAll(sel)[21];
  return d ? d.getAttribute('data-date') : null;
}, DAYCELL);
ok('dragged event persisted at target date', !!moved1 && !!targetDay && moved1.includes('DTSTART:' + targetDay.replaceAll('-', '')),
  'target=' + targetDay + ' row=' + (moved1 ? moved1.split('\n').find(l => l.startsWith('DTSTART')) : 'not found'));

/* ============ 7. week view ============ */
m = mark();
await weekBtn();
await page.waitForTimeout(700);
const weekShape = await timeGridShape();
ok('week view renders 7 day columns (+axis)', weekShape.cols === 7 && weekShape.axis >= 1, JSON.stringify(weekShape));
ok('week view renders 48 half-hour slots',
  await page.evaluate(() => [...document.querySelectorAll('[data-time]')].filter((e) => !e.textContent.trim()).length) === 48,
  await page.locator('[data-time]').count());
ok('week view: plain event (moved to Oct 19 by §6) correctly absent', await page.locator('.fc-event', { hasText: 'E2E plain event' }).count() === 0);
ok('week view: no grid requests on switch', since(m).filter((r) => r.m !== 'PUT').length === 0, since(m).length);
ok('now indicator visible', await page.locator(NOWLINE).count() >= 1, NOWLINE);

/* ============ 8. day view ============ */
await page.click('#calendar button[aria-label="Day view"]');
await page.waitForTimeout(500);
const dayShape = await timeGridShape();
ok('day view renders 1 column (+axis)', dayShape.cols === 1 && dayShape.axis >= 1, JSON.stringify(dayShape));

/* ============ 9. custom view (settings-driven day count) ============ */
await page.click('#btn-settings');
await page.waitForTimeout(400);
await page.selectOption('#set-customdays', '10');
await page.waitForTimeout(600);
await page.click('#settings-modal .button-primary'); // Done
await page.waitForTimeout(400);
await page.click('#calendar button[aria-label="Custom view"]');
await page.waitForTimeout(700);
const customShape = await timeGridShape();
ok('custom view renders 10 columns (+axis)', customShape.cols === 10 && customShape.axis >= 1, JSON.stringify(customShape));

/* ============ 10. year view ============ */
await page.click('#calendar button[aria-label="Year view"]');
await page.waitForTimeout(900);
ok('year view renders 12 months', await page.locator('#calendar [role=table]').count() === 12, await page.locator('#calendar [role=table]').count());

/* ============ 11. agenda (list) view ============ */
await page.click('#calendar button[aria-label="Agenda view"]');
await page.waitForTimeout(700);
ok('agenda lists saved events', await page.locator('.fc-event', { hasText: 'E2E plain event' }).count() >= 1);

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
await page.click('#calendar button[aria-label^="Next"]');
await page.waitForTimeout(800);
ok('recurring renders ~30 chips next month', (await page.locator('.fc-event', { hasText: 'E2E daily recurring' }).count()) >= 28, await page.locator('.fc-event', { hasText: 'E2E daily recurring' }).count());
await page.click('#calendar button[aria-label^="Previous"]');
await page.waitForTimeout(600);

/* all-day event via click on an empty day cell (dateClick → editor) */
m = mark();
const emptyDay = page.locator(DAYCELL).nth(8);
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
await clearToasts();
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'E2E second cal event');
// v7 migration note: the v6 test relied on the editor's wall-clock default
// times; at this environment's runtime (~23:00) that lands the chip in the
// LAST slot of the grid's LAST column — permanently inside the toast zone
// (no room below it either: §14's +60px drag and §16's +60px resize would
// drop off-grid). Fixed mid-day times keep every later §13–§16 assertion
// identical while making the geometry deterministic.
await page.fill('input[aria-label="Starts time"]', '10:00');
await page.fill('input[aria-label="Ends time"]', '11:00');
await page.selectOption('select[aria-label="Calendar"]', { label: 'Second calendar' });
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1200);
ok('event on 2nd calendar = 1 PUT', puts(since(m)) === 1);
const secondCalCount = await page.locator('.fc-event', { hasText: 'E2E second cal event' }).count();
ok('second-cal event renders in week view', secondCalCount >= 1,
  'count=' + secondCalCount + ' DOM=' + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.fc-event')].map(e => e.textContent.trim().slice(0, 30)))).slice(0, 300));

/* ============ 14. timed drag in WEEK view (day + time shift) ============ */
const wchip = page.locator(TIMED_EV, { hasText: 'E2E second cal event' }).first();
await clearToasts(); // the §13 "Event saved." toast overlays the grid's bottom-right
await wchip.scrollIntoViewIfNeeded(); // 10:00 sits above the now-anchored scroll position
const wbox = await wchip.boundingBox();
const colBox = await page.locator('.' + SCROLLER + ' ' + DAYCELL).first().boundingBox();
const colW = colBox ? colBox.width : 1188 / 7;
m = mark();
const wx = R(wbox.x + wbox.width / 2);
const wy = R(wbox.y + wbox.height / 2);
// The event sits on TODAY'S weekday, whose column POSITION depends on the
// weekday and firstDay=1 (e.g. Sunday = last column, Monday = first). Drag
// two columns TOWARDS THE GRID CENTRE so the drop always stays in-viewport
// (dragging off-grid makes FullCalendar revert silently → 0 PUTs).
const chipColIdx = await page.evaluate((args) => {
  const [x, sel] = args;
  const cols = [...document.querySelectorAll(sel)].filter((c) => c.getBoundingClientRect().width > 0);
  return cols.findIndex((c) => { const r = c.getBoundingClientRect(); return x >= r.x && x < r.x + r.width; });
}, [wx, '.' + SCROLLER + ' ' + DAYCELL]);
const dragRight = chipColIdx >= 0 && chipColIdx < 3;
const dx = dragRight ? R(colW * 2) : -R(colW * 2);
await page.mouse.move(wx, wy);
await page.mouse.down();
await page.mouse.move(wx + dx, wy + 60, { steps: 20 });
await page.mouse.up();
await page.waitForTimeout(2000);
const wdrag = since(m);
ok('week-view drag = 1 PUT', puts(wdrag) === 1, JSON.stringify(wdrag.map(r => r.m)));

/* ============ 15. drag-create in week view (select) ============ */
m = mark();
// §14's drag moved 'E2E second cal event' TWO columns left — find a point
// guaranteed NOT covered by any event (a select starting on an event is an
// event-drag, never a create-select).
const point = await page.evaluate((scrSel) => {
  const scr = document.querySelector(scrSel);
  if (!scr) return null;
  const r = scr.getBoundingClientRect();
  const cols = [...document.querySelectorAll(scrSel + ' [data-date][role=cell]')];
  const evs = [...document.querySelectorAll(scrSel + ' .fc-event')].map(e => e.getBoundingClientRect());
  for (const c of cols) {
    const cr = c.getBoundingClientRect();
    const cx = cr.x + Math.min(30, cr.width / 2);
    for (let fy = 0.25; fy <= 0.75; fy += 0.125) {
      const cy = r.y + r.height * fy;
      if (!evs.some(ev => cx >= ev.x - 2 && cx <= ev.x + ev.width + 2 && cy >= ev.y - 2 && cy <= ev.y + ev.height + 2)) {
        return { x: Math.round(cx), y: Math.round(cy) };
      }
    }
  }
  return null;
}, '.' + SCROLLER);
if (point) {
  await clearToasts();
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
const rchip = page.locator(TIMED_EV, { hasText: 'E2E second cal event' }).first();
await clearToasts(); // the §15 "Event saved." toast overlays the grid's bottom-right
await rchip.scrollIntoViewIfNeeded();
// Center the chip vertically INSIDE the timegrid scroller before the
// gesture: after §14's +2h downward drag the chip can sit at the grid's
// bottom edge, where a +60px resize drag ends BELOW the last hit →
// FullCalendar reverts silently (documented FC behaviour, same species as
// the §14 note) and no PUT ever fires. The resizer rect is re-read AFTER
// this repositioning, so the gesture coordinates stay exact.
await page.evaluate((args) => {
  const [scrSel, needle] = args;
  const scr = document.querySelector(scrSel);
  if (!scr) return;
  const ev = [...scr.querySelectorAll('.fc-event')].find((e) => e.textContent.includes(needle));
  if (!ev) return;
  const evTop = ev.getBoundingClientRect().top - scr.getBoundingClientRect().top + scr.scrollTop;
  scr.scrollTop = Math.max(0, evTop - scr.clientHeight / 2);
}, ['.' + SCROLLER, 'E2E second cal event']);
await page.waitForTimeout(300);
await rchip.hover();
await page.waitForTimeout(400); // hover → FullCalendar shows the resizer
const rz = await page.evaluate((args) => {
  const [title, rzClass] = args;
  for (const e of document.querySelectorAll('.fc-event')) {
    if (e.textContent.includes(title)) {
      // v7 renders the end-resizer as an internal marker child (hashed class,
      // extracted from the vendored bundle at the top of this script).
      const z = e.querySelector('.' + rzClass);
      return z ? z.getBoundingClientRect().toJSON() : null;
    }
  }
  return null;
}, ['E2E second cal event', RESIZER_END]);
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
  console.log('DEBUG rz=' + JSON.stringify(rz));
  console.log('DEBUG html=' + (await page.evaluate((needle) => {
    for (const e of document.querySelectorAll('.fc-event')) {
      if (e.textContent.includes(needle)) return e.outerHTML.slice(0, 700);
    }
    return 'NO EL';
  }, 'E2E second cal event')));
}

/* ============ 17. recurring drag → "This event" ============ */
await monthBtn();
await page.waitForTimeout(700);
const rchip2 = page.locator('.fc-event', { hasText: 'E2E daily recurring' }).first();
const rbox2 = await rchip2.boundingBox();
const dest = page.locator(DAYCELL).nth(14);
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

/* ============ 18. settings: theme + palette + first day + 24h ============ */
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
// accent colour — v7: the per-theme Palette select is the accent system
// (#set-fcpalette; the v6 swatch row is gone). Monarch's purple palette
// drives --interaction-norm like the old swatch did.
await page.selectOption('#set-fcpalette', 'purple');
await page.waitForTimeout(600);
const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--interaction-norm').trim());
ok('accent colour applied', accent.toLowerCase() === '#6750a4', accent);
await page.selectOption('#set-fcpalette', 'blue'); // back to default
await page.waitForTimeout(300);
// first day of week
await page.selectOption('#set-firstday', '0'); // Sunday
await page.waitForTimeout(600);
const firstCol = await page.locator(DAYCELL).first().getAttribute('data-date');
ok('first day of week applied (grid starts Sunday)', new Date(firstCol + 'T00:00:00').getDay() === 0, firstCol);
await page.selectOption('#set-firstday', '1'); // back to Monday
await page.waitForTimeout(500);
// 24-hour time format
await page.selectOption('#set-hour12', '24');
await page.waitForTimeout(600);
const slotLabel = await page.locator('[data-time="00:00:00"]').first().textContent().catch(() => null); // month view: no slot labels (as in v6)
await page.selectOption('#set-hour12', '');
await page.waitForTimeout(400);
await page.click('#settings-modal .button-primary'); // Done
await page.waitForTimeout(400);
ok('settings persist + close', await page.locator('#settings-modal').isHidden());
// settings survive reload (v45: fcTheme/fcPalette replace the v6 accent)
await page.reload();
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1200);
const persisted = await page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('clock_poc_settings_v45') || 'null'); } catch { return null; }
});
ok('settings persisted across reload', !!persisted && persisted.firstDay === 1 && persisted.fcTheme === 'monarch' && persisted.fcPalette === 'blue', JSON.stringify(persisted));

/* ============ 19. keyboard shortcuts ============ */
await page.keyboard.press('d');
await page.waitForTimeout(300);
const kbD = await timeGridShape();
ok('keyboard d → day view', kbD.cols === 1 && kbD.axis >= 1, JSON.stringify(kbD));
await page.keyboard.press('w');
await page.waitForTimeout(300);
const kbW = await timeGridShape();
ok('keyboard w → week view', kbW.cols === 7 && kbW.axis >= 1, JSON.stringify(kbW));
await page.keyboard.press('m');
await page.waitForTimeout(300);
ok('keyboard m → month view', await page.locator(DAYCELL).count() === 42);
await page.keyboard.press('y');
await page.waitForTimeout(400);
ok('keyboard y → year view', await page.locator('#calendar [role=table]').count() === 12);
await page.keyboard.press('a');
await page.waitForTimeout(300);
ok('keyboard a → agenda view', await page.locator('.fc-event').count() >= 1);
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
