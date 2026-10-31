// e2e-prod.mjs — verify the LIVE deployment (GitHub Pages client + production
// worker): seeded events render, request counts, views, dark mode, one
// create+delete round-trip. Leaves the seeded data intact.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';

const SITE = 'https://sh-clock.github.io/Calendar-Web/';
const SERVER = 'https://calendar-poc.sh-clock.workers.dev';
const AUTH_UI = '*SCRUBBED*<=';

const requests = [];
const pageErrors = [];
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + String(detail) : '')); }
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('request', (r) => { const u = String(r.url()); if (u.startsWith(SERVER)) requests.push(r.method() + ' ' + u.replace(SERVER, '').slice(0, 40)); });
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) pageErrors.push('CONSOLE: ' + m.text()); });

/* unlock on the LIVE site */
await page.goto(SITE + '#setup=' + AUTH_UI + '&server=' + encodeURIComponent(SERVER));
await page.waitForTimeout(1500);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 45000 });
await page.waitForTimeout(2500);
ok('live unlock: proto badge shows 4.3', (await page.locator('#proto-badge').textContent()) === 'protocol 4.3');
ok('live unlock ≤ 5 requests', requests.length <= 5, JSON.stringify(requests));
ok('seeded Welcome event renders', (await page.locator('.calendar-dayeventcell', { hasText: 'Welcome to Calendar v4.3' }).count()) >= 1);
// Team standup is MO–FR and today is Saturday → first occurrence Mon Nov 2:
// verify it in NOVEMBER, not the current (October) month.
await page.click('#btn-next');
await page.waitForTimeout(700);
const standupCount = await page.locator('.calendar-dayeventcell', { hasText: 'Team standup' }).count();
ok('seeded Team standup renders (November weekdays)', standupCount >= 5, standupCount);
await page.click('#btn-prev');
await page.waitForTimeout(600);
ok('two calendars in sidebar', (await page.locator('#calendar-list li').count()) === 2);

await page.screenshot({ path: '/tmp/prod-month.png' });

/* week view — Lunch is tomorrow (Sunday, current week); the standup is
   MO–FR so it first occurs NEXT week (Mon Nov 2 …). */
await page.click('.view-button[data-view="week"]');
await page.waitForTimeout(500);
ok('live week view: 7 columns', (await page.locator('.timegrid-day').count()) === 7);
ok('live week view: Lunch with Alex chip (current week)', (await page.locator('.calendar-eventcell', { hasText: 'Lunch with Alex' }).count()) >= 1);
await page.click('#btn-next');
await page.waitForTimeout(700);
ok('live week view: standup chip (next week)', (await page.locator('.calendar-eventcell', { hasText: 'Team standup' }).count()) >= 1);
await page.click('#btn-prev');
await page.waitForTimeout(500);
const nowLine = await page.locator('.calendar-grid-nowHourLine').count();
ok('live week view: now-line on today', nowLine === 1, nowLine);
await page.screenshot({ path: '/tmp/prod-week.png' });

/* day view */
await page.click('.view-button[data-view="day"]');
await page.waitForTimeout(600);
ok('live day view: 1 column', (await page.locator('.timegrid-day').count()) === 1);
await page.screenshot({ path: '/tmp/prod-day.png' });

/* year view */
await page.click('.view-button[data-view="year"]');
await page.waitForTimeout(900);
ok('live year view: 12 months', (await page.locator('.yeargrid-month').count()) === 12);
ok('live year view: event dots present', (await page.locator('.yearday-dot').count()) >= 5);
await page.screenshot({ path: '/tmp/prod-year.png' });

/* dark mode screenshots */
await page.click('.view-button[data-view="month"]');
await page.waitForTimeout(500);
await page.click('#btn-theme');
await page.waitForTimeout(600);
ok('dark theme on live site', await page.evaluate(() => document.documentElement.dataset.theme === 'dark'));
await page.screenshot({ path: '/tmp/prod-month-dark.png' });
await page.click('.view-button[data-view="week"]');
await page.waitForTimeout(700);
await page.screenshot({ path: '/tmp/prod-week-dark.png' });
await page.click('.view-button[data-view="month"]');
await page.waitForTimeout(400);
await page.click('#btn-theme');
await page.waitForTimeout(300);

/* one create + delete round-trip on production */
const before = requests.length;
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'PROD-VERIFY (will self-delete)');
await page.click('button.button-primary:has-text("Save")');
await page.waitForTimeout(2500);
ok('live create = 1 PUT', requests.slice(before).filter((r) => r.startsWith('PUT')).length === 1, JSON.stringify(requests.slice(before)));
ok('created event visible', (await page.locator('.calendar-dayeventcell', { hasText: 'PROD-VERIFY' }).count()) >= 1);

const b2 = requests.length;
const chip = page.locator('.calendar-dayeventcell', { hasText: 'PROD-VERIFY' }).first();
const box = await chip.boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(1200);
await page.click('#event-popover button[title="Delete"]');
await page.waitForTimeout(2500);
ok('live delete = 1 DELETE', requests.slice(b2).filter((r) => r.startsWith('DELETE')).length === 1, JSON.stringify(requests.slice(b2)));
ok('deleted from UI', (await page.locator('.calendar-dayeventcell', { hasText: 'PROD-VERIFY' }).count()) === 0);

/* seeded data intact check */
ok('seeded Welcome still present', (await page.locator('.calendar-dayeventcell', { hasText: 'Welcome to Calendar v4.3' }).count()) >= 1);

console.log('\n=== PROD E2E: ' + pass + ' passed, ' + fail + ' failed | total requests: ' + requests.length + ' ===');
console.log('=== PAGE ERRORS (' + pageErrors.length + ') ===');
for (const e of pageErrors.slice(0, 10)) console.log('  ' + e.slice(0, 200));
await browser.close();
process.exit(fail > 0 ? 1 : 0);
