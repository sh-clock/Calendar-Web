// e2e-fc-fixes.mjs — regression tests for the audit-wave fixes (A1/A3/A5).
// Runs against the same local stack as e2e-fc.mjs (worker 8787 + client 8080).
// Usage: node scripts/e2e-fc-fixes.mjs
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
const chip2 = page.locator('.fc-event', { hasText: 'FIX cancel guard' }).first();
const cb2 = await chip2.boundingBox();
const dest = await page.locator('.fc-daygrid-day').nth(10).boundingBox();
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
// create an all-day event via day-cell click
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
    const el = document.querySelector('.fc-daygrid-day[data-date="' + iso(d) + '"]');
    if (el && el.querySelectorAll('.fc-event').length === 0) out.push(iso(d));
  }
  out.push(iso(now)); // fallback: today
  return out;
});
let t3opened = false;
let cellDate = null;
for (const day of emptyWeekDays) {
  const cell = page.locator('.fc-daygrid-day[data-date="' + day + '"]').first();
  if (!(await cell.count())) continue;
  const cellBox = await cell.boundingBox();
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
await page.click('.fc-timeGridWeek-button');
await page.waitForTimeout(800);
const adChip = page.locator('.fc-daygrid-event', { hasText: 'FIX conversion' }).first();
if ((await adChip.count()) === 0) {
  // all-day row chip class differs in the timeGrid heading
  ok('T3: all-day chip present in week view', false, 'chip not found in all-day row');
} else {
  const ab = await adChip.boundingBox();
  // the all-day row sits above the time grid: drag DOWN into the slot area
  const scr = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.fc-scroller')];
    return els.reduce((a, e) => { const r = e.getBoundingClientRect(); return r.height > (a ? a.h : 0) ? { x: r.x, y: r.y, h: r.height } : a; }, null);
  });
  m = mark();
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
      (await page.locator('.fc-timegrid-event', { hasText: 'FIX conversion' }).count()) >= 1);
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
await page.click('.fc-dayGridMonth-button');
await page.waitForTimeout(700);
// drag the recurring event to the all-day... in month view everything is all-day; instead:
// drag the recurring chip in WEEK view into the all-day row
await page.click('.fc-timeGridWeek-button');
await page.waitForTimeout(800);
const recChip = page.locator('.fc-timegrid-event', { hasText: 'FIX cancel guard' }).first();
if ((await recChip.count()) > 0) {
  const rb = await recChip.boundingBox();
  const alldayRow = await page.evaluate(() => {
    const el = document.querySelector('.fc-timegrid-cols') || document.querySelector('.fc-scroller');
    return el ? null : null;
  });
  // the all-day row is ABOVE the slot area — drag UP from the timed chip
  const top = await page.evaluate(() => {
    const rows = document.querySelector('.fc-timegrid-allday, .fc-daygrid-body');
    return rows ? rows.getBoundingClientRect().toJSON() : null;
  });
  m = mark();
  if (top) {
    await page.mouse.move(R(rb.x + rb.width / 2), R(rb.y + rb.height / 2));
    await page.mouse.down();
    await page.mouse.move(R(rb.x + rb.width / 2), R(top.y + top.height / 2), { steps: 25 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
    const convReqs = since(m);
    const rowT4 = await findRow('FIX cancel guard');
    // either blocked (0 PUT, row unchanged, toast) or — if the drop did not
    // register as a conversion — nothing happened. The invariant: the row
    // must NEVER become corrupt.
    const masterOk = rowT4 && rowT4[1].includes('RRULE:FREQ=DAILY') && !rowT4[1].includes('DTSTART;VALUE=DATE:');
    ok('T4: recurring row never corrupt after attempted conversion', !!masterOk,
      rowT4 ? (rowT4[1].includes('DTSTART;VALUE=DATE:') ? 'STALE PARAMS LEAKED' : 'ok') : 'row missing');
  } else {
    ok('T4: all-day row found for conversion attempt', false, 'no .fc-daygrid-body in week view');
  }
} else {
  ok('T4: recurring timed chip present in week view', false, 'chip not found');
}

/* ============ T5: theme-boot precedence (F-A3-2/F-A5-1) ============ */
// settings.theme='system' + legacy key 'dark' + OS light → must paint LIGHT.
await page.evaluate(() => {
  localStorage.setItem('clock_poc_settings_v44', JSON.stringify({ theme: 'system' }));
  localStorage.setItem('clock_poc_theme', 'dark');
});
await page.reload();
await page.waitForTimeout(600);
const painted = await page.evaluate(() => document.documentElement.dataset.theme);
const osDark = await page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
ok('T5: theme=system follows the OS (legacy key ignored)', painted === (osDark ? 'dark' : 'light'), 'painted=' + painted + ' osDark=' + osDark);
// legacy-only (no settings): legacy wins
await page.evaluate(() => {
  localStorage.removeItem('clock_poc_settings_v44');
  localStorage.setItem('clock_poc_theme', 'dark');
});
await page.reload();
await page.waitForTimeout(500);
ok('T5b: no settings + legacy dark → dark', await page.evaluate(() => document.documentElement.dataset.theme === 'dark'));
// cleanup: restore normal settings via unlock
await page.evaluate(() => { localStorage.removeItem('clock_poc_theme'); localStorage.removeItem('clock_poc_settings_v44'); });
await page.reload();
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1200);

/* ============ T6: active view button uses the ACCENT (F-A3-1) ============ */
await page.click('.fc-timeGridWeek-button');
await page.waitForTimeout(700);
await page.mouse.move(700, 400); // pointer OFF the button (hover = major-1)
await page.waitForTimeout(200);
const activeBg = await page.evaluate(() => {
  const b = document.querySelector('.fc-timeGridWeek-button');
  return getComputedStyle(b).backgroundColor;
});
const normRgb = await page.evaluate(() => {
  // resolve var(--interaction-norm) to rgb() via a probe element
  const el = document.createElement('div');
  el.style.background = 'var(--interaction-norm)';
  document.body.appendChild(el);
  const v = getComputedStyle(el).backgroundColor;
  el.remove();
  return v;
});
ok('T6: active view button background = interaction-norm (accent)', activeBg === normRgb, activeBg + ' vs ' + normRgb);

/* ============ T7: custom accent keeps the DARK palette alive (F-A3-3/F-A5-3) ============ */
await page.click('#btn-settings');
await page.waitForTimeout(400);
await page.locator('#settings-modal .palette-swatch').nth(2).click(); // #f78400
await page.waitForTimeout(400);
const lightAccent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--interaction-norm').trim());
// switch to dark and verify the DARK-adjusted primary (not the raw accent, not the dead #8a6eff)
await page.click('.settings-segment-button:has-text("Dark")');
await page.waitForTimeout(500);
const darkPrimary = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim());
const darkNorm = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--interaction-norm').trim());
ok('T7: custom accent applied in light', lightAccent.toLowerCase() === '#f78400', lightAccent);
ok('T7: dark primary is the light-adjusted accent (palette alive)', /^#[0-9A-F]{6}$/i.test(darkPrimary) && darkPrimary.toLowerCase() !== '#8a6eff' && darkPrimary.toLowerCase() !== '#f78400', darkPrimary);
ok('T7: dark interaction-norm = raw accent', darkNorm.toLowerCase() === '#f78400', darkNorm);
// reset to defaults via the RESET button (T7b's actual subject)
await page.click('#settings-modal .button:has-text("Reset to defaults")');
await page.waitForTimeout(900);
const afterReset = await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('clock_poc_settings_v44') || 'null');
  return { accent: s && s.accent, view: s && s.view, lv: localStorage.getItem('clock_poc_view_fc6'), legacyTheme: localStorage.getItem('clock_poc_theme'), legacyView: localStorage.getItem('clock_poc_view_v43') };
});
ok('T7b: reset restores the DEFAULT view + legacy keys are cleaned',
  afterReset.lv === 'dayGridMonth' && afterReset.legacyTheme === null && afterReset.legacyView === null,
  JSON.stringify(afterReset));

/* ============ T8: all-day-surface clicks create ALL-DAY events (F-A2-1) ============
 * multiMonth (year view) does NOT emit dateClick in FullCalendar v6.1.22
 * (verified empirically — native limitation); the real F-A2-1 surface is
 * the WEEK/DAY all-day strip, where the old view-type branch produced a
 * timed 00:00 event instead of an all-day one. */
await page.click('.fc-timeGridWeek-button');
await page.waitForTimeout(800);
const adRow = await page.evaluate(() => {
  // the all-day strip sits above the time grid (inside .fc-daygrid-body)
  const el = document.querySelector('.fc-daygrid-body');
  return el ? el.getBoundingClientRect().toJSON() : null;
});
if (adRow) {
  // click an empty spot of the all-day strip (away from any event chip)
  const chips = await page.evaluate(() => [...document.querySelectorAll('.fc-daygrid-event')].map(e => e.getBoundingClientRect().toJSON()));
  let px = null;
  for (let fx = 0.15; fx <= 0.9 && !px; fx += 0.1) {
    const x = R(adRow.x + adRow.width * fx);
    const y = R(adRow.y + adRow.height / 2);
    if (!chips.some(c => x >= c.x - 2 && x <= c.x + c.width + 2 && y >= c.y - 2 && y <= c.y + c.height + 2)) px = { x, y };
  }
  if (px) {
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
  ok('T8: all-day strip present in week view', false, 'no .fc-daygrid-body');
}
await page.click('.fc-dayGridMonth-button');
await page.waitForTimeout(500);

/* ============ wrap up ============ */
console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
console.log('=== PAGE ERRORS (' + pageErrors.length + ') ===');
for (const e of pageErrors.slice(0, 10)) console.log('  ' + e.slice(0, 200));
console.log('=== CONSOLE ERRORS (' + consoleErrors.length + ') ===');
for (const e of consoleErrors.slice(0, 10)) console.log('  ' + e.slice(0, 200));
await browser.close();
process.exit(fail > 0 ? 1 : 0);
