// probe3: after backdrop-dismiss desync, dump where the chip is after view switches
import { harness } from './_lib.mjs';
const h = await harness();
const { page } = h;
const sleep = (ms) => page.waitForTimeout(ms);
await h.unlock();
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'P3 daily');
await page.fill('input[aria-label="Starts date"]', '2026-11-05');
await page.fill('input[aria-label="Starts time"]', '10:00');
await page.fill('input[aria-label="Ends date"]', '2026-11-05');
await page.fill('input[aria-label="Ends time"]', '11:00');
await page.selectOption('select[aria-label="Frequency"]', 'DAILY');
await page.click('#editor-modal .button-primary');
await sleep(1200);
await page.click('.fc-dayGridMonth-button'); await sleep(600);
await page.click('.fc-next-button'); await sleep(600);

const dump = (label) => page.evaluate((l) => {
  const cells = [...document.querySelectorAll('.fc-daygrid-day')];
  const found = [];
  for (const c of cells) {
    for (const e of c.querySelectorAll('.fc-event')) {
      if (e.textContent.includes('P3 daily')) found.push(c.getAttribute('data-date'));
    }
  }
  const view = document.querySelector('.fc .fc-view')?.className || '?';
  return { label: l, view: view.slice(0, 40), months: cells.length, first: cells[0]?.getAttribute('data-date'), last: cells[cells.length - 1]?.getAttribute('data-date'), days: found };
}, label).then((r) => console.log(JSON.stringify(r)));

// drag Nov5 -> Nov8 then backdrop-dismiss
const g = await page.evaluate(() => {
  const fromCell = document.querySelector('.fc-daygrid-day[data-date="2026-11-05"]');
  const toCell = document.querySelector('.fc-daygrid-day[data-date="2026-11-08"]');
  const chip = [...fromCell.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('P3 daily'));
  const cb = chip.getBoundingClientRect();
  const tb = toCell.getBoundingClientRect();
  return { fx: cb.x + cb.width / 2, fy: cb.y + cb.height / 2, tx: tb.x + tb.width / 2, ty: tb.y + 10 };
});
await page.mouse.move(h.R(g.fx), h.R(g.fy));
await page.mouse.down();
await page.mouse.move(h.R(g.tx), h.R(g.ty), { steps: 15 });
await page.mouse.up();
await sleep(900);
console.log('modal open:', await page.locator('#recur-modal').isVisible());
await page.mouse.click(5, 500);
await sleep(700);
await dump('after-backdrop-dismiss');
await page.click('.fc-listYear-button'); await sleep(600);
await dump('after-listYear');
await page.click('.fc-dayGridMonth-button'); await sleep(700);
await dump('after-month-return');
// also try a pure month->week->month cycle without listYear
await page.click('.fc-timeGridWeek-button'); await sleep(600);
await page.click('.fc-dayGridMonth-button'); await sleep(600);
await dump('after-week-month-cycle');
await h.shot('probe3');
await h.close();
