// reverify v2 — clean cases:
//  A: fresh 09:00-10:00 event, drag bottom resizer clearly ABOVE the start
//     (end < start): PUTs? toast? chip reverted?
//  B: recurring month drag -> Escape (desync screenshot) -> reload -> truth;
//     backdrop-click dismissal; Cancel button reference.
import { harness, decryptAll, findEvt, makeTally } from './_lib.mjs';

const T = makeTally();
const h = await harness();
const { page } = h;
const sleep = (ms) => page.waitForTimeout(ms);

async function newTimed(title, sd, st, ed, et) {
  await page.click('#btn-new-event');
  await page.fill('input[aria-label="Title"]', title);
  await page.fill('input[aria-label="Starts date"]', sd);
  await page.fill('input[aria-label="Starts time"]', st);
  await page.fill('input[aria-label="Ends date"]', ed);
  await page.fill('input[aria-label="Ends time"]', et);
  await page.click('#editor-modal .button-primary');
  await sleep(1200);
}

try {
  await h.unlock();
  await newTimed('RV2 resize target', '2026-11-04', '09:00', '2026-11-04', '10:00');

  await page.click('.fc-dayGridMonth-button'); await sleep(400);
  await page.click('.fc-next-button'); await sleep(700);
  await page.click('.fc-daygrid-day[data-date="2026-11-04"] .fc-daygrid-day-number');
  await sleep(700);

  const geomOf = () => page.evaluate(() => {
    const chip = [...document.querySelectorAll('.fc-timegrid-event')].find((e) => e.textContent.includes('RV2 resize target'));
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

  let g = await geomOf();
  await page.mouse.move(h.R(g.left + g.w / 2), h.R(g.top + g.h / 2));
  await sleep(500);
  g = await geomOf();

  const m = h.mark();
  await page.mouse.move(h.R(g.zx), h.R(g.top + g.h / 2)); await sleep(150);
  await page.mouse.move(h.R(g.zx), h.R(g.zy)); await sleep(250);
  await page.mouse.down();
  await page.mouse.move(h.R(g.zx), h.R(g.top - g.pxPerSlot * 3), { steps: 20 });
  await page.mouse.up();
  await sleep(1600);
  const toasts = await page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent));
  const reqs = h.since(m);
  const rows = await decryptAll();
  const ev = findEvt(rows, 'RV2 resize target');
  const g2 = await geomOf();
  T.ok('A above-start resize: NO PUT', h.puts(reqs) === 0, JSON.stringify(reqs.map((r) => r.m)));
  T.ok('A above-start resize: DTEND unchanged 10:00', ev && ev.dtend === 'DTEND:20261104T100000Z', ev ? ev.dtend : '-');
  T.ok('A above-start resize: chip reverted to 2 slots', !!g2 && Math.abs(g2.h / g2.pxPerSlot - 2) < 1, g2 ? (g2.h / g2.pxPerSlot).toFixed(2) : 'gone');
  const toastShown = toasts.length > 0;
  T.ok('A above-start resize: revert toast shown', toastShown, JSON.stringify(toasts));
  if (!toastShown) console.log('  ..   A: FullCalendar swallowed the negative resize (no eventResize fired) — silent revert, no app toast');
  await h.shot('rv2-above-start');

  /* ---- B: recurring drag dismissals ---- */
  await page.click('#btn-new-event');
  await page.fill('input[aria-label="Title"]', 'RV2 daily');
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
    return cell ? [...cell.querySelectorAll('.fc-event')].filter((e) => e.textContent.includes('RV2 daily')).length : -1;
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
    if (!g) throw new Error('monthDrag geometry missing ' + fromDay + '->' + toDay);
    await page.mouse.move(h.R(g.fx), h.R(g.fy));
    await page.mouse.down();
    await page.mouse.move(h.R(g.tx), h.R(g.ty), { steps: 15 });
    await page.mouse.up();
  }

  // B1 Escape
  let m1 = h.mark();
  await monthDrag('2026-11-05', '2026-11-07');
  await sleep(800);
  await page.keyboard.press('Escape');
  await sleep(700);
  T.ok('B1 Escape: modal closed, 0 PUTs', (await page.locator('#recur-modal').isHidden()) && h.puts(h.since(m1)) === 0);
  const esc5 = await chipCount('2026-11-05'), esc7 = await chipCount('2026-11-07');
  T.ok('B1 Escape: chip visually reverted to Nov 5', esc5 === 1 && esc7 === 1, 'Nov5=' + esc5 + ' Nov7=' + esc7);
  await h.shot('rv2-escape-desync');
  // reload: DOM returns to data truth
  await page.reload(); await sleep(2500);
  T.ok('B1 after reload: chip back on Nov 5', (await chipCount('2026-11-05')) === 1, 'Nov5=' + (await chipCount('2026-11-05')));

  // B2 backdrop click
  m1 = h.mark();
  await monthDrag('2026-11-05', '2026-11-08');
  await sleep(800);
  await page.mouse.click(5, 500);
  await sleep(700);
  T.ok('B2 backdrop: modal closed, 0 PUTs', (await page.locator('#recur-modal').isHidden()) && h.puts(h.since(m1)) === 0);
  const bk5 = await chipCount('2026-11-05'), bk8 = await chipCount('2026-11-08');
  T.ok('B2 backdrop: chip visually reverted to Nov 5', bk5 === 1 && bk8 === 1, 'Nov5=' + bk5 + ' Nov8=' + bk8);
  await page.reload(); await sleep(2500);

  // B3 Cancel reference
  m1 = h.mark();
  await monthDrag('2026-11-05', '2026-11-09');
  await sleep(800);
  await page.click('#recur-modal button:has-text("Cancel")');
  await sleep(700);
  T.ok('B3 Cancel: 0 PUTs + chip back on Nov 5',
    h.puts(h.since(m1)) === 0 && (await chipCount('2026-11-05')) === 1 && (await chipCount('2026-11-09')) === 1,
    'Nov5=' + (await chipCount('2026-11-05')) + ' Nov9=' + (await chipCount('2026-11-09')));

  const rows2 = await decryptAll();
  const ev2 = findEvt(rows2, 'RV2 daily');
  T.ok('B: daily row intact (1 VEVENT, no EXDATE, RRULE intact)',
    !!ev2 && (ev2.text.match(/BEGIN:VEVENT/g) || []).length === 1 && ev2.exdate.length === 0 && ev2.rrule === 'RRULE:FREQ=DAILY',
    'vevents=' + (ev2 ? (ev2.text.match(/BEGIN:VEVENT/g) || []).length : '?'));
} catch (e) {
  T.ok('reverify2 ran to completion', false, String(e));
  await h.shot('rv2-crash');
}

T.ok('no page errors during reverify2', h.pageErrors.length === 0, h.pageErrors.join(' | ').slice(0, 300));
console.log('\n=== REVERIFY2: ' + T.summary() + ' ===');
if (T.fail > 0) console.log('FAILURES: ' + T.failures.join(' ; '));
await h.close();
process.exit(T.fail > 0 ? 1 : 0);
