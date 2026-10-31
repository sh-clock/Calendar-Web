// probe: discover FC v6 DOM shapes used by the A6 stress tests (throwaway)
import { harness, findEvt, decryptAll } from './_lib.mjs';

const h = await harness();
const { page } = h;
await h.unlock();

// create one timed event to probe against
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'A6 probe event');
await page.fill('input[aria-label="Starts date"]', '2026-11-04');
await page.fill('input[aria-label="Starts time"]', '22:00');
await page.fill('input[aria-label="Ends date"]', '2026-11-05');
await page.fill('input[aria-label="Ends time"]', '02:00');
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1200);

const probe = await page.evaluate(() => {
  const out = {};
  out.monthCells = document.querySelectorAll('.fc-daygrid-day').length;
  out.firstCell = document.querySelector('.fc-daygrid-day')?.getAttribute('data-date');
  out.lastCell = document.querySelectorAll('.fc-daygrid-day')[41]?.getAttribute('data-date');
  const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('A6 probe event'));
  out.chipFoundInMonth = !!chip;
  if (chip) {
    out.chipClasses = chip.className;
    out.chipParentDay = chip.closest('.fc-daygrid-day')?.getAttribute('data-date');
  }
  return out;
});
console.log('MONTH:', JSON.stringify(probe, null, 2));

await page.click('.fc-timeGridWeek-button');
await page.waitForTimeout(700);
const probe2 = await page.evaluate(() => {
  const out = {};
  out.cols = document.querySelectorAll('.fc-timegrid-col').length;
  const col = document.querySelector('.fc-timegrid-col');
  out.colAttrs = col ? [...col.attributes].map((a) => a.name + '=' + a.value).join(' ') : null;
  out.headerCells = [...document.querySelectorAll('.fc-col-header-cell')].map((c) => c.getAttribute('data-date') || c.textContent.trim()).slice(0, 8);
  out.slotLanes = document.querySelectorAll('.fc-timegrid-slot-lane').length;
  const chip = [...document.querySelectorAll('.fc-timegrid-event')].find((e) => e.textContent.includes('A6 probe event'));
  out.timedChipFound = !!chip;
  if (chip) {
    const r = chip.getBoundingClientRect();
    out.chipRect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    out.chipText = chip.textContent.trim();
    out.resizers = chip.querySelectorAll('.fc-event-resizer').length;
    // which day column does the chip overlap?
    const cols = [...document.querySelectorAll('.fc-timegrid-col')];
    out.overlapCols = cols.filter((c) => {
      const cr = c.getBoundingClientRect();
      return r.x + r.width > cr.x && r.x < cr.x + cr.width;
    }).length;
    out.slotLabels = [...document.querySelectorAll('.fc-timegrid-slot-label')].slice(0, 4).map((s) => s.textContent.trim());
  }
  return out;
});
console.log('WEEK:', JSON.stringify(probe2, null, 2));

// all-day row in week view?
const probe3 = await page.evaluate(() => ({
  dayHeaderRow: document.querySelectorAll('.fc-daygrid-day').length,
  alldayChips: [...document.querySelectorAll('.fc-daygrid-event')].length,
}));
console.log('WEEK-ALLDAY:', JSON.stringify(probe3));

const rows = await decryptAll();
const ev = findEvt(rows, 'A6 probe event');
console.log('ROW:', JSON.stringify({ dtstart: ev?.dtstart, dtend: ev?.dtend, rrule: ev?.rrule }, null, 2));
console.log('FULLTEXT:\n' + (ev ? ev.text.split('\r\n').filter(l => l.startsWith('DT') || l.startsWith('SUM')).join('\n') : 'n/a'));

await page.screenshot({ path: '/tmp/stress-probe.png' });
await h.close();
