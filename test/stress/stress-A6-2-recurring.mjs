// stress-A6-2-recurring.mjs — GROUP 2: RECURRING EDITS.
// Daily series -> drag ONE occurrence ('This event' -> RECURRENCE-ID exception),
// edit the exception via the editor, delete 'This event' (EXDATE), delete
// 'All events'; weekly custom rrule (INTERVAL=2, BYDAY=MO,WE,FR, COUNT=10;
// and UNTIL) — verify expansion in month view + agenda + serialized RRULE.
import { harness, decryptAll, findEvt, makeTally, veventsOf, gotoMonth } from './_lib.mjs';

const T = makeTally();
const h = await harness();
const { page } = h;

const sleep = (ms) => page.waitForTimeout(ms);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** Bounding boxes in the page. */
async function box(sel) {
  const b = await page.locator(sel).first().boundingBox();
  return b;
}

async function openEditorNew(spec) {
  await page.click('#btn-new-event');
  await page.fill('input[aria-label="Title"]', spec.title);
  await page.fill('input[aria-label="Starts date"]', spec.sd);
  if (spec.st) await page.fill('input[aria-label="Starts time"]', spec.st);
  await page.fill('input[aria-label="Ends date"]', spec.ed);
  if (spec.et) await page.fill('input[aria-label="Ends time"]', spec.et);
}

try {
  await h.unlock();

  /* ============ 2.1 daily series ============ */
  await openEditorNew({ title: 'A6 daily rec', sd: '2026-11-04', st: '10:00', ed: '2026-11-04', et: '11:00' });
  await page.selectOption('select[aria-label="Frequency"]', 'DAILY');
  let m = h.mark();
  await page.click('#editor-modal .button-primary');
  await sleep(1200);
  T.ok('daily create = 1 PUT', h.puts(h.since(m)) === 1, JSON.stringify(h.since(m).map((r) => r.m)));

  let rows = await decryptAll();
  let ev = findEvt(rows, 'A6 daily rec');
  T.ok('daily master RRULE:FREQ=DAILY', !!ev && ev.rrule === 'RRULE:FREQ=DAILY', ev ? ev.rrule : 'row missing');
  T.ok('daily master DTSTART:20261104T100000Z', !!ev && ev.dtstart === 'DTSTART:20261104T100000Z', ev ? ev.dtstart : '-');

  // month view expansion (November view spans Oct 26..Dec 6; the series
  // renders in the trailing Dec 1..6 cells too)
  await page.click('#calendar button[aria-label="Month view"]'); await sleep(400);
  await gotoMonth(page, '2026-11'); await sleep(600);
  let n = await page.locator('.fc-event', { hasText: 'A6 daily rec' }).count();
  T.ok('daily expansion: 27 Nov chips + 6 trailing Dec chips = 33', n === 33, 'count=' + n);

  /* ============ 2.2 drag ONE occurrence (day view, +1h) = 'This event' ============ */
  // navLinks day-number click -> timeGridDay for Nov 10
  await page.click('[data-date="2026-11-10"] [role=link][aria-label^="Go to"]');
  await sleep(700);
  // find the 10:00 chip in the Nov 10 column
  const geom0 = await page.evaluate(() => {
    const lanes = [...document.querySelectorAll('[data-time]')].filter((e) => !e.textContent.trim()); // v7: lanes carry data-time but no text (labels do)
    const first = lanes[0].getBoundingClientRect();
    const last = lanes[lanes.length - 1].getBoundingClientRect();
    const pxPerSlot = (last.y + last.height - first.y) / lanes.length;
    const headers = [...document.querySelectorAll('[data-date][role=columnheader]')];
    const col = headers.find((c) => c.getAttribute('data-date') === '2026-11-10');
    const colR = col.getBoundingClientRect();
    const chip = [...document.querySelectorAll('.fc-event')]
      .find((e) => e.textContent.includes('A6 daily rec') && e.getBoundingClientRect().x + e.getBoundingClientRect().width > colR.x && e.getBoundingClientRect().x < colR.x + colR.width);
    if (!chip) return null;
    const r = chip.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, topSlots: (r.y - first.y) / pxPerSlot, pxPerSlot };
  });
  T.ok('Nov 10 daily occurrence chip at 10:00 (slot 20) in week view', !!geom0 && near(geom0.topSlots, 20, 1.2),
    geom0 ? 'topSlots=' + geom0.topSlots.toFixed(2) : 'chip not found');
  // v7: the day view scrolls to `now`; 10:00 may sit above the viewport —
  // bring the chip into view and RECOMPUTE its geometry before dragging.
  await page.evaluate(() => {
    const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('A6 daily rec'));
    if (chip) chip.scrollIntoView({ block: 'center' });
  });
  await sleep(300);
  const geomV = await page.evaluate(() => {
    const lanes = [...document.querySelectorAll('[data-time]')].filter((e) => !e.textContent.trim());
    const first = lanes[0].getBoundingClientRect();
    const last = lanes[lanes.length - 1].getBoundingClientRect();
    const pxPerSlot = (last.y + last.height - first.y) / lanes.length;
    const headers = [...document.querySelectorAll('[data-date][role=columnheader]')];
    const col = headers.find((c) => c.getAttribute('data-date') === '2026-11-10');
    const colR = col.getBoundingClientRect();
    const chip = [...document.querySelectorAll('.fc-event')]
      .find((e) => e.textContent.includes('A6 daily rec') && e.getBoundingClientRect().x + e.getBoundingClientRect().width > colR.x && e.getBoundingClientRect().x < colR.x + colR.width);
    if (!chip) return null;
    const r = chip.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, topSlots: (r.y - first.y) / pxPerSlot, pxPerSlot };
  });
  const geom = geomV || geom0;
  m = h.mark();
  await page.mouse.move(h.R(geom.x), h.R(geom.y));
  await page.mouse.down();
  await page.mouse.move(h.R(geom.x), h.R(geom.y + geom.pxPerSlot * 2), { steps: 20 }); // +1h -> 11:00
  await page.mouse.up();
  await sleep(800);
  T.ok('recurring drag opens This/All choice modal', await page.locator('#recur-modal').isVisible());
  await page.click('#recur-modal button:has-text("This event")');
  await sleep(1500);
  T.ok('occurrence drag = 1 PUT', h.puts(h.since(m)) === 1, JSON.stringify(h.since(m).map((r) => r.m)));

  rows = await decryptAll();
  ev = findEvt(rows, 'A6 daily rec');
  const blocks = ev ? veventsOf(ev) : [];
  T.ok('row now has master + 1 exception VEVENT', blocks.length === 2, 'blocks=' + blocks.length);
  const exc = blocks.find((b) => b.get('RECURRENCE-ID'));
  const mst = blocks.find((b) => !b.get('RECURRENCE-ID'));
  T.ok('exception RECURRENCE-ID:20261110T100000Z', !!exc && exc.get('RECURRENCE-ID') === 'RECURRENCE-ID:20261110T100000Z',
    exc ? exc.get('RECURRENCE-ID') : 'no exception');
  T.ok('exception DTSTART:20261110T110000Z (moved +1h)', !!exc && exc.get('DTSTART') === 'DTSTART:20261110T110000Z',
    exc ? exc.get('DTSTART') : '-');
  T.ok('exception DTEND:20261110T120000Z', !!exc && exc.get('DTEND') === 'DTEND:20261110T120000Z',
    exc ? exc.get('DTEND') : '-');
  T.ok('master untouched (RRULE + DTSTART)', !!mst && mst.get('RRULE') === 'RRULE:FREQ=DAILY' && mst.get('DTSTART') === 'DTSTART:20261104T100000Z',
    mst ? mst.get('RRULE') + ' ' + mst.get('DTSTART') : 'no master');

  // the Nov 10 chip should now be at 11:00 (replaced occurrence)
  const geom2 = await page.evaluate(() => {
    const lanes = [...document.querySelectorAll('[data-time]')].filter((e) => !e.textContent.trim()); // v7: lanes carry data-time but no text (labels do)
    const first = lanes[0].getBoundingClientRect();
    const last = lanes[lanes.length - 1].getBoundingClientRect();
    const pxPerSlot = (last.y + last.height - first.y) / lanes.length;
    const col = [...document.querySelectorAll('[data-date][role=columnheader]')].find((c) => c.getAttribute('data-date') === '2026-11-10');
    const colR = col.getBoundingClientRect();
    const chips = [...document.querySelectorAll('.fc-event')]
      .filter((e) => e.textContent.includes('A6 daily rec') && e.getBoundingClientRect().x + e.getBoundingClientRect().width > colR.x && e.getBoundingClientRect().x < colR.x + colR.width);
    return chips.map((c) => { const r = c.getBoundingClientRect(); return { topSlots: (r.y - first.y) / pxPerSlot, text: c.textContent.trim() }; });
  });
  T.ok('Nov 10 now shows ONLY the 11:00 exception (slot 22)', geom2.length === 1 && near(geom2[0].topSlots, 22, 1.2),
    JSON.stringify(geom2.map((g) => ({ t: Math.round(g.topSlots) }))));

  // Nov 10 now shows ONLY the 11:00 exception — switch to week view (Nov 9-15)
  // for the following occurrence interactions
  await page.click('#calendar button[aria-label="Week view"]');
  await sleep(700);
  // v7: scroll the exception chip into the viewport before clicking (the
  // week view anchors its scroll at `now`, which can leave 11:00 off-screen).
  await page.evaluate(() => {
    const col = [...document.querySelectorAll('[data-date][role=columnheader]')].find((c) => c.getAttribute('data-date') === '2026-11-10');
    if (!col) return;
    const colR = col.getBoundingClientRect();
    const chip = [...document.querySelectorAll('.fc-event')]
      .find((e) => e.textContent.includes('A6 daily rec') && e.getBoundingClientRect().x + e.getBoundingClientRect().width > colR.x && e.getBoundingClientRect().x < colR.x + colR.width);
    if (chip) chip.scrollIntoView({ block: 'center' });
  });
  await sleep(300);

  /* ============ 2.3 edit the exception via the editor ============ */
  // click the 11:00 chip on Nov 10 -> popover -> Edit -> 'This event' -> editor
  const excChip = await page.evaluate(() => {
    const lanes = [...document.querySelectorAll('[data-time]')].filter((e) => !e.textContent.trim()); // v7: lanes carry data-time but no text (labels do)
    const first = lanes[0].getBoundingClientRect();
    const last = lanes[lanes.length - 1].getBoundingClientRect();
    const pxPerSlot = (last.y + last.height - first.y) / lanes.length;
    const col = [...document.querySelectorAll('[data-date][role=columnheader]')].find((c) => c.getAttribute('data-date') === '2026-11-10');
    const colR = col.getBoundingClientRect();
    const chip = [...document.querySelectorAll('.fc-event')]
      .find((e) => e.textContent.includes('A6 daily rec') && e.getBoundingClientRect().x + e.getBoundingClientRect().width > colR.x && e.getBoundingClientRect().x < colR.x + colR.width);
    if (!chip) return null;
    const r = chip.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(h.R(excChip.x), h.R(excChip.y));
  await sleep(700);
  T.ok('popover opens for exception', await page.locator('#event-popover:not([hidden])').isVisible());
  await page.click('#event-popover button[title="Edit"]');
  await sleep(600);
  T.ok('edit asks scope (This/All)', await page.locator('#recur-modal').isVisible());
  await page.click('#recur-modal button:has-text("This event")');
  await sleep(600);
  T.ok('editor opened for the exception', await page.locator('#editor-modal').isVisible());
  T.ok('editor pre-filled with exception start 11:00',
    (await page.locator('input[aria-label="Starts time"]').inputValue()) === '11:00',
    await page.locator('input[aria-label="Starts time"]').inputValue());
  await page.fill('input[aria-label="Title"]', 'A6 daily rec EXC');
  await page.fill('input[aria-label="Starts time"]', '13:00');
  await page.fill('input[aria-label="Ends time"]', '14:00');
  m = h.mark();
  await page.click('#editor-modal .button-primary');
  await sleep(1400);
  T.ok('exception edit = 1 PUT', h.puts(h.since(m)) === 1, JSON.stringify(h.since(m).map((r) => r.m)));

  rows = await decryptAll();
  ev = findEvt(rows, 'A6 daily rec EXC');
  T.ok('exception row found under edited title', !!ev, 'not found');
  const blocks2 = ev ? veventsOf(ev) : [];
  const exc2 = blocks2.find((b) => b.get('RECURRENCE-ID'));
  T.ok('edited exception keeps RECURRENCE-ID:20261110T100000Z',
    !!exc2 && exc2.get('RECURRENCE-ID') === 'RECURRENCE-ID:20261110T100000Z', exc2 ? exc2.get('RECURRENCE-ID') : '-');
  T.ok('edited exception DTSTART:20261110T130000Z / DTEND:20261110T140000Z',
    !!exc2 && exc2.get('DTSTART') === 'DTSTART:20261110T130000Z' && exc2.get('DTEND') === 'DTEND:20261110T140000Z',
    exc2 ? exc2.get('DTSTART') + ' ' + exc2.get('DTEND') : '-');
  T.ok('edited exception has NO stray rrule (exception carries none)',
    !!exc2 && exc2.get('RRULE') === null, exc2 ? exc2.get('RRULE') : '-');

  /* ============ 2.4 delete 'This event' (EXDATE) on another occurrence ============ */
  // Nov 12 10:00 occurrence
  const occChip = await page.evaluate(() => {
    const col = [...document.querySelectorAll('[data-date][role=columnheader]')].find((c) => c.getAttribute('data-date') === '2026-11-12');
    const colR = col.getBoundingClientRect();
    const chip = [...document.querySelectorAll('.fc-event')]
      .find((e) => e.textContent.includes('A6 daily rec') && e.getBoundingClientRect().x + e.getBoundingClientRect().width > colR.x && e.getBoundingClientRect().x < colR.x + colR.width);
    if (!chip) return null;
    const r = chip.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(h.R(occChip.x), h.R(occChip.y));
  await sleep(700);
  await page.click('#event-popover button[title="Delete"]');
  await sleep(600);
  T.ok('delete asks scope', await page.locator('#recur-modal').isVisible());
  m = h.mark();
  await page.click('#recur-modal button:has-text("This event")');
  await sleep(1500);
  T.ok('this-event delete = 1 PUT (EXDATE)', h.puts(h.since(m)) === 1, JSON.stringify(h.since(m).map((r) => r.m)));

  rows = await decryptAll();
  ev = findEvt(rows, 'A6 daily rec EXC'); // master SUMMARY unchanged ('A6 daily rec')
  const mst2 = ev ? veventsOf(ev).find((b) => !b.get('RECURRENCE-ID')) : null;
  T.ok('master gained EXDATE:20261112T100000Z',
    !!mst2 && mst2.lines.some((l) => l.startsWith('EXDATE') && l.includes('20261112T100000Z')),
    mst2 ? mst2.lines.filter((l) => l.startsWith('EXDATE')).join(' | ') : 'master missing');
  // chip gone from Nov 12
  const nov12chips = await page.evaluate(() => {
    const col = [...document.querySelectorAll('[data-date][role=columnheader]')].find((c) => c.getAttribute('data-date') === '2026-11-12');
    const colR = col.getBoundingClientRect();
    return [...document.querySelectorAll('.fc-event')]
      .filter((e) => e.textContent.includes('A6 daily rec') && e.getBoundingClientRect().x + e.getBoundingClientRect().width > colR.x && e.getBoundingClientRect().x < colR.x + colR.width).length;
  });
  T.ok('Nov 12 occurrence chip removed from week view', nov12chips === 0, 'count=' + nov12chips);

  /* ============ 2.5 delete 'All events' ============ */
  // click the Nov 13 occurrence
  const occ2 = await page.evaluate(() => {
    const col = [...document.querySelectorAll('[data-date][role=columnheader]')].find((c) => c.getAttribute('data-date') === '2026-11-13');
    const colR = col.getBoundingClientRect();
    const chip = [...document.querySelectorAll('.fc-event')]
      .find((e) => e.textContent.includes('A6 daily rec') && e.getBoundingClientRect().x + e.getBoundingClientRect().width > colR.x && e.getBoundingClientRect().x < colR.x + colR.width);
    if (!chip) return null;
    const r = chip.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(h.R(occ2.x), h.R(occ2.y));
  await sleep(700);
  await page.click('#event-popover button[title="Delete"]');
  await sleep(600);
  m = h.mark();
  await page.click('#recur-modal button:has-text("All events")');
  await sleep(1500);
  const delReqs = h.since(m);
  T.ok('all-events delete = 1 DELETE (no PUT)', delReqs.length === 1 && delReqs[0].m === 'DELETE',
    JSON.stringify(delReqs.map((r) => r.m)));
  rows = await decryptAll();
  T.ok('row gone from server after All-events delete',
    !Object.entries(rows).some(([id]) => id.startsWith('evt:')), 'evt rows remain');
  await page.click('#calendar button[aria-label="Month view"]'); await sleep(600);
  T.ok('daily chips gone from month view', (await page.locator('.fc-event', { hasText: 'A6 daily rec' }).count()) === 0);

  /* ============ 2.6 weekly custom rrule: INTERVAL=2, BYDAY=MO,WE,FR, COUNT=10 ============ */
  await openEditorNew({ title: 'A6 custom biweekly', sd: '2026-11-02', st: '09:00', ed: '2026-11-02', et: '09:30' });
  await page.selectOption('select[aria-label="Frequency"]', 'CUSTOM');
  await sleep(500);
  T.ok('custom frequency modal opens', await page.locator('#freq-modal').isVisible());
  await page.fill('#freq-modal input[aria-label="Interval"]', '2');
  // select MO, WE, FR (labels are 2-letter, Monday-first)
  for (const d of ['Mo', 'We', 'Fr']) {
    await page.locator('#freq-modal label', { hasText: new RegExp('^' + d + '$') }).locator('input').check();
  }
  await page.locator('#freq-modal select').nth(1).selectOption('count'); // Ends: After (2nd select)
  await page.fill('#freq-modal input[aria-label="Occurrences"]', '10');
  await page.click('#freq-modal .button-primary'); // Apply
  await sleep(500);
  const freqLabel = await page.evaluate(() => document.querySelector('#editor-modal select[aria-label="Frequency"]').selectedOptions[0].textContent);
  T.ok('editor shows Custom… (FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=10)',
    freqLabel.includes('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=10'), freqLabel);
  m = h.mark();
  await page.click('#editor-modal .button-primary');
  await sleep(1300);
  T.ok('custom create = 1 PUT', h.puts(h.since(m)) === 1, JSON.stringify(h.since(m).map((r) => r.m)));

  rows = await decryptAll();
  ev = findEvt(rows, 'A6 custom biweekly');
  T.ok('serialized RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=10',
    !!ev && ev.rrule === 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=10', ev ? ev.rrule : 'row missing');

  // month view expansion: Nov 2,4,6 (week 1), 16,18,20 (week 3), 30 (week 5)
  await page.click('#calendar button[aria-label="Month view"]'); await sleep(600);
  const daysCovered = await page.evaluate((t) => {
    const chips = [...document.querySelectorAll('[data-date][role=cell] .fc-event')]
      .filter((e) => e.textContent.includes(t)).map((e) => e.getBoundingClientRect());
    const days = [];
    for (const cell of document.querySelectorAll('[data-date][role=cell]')) {
      const d = cell.getAttribute('data-date');
      const r = cell.getBoundingClientRect();
      if (chips.some((c) => c.x < r.x + r.width - 2 && c.x + c.width > r.x + 2 && c.y < r.y + r.height && c.y + c.height > r.y)) days.push(d);
    }
    return days;
  }, 'A6 custom biweekly');
  const expectDays = ['2026-11-02', '2026-11-04', '2026-11-06', '2026-11-16', '2026-11-18', '2026-11-20', '2026-11-30', '2026-12-02', '2026-12-04'];
  T.ok('biweekly expansion in Nov view (incl. trailing Dec 2/4): ' + expectDays.length + ' days',
    JSON.stringify(daysCovered) === JSON.stringify(expectDays), JSON.stringify(daysCovered));

  // agenda: all 10 occurrences (Nov 2..Dec 6, all in 2026)
  await page.click('#calendar button[aria-label="Agenda view"]'); await sleep(800);
  const agendaN = await page.locator('.fc-event', { hasText: 'A6 custom biweekly' }).count();
  T.ok('agenda lists all 10 COUNT occurrences', agendaN === 10, 'count=' + agendaN);

  /* ============ 2.7 weekly custom rrule with UNTIL ============ */
  await page.click('#calendar button[aria-label="Month view"]'); await sleep(500);
  await openEditorNew({ title: 'A6 custom until', sd: '2026-11-03', st: '15:00', ed: '2026-11-03', et: '16:00' });
  await page.selectOption('select[aria-label="Frequency"]', 'CUSTOM');
  await sleep(500);
  // interval 1, TU+TH
  await page.fill('#freq-modal input[aria-label="Interval"]', '1');
  for (const d of ['Tu', 'Th']) {
    await page.locator('#freq-modal label', { hasText: new RegExp('^' + d + '$') }).locator('input').check();
  }
  for (const d of ['Mo', 'We', 'Fr', 'Sa', 'Su']) {
    await page.locator('#freq-modal label', { hasText: new RegExp('^' + d + '$') }).locator('input').uncheck();
  }
  await page.locator('#freq-modal select').nth(1).selectOption('until'); // Ends: On date
  await page.fill('#freq-modal input[aria-label="Until date"]', '2026-11-17');
  await page.click('#freq-modal .button-primary'); // Apply
  await sleep(500);
  m = h.mark();
  await page.click('#editor-modal .button-primary');
  await sleep(1300);
  T.ok('until create = 1 PUT', h.puts(h.since(m)) === 1, JSON.stringify(h.since(m).map((r) => r.m)));

  rows = await decryptAll();
  ev = findEvt(rows, 'A6 custom until');
  T.ok('serialized RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,TH;UNTIL=20261117T150000Z',
    !!ev && ev.rrule === 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,TH;UNTIL=20261117T150000Z', ev ? ev.rrule : 'row missing');

  await page.click('#calendar button[aria-label="Month view"]'); await sleep(600);
  const daysUntil = await page.evaluate((t) => {
    const chips = [...document.querySelectorAll('[data-date][role=cell] .fc-event')]
      .filter((e) => e.textContent.includes(t)).map((e) => e.getBoundingClientRect());
    const days = [];
    for (const cell of document.querySelectorAll('[data-date][role=cell]')) {
      const d = cell.getAttribute('data-date');
      const r = cell.getBoundingClientRect();
      if (chips.some((c) => c.x < r.x + r.width - 2 && c.x + c.width > r.x + 2 && c.y < r.y + r.height && c.y + c.height > r.y)) days.push(d);
    }
    return days;
  }, 'A6 custom until');
  const expectUntil = ['2026-11-03', '2026-11-05', '2026-11-10', '2026-11-12', '2026-11-17'];
  T.ok('UNTIL expansion in Nov view: ' + expectUntil.join(',') + ' (NOT Nov 19)',
    JSON.stringify(daysUntil) === JSON.stringify(expectUntil), JSON.stringify(daysUntil));

  await page.click('#calendar button[aria-label="Agenda view"]'); await sleep(700);
  const agendaU = await page.locator('.fc-event', { hasText: 'A6 custom until' }).count();
  T.ok('agenda lists exactly 5 UNTIL occurrences', agendaU === 5, 'count=' + agendaU);
} catch (e) {
  T.ok('group 2 ran to completion', false, String(e));
  await h.shot('g2-crash');
}

T.ok('no page errors during group 2', h.pageErrors.length === 0, h.pageErrors.join(' | ').slice(0, 400));
T.ok('no console errors during group 2', h.consoleErrors.length === 0, h.consoleErrors.join(' | ').slice(0, 400));

await h.shot('g2-final');
console.log('\n=== GROUP 2 (RECURRING EDITS): ' + T.summary() + ' ===');
if (T.fail > 0) console.log('FAILURES: ' + T.failures.join(' ; ').slice(0, 700));
await h.close();
process.exit(T.fail > 0 ? 1 : 0);
