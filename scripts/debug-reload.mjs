// debug-reload.mjs — verify the reload path renders the saved event.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8080';
const SERVER = 'http://127.0.0.1:8787';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });

async function dump(label) {
  const d = await page.evaluate(() => ({
    chips: [...document.querySelectorAll('.calendar-dayeventcell')].map((c) => c.textContent.trim().slice(0, 36)),
    toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
    label: document.querySelector('#month-label').textContent,
    appHidden: document.querySelector('#app').hidden,
  }));
  console.log(label, JSON.stringify(d));
}

await page.goto(BASE + '/?server=' + SERVER + '&setup=' + mat.auth_ui_hex);
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1200);

await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'RELOADCHECK');
await page.click('button.button-primary:has-text("Save")');
await page.waitForTimeout(1500);
await dump('after-save:');

await page.reload();
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
for (const wait of [500, 1500, 3000]) {
  await page.waitForTimeout(wait);
  await dump('after-reload (+' + wait + 'ms):');
}
await browser.close();
