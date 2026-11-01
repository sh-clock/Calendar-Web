// probe-v7e — round 5: weekNumbers ON cell structure (extra role=cell?),
// month-view timed dot chips, active tab in month view, popover open.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const mat = JSON.parse(readFileSync('/tmp/local-material-2.json', 'utf8'));
const BASE = 'http://127.0.0.1:8081';
const SERVER = 'http://127.0.0.1:8788';

const browser = await chromium.launch({ args: ['--disable-web-security'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 300)); });

await page.goto(BASE + '/#server=' + SERVER + '&setup=' + mat.auth_ui_hex);
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1800);

// create a timed event (V7 resize probe exists already from probe-v7d? new universe — create fresh)
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'V7 dot probe');
await page.fill('input[aria-label="Starts date"]', '2026-11-10');
await page.fill('input[aria-label="Starts time"]', '09:00');
await page.fill('input[aria-label="Ends date"]', '2026-11-10');
await page.fill('input[aria-label="Ends time"]', '10:00');
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1500);

// week numbers ON
await page.click('#btn-settings');
await page.waitForSelector('#settings-modal:not([hidden])');
await page.check('#set-weeknumbers');
await page.waitForTimeout(300);
await page.click('#settings-modal button:has-text("Done")');
await page.waitForTimeout(400);

// month view November
await page.click('#calendar button[aria-label="Month view"]');
await page.waitForTimeout(600);
await page.click('#calendar button[aria-label^="Next"]');
await page.waitForTimeout(800);

const monthWN = await page.evaluate(() => {
  const out = {};
  out.roleCells = document.querySelectorAll('[role="cell"]').length;
  out.roleCellsDated = document.querySelectorAll('[role="cell"][data-date]').length;
  const first = document.querySelector('[role="cell"]');
  out.firstCell = { date: first?.getAttribute('data-date'), role: first?.getAttribute('role'), text: first?.textContent.trim().slice(0, 8), aria: first?.getAttribute('aria-label') };
  out.datedOnly = document.querySelector('[role="cell"][data-date]')?.getAttribute('data-date');
  out.weekNavlinks = document.querySelectorAll('[aria-label^="Go to Week"]').length;
  out.tab = document.querySelector('#calendar [role="tab"][aria-selected="true"]')?.getAttribute('aria-label');
  // timed dot chip in month view
  const cell = document.querySelector('[role="cell"][data-date="2026-11-10"]');
  out.dotChips = cell ? [...cell.querySelectorAll('.fc-event')].map((c) => ({ text: c.textContent.trim().slice(0, 30), role: c.getAttribute('role'), kids: c.children.length })) : null;
  // month cell rect size sanity
  const c2 = document.querySelector('[role="cell"][data-date="2026-11-10"]').getBoundingClientRect();
  out.cellSize = { w: Math.round(c2.width), h: Math.round(c2.height) };
  return out;
});
console.log('MONTH-WN-ON:', JSON.stringify(monthWN, null, 2));

// week numbers OFF again
await page.click('#btn-settings');
await page.waitForSelector('#settings-modal:not([hidden])');
await page.uncheck('#set-weeknumbers');
await page.click('#settings-modal button:has-text("Done")');
await page.waitForTimeout(500);

const monthWNoff = await page.evaluate(() => ({
  roleCells: document.querySelectorAll('[role="cell"]').length,
  roleCellsDated: document.querySelectorAll('[role="cell"][data-date]').length,
  weekNavlinks: document.querySelectorAll('[aria-label^="Go to Week"]').length,
}));
console.log('MONTH-WN-OFF:', JSON.stringify(monthWNoff));

// popover open on chip click
await page.evaluate(() => {
  const cell = document.querySelector('[role="cell"][data-date="2026-11-10"]');
  const chip = cell && [...cell.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 dot probe'));
  if (chip) {
    const r = chip.getBoundingClientRect();
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
  }
});
await page.waitForTimeout(700);
const pop = await page.evaluate(() => ({
  visible: !document.querySelector('#event-popover')?.hidden,
  text: document.querySelector('#event-popover')?.textContent.trim().slice(0, 80),
}));
console.log('POPOVER:', JSON.stringify(pop));
await page.keyboard.press('Escape');

// drag in month view: Nov 10 -> Nov 12 chip (exercise the FC drag machinery)
const drag = await page.evaluate(() => {
  const from = document.querySelector('[role="cell"][data-date="2026-11-10"]');
  const to = document.querySelector('[role="cell"][data-date="2026-11-12"]');
  const chip = from && [...from.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 dot probe'));
  if (!chip || !to) return null;
  const cb = chip.getBoundingClientRect();
  const tb = to.getBoundingClientRect();
  return { fx: cb.x + cb.width / 2, fy: cb.y + cb.height / 2, tx: tb.x + tb.width / 2, ty: tb.y + 12 };
});
console.log('DRAG-GEOM:', JSON.stringify(drag));
if (drag) {
  await page.mouse.move(drag.fx, drag.fy);
  await page.mouse.down();
  await page.mouse.move(drag.tx, drag.ty, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(1800);
  const after = await page.evaluate(() => {
    const to = document.querySelector('[role="cell"][data-date="2026-11-12"]');
    return to ? [...to.querySelectorAll('.fc-event')].map((c) => c.textContent.trim().slice(0, 24)) : null;
  });
  console.log('AFTER-DRAG (Nov 12 chips):', JSON.stringify(after));
}

console.log('ERRORS:', errs.length, errs.slice(0, 5));
await browser.close();
