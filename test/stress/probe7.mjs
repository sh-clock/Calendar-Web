// probe7: (a) timegrid col count in standard week view (is there a filler col?);
// (b) slot-label texts with 15-min slots (slotLabelInterval override);
// (c) current-date drift through year-view transitions.
import { harness } from './_lib.mjs';
const h = await harness();
const { page } = h;
const sleep = (ms) => page.waitForTimeout(ms);
await h.unlock();

// (a) week view column count
await page.click('.fc-timeGridWeek-button'); await sleep(700);
const week = await page.evaluate(() => ({
  cols: document.querySelectorAll('.fc-timegrid-col').length,
  headers: [...document.querySelectorAll('.fc-col-header-cell')].map((c) => c.getAttribute('data-date')),
  colDates: [...document.querySelectorAll('.fc-timegrid-col')].map((c) => c.getAttribute('data-date')),
}));
console.log('WEEK cols=' + week.cols, 'headers=' + week.headers.join(','), 'colDates=' + week.colDates.join(','));

// day view column count
await page.click('.fc-timeGridDay-button'); await sleep(600);
const day = await page.evaluate(() => ({
  cols: document.querySelectorAll('.fc-timegrid-col').length,
  headers: [...document.querySelectorAll('.fc-col-header-cell')].map((c) => c.getAttribute('data-date')),
}));
console.log('DAY cols=' + day.cols, 'headers=' + day.headers.join(','));

// (b) 15-min slots: label texts
await page.click('#btn-settings');
await page.waitForSelector('#settings-modal:not([hidden])');
await page.selectOption('#set-slot', '00:15:00');
await sleep(400);
await page.click('#settings-modal button:has-text("Done")');
await sleep(300);
await page.click('.fc-timeGridDay-button'); await sleep(700);
const labels = await page.evaluate(() => [...document.querySelectorAll('.fc-timegrid-slot-label')].slice(0, 12).map((l) => l.textContent.trim()));
const labelN = await page.evaluate(() => document.querySelectorAll('.fc-timegrid-slot-label').length);
console.log('15min labels count=' + labelN, 'first12=' + JSON.stringify(labels));
await h.shot('probe7-15min');

// (c) custom view 3 days — col dates
await page.click('#btn-settings');
await page.waitForSelector('#settings-modal:not([hidden])');
await page.selectOption('#set-customdays', '3');
await sleep(300);
await page.click('#settings-modal button:has-text("Done")');
await sleep(250);
await page.click('.fc-custom-button'); await sleep(700);
const cust = await page.evaluate(() => ({
  cols: document.querySelectorAll('.fc-timegrid-col').length,
  headers: [...document.querySelectorAll('.fc-col-header-cell')].map((c) => c.getAttribute('data-date') || c.textContent.trim()),
}));
console.log('CUSTOM3 cols=' + cust.cols, 'headers=' + JSON.stringify(cust.headers));
await h.shot('probe7-custom3');
await h.close();
