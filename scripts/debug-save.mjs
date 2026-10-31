// debug-save.mjs — dump DOM + toasts right after a save to find why the
// immediate render is missing the new event.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8080';
const SERVER = 'http://127.0.0.1:8787';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE[' + m.type() + ']', m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
const reqs = [];
page.on('request', (r) => { const u = String(r.url()); if (u.startsWith(SERVER)) reqs.push(r.method() + ' ' + u.replace(SERVER, '').slice(0, 60)); });

await page.goto(BASE + '/?server=' + SERVER + '&setup=' + mat.auth_ui_hex);
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1200);

reqs.length = 0;
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'DEBUG event');
await page.click('button.button-primary:has-text("Save")');
await page.waitForTimeout(2500);

const dump = await page.evaluate(() => ({
  chips: [...document.querySelectorAll('.calendar-dayeventcell')].map((c) => c.textContent.trim().slice(0, 40)),
  toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
  editorHidden: document.querySelector('#editor-modal').hidden,
  label: document.querySelector('#month-label').textContent,
}));
console.log(JSON.stringify(dump, null, 1));
console.log('requests:', reqs);
await page.screenshot({ path: '/tmp/debug-save.png' });
await browser.close();
