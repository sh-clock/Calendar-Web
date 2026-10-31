// probe6: replicate group-4 fd loop exactly, printing titles
import { harness } from './_lib.mjs';
const h = await harness();
const { page } = h;
const sleep = (ms) => page.waitForTimeout(ms);
await h.unlock();
const title = () => page.evaluate(() => document.querySelector('.fc-toolbar-title')?.textContent || '?');
const firstCol = () => page.evaluate(() => document.querySelector('.fc-col-header-cell')?.getAttribute('data-date'));
const firstCell = () => page.evaluate(() => document.querySelector('.fc-daygrid-day')?.getAttribute('data-date'));

async function openSettings() {
  await page.click('#btn-settings');
  await page.waitForSelector('#settings-modal:not([hidden])');
}
async function closeSettings() {
  await page.click('#settings-modal button:has-text("Done")');
  await sleep(250);
}

for (const fd of [0, 1]) {
  await openSettings();
  await page.selectOption('#set-firstday', String(fd));
  await sleep(350);
  await closeSettings();
  console.log('fd=' + fd + ' set; view title now:', await title());
  await page.click('.fc-timeGridWeek-button'); await sleep(600);
  console.log('  week firstCol:', await firstCol(), '| title:', await title());
  await page.click('.fc-dayGridMonth-button'); await sleep(600);
  console.log('  month title:', await title());
  await page.click('.fc-next-button'); await sleep(600);
  console.log('  +next title:', await title(), 'firstCell:', await firstCell());
  await page.click('.fc-prev-button'); await sleep(400);
  console.log('  -prev title:', await title());
  await page.click('.fc-multiMonthYear-button'); await sleep(900);
  console.log('  year title:', await title());
  await page.click('.fc-dayGridMonth-button'); await sleep(500);
  console.log('  month-after-year title:', await title());
}
await h.close();
