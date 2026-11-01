// measure-month.mjs — measure the actual month-grid geometry on the live site.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';

const SITE = 'https://sh-clock.github.io/Calendar-Web/';
const SERVER = 'https://calendar-poc.sh-clock.workers.dev';
import { AUTH_UI } from './lib-prod-material.mjs'; // sec-S7-F1

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(SITE + '#setup=' + AUTH_UI + '&server=' + encodeURIComponent(SERVER));
await page.waitForTimeout(1200);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 45000 });
await page.waitForTimeout(2500);

const geo = await page.evaluate(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  return {
    viewport: { w: innerWidth, h: innerHeight },
    viewRoot: r(document.querySelector('#view-root')),
    daygridWrap: r(document.querySelector('.daygrid-wrap')),
    gridRows: r(document.querySelector('#grid-rows')),
    weeks: [...document.querySelectorAll('.daygrid-week')].map(r),
    rowevents: [...document.querySelectorAll('.daygrid-rowevents')].map(r),
    header: r(document.querySelector('#grid-head')),
    toolbar: r(document.querySelector('#toolbar')),
    scroll: { wrapScrollH: document.querySelector('.daygrid-wrap').scrollHeight, wrapClientH: document.querySelector('.daygrid-wrap').clientHeight },
  };
});
console.log(JSON.stringify(geo, null, 1));
await browser.close();
