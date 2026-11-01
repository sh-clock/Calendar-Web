// probe-v7d — round 4: timed-chip column containment + END resizer (fc-lw).
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

// create a plain 09:00-10:00 event on Nov 10
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'V7 resize probe');
await page.fill('input[aria-label="Starts date"]', '2026-11-10');
await page.fill('input[aria-label="Starts time"]', '09:00');
await page.fill('input[aria-label="Ends date"]', '2026-11-10');
await page.fill('input[aria-label="Ends time"]', '10:00');
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1500);

// month -> Nov -> week (week of Nov 9-15)
await page.click('#calendar button[aria-label="Month view"]');
await page.waitForTimeout(500);
await page.click('#calendar button[aria-label^="Next"]');
await page.waitForTimeout(700);
await page.click('[role="cell"][data-date="2026-11-10"] [role="link"]'); // day view of Nov 10
await page.waitForTimeout(700);
await page.click('#calendar button[aria-label="Week view"]');
await page.waitForTimeout(900);

const wk = await page.evaluate(() => {
  const out = {};
  const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 resize probe'));
  if (!chip) return { missing: true };
  const r = chip.getBoundingClientRect();
  out.chip = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), text: chip.textContent.trim() };
  // containment
  const cell = chip.closest('[role="cell"]');
  const cr = cell?.getBoundingClientRect();
  out.closestCell = cell ? {
    date: cell.getAttribute('data-date'), h: Math.round(cr.height), y: Math.round(cr.y), w: Math.round(cr.width),
    containsChip: cell.contains(chip),
  } : null;
  out.parentElementRole = chip.parentElement.getAttribute('role');
  // ancestors
  const chain = [];
  let n = chip.parentElement;
  for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
    chain.push({ tag: n.tagName, role: n.getAttribute('role'), date: n.getAttribute('data-date'), time: n.getAttribute('data-time'), cls: String(n.className).slice(0, 30) });
  }
  out.ancestors = chain;
  // resizers
  out.resizers = [...chip.querySelectorAll('.fc-lw, .fc-ik, .fc-bM')].map((z) => {
    const zr = z.getBoundingClientRect();
    return { cls: String(z.className).slice(0, 80), w: Math.round(zr.width), h: Math.round(zr.height), x: Math.round(zr.x), y: Math.round(zr.y), cursor: getComputedStyle(z).cursor };
  });
  // slot lanes + geometry
  const lanes = [...document.querySelectorAll('[data-time]')].filter((e) => !e.textContent.trim());
  const first = lanes[0].getBoundingClientRect();
  const last = lanes[lanes.length - 1].getBoundingClientRect();
  const pxPerSlot = (last.y + last.height - first.y) / lanes.length;
  out.lanes = lanes.length;
  out.pxPerSlot = Math.round(pxPerSlot * 100) / 100;
  out.topSlots = Math.round((r.y - first.y) / pxPerSlot * 100) / 100;
  out.heightSlots = Math.round(r.height / pxPerSlot * 100) / 100;
  // column headers
  out.headers = [...document.querySelectorAll('[role="columnheader"]')].map((c) => c.getAttribute('data-date'));
  return out;
});
console.log('WEEK-TIMED:', JSON.stringify(wk, null, 2));

// hover then re-check resizer rects (visibility may be CSS-gated)
await page.locator('.fc-event', { hasText: 'V7 resize probe' }).first().hover();
await page.waitForTimeout(400);
const wk2 = await page.evaluate(() => {
  const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 resize probe'));
  if (!chip) return null;
  return [...chip.querySelectorAll('.fc-lw, .fc-ik')].map((z) => {
    const zr = z.getBoundingClientRect();
    return { cls: String(z.className).slice(0, 80), w: Math.round(zr.width), h: Math.round(zr.height), x: Math.round(zr.x), y: Math.round(zr.y), cursor: getComputedStyle(z).cursor, display: getComputedStyle(z).display, visibility: getComputedStyle(z).visibility };
  });
});
console.log('RESIZERS-HOVERED:', JSON.stringify(wk2, null, 2));

// perform a real resize gesture: +30min via the fc-lw handle, then verify
const rzGeom = await page.evaluate(() => {
  const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 resize probe'));
  const z = chip?.querySelector('.fc-lw');
  if (!z) return null;
  const zr = z.getBoundingClientRect();
  return { x: zr.x + zr.width / 2, y: zr.y + zr.height / 2 };
});
if (rzGeom) {
  await page.mouse.move(rzGeom.x, rzGeom.y);
  await page.waitForTimeout(250);
  await page.mouse.down();
  await page.mouse.move(rzGeom.x, rzGeom.y + 37, { steps: 10 }); // +1 slot (30min)
  await page.mouse.up();
  await page.waitForTimeout(1800);
  const after = await page.evaluate(() => {
    const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 resize probe'));
    if (!chip) return null;
    const lanes = [...document.querySelectorAll('[data-time]')].filter((e) => !e.textContent.trim());
    const first = lanes[0].getBoundingClientRect();
    const last = lanes[lanes.length - 1].getBoundingClientRect();
    const pxPerSlot = (last.y + last.height - first.y) / lanes.length;
    const r = chip.getBoundingClientRect();
    return { text: chip.textContent.trim(), topSlots: (r.y - first.y) / pxPerSlot, heightSlots: r.height / pxPerSlot };
  });
  console.log('AFTER-RESIZE:', JSON.stringify(after));
}

console.log('ERRORS:', errs.length, errs.slice(0, 5));
await browser.close();
