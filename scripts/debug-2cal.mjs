// debug-2cal.mjs — why doesn't the second-calendar event render in week view?
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8080';
const SERVER = 'http://127.0.0.1:8787';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));

await page.goto(BASE + '/#server=' + SERVER + '&setup=' + mat.auth_ui_hex);
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1200);

// create a second calendar
await page.click('#btn-add-calendar');
await page.fill('input[aria-label="Name"]', 'Debug second');
await page.locator('.palette-swatch').nth(4).click();
await page.click('#cal-modal .button-primary:has-text("Save")');
await page.waitForTimeout(1500);
const sidebar = await page.evaluate(() => [...document.querySelectorAll('#calendar-list li')].map((li) => li.textContent.trim()));
console.log('sidebar:', JSON.stringify(sidebar));

// switch to week view and create an event on the 2nd calendar
await page.click('.view-button[data-view="week"]');
await page.waitForTimeout(500);
await page.click('#btn-new-event');
await page.waitForTimeout(500);
const opts = await page.evaluate(() => [...document.querySelectorAll('#editor-modal select[aria-label="Calendar"] option')].map((o) => o.value + '|' + o.textContent));
console.log('editor cal options:', JSON.stringify(opts));
await page.fill('input[aria-label="Title"]', 'Debug2cal event');
await page.selectOption('select[aria-label="Calendar"]', { label: 'Debug second' });
await page.click('button.button-primary:has-text("Save")');
await page.waitForTimeout(1500);

const dump = await page.evaluate(() => ({
  chips: [...document.querySelectorAll('.calendar-eventcell')].map((c) => c.textContent.trim().slice(0, 40)),
  toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
}));
console.log('week chips:', JSON.stringify(dump, null, 1));
await browser.close();
