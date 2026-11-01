// probe-v7 — dump the ACTUAL v7 DOM shapes of the running app (8081/8788)
// so the stress migration uses verified hooks. Throwaway diagnostic.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const mat = JSON.parse(readFileSync('/tmp/local-material-2.json', 'utf8'));
const BASE = 'http://127.0.0.1:8081';
const SERVER = 'http://127.0.0.1:8788';

const browser = await chromium.launch({ args: ['--disable-web-security'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });

await page.goto(BASE + '/?server=' + SERVER + '&setup=' + mat.auth_ui_hex);
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1800);

// create one timed event to probe against
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'V7 probe timed');
await page.fill('input[aria-label="Starts date"]', '2026-11-04');
await page.fill('input[aria-label="Starts time"]', '22:00');
await page.fill('input[aria-label="Ends date"]', '2026-11-05');
await page.fill('input[aria-label="Ends time"]', '02:00');
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1500);

// create one all-day event
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'V7 probe allday');
await page.fill('input[aria-label="Starts date"]', '2026-11-12');
await page.fill('input[aria-label="Ends date"]', '2026-11-16');
await page.check('#editor-modal .fullday-recurrency input[type=checkbox]');
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1500);

/* ---------- TOOLBAR ---------- */
const toolbar = await page.evaluate(() => {
  const out = {};
  out.buttons = [...document.querySelectorAll('#calendar button')].map((b) => ({
    label: b.getAttribute('aria-label'), text: b.textContent.trim(),
    cls: b.className.slice(0, 40), role: b.getAttribute('role'),
  }));
  out.title = [...document.querySelectorAll('#calendar h2, .fc-toolbar-title, [role="heading"]')].map((t) => t.textContent.trim()).slice(0, 3);
  out.titleSel = !!document.querySelector('#calendar h2');
  return out;
});
console.log('TOOLBAR:', JSON.stringify(toolbar, null, 2));

/* ---------- MONTH VIEW ---------- */
const month = await page.evaluate(() => {
  const out = {};
  out.datedEls = document.querySelectorAll('[data-date]').length;
  out.roleCells = document.querySelectorAll('[role="cell"]').length;
  const cell = document.querySelector('[data-date][role="cell"]');
  out.firstCellAttrs = cell ? [...cell.attributes].map((a) => a.name + '=' + a.value).join(' ') : null;
  out.firstCellDate = cell?.getAttribute('data-date');
  out.cell42 = document.querySelectorAll('[data-date][role="cell"]').length;
  // day-number (navLink) element inside a cell
  const dayNum = cell ? [...cell.querySelectorAll('a, button, [role="link"], [data-navlink]')].map((e) => ({
    tag: e.tagName, cls: String(e.className).slice(0, 50), attrs: [...e.attributes].map((a) => a.name).join(','),
    text: e.textContent.trim().slice(0, 10),
  })) : null;
  out.dayNumCandidates = dayNum;
  // event chips in month view
  const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 probe allday'));
  out.alldayChip = chip ? {
    cls: String(chip.className).slice(0, 80), role: chip.getAttribute('role'),
    parentDate: chip.closest('[data-date]')?.getAttribute('data-date'),
    parentRole: chip.closest('[data-date]')?.getAttribute('role'),
    inCell: !!chip.closest('[role="cell"]'),
  } : null;
  const tchip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 probe timed'));
  out.timedChipInMonth = tchip ? { cls: String(tchip.className).slice(0, 80), parentDate: tchip.closest('[data-date]')?.getAttribute('data-date') } : null;
  // week-number element?
  out.weekNumbers = document.querySelectorAll('[data-week-number], .fc-week-number, .fc-daygrid-week-number').length;
  return out;
});
console.log('MONTH:', JSON.stringify(month, null, 2));

// navigate to November
await page.click('#calendar button[aria-label="Next"]').catch(async () => {
  await page.click('#calendar button[aria-label^="Next"]');
});
await page.waitForTimeout(800);

/* ---------- TIMEGRID (week view) ---------- */
await page.click('#calendar button[aria-label="Week view"]').catch(() => {});
await page.waitForTimeout(900);
const week = await page.evaluate(() => {
  const out = {};
  out.headerCells = [...document.querySelectorAll('[role="columnheader"]')].map((c) => c.getAttribute('data-date') || c.textContent.trim().slice(0, 12));
  out.datedNonHeader = [...document.querySelectorAll('[data-date]')].filter((e) => e.getAttribute('role') !== 'columnheader').map((e) => e.getAttribute('data-date'));
  // time slots
  out.timeEls = document.querySelectorAll('[data-time]').length;
  const t = document.querySelector('[data-time]');
  out.timeElAttrs = t ? [...t.attributes].map((a) => a.name + '=' + a.value).join(' ') : null;
  out.timeElRole = t?.getAttribute('role');
  out.timeElTag = t?.tagName;
  out.uniqueTimes = [...new Set([...document.querySelectorAll('[data-time]')].map((e) => e.getAttribute('data-time')))].slice(0, 5);
  // slot headers/labels
  out.rowHeaders = [...document.querySelectorAll('[role="rowheader"]')].slice(0, 4).map((e) => e.textContent.trim());
  // timed chip
  const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 probe timed'));
  out.timedChip = chip ? {
    cls: String(chip.className).slice(0, 120), role: chip.getAttribute('role'),
    hasMain: !!chip.querySelector('.fc-event-main'), tag: chip.tagName,
    childTags: [...chip.children].map((c) => c.tagName + '.' + String(c.className).slice(0, 30)),
    parentAttrs: [...chip.parentElement.attributes].map((a) => a.name + '=' + a.value).join(' ').slice(0, 100),
    grandparentTag: chip.parentElement.parentElement.tagName,
  } : null;
  // all-day chips (daygrid section inside week view)
  const ad = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 probe allday'));
  out.alldayChipInWeek = ad ? {
    parentDate: ad.closest('[data-date]')?.getAttribute('data-date'),
    parentRole: ad.closest('[data-date]')?.getAttribute('role'),
    cls: String(ad.className).slice(0, 80),
  } : null;
  // how to distinguish timed from allday chips structurally
  const all = [...document.querySelectorAll('.fc-event')];
  out.chipContexts = all.slice(0, 8).map((e) => ({
    text: e.textContent.trim().slice(0, 14),
    inTimeBody: !!e.closest('[role="rowgrid"], [role="grid"]') && !!e.parentElement.closest('[data-time]'),
    closestRow: e.closest('[role="row"]') ? [...e.closest('[role="row"]').attributes].map((a) => a.name + '=' + a.value).join(' ').slice(0, 80) : null,
  }));
  return out;
});
console.log('WEEK:', JSON.stringify(week, null, 2));

// resizer probe: hover the timed chip
await page.evaluate(() => {
  const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 probe timed'));
  if (chip) {
    const r = chip.getBoundingClientRect();
    const ev = new MouseEvent('mousemove', { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 });
    chip.dispatchEvent(ev);
  }
});
await page.hover('.fc-event', { position: undefined }).catch(() => {});
const rz = await page.evaluate(() => {
  const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 probe timed'));
  if (!chip) return null;
  const kids = [...chip.querySelectorAll('*')].map((e) => ({ tag: e.tagName, cls: String(e.className).slice(0, 40) }));
  return { kids: kids.slice(0, 14) };
});
console.log('CHIP-CHILDREN (no hover):', JSON.stringify(rz, null, 2));
await page.locator('.fc-event').first().hover().catch(() => {});
await page.waitForTimeout(300);
const rz2 = await page.evaluate(() => {
  const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 probe timed'));
  if (!chip) return null;
  const kids = [...chip.querySelectorAll('*')].map((e) => ({ tag: e.tagName, cls: String(e.className).slice(0, 40), h: e.getBoundingClientRect().height }));
  return { kids: kids.slice(0, 16) };
});
console.log('CHIP-CHILDREN (after hover):', JSON.stringify(rz2, null, 2));

/* ---------- AGENDA (listYear) ---------- */
await page.click('#calendar button[aria-label="Agenda view"]').catch(() => {});
await page.waitForTimeout(900);
const list = await page.evaluate(() => {
  const out = {};
  out.rows = document.querySelectorAll('[role="row"]').length;
  out.grid = document.querySelectorAll('[role="grid"]').length;
  out.dated = document.querySelectorAll('[data-date]').length;
  const evRow = [...document.querySelectorAll('[role="row"]')].find((r) => r.textContent.includes('V7 probe timed'));
  out.eventRowAttrs = evRow ? [...evRow.attributes].map((a) => a.name + '=' + a.value).join(' ').slice(0, 120) : null;
  const dayRow = [...document.querySelectorAll('[data-date]')].filter((e) => e.getAttribute('role') !== 'columnheader');
  out.dayRowSample = dayRow.slice(0, 3).map((e) => ({ tag: e.tagName, role: e.getAttribute('role'), d: e.getAttribute('data-date'), cls: String(e.className).slice(0, 40) }));
  // how to count events?
  out.eventish = [...document.querySelectorAll('.fc-event')].length;
  return out;
});
console.log('AGENDA:', JSON.stringify(list, null, 2));

/* ---------- YEAR VIEW ---------- */
await page.click('#calendar button[aria-label="Year view"]').catch(() => {});
await page.waitForTimeout(1200);
const year = await page.evaluate(() => {
  const out = {};
  out.tables = document.querySelectorAll('[role="table"]').length;
  const tables = [...document.querySelectorAll('[role="table"]')];
  out.tableAttrs = tables.slice(0, 4).map((t) => [...t.attributes].map((a) => a.name + '=' + a.value).join(' ').slice(0, 100));
  out.tableTitles = tables.slice(0, 4).map((t) => t.textContent.trim().slice(0, 20));
  out.monthWrappers = document.querySelectorAll('.fc-multimonth-month').length;
  const gridcell = document.querySelector('[role="gridcell"]');
  out.gridcellAttrs = gridcell ? [...gridcell.attributes].map((a) => a.name + '=' + a.value).join(' ') : null;
  out.roleCells = document.querySelectorAll('[role="cell"]').length;
  return out;
});
console.log('YEAR:', JSON.stringify(year, null, 2));

/* ---------- SETTINGS MODAL (v45) ---------- */
await page.click('#calendar button[aria-label="Month view"]').catch(() => {});
await page.waitForTimeout(700);
await page.click('#btn-settings');
await page.waitForSelector('#settings-modal:not([hidden])');
const settings = await page.evaluate(() => {
  const out = {};
  out.segments = [...document.querySelectorAll('#settings-modal .settings-segment')].map((s) => ({
    label: s.getAttribute('aria-label'), n: s.querySelectorAll('.settings-segment-button').length,
    texts: [...s.querySelectorAll('.settings-segment-button')].map((b) => b.textContent.trim()),
  }));
  out.ids = [...document.querySelectorAll('#settings-modal [id]')].map((e) => e.id);
  out.lsKeys = Object.keys(localStorage).filter((k) => k.startsWith('clock_poc'));
  out.settings45 = JSON.parse(localStorage.getItem('clock_poc_settings_v45') || 'null');
  return out;
});
console.log('SETTINGS:', JSON.stringify(settings, null, 2));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

console.log('ERRORS:', errs.length, errs.slice(0, 5));
await page.screenshot({ path: '/tmp/probe-v7.png' });
await browser.close();
