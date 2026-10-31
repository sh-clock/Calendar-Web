// probe2: month-view DOM geometry for multi-day events
import { harness } from './_lib.mjs';
const h = await harness();
const { page } = h;
await h.unlock();
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'P2 allday 5day');
await page.fill('input[aria-label="Starts date"]', '2026-11-12');
await page.fill('input[aria-label="Ends date"]', '2026-11-16');
await page.check('#editor-modal .fullday-recurrency input[type=checkbox]');
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1000);
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'P2 midnight');
await page.fill('input[aria-label="Starts date"]', '2026-11-04');
await page.fill('input[aria-label="Starts time"]', '23:30');
await page.fill('input[aria-label="Ends date"]', '2026-11-05');
await page.fill('input[aria-label="Ends time"]', '00:30');
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1000);

await page.click('.fc-dayGridMonth-button');
await page.waitForTimeout(300);
await page.click('.fc-next-button');
await page.waitForTimeout(700);

const out = await page.evaluate(() => {
  const res = { chips: [], dayRects: {} };
  for (const cell of document.querySelectorAll('.fc-daygrid-day')) {
    const d = cell.getAttribute('data-date');
    const r = cell.getBoundingClientRect();
    res.dayRects[d] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    for (const chip of cell.querySelectorAll('.fc-event')) {
      const cr = chip.getBoundingClientRect();
      res.chips.push({
        title: chip.textContent.trim().slice(0, 30),
        parentDay: d,
        classes: chip.className.replace(/fc-event-draggable|fc-h-event|fc-/g, '').trim().slice(0, 80),
        rect: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) },
        style: chip.getAttribute('style'),
      });
    }
  }
  return res;
});
for (const c of out.chips) console.log(JSON.stringify(c));
console.log('Nov 4 rect:', JSON.stringify(out.dayRects['2026-11-04']));
console.log('Nov 5 rect:', JSON.stringify(out.dayRects['2026-11-05']));
await page.screenshot({ path: '/tmp/stress-probe2.png' });
await h.close();
