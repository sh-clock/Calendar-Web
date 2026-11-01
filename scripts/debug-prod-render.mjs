// debug-prod-render.mjs — unlock on the live site and dump every chip.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';

const SITE = 'https://sh-clock.github.io/Calendar-Web/';
const SERVER = 'https://calendar-poc.sh-clock.workers.dev';
import { AUTH_UI } from './lib-prod-material.mjs'; // sec-S7-F1

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });

await page.goto(SITE + '#setup=' + AUTH_UI + '&server=' + encodeURIComponent(SERVER));
await page.waitForTimeout(1500);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 45000 });
await page.waitForTimeout(3000);

const d = await page.evaluate(() => ({
  chips: [...document.querySelectorAll('.calendar-dayeventcell')].map((c) => c.textContent.trim().slice(0, 44)),
  calList: [...document.querySelectorAll('#calendar-list li')].map((li) => li.textContent.trim()),
  corrupt: [...document.querySelectorAll('.corrupt-note')].map((n) => n.textContent),
  label: document.querySelector('#month-label').textContent,
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  today: new Date().toISOString(),
}));
console.log(JSON.stringify(d, null, 1));
await page.screenshot({ path: '/tmp/prod-debug.png' });
await browser.close();
