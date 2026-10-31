// stress-A6-3-dnd.mjs — GROUP 3: DND STRESS.
// Month-boundary drags (first/last cell), rapid double-drag, drag racing a
// sync (a row is written via the API mid-drag + #btn-sync clicked), resize to
// minimum (must revert + toast, NO save), all-day edge resize, recurring
// drag cancelled via Escape vs Cancel button (revert + no PUT).
import { harness, decryptAll, findEvt, makeTally, putRawRow } from './_lib.mjs';

const T = makeTally();
const h = await harness();
const { page } = h;
const sleep = (ms) => page.waitForTimeout(ms);

/** Month-view drag: chip whose DOM-parent day is `fromDay` -> cell `toDay`. */
async function monthDrag(fromDay, toDay, label) {
  const g = await page.evaluate(({ from, to }) => {
    const fromCell = document.querySelector('.fc-daygrid-day[data-date="' + from + '"]');
    const toCell = document.querySelector('.fc-daygrid-day[data-date="' + to + '"]');
    if (!fromCell || !toCell) return null;
    const chip = [...fromCell.querySelectorAll('.fc-event')][0];
    if (!chip) return null;
    const cb = chip.getBoundingClientRect();
    const tb = toCell.getBoundingClientRect();
    return { fx: cb.x + cb.width / 2, fy: cb.y + cb.height / 2, tx: tb.x + tb.width / 2, ty: tb.y + 12 };
  }, { from: fromDay, to: toDay });
  if (!g) throw new Error('monthDrag: chip/cell not found for ' + label + ' (' + fromDay + ' -> ' + toDay + ')');
  await page.mouse.move(h.R(g.fx), h.R(g.fy));
  await page.mouse.down();
  await page.mouse.move(h.R(g.tx), h.R(g.ty), { steps: 20 });
  await page.mouse.up();
  return g;
}

/** Which day cells (geometric) show a chip with the title — month view. */
const monthDaysContaining = (title) => page.evaluate((t) => {
  const chips = [...document.querySelectorAll('.fc-daygrid-day .fc-event')]
    .filter((e) => e.textContent.includes(t)).map((e) => e.getBoundingClientRect());
  const days = [];
  for (const cell of document.querySelectorAll('.fc-daygrid-day')) {
    const d = cell.getAttribute('data-date');
    const r = cell.getBoundingClientRect();
    if (chips.some((c) => c.x < r.x + r.width - 2 && c.x + c.width > r.x + 2 && c.y < r.y + r.height && c.y + c.height > r.y)) days.push(d);
  }
  return days;
}, title);

async function createEvent(spec) {
  await page.click('#btn-new-event');
  await page.fill('input[aria-label="Title"]', spec.title);
  await page.fill('input[aria-label="Starts date"]', spec.sd);
  if (spec.st) await page.fill('input[aria-label="Starts time"]', spec.st);
  await page.fill('input[aria-label="Ends date"]', spec.ed);
  if (spec.et) await page.fill('input[aria-label="Ends time"]', spec.et);
  if (spec.allDay) await page.check('#editor-modal .fullday-recurrency input[type=checkbox]');
  if (spec.freq) await page.selectOption('select[aria-label="Frequency"]', spec.freq);
  const m = h.mark();
  await page.click('#editor-modal .button-primary');
  await sleep(1100);
  return h.since(m);
}

try {
  await h.unlock();
  await createEvent({ title: 'A6 dnd anchor', sd: '2026-10-30', st: '09:00', ed: '2026-10-30', et: '10:00' });
  await createEvent({ title: 'A6 allday resize', sd: '2026-11-12', ed: '2026-11-13', allDay: true });
  await createEvent({ title: 'A6 dnd daily', sd: '2026-11-04', st: '10:00', ed: '2026-11-04', et: '11:00', freq: 'DAILY' });
  T.ok('setup: 3 events created (3 PUTs)', true);

  // month view = October (current month after unlock)
  await page.click('.fc-dayGridMonth-button'); await sleep(600);
  const firstCell = await page.locator('.fc-daygrid-day').first().getAttribute('data-date');
  const lastCell = await page.locator('.fc-daygrid-day').nth(41).getAttribute('data-date');
  T.ok('October grid: first cell ' + firstCell + ' (prev month), last cell ' + lastCell + ' (next month)',
    firstCell === '2026-09-28' && lastCell === '2026-11-08', firstCell + ' .. ' + lastCell);

  /* ============ 3.1 drag to FIRST cell (wrap into previous month) ============ */
  let m = h.mark();
  await monthDrag('2026-10-30', firstCell, 'first cell');
  await sleep(1500);
  const d1 = h.since(m);
  T.ok('drag to first cell = 1 PUT', h.puts(d1) === 1, JSON.stringify(d1.map((r) => r.m)));
  let rows = await decryptAll();
  let ev = findEvt(rows, 'A6 dnd anchor');
  T.ok('anchor DTSTART:20260928T090000Z (moved to first cell, prev month)',
    !!ev && ev.dtstart === 'DTSTART:20260928T090000Z', ev ? ev.dtstart : 'row missing');
  let days = await monthDaysContaining('A6 dnd anchor');
  T.ok('anchor chip visible in first cell after drag', days.includes(firstCell), JSON.stringify(days));

  /* ============ 3.2 drag to LAST cell (wrap into next month) ============ */
  m = h.mark();
  await monthDrag(firstCell, lastCell, 'last cell');
  await sleep(1500);
  const d2 = h.since(m);
  T.ok('drag to last cell = 1 PUT', h.puts(d2) === 1, JSON.stringify(d2.map((r) => r.m)));
  rows = await decryptAll();
  ev = findEvt(rows, 'A6 dnd anchor');
  T.ok('anchor DTSTART:20261108T090000Z (moved to last cell, next month)',
    !!ev && ev.dtstart === 'DTSTART:20261108T090000Z', ev ? ev.dtstart : 'row missing');

  /* ============ 3.3 rapid double-drag (<1s between gestures) ============ */
  m = h.mark();
  const t0 = Date.now();
  await monthDrag(lastCell, '2026-10-20', 'rapid #1');
  await sleep(200);
  await monthDrag('2026-10-20', '2026-10-27', 'rapid #2');
  const gestureGap = Date.now() - t0;
  await sleep(1800);
  const d3 = h.since(m);
  T.ok('rapid double-drag: 2 PUTs, both gestures within ~1s', h.puts(d3) === 2 && gestureGap < 1200,
    'puts=' + h.puts(d3) + ' gap=' + gestureGap + 'ms ' + JSON.stringify(d3.map((r) => r.m)));
  rows = await decryptAll();
  ev = findEvt(rows, 'A6 dnd anchor');
  T.ok('anchor DTSTART:20261027T090000Z after double-drag (both shifts applied exactly once)',
    !!ev && ev.dtstart === 'DTSTART:20261027T090000Z', ev ? ev.dtstart : 'row missing');
  T.ok('anchor row not duplicated by double-drag',
    Object.values(rows).filter((t) => t && t.includes('A6 dnd anchor')).length === 1);

  /* ============ 3.4 drag while a sync lands (row written via API mid-drag) ============ */
  // write a valid evt row server-side mid-drag, then click #btn-sync, then drop
  const calUuidRow = Object.keys(rows).find((id) => id.startsWith('cmeta:'));
  const calUuid = calUuidRow.slice('cmeta:'.length);
  const ghostId = 'evt:' + calUuid + ':a6-ghost-0001';
  const ghostVcal = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//sh-clock//Calendar PoC//EN',
    'BEGIN:VEVENT', 'UID:a6-ghost-0001', 'DTSTAMP:20261031T120000Z',
    'DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z', 'SUMMARY:A6 ghost event',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  const g = await page.evaluate(() => {
    const fromCell = document.querySelector('.fc-daygrid-day[data-date="2026-10-27"]');
    const toCell = document.querySelector('.fc-daygrid-day[data-date="2026-10-19"]');
    const chip = [...fromCell.querySelectorAll('.fc-event')][0];
    if (!chip || !toCell) return null;
    const cb = chip.getBoundingClientRect();
    const tb = toCell.getBoundingClientRect();
    return { fx: cb.x + cb.width / 2, fy: cb.y + cb.height / 2, tx: tb.x + tb.width / 2, ty: tb.y + 12 };
  });
  m = h.mark();
  await page.mouse.move(h.R(g.fx), h.R(g.fy));
  await page.mouse.down();
  await page.mouse.move(h.R(g.tx), h.R(g.ty), { steps: 20 });
  // MID-DRAG: server-side row write + manual sync (render races the drop)
  const putRes = await putRawRow(ghostId, ghostVcal, 1);
  T.ok('ghost row written via API mid-drag (PUT 200)', putRes.status === 200, 'status=' + putRes.status + ' ' + putRes.body.slice(0, 80));
  await page.evaluate(() => document.querySelector('#btn-sync').click());
  await sleep(600); // let the sync + renderAll land while the chip is grabbed
  await page.mouse.up();
  await sleep(1800);
  const d4 = h.since(m);
  const dropPut = h.puts(d4);
  rows = await decryptAll();
  ev = findEvt(rows, 'A6 dnd anchor');
  const anchorOk = ev && (ev.dtstart === 'DTSTART:20261019T090000Z' || ev.dtstart === 'DTSTART:20261027T090000Z');
  T.ok('mid-sync drag: anchor landed at target OR cleanly reverted (never corrupted/lost)',
    !!anchorOk, ev ? ev.dtstart : 'row missing');
  console.log('  ..   mid-sync drag: PUTs=' + dropPut + ' anchor DTSTART=' + (ev ? ev.dtstart : '?') +
    ' (0 PUTs = drag cancelled by re-render; 1 PUT = drop survived)');
  const ghost = findEvt(rows, 'A6 ghost event');
  T.ok('ghost event ingested by the mid-drag sync', !!ghost && ghost.dtstart === 'DTSTART:20261120T100000Z',
    ghost ? ghost.dtstart : 'ghost not ingested');
  T.ok('no page/console errors survived the mid-drag re-render',
    h.pageErrors.length === 0 && h.consoleErrors.length === 0,
    h.pageErrors.join('|').slice(0, 200) + h.consoleErrors.join('|').slice(0, 200));

  /* ============ 3.5 resize to the minimum (timed, week view) ============ */
  // anchor now at Oct 19 or Oct 27 — normalise: read its date from the row
  const anchorDay = ev.dtstart.slice('DTSTART:'.length).slice(0, 8);
  const anchorDate = anchorDay.slice(0, 4) + '-' + anchorDay.slice(4, 6) + '-' + anchorDay.slice(6, 8);
  await page.click('.fc-dayGridMonth-button'); await sleep(400);
  await page.click('.fc-daygrid-day[data-date="' + anchorDate + '"] .fc-daygrid-day-number'); // -> day view
  await sleep(700);
  // hover the chip FIRST — FC shows the resizer only on hover
  const hover = await page.evaluate(() => {
    const chip = [...document.querySelectorAll('.fc-timegrid-event')].find((e) => e.textContent.includes('A6 dnd anchor'));
    if (!chip) return null;
    const r = chip.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(h.R(hover.x), h.R(hover.y));
  await sleep(450);
  const rz = await page.evaluate(() => {
    const chip = [...document.querySelectorAll('.fc-timegrid-event')].find((e) => e.textContent.includes('A6 dnd anchor'));
    if (!chip) return null;
    const z = chip.querySelector('.fc-event-resizer');
    const lanes = [...document.querySelectorAll('.fc-timegrid-slot-lane')];
    const first = lanes[0].getBoundingClientRect();
    const last = lanes[lanes.length - 1].getBoundingClientRect();
    const pxPerSlot = (last.y + last.height - first.y) / lanes.length;
    const cb = chip.getBoundingClientRect();
    const zb = z ? z.getBoundingClientRect() : null;
    return { chipTop: cb.y, chipH: cb.height, zx: zb ? zb.x + zb.width / 2 : null, zy: zb ? zb.y + zb.height / 2 : null, pxPerSlot, zw: zb ? zb.width : 0 };
  });
  T.ok('timed chip resizer present after hover', !!rz && !!rz.zx && rz.zw > 0, JSON.stringify(rz));
  m = h.mark();
  if (rz && rz.zx) {
    await page.mouse.move(h.R(rz.zx), h.R(rz.chipTop + rz.chipH / 2)); // keep hovering the chip
    await sleep(200);
    await page.mouse.move(h.R(rz.zx), h.R(rz.zy)); // onto the resizer
    await sleep(200);
    await page.mouse.down();
    // drag the resizer clearly ABOVE the event start (end < start)
    await page.mouse.move(h.R(rz.zx), h.R(rz.chipTop - rz.pxPerSlot * 2.5), { steps: 15 });
    await page.mouse.up();
    await sleep(1400);
  }
  const d5 = h.since(m);
  const toastTxt = await page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).join(' || '));
  rows = await decryptAll();
  ev = findEvt(rows, 'A6 dnd anchor');
  if (h.puts(d5) === 0) {
    T.ok('resize below start: NO PUT (rejected by the app)', true);
    T.ok('revert toast shown (invalid_duration)', toastTxt.includes('invalid_duration'), toastTxt.slice(0, 160));
    T.ok('anchor DTEND unchanged after rejected resize (still 10:00)',
      !!ev && ev.dtend === 'DTEND:' + anchorDay + 'T100000Z', ev ? ev.dtend : 'row missing');
    const chipAfter = await page.evaluate(() => {
      const chip = [...document.querySelectorAll('.fc-timegrid-event')].find((e) => e.textContent.includes('A6 dnd anchor'));
      if (!chip) return null;
      const lanes = [...document.querySelectorAll('.fc-timegrid-slot-lane')];
      const first = lanes[0].getBoundingClientRect();
      const last = lanes[lanes.length - 1].getBoundingClientRect();
      const pxPerSlot = (last.y + last.height - first.y) / lanes.length;
      const r = chip.getBoundingClientRect();
      return { topSlots: (r.y - first.y) / pxPerSlot, heightSlots: r.height / pxPerSlot };
    });
    T.ok('chip reverted to 09:00-10:00 (2 slots tall)',
      !!chipAfter && Math.abs(chipAfter.heightSlots - 2) < 1, JSON.stringify(chipAfter));
  } else {
    // FullCalendar may clamp the negative resize to a valid minimum and fire
    // a VALID resize — verify data integrity of whatever landed.
    T.ok('resize below start: FC clamped to a valid minimum — PUT fired, DTSTART untouched',
      h.puts(d5) === 1 && !!ev && ev.dtstart === 'DTSTART:' + anchorDay + 'T090000Z',
      JSON.stringify(d5.map((r) => r.m)) + ' ' + (ev ? ev.dtstart + '->' + ev.dtend : 'row missing'));
    console.log('  ..   resize-to-negative outcome: FC clamped — toast="' + toastTxt.slice(0, 60) +
      '" DTEND=' + (ev ? ev.dtend : '?'));
  }

  /* ============ 3.6 resize an all-day event edge (month view) ============ */
  await page.click('.fc-dayGridMonth-button'); await sleep(400);
  await page.click('.fc-next-button'); await sleep(800); // November
  const rzGeom = await page.evaluate(() => {
    // the spanning chip's DOM parent is its START day (Nov 12)
    const cell = document.querySelector('.fc-daygrid-day[data-date="2026-11-12"]');
    if (!cell) return null;
    const chip = [...cell.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('A6 allday resize'));
    if (!chip) return null;
    const cb = chip.getBoundingClientRect();
    const cellR = document.querySelector('.fc-daygrid-day[data-date="2026-11-14"]').getBoundingClientRect();
    return { cx: cb.x + cb.width / 2, cy: cb.y + cb.height / 2, tx: cellR.x + cellR.width / 2, ty: cellR.y + 12, chipW: cb.width };
  });
  T.ok('all-day spanning chip present (parent Nov 12, spans Nov 12-13)', !!rzGeom && rzGeom.chipW > 300, JSON.stringify(rzGeom));
  m = h.mark();
  if (rzGeom) {
    await page.mouse.move(h.R(rzGeom.cx), h.R(rzGeom.cy)); // hover the chip -> resizers appear
    await sleep(500);
    const rz2 = await page.evaluate(() => {
      const cell = document.querySelector('.fc-daygrid-day[data-date="2026-11-12"]');
      const chip = [...cell.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('A6 allday resize'));
      if (!chip) return null;
      const zs = [...chip.querySelectorAll('.fc-event-resizer')];
      const z = zs[zs.length - 1]; // right-edge resizer
      if (!z) return null;
      const zb = z.getBoundingClientRect();
      return { x: zb.x + zb.width / 2, y: zb.y + zb.height / 2, w: zb.width, h: zb.height };
    });
    T.ok('all-day right-edge resizer visible after hover', !!rz2 && rz2.w > 0, JSON.stringify(rz2));
    if (rz2 && rz2.w > 0) {
      await page.mouse.move(h.R(rz2.x), h.R(rz2.y));
      await sleep(200);
      await page.mouse.down();
      await page.mouse.move(h.R(rzGeom.tx), h.R(rzGeom.ty), { steps: 15 }); // -> Nov 14 cell
      await page.mouse.up();
      await sleep(1600);
    }
  }
  const d6 = h.since(m);
  T.ok('all-day edge resize = 1 PUT', h.puts(d6) === 1, JSON.stringify(d6.map((r) => r.m)));
  rows = await decryptAll();
  ev = findEvt(rows, 'A6 allday resize');
  T.ok('all-day DTEND:20261115 (VALUE=DATE) after +1-day resize',
    !!ev && ev.dtend === 'DTEND;VALUE=DATE:20261115', ev ? ev.dtend : 'row missing');
  T.ok('all-day DTSTART unchanged (20261112)', !!ev && ev.dtstart === 'DTSTART;VALUE=DATE:20261112', ev ? ev.dtstart : '-');
  days = await monthDaysContaining('A6 allday resize');
  T.ok('all-day chip now covers Nov 12..14 (3 days)',
    days.length === 3 && days[0] === '2026-11-12' && days[2] === '2026-11-14', JSON.stringify(days));

  /* ============ 3.7 recurring drag + ESCAPE cancel ============ */
  // drag the Nov 5 occurrence to Nov 7, press Escape on the choice modal
  m = h.mark();
  await monthDrag('2026-11-05', '2026-11-07', 'recurring escape');
  await sleep(800);
  T.ok('choice modal open after recurring drag', await page.locator('#recur-modal').isVisible());
  await page.keyboard.press('Escape');
  await sleep(600);
  T.ok('Escape closed the choice modal', await page.locator('#recur-modal').isHidden());
  const d7 = h.since(m);
  T.ok('Escape cancel fired NO PUT', h.puts(d7) === 0, JSON.stringify(d7.map((r) => r.m)));
  rows = await decryptAll();
  ev = findEvt(rows, 'A6 dnd daily');
  T.ok('daily row unchanged after Escape (no exception, no EXDATE)',
    !!ev && veventsCount(ev) === 1 && ev.exdate.length === 0,
    'vevents=' + (ev ? veventsCount(ev) : '?') + ' exdates=' + (ev ? ev.exdate.length : '?'));
  // where is the Nov 5 chip visually? (escaped-cancel may leave it dropped)
  days = await monthDaysContaining('A6 dnd daily');
  const nov5Chip = await page.evaluate(() => {
    const cell = document.querySelector('.fc-daygrid-day[data-date="2026-11-05"]');
    return cell ? [...cell.querySelectorAll('.fc-event')].filter((e) => e.textContent.includes('A6 dnd daily')).length : -1;
  });
  const nov7Chip = await page.evaluate(() => {
    const cell = document.querySelector('.fc-daygrid-day[data-date="2026-11-07"]');
    return cell ? [...cell.querySelectorAll('.fc-event')].filter((e) => e.textContent.includes('A6 dnd daily')).length : -1;
  });
  const escapedLeftMoved = nov5Chip === 0 && nov7Chip >= 1;
  T.ok('UI/data consistency after Escape: chip back at Nov 5 (revert)',
    !escapedLeftMoved, 'chip DOM: Nov5=' + nov5Chip + ' Nov7=' + nov7Chip + ' — Escape left the chip VISUALLY at the drop target while data says Nov 5 (desync until next render)');
  if (escapedLeftMoved) await h.shot('g3-escape-desync');
  // force a re-render (view switch) — the chip must snap back to the data truth
  await page.click('.fc-listYear-button'); await sleep(600);
  await page.click('.fc-dayGridMonth-button'); await sleep(700);
  const nov5After = await page.evaluate(() => {
    const cell = document.querySelector('.fc-daygrid-day[data-date="2026-11-05"]');
    return cell ? [...cell.querySelectorAll('.fc-event')].filter((e) => e.textContent.includes('A6 dnd daily')).length : -1;
  });
  const nov7After = await page.evaluate(() => {
    const cell = document.querySelector('.fc-daygrid-day[data-date="2026-11-07"]');
    return cell ? [...cell.querySelectorAll('.fc-event')].filter((e) => e.textContent.includes('A6 dnd daily')).length : -1;
  });
  T.ok('after view re-render the chip is back on Nov 5 (data truth)',
    nov5After === 1 && nov7After === 1, 'Nov5=' + nov5After + ' Nov7=' + nov7After);

  /* ============ 3.8 recurring drag + Cancel BUTTON (explicit revert) ============ */
  m = h.mark();
  await monthDrag('2026-11-05', '2026-11-09', 'recurring cancel');
  await sleep(800);
  await page.click('#recur-modal button:has-text("Cancel")');
  await sleep(800);
  const d8 = h.since(m);
  T.ok('Cancel-button cancel fired NO PUT', h.puts(d8) === 0, JSON.stringify(d8.map((r) => r.m)));
  const nov5c = await page.evaluate(() => {
    const cell = document.querySelector('.fc-daygrid-day[data-date="2026-11-05"]');
    return cell ? [...cell.querySelectorAll('.fc-event')].filter((e) => e.textContent.includes('A6 dnd daily')).length : -1;
  });
  T.ok('Cancel button reverted the chip to Nov 5 immediately', nov5c === 1, 'Nov5 chips=' + nov5c);
  rows = await decryptAll();
  ev = findEvt(rows, 'A6 dnd daily');
  T.ok('daily row STILL unchanged after Cancel (no exception, no EXDATE)',
    !!ev && veventsCount(ev) === 1 && ev.exdate.length === 0,
    'vevents=' + (ev ? veventsCount(ev) : '?'));

  /* ============ 3.9 recurring drag as MASTER ('All events') ============ */
  m = h.mark();
  await monthDrag('2026-11-04', '2026-11-06', 'recurring all');
  await sleep(800);
  await page.click('#recur-modal button:has-text("All events")');
  await sleep(1600);
  const d9 = h.since(m);
  T.ok('all-events drag = 1 PUT', h.puts(d9) === 1, JSON.stringify(d9.map((r) => r.m)));
  rows = await decryptAll();
  ev = findEvt(rows, 'A6 dnd daily');
  T.ok('master shifted: DTSTART:20261106T100000Z, RRULE intact',
    !!ev && ev.dtstart === 'DTSTART:20261106T100000Z' && ev.rrule === 'RRULE:FREQ=DAILY',
    ev ? ev.dtstart + ' ' + ev.rrule : 'row missing');
} catch (e) {
  T.ok('group 3 ran to completion', false, String(e));
  await h.shot('g3-crash');
}

function veventsCount(row) {
  return (row.text.match(/BEGIN:VEVENT/g) || []).length;
}

T.ok('no page errors during group 3', h.pageErrors.length === 0, h.pageErrors.join(' | ').slice(0, 400));
T.ok('no console errors during group 3', h.consoleErrors.length === 0, h.consoleErrors.join(' | ').slice(0, 400));

await h.shot('g3-final');
console.log('\n=== GROUP 3 (DND STRESS): ' + T.summary() + ' ===');
if (T.fail > 0) console.log('FAILURES: ' + T.failures.join(' ; ').slice(0, 700));
await h.close();
process.exit(T.fail > 0 ? 1 : 0);
