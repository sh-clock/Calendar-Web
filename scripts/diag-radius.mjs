import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:8080/?server=http://127.0.0.1:8787&setup=' + mat.auth_ui_hex);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1500);
// switch to MUI theme
await page.click('#btn-settings');
await page.waitForSelector('#settings-modal:not([hidden])');
await page.click('.settings-segment-wrap .settings-segment-button:has-text("MUI")');
await page.waitForTimeout(2200);
await page.click('#settings-modal .button-primary');
await page.waitForTimeout(400);
const diag = await page.evaluate(() => {
  const g = (s) => { const e = document.querySelector(s); const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
    return { radius: cs.borderRadius, x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
  return { main: g('#btn-new-event'), caret: g('#btn-new-task'), theme: document.documentElement.dataset.fctheme };
});
console.log(JSON.stringify(diag, null, 1));
await page.screenshot({ path: '/tmp/mui-split.png', clip: { x: 0, y: 60, width: 300, height: 140 } });
await browser.close();
