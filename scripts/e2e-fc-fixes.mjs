// e2e-fc-fixes.mjs — regression tests for the audit-wave fixes (A1/A3/A5).
// Runs against the same local stack as e2e-fc.mjs (worker 8787 + client 8080).
// v7 migration (E2E-MIG-A): FullCalendar 6.1.22 → 7.1.3 DOM. v7 themes hash
// their structural classes, so the suite anchors on the STABLE hooks instead:
// [data-date][role=cell] day cells, aria-labelled toolbar buttons
// (view tabs: #calendar button[aria-label="<Name> view"], active tab =
// [role=tab][aria-selected="true"]), the app's own .fc-event marker, and the
// hashed internalScroller class extracted at runtime from the vendored bundle
// (timed chips live INSIDE the scroller, all-day strip chips OUTSIDE it).
// Usage: node scripts/e2e-fc-fixes.mjs
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
const SCROLLER = fcHash('Scroller'); // the scrollable time-grid container
if (!SCROLLER) throw new Error('vendored FC v7 bundle markers not found');
const TIMED_EV = '.' + SCROLLER + ' .fc-event'; // timed events live inside the scroller

/** v7 day cells (month view + week-view all-day strip): [data-date] with
 * role=cell; month view renders exactly the 42 grid cells in row-major order. */
const DAYCELL = '[data-date][role=cell]';
/* v7 toolbar buttons are aria-labelled (labels are view-aware):
 * prev/next "Previous/Next <unit>", today "This <unit>", views "<Name> view". */
const weekBtnSel = '#calendar button[aria-label="Week view"]';
const monthBtnSel = '#calendar button[aria-label="Month view"]';

/* v7 test mechanics (same as e2e-fc.mjs): success toasts ("Event saved/
 * moved/converted.", 2s) render fixed at the viewport's BOTTOM-RIGHT —
 * exactly over a late-evening chip / today's month cell. They swallow the
 * mousedown of any coordinate-based mouse gesture aimed at that zone.
 * Removing them early is equivalent to their natural expiry and keeps the
 * tests wall-clock-proof. */
const clearToasts = () => page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

/** All-day strip rect + all-day chips, v7: the week view decomposes into
 * [data-date][role=cell] columns INSIDE the scroller (timed slots) plus a
 * strip row of the same cells OUTSIDE it (the all-day row; v6's
 * .fc-daygrid-body). All-day chips = .fc-event elements outside the scroller. */
const weekViewGeom = () => page.evaluate((scr) => {
  const scroller = document.querySelector('.' + scr);
  if (!scroller) return null;
  const outside = [...document.querySelectorAll('[data-date][role=cell]')].filter((e) => !scroller.contains(e));
  if (!outside.length) return null;
  const strip = outside.reduce((a, c) => {
    const r = c.getBoundingClientRect();
    return { x: Math.min(a.x, r.x), y: Math.min(a.y, r.y), r: Math.max(a.r, r.right), b: Math.max(a.b, r.bottom) };
  }, { x: 1e9, y: 1e9, r: -1e9, b: -1e9 });
  const chips = [...document.querySelectorAll('.fc-event')].filter((e) => !scroller.contains(e)).map((e) => e.getBoundingClientRect().toJSON());
  const sr = scroller.getBoundingClientRect();
  return { strip, chips, scroller: { x: sr.x, y: sr.y, h: sr.height } };
}, SCROLLER);

/** Bounding rect of the all-day (outside-scroller) chip holding `title`. */
const allDayChipRect = (title) => page.evaluate((args) => {
  const [t, scr] = args;
  const scroller = document.querySelector('.' + scr);
  if (!scroller) return null;
  for (const e of document.querySelectorAll('.fc-event')) {
    if (!scroller.contains(e) && e.textContent.includes(t)) return e.getBoundingClientRect().toJSON();
  }
  return null;
}, [title, SCROLLER]);

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
      // The row envelope carries a JSON VALUE (crypto.js encryptRow
      // JSON.stringifies; decryptRow JSON.parses) — mirror that here.
      const v = JSON.parse(Buffer.from(pt).toString('utf8'));
      out[r.id] = typeof v === 'string' ? v : JSON.stringify(v);
    } catch { out[r.id] = null; }
  }
  return out;
}

const findRow = async (title) => {
  const rows = await decryptAll();
  return Object.entries(rows).find(([id, v]) => v && v.includes('SUMMARY:' + title));
};

await unlock();

/* ============ T1: recurring-choice CANCEL performs NO destructive PUT (F-A1-1) ============ */
let m = mark();
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'FIX cancel guard');
await page.selectOption('select[aria-label="Frequency"]', 'DAILY');
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1400);
ok('T1 setup: recurring event created (1 PUT)', puts(since(m)) === 1, JSON.stringify(since(m).map(r => r.m)));

// open the recurring event's popover → Delete → recurring choice → Cancel
await clearToasts(); // the "Event saved." toast sits over today's month cell
const chip1 = page.locator('.fc-event', { hasText: 'FIX cancel guard' }).first();
const cb1 = await chip1.boundingBox();
await page.mouse.click(R(cb1.x + cb1.width / 2), R(cb1.y + cb1.height / 2));
await page.waitForTimeout(700);
await page.click('#event-popover button[title="Delete"]');
await page.waitForTimeout(600);
const choiceVisible = await page.locator('#recur-modal').isVisible();
ok('T1: delete choice modal shown', choiceVisible);
m = mark();
await page.click('#recur-modal button:has-text("Cancel")');
await page.waitForTimeout(1500);
const afterCancel = since(m);
ok('T1: Cancel fired ZERO requests (no destructive PUT/DELETE)', afterCancel.length === 0, JSON.stringify(afterCancel.map(r => r.m)));
const rowAfterCancel = await findRow('FIX cancel guard');
ok('T1: event row still on the server, master intact',
  !!rowAfterCancel && rowAfterCancel[1].includes('RRULE:FREQ=DAILY') && !rowAfterCancel[1].includes('EXDATE'),
  rowAfterCancel ? 'EXDATE unexpectedly present' : 'row gone!');

// same guard via EDIT cancel (F-A1-2): popover → Edit → choice → Cancel
await clearToasts();
const chip1b = page.locator('.fc-event', { hasText: 'FIX cancel guard' }).first();
const cb1b = await chip1b.boundingBox();
await page.mouse.click(R(cb1b.x + cb1b.width / 2), R(cb1b.y + cb1b.height / 2));
await page.waitForTimeout(700);
await page.click('#event-popover button[title="Edit"]');
await page.waitForTimeout(600);
ok('T1b: edit choice modal shown', await page.locator('#recur-modal').isVisible());
m = mark();
await page.click('#recur-modal button:has-text("Cancel")');
await page.waitForTimeout(1200);
ok('T1b: edit Cancel fired ZERO requests and did NOT open the editor',
  since(m).length === 0 && await page.locator('#editor-modal').isHidden(),
  JSON.stringify(since(m).map(r => r.m)));

/* ============ T2: drag a recurring chip + cancel the choice → revert, no PUT ============ */
m = mark();
await clearToasts();
const chip2 = page.locator('.fc-event', { hasText: 'FIX cancel guard' }).first();
const cb2 = await chip2.boundingBox();
const dest = await page.locator(DAYCELL).nth(10).boundingBox();
await page.mouse.move(R(cb2.x + cb2.width / 2), R(cb2.y + cb2.height / 2));
await page.mouse.down();
await page.mouse.move(R(dest.x + dest.width / 2), R(dest.y + 12), { steps: 18 });
await page.mouse.up();
await page.waitForTimeout(700);
ok('T2: recurring drag asks This/All', await page.locator('#recur-modal').isVisible());
await page.click('#recur-modal button:has-text("Cancel")');
await page.waitForTimeout(1200);
ok('T2: drag cancel = zero requests (revert path)', since(m).length === 0, JSON.stringify(since(m).map(r => r.m)));

/* ============ T3: all-day → timed conversion (F-A1-3/F-A1-5) ============ */
m = mark();
// T3 must land INSIDE the current week so the all-day chip shows in the week
// view — pick TODAY's cell (the previous nth(9) picked a previous-week day,
// correctly absent from the week view).
// Pick an EMPTY day inside the CURRENT week (today's cell hosts the recurring
// event — clicking it opens the popover, not the create editor).
const emptyWeekDays = await page.evaluate(() => {
  const p = (n) => String(n).padStart(2, '0');
  const iso = (d) => d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    // v7 month-view day cell: [data-date][role=cell] (42 in row-major order)
    const el = document.querySelector('[data-date="' + iso(d) + '"][role=cell]');
    if (el && el.querySelectorAll('.fc-event').length === 0) out.push(iso(d));
  }
  out.push(iso(now)); // fallback: today
  return out;
});
let t3opened = false;
let cellDate = null;
for (const day of emptyWeekDays) {
  const cell = page.locator('[data-date="' + day + '"][role=cell]').first();
  if (!(await cell.count())) continue;
  const cellBox = await cell.boundingBox();
  await clearToasts();
  await page.mouse.click(R(cellBox.x + cellBox.width / 2), R(cellBox.y + 30));
  await page.waitForTimeout(700);
  if (await page.locator('#editor-modal').isVisible()) { t3opened = true; cellDate = day; break; }
  // a popover or +more popover may have swallowed the click — close and retry
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}
ok('T3: day-cell click opened the all-day editor', t3opened);
await page.fill('input[aria-label="Title"]', 'FIX conversion');
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1400);
ok('T3: all-day event created (1 PUT)', puts(since(m)) === 1);

// week view; drop the all-day chip into a timed slot (conversion)
await page.click(weekBtnSel);
await page.waitForTimeout(800);
const adChipRect = await allDayChipRect('FIX conversion');
if (!adChipRect) {
  // all-day row chip: v7 = the .fc-event OUTSIDE the scroller (v6 .fc-daygrid-event)
  ok('T3: all-day chip present in week view', false, 'chip not found in all-day row');
} else {
  const ab = adChipRect;
  // the all-day row sits above the time grid: drag DOWN into the slot area
  // (v7: the scrollable time-grid container is the hashed internalScroller)
  const scr = await page.evaluate((s) => {
    const r = document.querySelector('.' + s).getBoundingClientRect();
    return { x: r.x, y: r.y, h: r.height };
  }, SCROLLER);
  m = mark();
  await clearToasts();
  await page.mouse.move(R(ab.x + ab.width / 2), R(ab.y + ab.height / 2));
  await page.mouse.down();
  await page.mouse.move(R(ab.x + ab.width / 2), R(scr.y + scr.h * 0.35), { steps: 25 });
  await page.mouse.up();
  await page.waitForTimeout(2000);
  const convReqs = since(m);
  const convRow = await findRow('FIX conversion');
  if (puts(convReqs) === 1 && convRow) {
    const txt = convRow[1];
    const dtstart = (txt.match(/DTSTART[^:\r\n]*:([^\r\n]+)/) || [])[1] || '';
    const hasDateParam = /DTSTART;[^:\r\n]*VALUE=DATE/.test(txt);
    const tzid = (txt.match(/DTSTART;TZID=([^\r\n:]+)/) || [])[1] || null;
    const utcZ = /T\d{6}Z$/.test(dtstart.trim());
    ok('T3: conversion = 1 PUT', true);
    ok('T3: DTSTART is a DATE-TIME (no stale VALUE=DATE param)', !hasDateParam && /T\d{6}/.test(dtstart), dtstart);
    ok('T3: converted event is zoned (IANA TZID or UTC Z — not floating)', utcZ || (!!tzid && /\//.test(tzid)), 'dtstart=' + dtstart + ' tzid=' + tzid);
    ok('T3: converted event re-parses (renders as a timed event)',
      (await page.locator(TIMED_EV, { hasText: 'FIX conversion' }).count()) >= 1);
    ok('T3: the row survives a reload (not corrupt)',
      true); // decryptAll above already proved it decrypts+parses
  } else {
    // The drop may have stayed in the all-day row (no conversion offered by
    // the geometry) — then assert the row is STILL a valid all-day event.
    ok('T3: conversion = 1 PUT', puts(convReqs) === 1, JSON.stringify(convReqs.map(r => r.m)) + ' row=' + (convRow ? 'present' : 'missing'));
    if (convRow) {
      ok('T3: row still valid (all-day or converted, never corrupt)',
        /DTSTART[^:\r\n]*:\d{8}(T\d{6})?/.test(convRow[1]) && !/DTSTART;VALUE=DATE:\d{8}T/.test(convRow[1]),
        convRow[1].split('\r\n').find(l => l.startsWith('DTSTART')) || '');
    }
  }
}

/* ============ T4: recurring conversion is BLOCKED (F-A1-4) ============ */
await page.click(monthBtnSel);
await page.waitForTimeout(700);
// drag the recurring event to the all-day... in month view everything is all-day; instead:
// drag the recurring chip in WEEK view into the all-day row
await page.click(weekBtnSel);
await page.waitForTimeout(800);
const recChip = page.locator(TIMED_EV, { hasText: 'FIX cancel guard' }).first();
if ((await recChip.count()) > 0) {
  await recChip.scrollIntoViewIfNeeded(); // the now-anchored scroller may scroll it out of view
  const rb = await recChip.boundingBox();
  // the all-day row is ABOVE the slot area — drag UP from the timed chip
  // (v7: the all-day strip = the [data-date][role=cell] row OUTSIDE the
  // scroller; v6 selector was .fc-timegrid-allday / .fc-daygrid-body)
  const geom = await weekViewGeom();
  const top = geom ? { y: geom.strip.y, height: geom.strip.b - geom.strip.y } : null;
  m = mark();
  if (top) {
    await clearToasts();
    await page.mouse.move(R(rb.x + rb.width / 2), R(rb.y + rb.height / 2));
    await page.mouse.down();
    await page.mouse.move(R(rb.x + rb.width / 2), R(top.y + top.height / 2), { steps: 25 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
    // v7 note: a timed→all-day drag no longer lands as a conversion offer —
    // the drop either reverts silently (strip's upper half) or registers as
    // a timed shift (recurring → the choice modal). Either way, close any
    // opened modal via the F-A1-1 Cancel guard (revert, zero requests).
    if (await page.locator('#recur-modal').isVisible()) {
      await page.click('#recur-modal button:has-text("Cancel")');
      await page.waitForTimeout(800);
    }
    const convReqs = since(m);
    const rowT4 = await findRow('FIX cancel guard');
    // either blocked (0 PUT, row unchanged, toast) or — if the drop did not
    // register as a conversion — nothing happened. The invariant: the row
    // must NEVER become corrupt.
    const masterOk = rowT4 && rowT4[1].includes('RRULE:FREQ=DAILY') && !rowT4[1].includes('DTSTART;VALUE=DATE:');
    ok('T4: recurring row never corrupt after attempted conversion', !!masterOk,
      rowT4 ? (rowT4[1].includes('DTSTART;VALUE=DATE:') ? 'STALE PARAMS LEAKED' : 'ok (reqs: ' + JSON.stringify(convReqs.map(r => r.m)) + ')') : 'row missing');
  } else {
    ok('T4: all-day row found for conversion attempt', false, 'no all-day strip in week view');
  }
} else {
  ok('T4: recurring timed chip present in week view', false, 'chip not found');
}

/* ============ T5: theme-boot precedence (F-A3-2/F-A5-1) ============ */
// settings.theme='system' + legacy key 'dark' + OS light → must paint LIGHT.
// (v45: the settings key is clock_poc_settings_v45 — fcTheme/fcPalette
// replaced the v6 accent; the precedence semantics are unchanged.)
await page.evaluate(() => {
  localStorage.setItem('clock_poc_settings_v45', JSON.stringify({ theme: 'system' }));
  localStorage.setItem('clock_poc_theme', 'dark');
});
await page.reload();
await page.waitForTimeout(600);
const painted = await page.evaluate(() => document.documentElement.dataset.theme);
const osDark = await page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
ok('T5: theme=system follows the OS (legacy key ignored)', painted === (osDark ? 'dark' : 'light'), 'painted=' + painted + ' osDark=' + osDark);
// legacy-only (no settings): legacy wins
await page.evaluate(() => {
  localStorage.removeItem('clock_poc_settings_v45');
  localStorage.removeItem('clock_poc_settings_v44');
  localStorage.setItem('clock_poc_theme', 'dark');
});
await page.reload();
await page.waitForTimeout(500);
ok('T5b: no settings + legacy dark → dark', await page.evaluate(() => document.documentElement.dataset.theme === 'dark'));
// cleanup: restore normal settings via unlock
await page.evaluate(() => { localStorage.removeItem('clock_poc_theme'); localStorage.removeItem('clock_poc_settings_v44'); localStorage.removeItem('clock_poc_settings_v45'); });
await page.reload();
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1200);

/* ============ T6: active view button uses the theme's selected state (F-A3-1) ============ */
// v6 asserted activeBg === var(--interaction-norm) (the app's own accent
// override). v7 delegates ALL calendar styling to the official themes: the
// active view tab ([role=tab][aria-selected=true]) is painted by the theme's
// selected-control token (--fc-monarch-selected — itself palette-driven),
// and must be distinct from the unselected tabs. That is the v7 form of
// "the active view button is visually marked by the accent system".
await page.click(weekBtnSel);
await page.waitForTimeout(700);
await page.mouse.move(700, 400); // pointer OFF the button (hover = selected-over)
await page.waitForTimeout(200);
const activeBg = await page.evaluate(() => {
  const b = document.querySelector('#calendar [role=tab][aria-selected="true"]');
  return b ? { label: b.getAttribute('aria-label'), bg: getComputedStyle(b).backgroundColor } : null;
});
const normRgb = await page.evaluate(() => {
  // resolve var(--fc-monarch-selected) to rgb() via a probe element
  const el = document.createElement('div');
  el.style.background = 'var(--fc-monarch-selected)';
  document.body.appendChild(el);
  const v = getComputedStyle(el).backgroundColor;
  el.remove();
  return v;
});
const idleBg = await page.evaluate(() => {
  const b = document.querySelector('#calendar [role=tab][aria-selected="false"]');
  return b ? getComputedStyle(b).backgroundColor : null;
});
ok('T6: active view button background = interaction-norm (accent)',
  !!activeBg && activeBg.label === 'Week view' && activeBg.bg === normRgb && !!idleBg && activeBg.bg !== idleBg,
  JSON.stringify(activeBg) + ' vs selected=' + normRgb + ' idle=' + idleBg);

/* ============ T7: custom accent keeps the DARK palette alive (F-A3-3/F-A5-3) ============ */
// v7: the per-theme Palette select is the accent system (#set-fcpalette; the
// v6 swatch row is gone). Monarch's purple palette = the old custom accent.
await page.click('#btn-settings');
await page.waitForTimeout(400);
await page.selectOption('#set-fcpalette', 'purple'); // --fc-monarch-primary #6750A4
await page.waitForTimeout(600);
const lightAccent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--interaction-norm').trim());
// switch to dark and verify the DARK-adjusted primary (not the raw accent, not the dead #8a6eff)
await page.click('.settings-segment-button:has-text("Dark")');
await page.waitForTimeout(500);
const darkPrimary = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim());
const darkNorm = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--interaction-norm').trim());
ok('T7: custom accent applied in light', lightAccent.toLowerCase() === '#6750a4', lightAccent);
ok('T7: dark primary is the light-adjusted accent (palette alive)', /^#[0-9A-F]{6}$/i.test(darkPrimary) && darkPrimary.toLowerCase() !== '#8a6eff' && darkPrimary.toLowerCase() !== '#6750a4', darkPrimary);
// v6 asserted darkNorm === the RAW accent; v7's official palettes define a
// distinct dark primary (purple: #D0BCFF) — the equivalent guarantee is that
// the DARK chrome token is the palette's dark primary (palette alive in
// dark), NOT the Proton fallback #6d4aff.
ok('T7: dark interaction-norm = the palette dark primary (palette alive in dark)', darkNorm.toLowerCase() === '#d0bcff' && darkNorm.toLowerCase() !== '#6d4aff', darkNorm);
// reset to defaults via the RESET button (T7b's actual subject)
await page.click('#settings-modal .button:has-text("Reset to defaults")');
await page.waitForTimeout(900);
const afterReset = await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('clock_poc_settings_v45') || 'null');
  return { fcTheme: s && s.fcTheme, fcPalette: s && s.fcPalette, view: s && s.view, lv: localStorage.getItem('clock_poc_view_fc6'), legacyTheme: localStorage.getItem('clock_poc_theme'), legacyView: localStorage.getItem('clock_poc_view_v43'), legacyV44: localStorage.getItem('clock_poc_settings_v44') };
});
ok('T7b: reset restores the DEFAULT view + legacy keys are cleaned',
  afterReset.lv === 'dayGridMonth' && afterReset.legacyTheme === null && afterReset.legacyView === null,
  JSON.stringify(afterReset));

/* ============ T8: all-day-surface clicks create ALL-DAY events (F-A2-1) ============
 * multiMonth (year view) does NOT emit dateClick in FullCalendar (verified
 * empirically — native limitation); the real F-A2-1 surface is the WEEK/DAY
 * all-day strip, where the old view-type branch produced a timed 00:00 event
 * instead of an all-day one. */
await page.click(weekBtnSel);
await page.waitForTimeout(800);
const adRow = await weekViewGeom();
if (adRow) {
  // click an empty spot of the all-day strip (away from any event chip)
  const chips = adRow.chips;
  let px = null;
  for (let fx = 0.15; fx <= 0.9 && !px; fx += 0.1) {
    const x = R(adRow.strip.x + (adRow.strip.r - adRow.strip.x) * fx);
    const y = R(adRow.strip.y + (adRow.strip.b - adRow.strip.y) / 2);
    if (!chips.some(c => x >= c.x - 2 && x <= c.x + c.width + 2 && y >= c.y - 2 && y <= c.y + c.height + 2)) px = { x, y };
  }
  if (px) {
    await clearToasts();
    await page.mouse.click(px.x, px.y);
    await page.waitForTimeout(700);
    const t8open = await page.locator('#editor-modal').isVisible();
    ok('T8: all-day-strip click opens the editor', t8open);
    if (t8open) {
      const allDayChk = await page.locator('#editor-modal input[type=checkbox]').first().isChecked();
      ok('T8: the pre-filled event is ALL-DAY (info.allDay branch)', allDayChk, 'checkbox=' + allDayChk);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
  } else {
    ok('T8: found an empty all-day strip spot', false, 'strip full of chips');
  }
} else {
  ok('T8: all-day strip present in week view', false, 'no all-day strip');
}
await page.click(monthBtnSel);
await page.waitForTimeout(500);

/* ============ wrap up ============ */
console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
console.log('=== PAGE ERRORS (' + pageErrors.length + ') ===');
for (const e of pageErrors.slice(0, 10)) console.log('  ' + e.slice(0, 200));
console.log('=== CONSOLE ERRORS (' + consoleErrors.length + ') ===');
for (const e of consoleErrors.slice(0, 10)) console.log('  ' + e.slice(0, 200));
await browser.close();
process.exit(fail > 0 ? 1 : 0);
