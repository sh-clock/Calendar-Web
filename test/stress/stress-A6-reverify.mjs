// reverify: (a) resize-to-minimum toast — drag resizer to exactly the event
// START (zero duration -> invalid_duration path) vs clearly above it; (b)
// Escape vs backdrop-click vs Cancel on the recurring-choice modal after a
// month-view drag (does the chip revert?).
import { harness, decryptAll, findEvt, makeTally } from './_lib.mjs';

const T = makeTally();
const h = await harness();
const { page } = h;
const sleep = (ms) => page.waitForTimeout(ms);

try {
  await h.unlock();
  // one plain timed event 09:00-10:00 on Nov 4
  await page.click('#btn-new-event');
  await page.fill('input[aria-label="Title"]', 'RV resize target');
  await page.fill('input[aria-label="Starts date"]', '2026-11-04');
  await page.fill('input[aria-label="Starts time"]', '09:00');
  await page.fill('input[aria-label="Ends date"]', '2026-11-04');
  await page.fill('input[aria-label="Ends time"]', '10:00');
  await page.click('#editor-modal .button-primary');
  await sleep(1200);

  // day view of Nov 4 via month navLink
  await page.click('.fc-dayGridMonth-button'); await sleep(400);
  await page.click('.fc-next-button'); await sleep(700);
  await page.click('.fc-daygrid-day[data-date="2026-11-04"] .fc-daygrid-day-number');
  await sleep(700);

  const geomOf = () => page.evaluate(() => {
    const chip = [...document.querySelectorAll('.fc-timegrid-event')].find((e) => e.textContent.includes('RV resize target'));
    if (!chip) return null;
    const lanes = [...document.querySelectorAll('.fc-timegrid-slot-lane')];
    const first = lanes[0].getBoundingClientRect();
    const last = lanes[lanes.length - 1].getBoundingClientRect();
    const pxPerSlot = (last.y + last.height - first.y) / lanes.length;
    const z = chip.querySelector('.fc-event-resizer');
    const r = chip.getBoundingClientRect();
    const zb = z ? z.getBoundingClientRect() : null;
    return { top: r.y, left: r.x, w: r.width, h: r.height, zx: zb ? zb.x + zb.width / 2 : null, zy: zb ? zb.y + zb.height / 2 : null, pxPerSlot };
  });

  // hover so resizer appears
  let g = await geomOf();
  await page.mouse.move(h.R(g.left + g.w / 2), h.R(g.top + g.h / 2));
  await sleep(500);
  g = await geomOf();
  T.ok('resizer present on hover', !!g && !!g.zx, JSON.stringify(g));

  /* (a1) drag the resizer to EXACTLY the event start (zero duration) */
  let m = h.mark();
  await page.mouse.move(h.R(g.zx), h.R(g.top + g.h / 2)); await sleep(150);
  await page.mouse.move(h.R(g.zx), h.R(g.zy)); await sleep(200);
  await page.mouse.down();
  await page.mouse.move(h.R(g.zx), h.R(g.top + 2), { steps: 15 }); // bottom edge -> start
  await page.mouse.up();
  await sleep(1500);
  const toasts1 = await page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent));
  const reqs1 = h.since(m);
  let rows = await decryptAll();
  let ev = findEvt(rows, 'RV resize target');
  T.ok('resize-to-start: NO PUT', h.puts(reqs1) === 0, JSON.stringify(reqs1.map((r) => r.m)));
  T.ok('resize-to-start: revert toast mentions invalid_duration',
    toasts1.some((t) => t.includes('invalid_duration')), JSON.stringify(toasts1));
  T.ok('resize-to-start: DTEND unchanged 10:00', ev && ev.dtend === 'DTEND:20261104T100000Z', ev ? ev.dtend : '-');
  const g1 = await geomOf();
  T.ok('resize-to-start: chip reverted to 2 slots', !!g1 && Math.abs(g1.h / g1.pxPerSlot - 2) < 1, g1 ? (g1.h / g1.pxPerSlot).toFixed(2) : 'gone');

  /* (a2) drag the resizer clearly ABOVE the start (negative duration) */
  m = h.mark();
  await page.mouse.move(h.R(g1.zx), h.R(g1.top + g1.h / 2)); await sleep(300);
  g = await geomOf();
  await page.mouse.move(h.R(g.zx), h.R(g.zy)); await sleep(200);
  await page.mouse.down();
  await page.mouse.move(h.R(g.zx), h.R(g.top - g.pxPerSlot * 3), { steps: 15 });
  await page.mouse.up();
  await sleep(1500);
  const toasts2 = await page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent));
  const reqs2 = h.since(m);
  rows = await decryptAll();
  ev = findEvt(rows, 'RV resize target');
  T.ok('resize-above-start: NO PUT', h.puts(reqs2) === 0, JSON.stringify(reqs2.map((r) => r.m)));
  T.ok('resize-above-start: DTEND unchanged 10:00', ev && ev.dtend === 'DTEND:20261104T100000Z', ev ? ev.dtend : '-');
  const g2 = await geomOf();
  T.ok('resize-above-start: chip reverted to 2 slots', !!g2 && Math.abs(g2.h / g2.pxPerSlot - 2) < 1, g2 ? (g2.h / g2.pxPerSlot).toFixed(2) : 'gone');
  console.log('  ..   above-start toasts: ' + JSON.stringify(toasts2) + ' (empty = FullCalendar never fired eventResize; silent revert, no app toast)');

  /* (b) Escape vs backdrop vs Cancel on recurring drag */
  await page.click('#btn-new-event');
  await page.fill('input[aria-label="Title"]', 'RV daily');
  await page.fill('input[aria-label="Starts date"]', '2026-11-05');
  await page.fill('input[aria-label="Starts time"]', '10:00');
  await page.fill('input[aria-label="Ends date"]', '2026-11-05');
  await page.fill('input[aria-label="Ends time"]', '11:00');
  await page.selectOption('select[aria-label="Frequency"]', 'DAILY');
  await page.click('#editor-modal .button-primary');
  await sleep(1200);

  await page.click('.fc-dayGridMonth-button'); await sleep(600);

  const chipCount = (day) => page.evaluate((d) => {
    const cell = document.querySelector('.fc-daygrid-day[data-date="' + d + '"]');
    return cell ? [...cell.querySelectorAll('.fc-event')].filter((e) => e.textContent.includes('RV daily')).length : -1;
  }, day);

  async function monthDrag(fromDay, toDay) {
    const g = await page.evaluate(({ from, to }) => {
      const fromCell = document.querySelector('.fc-daygrid-day[data-date="' + from + '"]');
      const toCell = document.querySelector('.fc-daygrid-day[data-date="' + to + '"]');
      const chip = fromCell && [...fromCell.querySelectorAll('.fc-event')][0];
      if (!chip || !toCell) return null;
      const cb = chip.getBoundingClientRect();
      const tb = toCell.getBoundingClientRect();
      return { fx: cb.x + cb.width / 2, fy: cb.y + cb.height / 2, tx: tb.x + tb.width / 2, ty: tb.y + 10 };
    }, { from: fromDay, to: toDay });
    await page.mouse.move(h.R(g.fx), h.R(g.fy));
    await page.mouse.down();
    await page.mouse.move(h.R(g.tx), h.R(g.ty), { steps: 15 });
    await page.mouse.up();
  }

  // b1: Escape
  let m1 = h.mark();
  await monthDrag('2026-11-05', '2026-11-07');
  await sleep(800);
  await page.keyboard.press('Escape');
  await sleep(700);
  T.ok('Escape: modal closed, 0 PUTs', (await page.locator('#recur-modal').isHidden()) && h.puts(h.since(m1)) === 0);
  T.ok('Escape: chip VISUALLY back on Nov 5 (immediate revert)',
    (await chipCount('2026-11-05')) === 1 && (await chipCount('2026-11-07')) === 1,
    'Nov5=' + (await chipCount('2026-11-05')) + ' Nov7=' + (await chipCount('2026-11-07')));

  // b2: backdrop click
  m1 = h.mark();
  await monthDrag('2026-11-05', '2026-11-08');
  await sleep(800);
  await page.mouse.click(10, 450); // far-left backdrop area
  await sleep(700);
  T.ok('backdrop: modal closed, 0 PUTs', (await page.locator('#recur-modal').isHidden()) && h.puts(h.since(m1)) === 0);
  T.ok('backdrop: chip VISUALLY back on Nov 5 (immediate revert)',
    (await chipCount('2026-11-05')) === 1 && (await chipCount('2026-11-08')) === 1,
    'Nov5=' + (await chipCount('2026-11-05')) + ' Nov8=' + (await chipCount('2026-11-08')));

  // b3: Cancel button (reference behavior)
  m1 = h.mark();
  await monthDrag('2026-11-05', '2026-11-09');
  await sleep(800);
  await page.click('#recur-modal button:has-text("Cancel")');
  await sleep(700);
  T.ok('Cancel: 0 PUTs + chip back on Nov 5',
    h.puts(h.since(m1)) === 0 && (await chipCount('2026-11-05')) === 1 && (await chipCount('2026-11-09')) === 1);

  // data integrity: no exception/EXDATE ever written
  rows = await decryptAll();
  ev = findEvt(rows, 'RV daily');
  T.ok('RV daily row intact (1 VEVENT, no EXDATE)',
    !!ev && (ev.text.match(/BEGIN:VEVENT/g) || []).length === 1 && ev.exdate.length === 0,
    'vevents=' + (ev ? (ev.text.match(/BEGIN:VEVENT/g) || []).length : '?'));
} catch (e) {
  T.ok('reverify ran to completion', false, String(e));
  await h.shot('reverify-crash');
}

T.ok('no page errors during reverify', h.pageErrors.length === 0, h.pageErrors.join(' | ').slice(0, 300));
console.log('\n=== REVERIFY: ' + T.summary() + ' ===');
if (T.fail > 0) console.log('FAILURES: ' + T.failures.join(' ; '));
await h.shot('reverify-final');
await h.close();
process.exit(T.fail > 0 ? 1 : 0);
