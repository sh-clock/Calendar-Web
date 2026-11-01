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
page.on('requestfailed', (r) => errs.push('REQFAIL ' + r.url().slice(0, 120) + ' ' + (r.failure() || {}).errorText));
page.on('request', (r) => { const u = String(r.url()); if (u.startsWith(SERVER)) errs.push('REQ ' + r.method() + ' ' + u.replace(SERVER, '')); });
page.on('response', (r) => { const u = String(r.url()); if (u.startsWith(SERVER)) errs.push('RESP ' + r.status() + ' ' + u.replace(SERVER, '')); });
await page.goto(BASE + '/?server=' + SERVER + '&setup=' + mat.auth_ui_hex);
await page.waitForTimeout(800);
const early = await page.evaluate(() => ({
  loginHidden: document.querySelector('#login')?.hidden,
  appHidden: document.querySelector('#app')?.hidden,
  msg: document.querySelector('#login-msg')?.textContent,
  syncbar: document.querySelector('#syncbar')?.hidden,
  syncmsg: document.querySelector('#syncmsg')?.textContent,
  token: (localStorage.getItem('clock_poc_token') || 'none').slice(0, 10),
  server: localStorage.getItem('clock_poc_server'),
  lsKeys: Object.keys(localStorage),
}));
console.log('EARLY:', JSON.stringify(early, null, 2));
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForTimeout(8000);
const late = await page.evaluate(() => ({
  loginHidden: document.querySelector('#login')?.hidden,
  appHidden: document.querySelector('#app')?.hidden,
  msg: document.querySelector('#login-msg')?.textContent,
  syncbar: document.querySelector('#syncbar')?.hidden,
  syncmsg: document.querySelector('#syncmsg')?.textContent,
  calChildren: document.querySelector('#calendar')?.children.length,
  lsKeys: Object.keys(localStorage),
}));
console.log('LATE:', JSON.stringify(late, null, 2));
console.log('LOG:');
for (const e of errs) console.log('  ' + e);
await page.screenshot({ path: '/tmp/probe-unlock-debug.png' });
await browser.close();
