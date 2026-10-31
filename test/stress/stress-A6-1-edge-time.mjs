// stress-A6-1-edge-time.mjs — GROUP 1: EDGE-TIME EVENTS (adversarial times).
// Creates events via the editor at boundary times, verifies rendering in the
// correct day/time slots (GEOMETRIC containment — FC multi-day chips span
// cells from their start-day DOM parent) AND exact DTSTART/DTEND round-trip.
import { harness, decryptAll, findEvt, makeTally } from './_lib.mjs';

const T = makeTally();
const h = await harness();
const { page } = h;

const E = {
  midnight: { title: 'A6 midnight 2330-0030', sd: '2026-11-04', st: '23:30', ed: '2026-11-05', et: '00:30' },
  allday1: { title: 'A6 allday 1day', sd: '2026-11-10', st: null, ed: '2026-11-10', et: null, allDay: true },
  allday5: { title: 'A6 allday 5day', sd: '2026-11-12', st: null, ed: '2026-11-16', et: null, allDay: true },
  multi222: { title: 'A6 timed 22-02', sd: '2026-11-18', st: '22:00', ed: '2026-11-19', et: '02:00' },
  zero: { title: 'A6 zero 0900-0900', sd: '2026-11-20', st: '09:00', ed: '2026-11-20', et: '09:00' },
  at0000: { title: 'A6 at 0000', sd: '2026-11-22', st: '00:00', ed: '2026-11-22', et: '01:00' },
  ends2359: { title: 'A6 ends 2359', sd: '2026-11-24', st: '22:00', ed: '2026-11-24', et: '23:59' },
  reversed: { title: 'A6 reversed swap', sd: '2026-11-26', st: '10:00', ed: '2026-11-26', et: '09:00' },
};

async function createEvent(spec) {
  await page.click('#btn-new-event');
  await page.fill('input[aria-label="Title"]', spec.title);
  await page.fill('input[aria-label="Starts date"]', spec.sd);
  if (spec.st !== null && spec.st !== undefined) await page.fill('input[aria-label="Starts time"]', spec.st);
  await page.fill('input[aria-label="Ends date"]', spec.ed);
  if (spec.et !== null && spec.et !== undefined) await page.fill('input[aria-label="Ends time"]', spec.et);
  if (spec.allDay) await page.check('#editor-modal .fullday-recurrency input[type=checkbox]');
  const m = h.mark();
  await page.click('#editor-modal .button-primary');
  await page.waitForTimeout(1100);
  return h.since(m);
}

/** Day cells (month view) GEOMETRICALLY covered by a chip with the title. */
const monthDaysContaining = (title) => page.evaluate((t) => {
  const chips = [...document.querySelectorAll('.fc-daygrid-day .fc-event')]
    .filter((e) => e.textContent.includes(t))
    .map((e) => e.getBoundingClientRect());
  const days = [];
  for (const cell of document.querySelectorAll('.fc-daygrid-day')) {
    const d = cell.getAttribute('data-date');
    const r = cell.getBoundingClientRect();
    if (chips.some((c) => c.x < r.x + r.width - 2 && c.x + c.width > r.x + 2 && c.y < r.y + r.height && c.y + c.height > r.y)) days.push(d);
  }
  return days;
}, title);

/** Time position of a timed chip in the CURRENT timegrid view, in 30-min slots. */
const chipGeom = (title) => page.evaluate((t) => {
  const chip = [...document.querySelectorAll('.fc-timegrid-event')].find((e) => e.textContent.includes(t));
  if (!chip) return null;
  const lanes = [...document.querySelectorAll('.fc-timegrid-slot-lane')];
  if (!lanes.length) return null;
  const first = lanes[0].getBoundingClientRect();
  const last = lanes[lanes.length - 1].getBoundingClientRect();
  const pxPerSlot = (last.y + last.height - first.y) / lanes.length;
  const cr = chip.getBoundingClientRect();
  return { topSlots: (cr.y - first.y) / pxPerSlot, heightSlots: cr.height / pxPerSlot, text: chip.textContent.trim() };
}, title);

const near = (a, b, tol) => Math.abs(a - b) <= tol;

try {
  await h.unlock();
  T.ok('unlock + default calendar bootstrap', await page.locator('.calendar-list li').count() >= 1);

  for (const spec of Object.values(E)) {
    const reqs = await createEvent(spec);
    T.ok('create "' + spec.title + '" = exactly 1 PUT', h.puts(reqs) === 1 && reqs.length === 1,
      JSON.stringify(reqs.map((r) => r.m)));
  }

  /* ---- month view: day-slot rendering (geometric) ---- */
  await page.click('.fc-dayGridMonth-button');
  await page.waitForTimeout(400);
  await page.click('.fc-next-button'); // October -> November
  await page.waitForTimeout(700);

  const md = {};
  for (const k of Object.keys(E)) md[k] = await monthDaysContaining(E[k].title);
  T.ok('midnight-crossing covers Nov 4 AND Nov 5',
    md.midnight.includes('2026-11-04') && md.midnight.includes('2026-11-05'), JSON.stringify(md.midnight));
  T.ok('all-day 1-day covers ONLY Nov 10', md.allday1.length === 1 && md.allday1[0] === '2026-11-10', JSON.stringify(md.allday1));
  T.ok('all-day 5-day covers Nov 12..16 exactly',
    md.allday5.length === 5 && md.allday5[0] === '2026-11-12' && md.allday5[4] === '2026-11-16',
    JSON.stringify(md.allday5));
  T.ok('timed 22-02 covers Nov 18 AND Nov 19',
    md.multi222.includes('2026-11-18') && md.multi222.includes('2026-11-19'), JSON.stringify(md.multi222));
  T.ok('zero-duration covers Nov 20 only', md.zero.length === 1 && md.zero[0] === '2026-11-20', JSON.stringify(md.zero));
  T.ok('00:00 event covers Nov 22 only', md.at0000.length === 1 && md.at0000[0] === '2026-11-22', JSON.stringify(md.at0000));
  T.ok('ends-23:59 covers Nov 24 only', md.ends2359.length === 1 && md.ends2359[0] === '2026-11-24', JSON.stringify(md.ends2359));
  T.ok('reversed-swap covers Nov 26 only', md.reversed.length === 1 && md.reversed[0] === '2026-11-26', JSON.stringify(md.reversed));

  /* ---- day view: precise time-slot geometry (navLinks on day numbers) ---- */
  async function dayViewOf(date) {
    await page.click('.fc-dayGridMonth-button');
    await page.waitForTimeout(400);
    await page.click('.fc-daygrid-day[data-date="' + date + '"] .fc-daygrid-day-number');
    await page.waitForTimeout(500);
  }

  await dayViewOf('2026-11-04');
  let g = await chipGeom(E.midnight.title);
  T.ok('Nov 4 day view: midnight event top ~23:30 (slot 47)', !!g && near(g.topSlots, 47, 1.2),
    g ? 'topSlots=' + g.topSlots.toFixed(2) : 'chip missing');
  T.ok('Nov 4 day view: midnight event clipped to 1 slot (23:30-24:00)', !!g && near(g.heightSlots, 1, 0.8),
    g ? 'heightSlots=' + g.heightSlots.toFixed(2) : 'chip missing');
  await page.click('.fc-next-button'); await page.waitForTimeout(400); // Nov 5
  g = await chipGeom(E.midnight.title);
  T.ok('Nov 5 day view: midnight continuation top ~00:00 (slot 0)', !!g && near(g.topSlots, 0, 1.2),
    g ? 'topSlots=' + g.topSlots.toFixed(2) : 'chip missing');

  await dayViewOf('2026-11-10');
  const ad1 = await page.locator('.fc-daygrid-event', { hasText: 'A6 allday 1day' }).count();
  T.ok('all-day 1-day chip present in Nov 10 day view', ad1 >= 1, 'count=' + ad1);

  await dayViewOf('2026-11-12');
  const ad5 = await page.locator('.fc-daygrid-event', { hasText: 'A6 allday 5day' }).count();
  T.ok('all-day 5-day chip present in Nov 12 day view', ad5 >= 1, 'count=' + ad5);

  await dayViewOf('2026-11-18');
  g = await chipGeom(E.multi222.title);
  T.ok('Nov 18 day view: 22:00 event top ~slot 44 (22:00)', !!g && near(g.topSlots, 44, 1.2),
    g ? 'topSlots=' + g.topSlots.toFixed(2) : 'chip missing');
  await page.click('.fc-next-button'); await page.waitForTimeout(400); // Nov 19
  g = await chipGeom(E.multi222.title);
  T.ok('Nov 19 day view: 22-02 continuation top ~0, height ~4 slots (00:00-02:00)',
    !!g && near(g.topSlots, 0, 1.2) && near(g.heightSlots, 4, 0.8),
    g ? 'top=' + g.topSlots.toFixed(2) + ' h=' + g.heightSlots.toFixed(2) : 'chip missing');

  await dayViewOf('2026-11-20');
  g = await chipGeom(E.zero.title);
  T.ok('Nov 20 day view: zero-duration chip top ~slot 18 (09:00)', !!g && near(g.topSlots, 18, 1.2),
    g ? 'topSlots=' + g.topSlots.toFixed(2) : 'chip missing');

  await dayViewOf('2026-11-22');
  g = await chipGeom(E.at0000.title);
  T.ok('Nov 22 day view: 00:00 event top ~slot 0', !!g && near(g.topSlots, 0, 1.2),
    g ? 'topSlots=' + g.topSlots.toFixed(2) : 'chip missing');

  await dayViewOf('2026-11-24');
  g = await chipGeom(E.ends2359.title);
  T.ok('Nov 24 day view: ends-23:59 event bottom ~slot 47.97 (23:59)',
    !!g && near(g.topSlots + g.heightSlots, 47.97, 1.2),
    g ? 'bottom=' + (g.topSlots + g.heightSlots).toFixed(2) : 'chip missing');

  await dayViewOf('2026-11-26');
  g = await chipGeom(E.reversed.title);
  T.ok('reversed-swap renders at 09:00 (slot 18) in day view', !!g && near(g.topSlots, 18, 1.2),
    g ? 'topSlots=' + g.topSlots.toFixed(2) : 'chip missing');

  /* ---- data integrity: decrypted DTSTART/DTEND round-trip ---- */
  const rows = await decryptAll();
  const expect = [
    ['midnight', 'DTSTART:20261104T233000Z', 'DTEND:20261105T003000Z'],
    ['allday1', 'DTSTART;VALUE=DATE:20261110', 'DTEND;VALUE=DATE:20261111'],
    ['allday5', 'DTSTART;VALUE=DATE:20261112', 'DTEND;VALUE=DATE:20261117'],
    ['multi222', 'DTSTART:20261118T220000Z', 'DTEND:20261119T020000Z'],
    ['zero', 'DTSTART:20261120T090000Z', 'DTEND:20261120T090000Z'],
    ['at0000', 'DTSTART:20261122T000000Z', 'DTEND:20261122T010000Z'],
    ['ends2359', 'DTSTART:20261124T220000Z', 'DTEND:20261124T235900Z'],
    ['reversed', 'DTSTART:20261126T090000Z', 'DTEND:20261126T100000Z'],
  ];
  for (const [k, ds, de] of expect) {
    const ev = findEvt(rows, E[k].title);
    T.ok('round-trip ' + k + ': ' + ds, !!ev && ev.dtstart === ds, ev ? ev.dtstart : 'row not found');
    T.ok('round-trip ' + k + ': ' + de, !!ev && ev.dtend === de, ev ? ev.dtend : 'row not found');
  }
} catch (e) {
  T.ok('group 1 ran to completion', false, String(e));
  await h.shot('g1-crash');
}

T.ok('no page errors during group 1', h.pageErrors.length === 0, h.pageErrors.join(' | ').slice(0, 400));
T.ok('no console errors during group 1', h.consoleErrors.length === 0, h.consoleErrors.join(' | ').slice(0, 400));

await page.click('.fc-dayGridMonth-button').catch(() => {});
await page.waitForTimeout(400);
await h.shot('g1-final');
console.log('\n=== GROUP 1 (EDGE-TIME EVENTS): ' + T.summary() + ' ===');
if (T.fail > 0) console.log('FAILURES: ' + T.failures.join(' ; ').slice(0, 600));
await h.close();
process.exit(T.fail > 0 ? 1 : 0);
