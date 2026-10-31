// probe5: track toolbar title (current date) across settings firstDay changes + view switches
import { harness } from './_lib.mjs';
const h = await harness();
const { page } = h;
const sleep = (ms) => page.waitForTimeout(ms);
await h.unlock();
const title = () => page.evaluate(() => document.querySelector('.fc-toolbar-title')?.textContent || '?');
const firstCol = () => page.evaluate(() => document.querySelector('.fc-col-header-cell')?.getAttribute('data-date'));

console.log('start:', await title());
await page.click('.fc-dayGridMonth-button'); await sleep(600);
console.log('month:', await title());
await page.click('.fc-multiMonthYear-button'); await sleep(900);
console.log('year:', await title());
await page.click('.fc-dayGridMonth-button'); await sleep(600);
console.log('month after year:', await title());

await page.click('#btn-settings');
await page.waitForSelector('#settings-modal:not([hidden])');
await page.selectOption('#set-firstday', '1');
await sleep(400);
console.log('after fd=1 resetOptions, month:', await title());
await page.click('#settings-modal button:has-text("Done")');
await sleep(250);
await page.click('.fc-timeGridWeek-button'); await sleep(600);
console.log('week:', await title(), 'firstCol:', await firstCol());

// what does the mini calendar think?
const mini = await page.evaluate(() => {
  const mc = document.querySelector('#minicalendar');
  const sel = mc?.querySelector('.minical-selected, [aria-current="date"], .selected');
  return { text: sel?.textContent, title: mc?.querySelector('.minical-title, h2, strong')?.textContent };
});
console.log('mini:', JSON.stringify(mini));
await h.shot('probe5');
await h.close();
