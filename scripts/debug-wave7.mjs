// debug-wave7.mjs — probe B1 (bottom click) and A1 (popover→Edit→This event).
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8080';
const SERVER = 'http://127.0.0.1:8787';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 150)); });

await page.goto(BASE + '/?server=' + SERVER + '&setup=' + mat.auth_ui_hex);
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1200);

/* B1 probe */
await page.click('.view-button[data-view="week"]');
await page.waitForTimeout(600);
await page.evaluate(() => { const el = document.querySelector('.calendar-time-grid'); el.scrollTop = el.scrollHeight; });
await page.waitForTimeout(300);
const scrollBox = await page.locator('.calendar-time-grid').boundingBox();
const col = await page.locator('.timegrid-day').first().boundingBox();
const y = scrollBox.y + scrollBox.height - 6;
const x = col.x + col.width / 2;
const hit = await page.evaluate(([x, y]) => {
  const el = document.elementFromPoint(x, y);
  return el ? el.tagName + '.' + String(el.className).slice(0, 50) : 'none';
}, [x, y]);
console.log('B1 hit at (' + Math.round(x) + ',' + Math.round(y) + '):', hit);
await page.mouse.click(x, y);
await page.waitForTimeout(800);
const b1state = await page.evaluate(() => ({
  editorHidden: document.querySelector('#editor-modal').hidden,
  recurHidden: document.querySelector('#recur-modal').hidden,
  popHidden: document.querySelector('#event-popover').hidden,
}));
console.log('B1 after click:', JSON.stringify(b1state));
await page.keyboard.press('Escape');

/* A1 probe: create recurring, click chip, popover, Edit, choice */
await page.click('.view-button[data-view="month"]');
await page.waitForTimeout(500);
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'A1 probe recurring');
await page.selectOption('select[aria-label="Frequency"]', 'DAILY');
await page.click('button.button-primary:has-text("Save")');
await page.waitForTimeout(1500);
const chip = page.locator('.calendar-dayeventcell', { hasText: 'A1 probe recurring' }).first();
const box = await chip.boundingBox();
console.log('A1 chip box:', JSON.stringify(box && { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) }));
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(900);
const popState = await page.evaluate(() => ({
  popHidden: document.querySelector('#event-popover').hidden,
  editBtn: !!document.querySelector('#event-popover button[title="Edit"]'),
}));
console.log('A1 popover state:', JSON.stringify(popState));
if (popState.editBtn) {
  await page.click('#event-popover button[title="Edit"]');
  await page.waitForTimeout(900);
  const afterEdit = await page.evaluate(() => ({
    recurHidden: document.querySelector('#recur-modal').hidden,
    editorHidden: document.querySelector('#editor-modal').hidden,
    recurButtons: [...document.querySelectorAll('#recur-modal button')].map((b) => b.textContent),
  }));
  console.log('A1 after Edit click:', JSON.stringify(afterEdit));
  if (!afterEdit.recurHidden) {
    await page.click('#recur-modal button:has-text("This event")');
    await page.waitForTimeout(800);
    const afterChoice = await page.evaluate(() => ({
      editorHidden: document.querySelector('#editor-modal').hidden,
    }));
    console.log('A1 after This-event click:', JSON.stringify(afterChoice));
  }
}
await page.screenshot({ path: '/tmp/debug-a1.png' });
await browser.close();
