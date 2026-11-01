// reverify: (a) resize-to-minimum toast — drag resizer to exactly the event
// START (zero duration -> invalid_duration path) vs clearly above it; (b)
// Escape vs backdrop-click vs Cancel on the recurring-choice modal after a
// month-view drag (does the chip revert?).
import { harness, decryptAll, findEvt, makeTally, resizerEndClass, scrollerClass, gotoMonth } from './_lib.mjs';

const T = makeTally();
const h = await harness();
const { page } = h;
const RZ_END = resizerEndClass(); // v7 hashed resizer class (see _lib)
const SCROLLER = scrollerClass(); // v7 hashed timegrid scroller class (see _lib)
const sleep = (ms) => page.waitForTimeout(ms);

try {
  await h.unlock();
await page.evaluate((c) => { window.__RZ_END = c; }, RZ_END); // v7 hashed resizer class, usable inside evaluate()
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
  await page.click('#calendar button[aria-label="Month view"]'); await sleep(400);
  await gotoMonth(page, '2026-11'); await sleep(700);
  await page.click('[data-date="2026-11-04"] [role=link][aria-label^="Go to"]');
  await sleep(700);

  const geomOf = () => page.evaluate(() => {
    const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('RV resize target'));
    if (!chip) return null;
    const lanes = [...document.querySelectorAll('[data-time]')].filter((e) => !e.textContent.trim()); // v7: lanes carry data-time but no text (labels do)
    const first = lanes[0].getBoundingClientRect();
    const last = lanes[lanes.length - 1].getBoundingClientRect();
    const pxPerSlot = (last.y + last.height - first.y) / lanes.length;
    const z = chip.querySelector('.' + window.__RZ_END);
    const r = chip.getBoundingClientRect();
    const zb = z ? z.getBoundingClientRect() : null;
    return { top: r.y, left: r.x, w: r.width, h: r.height, zx: zb ? zb.x + zb.width / 2 : null, zy: zb ? zb.y + zb.height / 2 : null, pxPerSlot };
  });

  // hover so resizer appears
  let g = await geomOf();
  // TIME-OF-DAY-dependent geometry (same species as the recorded e2e-fc §16
  // lesson): the day view auto-scrolls to "now", so a fixed-hour chip can sit
  // ABOVE the viewport depending on when the suite runs (a 09:00 chip at
  // 09:20 local time). Center the chip's lane in the timegrid scroller
  // BEFORE the hover, or the resizer never mounts (mouse never hovers it).
  if (g && g.top < 0) {
    await page.evaluate((sel) => {
      const scroller = document.querySelector(sel);
      const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('RV resize target'));
      if (!scroller || !chip) return;
      const r = chip.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      // target: chip center at the scroller's vertical center
      scroller.scrollTop += r.top + r.height / 2 - (sr.top + sr.height / 2);
    }, '.' + SCROLLER);
    await sleep(300);
    g = await geomOf();
  }
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
  // v7 note: sub-minimum resizes are either CANCELLED natively (v6 app-level
  // reject + invalid_duration toast) or CLAMPED to a valid minimum and fired
  // (v7 default) — the INVARIANT is: never a corrupt row, never >1 PUT, and
  // DTEND always >= DTSTART.
  const noPut1 = h.puts(reqs1) === 0;
  const clamped1 = h.puts(reqs1) === 1 && ev && ev.dtend >= 'DTEND:20261104T090000Z' && ev.dtstart === 'DTSTART:20261104T090000Z';
  T.ok('resize-to-start: cancelled OR clamped (1 PUT max, DTEND >= start)', noPut1 || clamped1,
    'puts=' + h.puts(reqs1) + ' dtend=' + (ev ? ev.dtend : '-'));
  T.ok('resize-to-start: no corruption (row parses)',
    !!ev && !!ev.dtstart && !!ev.dtend, ev ? ev.dtstart + ' ' + ev.dtend : '-');
  const g1 = await geomOf();
  T.ok('resize-to-start: chip valid height (>= 1 slot)', !!g1 && g1.h / g1.pxPerSlot >= 0.9, g1 ? (g1.h / g1.pxPerSlot).toFixed(2) : 'gone');

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
  const noPut2 = h.puts(reqs2) === 0;
  const clamped2 = h.puts(reqs2) === 1 && ev && ev.dtend >= 'DTSTART:' + (ev.dtstart || '').slice(8);
  T.ok('resize-above-start: cancelled OR clamped (1 PUT max, DTEND >= start)', noPut2 || clamped2,
    'puts=' + h.puts(reqs2) + ' dtend=' + (ev ? ev.dtend : '-'));
  const g2 = await geomOf();
  T.ok('resize-above-start: chip valid height (>= 1 slot)', !!g2 && g2.h / g2.pxPerSlot >= 0.9, g2 ? (g2.h / g2.pxPerSlot).toFixed(2) : 'gone');
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

  await gotoMonth(page, '2026-11'); await sleep(600);

  // v7: dayGrid events render in a positioned layer — count chips that
  // GEOMETRICALLY intersect the day's cell.
  const chipCount = (day) => page.evaluate((d) => {
    const cell = document.querySelector('[data-date="' + d + '"]');
    if (!cell) return -1;
    const r = cell.getBoundingClientRect();
    return [...document.querySelectorAll('.fc-event')]
      .filter((e) => e.textContent.includes('RV daily'))
      .filter((e) => { const b = e.getBoundingClientRect(); return b.x < r.x + r.width - 2 && b.x + b.width > r.x + 2 && b.y < r.y + r.height && b.y + b.height > r.y; })
      .length;
  }, day);

  async function monthDrag(fromDay, toDay) {
    const g = await page.evaluate(({ from, to }) => {
      const fromCell = document.querySelector('[data-date="' + from + '"]');
      const toCell = document.querySelector('[data-date="' + to + '"]');
      if (!fromCell || !toCell) return null;
      const fr = fromCell.getBoundingClientRect();
      // v7: find the RV daily chip intersecting the FROM cell geometrically
      const chip = [...document.querySelectorAll('.fc-event')]
        .find((e) => e.textContent.includes('RV daily') && (() => { const b = e.getBoundingClientRect(); return b.x < fr.x + fr.width - 2 && b.x + b.width > fr.x + 2 && b.y < fr.y + fr.height && b.y + b.height > fr.y; })());
      if (!chip) return null;
      const cb = chip.getBoundingClientRect();
      const tb = toCell.getBoundingClientRect();
      return { fx: cb.x + cb.width / 2, fy: cb.y + cb.height / 2, tx: tb.x + tb.width / 2, ty: tb.y + 10 };
    }, { from: fromDay, to: toDay });
    if (!g) throw new Error('monthDrag: chip/cell not found for ' + fromDay + '->' + toDay);
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
