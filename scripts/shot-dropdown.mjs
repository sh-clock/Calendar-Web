// shot-dropdown.mjs — screenshot + geometry of the new-event split button.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8080/#server=http://127.0.0.1:8787&setup=' + mat.auth_ui_hex);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1500);
const geo = await page.evaluate(() => {
  const g = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { x: Math.round(r.x), y: Math.round(r.y), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      pad: cs.padding, fs: cs.fontSize, br: cs.borderRadius };
  };
  return { group: g('.newevent-group'), main: g('#btn-new-event'), caret: g('#btn-new-task') };
});
console.log(JSON.stringify(geo, null, 1));
await page.screenshot({ path: '/tmp/dropdown-closed.png', clip: { x: 0, y: 0, width: 300, height: 400 } });
// open the dropdown menu
await page.click('#btn-new-task');
await page.waitForTimeout(300);
const menuGeo = await page.evaluate(() => {
  const m = document.getElementById('new-task-menu');
  if (!m) return null;
  const r = m.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
});
console.log('menu: ' + JSON.stringify(menuGeo));
await page.screenshot({ path: '/tmp/dropdown-open.png', clip: { x: 0, y: 0, width: 320, height: 460 } });
await browser.close();
