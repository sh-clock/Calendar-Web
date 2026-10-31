// probe8: isolate the RangeError: Invalid time value — clean page, rapid
// toolbar clicks, capture full stacks + WHEN they start.
import { harness } from './_lib.mjs';
const h = await harness();
const { page } = h;
const sleep = (ms) => page.waitForTimeout(ms);

const errs = [];
page.on('pageerror', (e) => errs.push(String(e && e.stack || e)));

await h.unlock();
console.log('after unlock: errors=' + errs.length);

// 1: 20x prev with stacks
for (let i = 0; i < 20; i++) { await page.click('.fc-prev-button'); await sleep(15); }
await sleep(500);
console.log('after 20x prev: errors=' + errs.length);
if (errs.length) console.log('STACK[0]:\n' + errs[0]);

// 2: 20x next
const before = errs.length;
for (let i = 0; i < 20; i++) { await page.click('.fc-next-button'); await sleep(15); }
await sleep(500);
console.log('after 20x next: +' + (errs.length - before));

// 3: rapid view switches
const before2 = errs.length;
for (let i = 0; i < 10; i++) {
  await page.click('.fc-timeGridDay-button'); await sleep(30);
  await page.click('.fc-dayGridMonth-button'); await sleep(30);
}
console.log('after view switches: +' + (errs.length - before2));
if (errs.length > before2) console.log('STACK:\n' + errs[before2]);

// what is the current view/date now?
console.log('title:', await page.evaluate(() => document.querySelector('.fc-toolbar-title')?.textContent));
console.log('errors total:', errs.length, 'unique:', [...new Set(errs.map((e) => e.split('\n')[1] || e))].length);
for (const u of [...new Set(errs.map((e) => (e.match(/at [^\n]+/) || ['?'])[0]))].slice(0, 6)) console.log('  site:', u);
await h.shot('probe8');
await h.close();
