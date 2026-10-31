// probe9: RangeError from listYear view + rapid prev? isolate further.
import { harness } from './_lib.mjs';
const h = await harness();
const { page } = h;
const sleep = (ms) => page.waitForTimeout(ms);
const errs = [];
page.on('pageerror', (e) => errs.push(String((e && e.stack) || e)));
await h.unlock();

// A: listYear + 20x prev
await page.click('.fc-listYear-button'); await sleep(900);
console.log('A listYear open: errors=' + errs.length);
for (let i = 0; i < 20; i++) { await page.click('.fc-prev-button'); await sleep(15); }
await sleep(600);
console.log('A after 20x prev (from listYear): errors=' + errs.length);
console.log('A title:', await page.evaluate(() => document.querySelector('.fc-toolbar-title')?.textContent));
if (errs.length) console.log('A STACK[0]:\n' + errs[0]);
await h.shot('probe9-a');

// B: keyboard shortcuts d/w/m/y/v/a from month view (like 6.5 without popover)
errs.length = 0;
await page.click('.fc-dayGridMonth-button'); await sleep(600);
for (const key of ['d', 'w', 'm', 'y', 'v', 'a']) { await page.keyboard.press(key); await sleep(60); }
await sleep(600);
console.log('B after shortcuts: errors=' + errs.length, 'view=', await page.evaluate(() => document.querySelector('.fc-view')?.className?.split(' ').find((c) => c.endsWith('-view'))));
if (errs.length) console.log('B STACK[0]:\n' + errs[0]);
await h.shot('probe9-b');

// C: rapid prev in timeGridDay (the 'd' view) — 20x
errs.length = 0;
await page.click('.fc-today-button'); await sleep(400);
await page.click('.fc-timeGridDay-button'); await sleep(600);
for (let i = 0; i < 20; i++) { await page.click('.fc-prev-button'); await sleep(15); }
await sleep(600);
console.log('C after 20x prev in day view: errors=' + errs.length);
if (errs.length) console.log('C STACK[0]:\n' + errs[0]);
await h.close();
