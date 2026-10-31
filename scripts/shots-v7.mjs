// shots-v7.mjs — capture every theme × color scheme + task states for the
// visual audit (VLM). Uses the SAME app the smoke test exercised.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const OUT = '/home/z/my-project/download/v7-themes';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(([t, s]) => {
  localStorage.setItem('clock_poc_auth_ui', t);
  localStorage.setItem('clock_poc_server', s);
}, [mat.auth_ui_hex, 'http://127.0.0.1:8787']);
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto('http://127.0.0.1:8080/index.html');
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#calendar [data-date]', { timeout: 30000 });
await page.waitForTimeout(3000);

const THEMES = ['monarch', 'forma', 'breezy', 'pulse', 'classic', 'shadcn', 'mui'];
for (const theme of THEMES) {
  for (const scheme of ['light', 'dark']) {
    await page.click('#btn-settings');
    await page.waitForSelector('#settings-modal:not([hidden])');
    // theme buttons live in the SECOND settings-segment (first = color scheme)
    const segs = await page.$$('.settings-segment');
    const themeSeg = segs.find((s) => (s.getAttribute('aria-label') || '') === 'Calendar theme') || segs[segs.length - 1];
    await themeSeg.$(`button:has-text("${theme === 'mui' ? 'MUI' : theme.charAt(0).toUpperCase() + theme.slice(1)}")`).then((b) => b.click());
    // color scheme segment (first)
    const schemeBtn = (await page.$$('.settings-segment'))[0].$(`button:has-text("${scheme.charAt(0).toUpperCase() + scheme.slice(1)}")`);
    await schemeBtn.then((b) => b.click());
    await page.waitForTimeout(2200);
    await page.click('#settings-modal .button-primary'); // Done
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/${theme}-${scheme}.png` });
  }
}

// Week view (monarch light) + task states close-up.
await page.click('#btn-settings');
await page.waitForSelector('#settings-modal:not([hidden])');
const segs = await page.$$('.settings-segment');
await segs[0].$('button:has-text("Light")').then((b) => b.click());
const themeSeg = segs.find((s) => (s.getAttribute('aria-label') || '') === 'Calendar theme');
await themeSeg.$('button:has-text("Monarch")').then((b) => b.click());
await page.click('#settings-modal .button-primary');
await page.waitForTimeout(1500);
await page.click('#calendar button[aria-label="Week view"]');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/monarch-week-light.png` });

// Task close-up: completed vs open tasks in month view.
await page.click('#calendar button[aria-label="Month view"]');
await page.waitForTimeout(800);
const taskCell = await page.$('.fc-event.fc-task');
if (taskCell) {
  const box = await taskCell.boundingBox();
  if (box) {
    await page.screenshot({ path: `${OUT}/task-closeup.png`, clip: { x: Math.max(0, box.x - 40), y: Math.max(0, box.y - 40), width: Math.min(520, 1440 - box.x), height: Math.min(300, 900 - box.y) } });
  }
}

console.log('page errors:', errs.length, errs.slice(0, 5));
await browser.close();
console.log('screenshots written to ' + OUT);
