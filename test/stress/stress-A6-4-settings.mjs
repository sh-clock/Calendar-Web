// stress-A6-4-settings.mjs — GROUP 4: SETTINGS RAPID-FIRE.
// theme x10 fast; firstDay Sun/Mon/Sat x views; slotDuration 15/30/60;
// weekNumbers toggle; customDays 2..14 sweep; reload persistence.
import { harness, makeTally } from './_lib.mjs';

const T = makeTally();
const h = await harness();
const { page } = h;
const sleep = (ms) => page.waitForTimeout(ms);

const themeOf = () => page.evaluate(() => document.documentElement.dataset.theme);
const firstColDate = () => page.evaluate(() => document.querySelector('.fc-col-header-cell')?.getAttribute('data-date'));
const firstMonthCell = () => page.evaluate(() => document.querySelector('.fc-daygrid-day')?.getAttribute('data-date'));
const lsSettings = () => page.evaluate(() => JSON.parse(localStorage.getItem('clock_poc_settings_v44') || 'null'));

async function openSettings() {
  await page.click('#btn-settings');
  await page.waitForSelector('#settings-modal:not([hidden])');
}
async function closeSettings() {
  await page.click('#settings-modal button:has-text("Done")');
  await sleep(250);
}

try {
  await h.unlock();

  /* ---- 4.1 theme rapid-fire x10 ---- */
  await openSettings();
  const seq = ['dark', 'light', 'system', 'dark', 'light', 'system', 'dark', 'light', 'system', 'dark'];
  const t0 = Date.now();
  await page.evaluate((order) => {
    const btns = [...document.querySelectorAll('#settings-modal [aria-label="Theme"] .settings-segment-button')];
    const byName = Object.fromEntries(btns.map((b) => [b.textContent.trim().toLowerCase(), b]));
    for (const n of order) byName[n].click();
  }, seq);
  const dt = Date.now() - t0;
  await sleep(400);
  T.ok('theme x10 rapid (10 clicks in ' + dt + 'ms) — final resolved dark', (await themeOf()) === 'dark', await themeOf());
  T.ok('theme persisted in settings = dark', (await lsSettings()).theme === 'dark', JSON.stringify(await lsSettings()));
  T.ok('settings modal survived rapid theme flips', await page.locator('#settings-modal').isVisible());
  await closeSettings();

  /* ---- 4.2 firstDay x views ---- */
  // Week-view first column WEEKDAY must equal firstDay (the exact date
  // depends on the current date, which legitimately drifts through the
  // year-view transitions — assert the weekday, and the exact November
  // month-grid leading cell.)
  const fdExpect = {
    0: { month: '2026-11-01' }, // Sunday
    1: { month: '2026-10-26' }, // Monday
    6: { month: '2026-10-31' }, // Saturday
  };
  const dowOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
  for (const fd of [0, 1, 6]) {
    await openSettings();
    await page.selectOption('#set-firstday', String(fd));
    await sleep(350);
    await closeSettings();
    await page.click('.fc-timeGridWeek-button'); await sleep(600);
    const wk = await firstColDate();
    T.ok('firstDay=' + fd + ': week view first column is a ' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][fd],
      !!wk && dowOf(wk) === fd, wk + ' (dow ' + (wk ? dowOf(wk) : '?') + ')');
    await page.click('.fc-dayGridMonth-button'); await sleep(600);
    await page.click('.fc-next-button'); await sleep(600); // November
    const mc = await firstMonthCell();
    T.ok('firstDay=' + fd + ': Nov month grid first cell ' + fdExpect[fd].month, mc === fdExpect[fd].month, mc);
    await page.click('.fc-prev-button'); await sleep(400);
    await page.click('.fc-multiMonthYear-button'); await sleep(900);
    const mmErr = h.pageErrors.length + h.consoleErrors.length;
    T.ok('firstDay=' + fd + ': year view renders without errors', mmErr === 0, h.consoleErrors.join('|').slice(0, 120));
    await page.click('.fc-dayGridMonth-button'); await sleep(500);
  }
  // restore Monday
  await openSettings();
  await page.selectOption('#set-firstday', '1');
  await closeSettings();

  /* ---- 4.3 slotDuration 15/30/60 ---- */
  // (FC renders one .fc-timegrid-slot-label element per LANE — unlabeled
  // ones are empty; count NON-EMPTY texts. 15-min slots get the hourly
  // slotLabelInterval override -> 24 real labels.)
  for (const [slot, lanes, labels] of [['00:15:00', 96, 24], ['00:30:00', 48, 24], ['01:00:00', 24, 24]]) {
    await openSettings();
    await page.selectOption('#set-slot', slot);
    await sleep(350);
    await closeSettings();
    await page.click('.fc-timeGridDay-button'); await sleep(700);
    const n = await page.evaluate(() => document.querySelectorAll('.fc-timegrid-slot-lane').length);
    T.ok('slotDuration ' + slot + ' -> ' + lanes + ' slot lanes', n === lanes, 'lanes=' + n);
    const lab = await page.evaluate(() => [...document.querySelectorAll('.fc-timegrid-slot-label')].filter((l) => l.textContent.trim()).length);
    T.ok('slotDuration ' + slot + ' -> ' + labels + ' visible slot labels', lab === labels, 'labels=' + lab);
  }

  /* ---- 4.4 weekNumbers toggle ---- */
  await page.click('.fc-dayGridMonth-button'); await sleep(600);
  await openSettings();
  await page.check('#set-weeknumbers'); await sleep(350);
  await closeSettings();
  let wn = await page.evaluate(() => document.querySelectorAll('.fc-daygrid-week-number, .fc-week-number').length);
  T.ok('weekNumbers ON renders week-number cells', wn > 0, 'cells=' + wn);
  await openSettings();
  await page.uncheck('#set-weeknumbers'); await sleep(350);
  await closeSettings();
  wn = await page.evaluate(() => document.querySelectorAll('.fc-daygrid-week-number, .fc-week-number').length);
  T.ok('weekNumbers OFF removes week-number cells', wn === 0, 'cells=' + wn);

  /* ---- 4.5 customDays sweep 2..14 ---- */
  // (.fc-timegrid-col includes one leading filler column with no data-date;
  // count only dated columns = day count.)
  let sweepBad = 0;
  for (let n = 2; n <= 14; n++) {
    await openSettings();
    await page.selectOption('#set-customdays', String(n));
    await sleep(250);
    await closeSettings();
    await page.click('.fc-custom-button'); await sleep(500);
    const cols = await page.evaluate(() => [...document.querySelectorAll('.fc-timegrid-col')].filter((c) => c.getAttribute('data-date')).length);
    if (cols !== n) {
      sweepBad++;
      T.ok('customDays=' + n + ' -> ' + n + ' dated timegrid columns', cols === n, 'cols=' + cols);
      await h.shot('g4-customdays-' + n);
    }
  }
  T.ok('customDays sweep 2..14: every column count matched', sweepBad === 0, sweepBad + ' mismatches');
  const cdPersist = (await lsSettings()).customDays;
  T.ok('customDays persisted (14)', cdPersist === 14, String(cdPersist));

  /* ---- 4.6 reload persistence ---- */
  // leave distinctive settings: dark, firstDay 6, slot 15, weekNumbers on, customDays 14
  await openSettings();
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#settings-modal [aria-label="Theme"] .settings-segment-button')];
    btns.find((b) => b.textContent.trim().toLowerCase() === 'dark').click();
  });
  await page.selectOption('#set-firstday', '6');
  await page.selectOption('#set-slot', '00:15:00');
  await page.check('#set-weeknumbers');
  await sleep(400);
  await closeSettings();
  await page.click('.fc-custom-button'); await sleep(600);

  await page.reload();
  await sleep(600);
  await page.fill('#password', 'password');
  await page.click('button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
  await sleep(1800);
  const s = await lsSettings();
  T.ok('after reload: settings block intact', !!s && s.theme === 'dark' && s.firstDay === 6 &&
    s.slotDuration === '00:15:00' && s.weekNumbers === true && s.customDays === 14, JSON.stringify(s));
  T.ok('after reload: theme applied (data-theme=dark)', (await themeOf()) === 'dark', await themeOf());
  const custCols = await page.evaluate(() => [...document.querySelectorAll('.fc-timegrid-col')].filter((c) => c.getAttribute('data-date')).length);
  T.ok('after reload: custom view restored with 14 dated columns', custCols === 14, 'cols=' + custCols);
  const lanes15 = await page.evaluate(() => document.querySelectorAll('.fc-timegrid-slot-lane').length);
  T.ok('after reload: 15-min slots active (96 lanes)', lanes15 === 96, 'lanes=' + lanes15);
  const wn2 = await page.evaluate(() => document.querySelectorAll('.fc-daygrid-week-number, .fc-week-number').length);
  T.ok('after reload: week numbers still on in month view', await page.click('.fc-dayGridMonth-button').then(() => sleep(500)).then(() => page.evaluate(() => document.querySelectorAll('.fc-daygrid-week-number, .fc-week-number').length)).then((x) => x > 0));
  // firstDay=6 live after reload: October grid (fd=6) starts Sat 2026-09-26;
  // November grid starts Sat 2026-10-31
  const mcOct = await page.evaluate(() => document.querySelector('.fc-daygrid-day')?.getAttribute('data-date'));
  T.ok('after reload: firstDay=6 October first cell Sat 2026-09-26', mcOct === '2026-09-26', mcOct);
  await page.click('.fc-next-button'); await sleep(600);
  const mc2 = await page.evaluate(() => document.querySelector('.fc-daygrid-day')?.getAttribute('data-date'));
  T.ok('after reload: firstDay=6 November first cell Sat 2026-10-31', mc2 === '2026-10-31', mc2);
  await h.shot('g4-after-reload');
} catch (e) {
  T.ok('group 4 ran to completion', false, String(e));
  await h.shot('g4-crash');
}

T.ok('no page errors during group 4', h.pageErrors.length === 0, h.pageErrors.join(' | ').slice(0, 400));
T.ok('no console errors during group 4', h.consoleErrors.length === 0, h.consoleErrors.join(' | ').slice(0, 400));

console.log('\n=== GROUP 4 (SETTINGS RAPID-FIRE): ' + T.summary() + ' ===');
if (T.fail > 0) console.log('FAILURES: ' + T.failures.join(' ; ').slice(0, 600));
await h.close();
process.exit(T.fail > 0 ? 1 : 0);
