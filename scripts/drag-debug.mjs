// drag-debug.mjs — instrument the DnD chain step by step against local dev.
// Checks: does mousedown start a drag (isDragging)? does mousemove set the
// drop-target highlight? does mouseup fire a PUT?
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';

const BASE = 'http://127.0.0.1:8080';
const SERVER = 'http://127.0.0.1:8787';
const AUTH_UI = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8')).auth_ui_hex; // with-stack material (never committed)

const puts = [];
const pageErrors = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('request', (r) => {
  const u = String(r.url());
  if (u.startsWith(SERVER) && r.method() === 'PUT') puts.push(u.replace(SERVER, ''));
});
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('CONSOLE: ' + m.text()); });

await page.goto(BASE + '/#server=' + SERVER + '&setup=' + AUTH_UI);
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(2000);

// Where are the chips? Report every chip + its week row + day column.
const chips = await page.evaluate(() => {
  const out = [];
  const rows = document.querySelectorAll('.daygrid-rowevents');
  rows.forEach((rowEl, rowIdx) => {
    rowEl.querySelectorAll('.calendar-dayeventcell').forEach((chip) => {
      const r = chip.getBoundingClientRect();
      out.push({
        rowIdx,
        text: chip.textContent.trim().slice(0, 40),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      });
    });
  });
  const gr = document.querySelector('#grid-rows').getBoundingClientRect();
  return { chips: out, gridRows: { x: Math.round(gr.x), y: Math.round(gr.y), w: Math.round(gr.width), h: Math.round(gr.height) }, nWeeks: rows.length };
});
console.log(JSON.stringify(chips, null, 1));

if (chips.chips.length === 0) { console.log('NO CHIPS — aborting'); await browser.close(); process.exit(1); }

const c = chips.chips[0];
const cx = c.rect.x + c.rect.w / 2;
const cy = c.rect.y + c.rect.h / 2;

// STEP 1: mousedown on the chip
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.waitForTimeout(300);
let state1 = await page.evaluate(() => ({
  dragging: document.querySelectorAll('.isDragging').length,
  dropTarget: document.querySelectorAll('.is-drop-target').length,
  ghost: document.querySelectorAll('.chip-ghost').length,
}));
console.log('after mousedown:', JSON.stringify(state1));

// STEP 2: move to another week row, different column
const gr = chips.gridRows;
const rowH = gr.h / chips.nWeeks;
const targetY = gr.y + rowH * 1 + 5;   // week row 1
const targetX = gr.x + gr.w * 0.55;    // Thursday-ish
await page.mouse.move(targetX, targetY, { steps: 15 });
await page.waitForTimeout(300);
let state2 = await page.evaluate(() => ({
  dragging: document.querySelectorAll('.isDragging').length,
  dropTarget: document.querySelectorAll('.is-drop-target').length,
  ghost: document.querySelectorAll('.chip-ghost').length,
}));
console.log('after mousemove:', JSON.stringify(state2));

// STEP 3: mouseup
await page.mouse.up();
await page.waitForTimeout(3000);
let state3 = await page.evaluate(() => ({
  dragging: document.querySelectorAll('.isDragging').length,
  dropTarget: document.querySelectorAll('.is-drop-target').length,
  ghost: document.querySelectorAll('.chip-ghost').length,
  modalVisible: !document.querySelector('#recur-modal').hidden,
  popoverVisible: !document.querySelector('#event-popover').hidden,
  toastText: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
}));
console.log('after mouseup:', JSON.stringify(state3));
console.log('PUTs fired:', puts.length, puts);
console.log('pageErrors:', pageErrors);

await page.screenshot({ path: '/tmp/drag-debug.png' });
await browser.close();
