// measure-week.mjs — hard-verify the week header states (aria-current = today,
// aria-pressed = selected) that the VLM claimed were inverted.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';

const SITE = "http://127.0.0.1:8080/";
const SERVER = 'http://127.0.0.1:8787';
const AUTH_UI = '*SCRUBBED*<=';

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(SITE + '#setup=' + AUTH_UI + '&server=' + encodeURIComponent(SERVER));
await page.waitForTimeout(1200);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 45000 });
await page.waitForTimeout(2000);

// replicate the E2E sequence exactly: month → next → prev → week → next → prev
await page.click('#btn-next');
await page.waitForTimeout(400);
await page.click('#btn-prev');
await page.waitForTimeout(400);
await page.click('.view-button[data-view="week"]');
await page.waitForTimeout(400);
await page.click('#btn-next');
await page.waitForTimeout(400);
await page.click('#btn-prev');
await page.waitForTimeout(600);

const d = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.calendar-grid-heading')].map((b) => ({
    day: b.querySelector('.calendar-grid-heading-number').textContent,
    current: b.getAttribute('aria-current'),
    pressed: b.getAttribute('aria-pressed'),
  }));
  const chips = [...document.querySelectorAll('.calendar-eventcell')].map((c) => {
    const r = c.getBoundingClientRect();
    return {
      text: c.textContent.trim().slice(0, 30),
      top: Math.round(r.y),
      left: Math.round(r.x),
      col: Math.round((r.x - document.querySelector('.timegrid-columns').getBoundingClientRect().x) / (r.width + 1)),
    };
  });
  const cols = [...document.querySelectorAll('.timegrid-day')].map((c) => c.getAttribute('aria-label'));
  return { today: new Date().toISOString().slice(0, 10), btns, chips, cols };
});
console.log(JSON.stringify(d, null, 1));
await browser.close();
