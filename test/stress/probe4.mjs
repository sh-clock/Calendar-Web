// probe4: all-day month-view resize to below-one-day (end < start) — does FC
// fire eventResize with a negative dayDelta (-> app invalid_duration toast)?
import { harness, decryptAll, findEvt, makeTally } from './_lib.mjs';
const T = makeTally();
const h = await harness();
const { page } = h;
const sleep = (ms) => page.waitForTimeout(ms);
try {
  await h.unlock();
  await page.click('#btn-new-event');
  await page.fill('input[aria-label="Title"]', 'P4 allday 3d');
  await page.fill('input[aria-label="Starts date"]', '2026-11-12');
  await page.fill('input[aria-label="Ends date"]', '2026-11-14');
  await page.check('#editor-modal .fullday-recurrency input[type=checkbox]');
  await page.click('#editor-modal .button-primary');
  await sleep(1200);
  await page.click('.fc-dayGridMonth-button'); await sleep(400);
  await page.click('.fc-next-button'); await sleep(700);

  const g = await page.evaluate(() => {
    const cell = document.querySelector('.fc-daygrid-day[data-date="2026-11-12"]');
    const chip = [...cell.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('P4 allday 3d'));
    if (!chip) return null;
    const cb = chip.getBoundingClientRect();
    return { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2, left: cb.x, w: cb.width };
  });
  await page.mouse.move(h.R(g.x), h.R(g.y)); await sleep(500);
  const z = await page.evaluate(() => {
    const cell = document.querySelector('.fc-daygrid-day[data-date="2026-11-12"]');
    const chip = [...cell.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('P4 allday 3d'));
    const zs = [...chip.querySelectorAll('.fc-event-resizer')];
    const zz = zs[zs.length - 1];
    if (!zz) return null;
    const b = zz.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  T.ok('allday resizer present', !!z);
  const target = await page.evaluate(() => {
    const cell = document.querySelector('.fc-daygrid-day[data-date="2026-11-10"]');
    const b = cell.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + 10 };
  });
  const m = h.mark();
  await page.mouse.move(h.R(z.x), h.R(z.y)); await sleep(250);
  await page.mouse.down();
  await page.mouse.move(h.R(target.x), h.R(target.y), { steps: 15 });
  await page.mouse.up();
  await sleep(1600);
  const toasts = await page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent));
  const reqs = h.since(m);
  const rows = await decryptAll();
  const ev = findEvt(rows, 'P4 allday 3d');
  T.ok('allday below-1-day resize: NO PUT', h.puts(reqs) === 0, JSON.stringify(reqs.map((r) => r.m)));
  T.ok('allday below-1-day resize: toast shown', toasts.length > 0, JSON.stringify(toasts));
  T.ok('allday below-1-day resize: DTEND unchanged 20261115', ev && ev.dtend === 'DTEND;VALUE=DATE:20261115', ev ? ev.dtend : '-');
  const days = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.fc-daygrid-day .fc-event')].filter((e) => e.textContent.includes('P4 allday 3d')).map((e) => e.getBoundingClientRect());
    const out = [];
    for (const cell of document.querySelectorAll('.fc-daygrid-day')) {
      const d = cell.getAttribute('data-date');
      const r = cell.getBoundingClientRect();
      if (chips.some((c) => c.x < r.x + r.width - 2 && c.x + c.width > r.x + 2)) out.push(d);
    }
    return out;
  });
  T.ok('allday below-1-day resize: chip reverted (Nov 12..14)', JSON.stringify(days) === JSON.stringify(['2026-11-12', '2026-11-13', '2026-11-14']), JSON.stringify(days));
} catch (e) {
  T.ok('probe4 ran to completion', false, String(e));
}
console.log('\n=== PROBE4: ' + T.summary() + ' ===');
if (T.fail > 0) console.log('FAILURES: ' + T.failures.join(' ; '));
await h.shot('probe4');
await h.close();
process.exit(T.fail > 0 ? 1 : 0);
