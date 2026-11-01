// e2e-prod.mjs — verify the LIVE deployment (GitHub Pages client + production
// worker): seeded events render, request counts, views, dark mode, one
// create+delete round-trip. Leaves the seeded data intact.
// v7 migration: anchors on FullCalendar's stable hooks (aria-labelled
// toolbar buttons, [data-date][role=cell] day cells, .fc-event chips) —
// same anchor strategy as scripts/e2e-fc.mjs.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';

const SITE = 'https://sh-clock.github.io/Calendar-Web/';
const SERVER = 'https://calendar-poc.sh-clock.workers.dev';
import { AUTH_UI } from './lib-prod-material.mjs'; // sec-S7-F1

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

const nextBtn = '#calendar button[aria-label^="Next"]';
const prevBtn = '#calendar button[aria-label^="Previous"]';
const monthBtn = '#calendar button[aria-label="Month view"]';
const weekBtn = '#calendar button[aria-label="Week view"]';
const dayBtn = '#calendar button[aria-label="Day view"]';
const yearBtn = '#calendar button[aria-label="Year view"]';

/* unlock on the LIVE site (fragment provisioning — the only accepted form;
   no #server= — the production worker is the client's default, and a remote
   server in a URL is exactly what sec-S5-F1 refuses) */
await page.goto(SITE + '#setup=' + AUTH_UI);
await page.waitForTimeout(1500);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 45000 });
await page.waitForSelector('#calendar [data-date]', { timeout: 20000 });
await page.waitForTimeout(2500);
ok('live unlock: proto badge shows 4.3', (await page.locator('#proto-badge').textContent()) === 'protocol 4.3');
ok('live unlock ≤ 5 requests', requests.length <= 5, JSON.stringify(requests));
ok('seeded Welcome event renders', (await page.locator('.fc-event', { hasText: 'Welcome to Calendar v4.3' }).count()) >= 1);

// Team standup is MO–FR: verify its weekday occurrences render in month view.
await page.click(nextBtn);
await page.waitForTimeout(700);
const standupCount = await page.locator('.fc-event', { hasText: 'Team standup' }).count();
ok('seeded Team standup renders (weekdays)', standupCount >= 1, standupCount);
await page.click(prevBtn);
await page.waitForTimeout(600);
ok('two calendars in sidebar', (await page.locator('#calendar-list li').count()) === 2);

await page.screenshot({ path: '/tmp/prod-month.png' });

/* week view — Lunch is tomorrow (day+1): visible in THIS week when tomorrow
   falls inside it, otherwise in NEXT week (date-of-run dependent). */
await page.click(weekBtn);
await page.waitForTimeout(700);
ok('live week view: 7 day columns', (await page.locator('[data-date][role=cell]').count()) >= 7);
let lunchCount = await page.locator('.fc-event', { hasText: 'Lunch' }).count();
if (lunchCount === 0) {
  await page.click(nextBtn);
  await page.waitForTimeout(700);
  lunchCount = await page.locator('.fc-event', { hasText: 'Lunch' }).count();
  await page.click(prevBtn);
  await page.waitForTimeout(400);
}
ok('live week view: Lunch chip present', lunchCount >= 1, lunchCount);
await page.screenshot({ path: '/tmp/prod-week.png' });

/* day view */
await page.click(dayBtn);
await page.waitForTimeout(600);
ok('live day view renders', (await page.locator('[data-date][role=cell]').count()) >= 1);
await page.screenshot({ path: '/tmp/prod-day.png' });

/* year view */
await page.click(yearBtn);
await page.waitForTimeout(900);
ok('live year view: 12 month grids', (await page.locator('#calendar [data-date]').count()) >= 300);
await page.screenshot({ path: '/tmp/prod-year.png' });

/* dark mode via settings (theme is a segmented button group) */
await page.click(monthBtn);
await page.waitForTimeout(500);
await page.click('#btn-settings');
await page.waitForTimeout(600);
await page.click('.settings-segment-button:has-text("Dark")');
await page.waitForTimeout(600);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok('dark theme on live site', await page.evaluate(() => document.documentElement.dataset.theme === 'dark'));
await page.screenshot({ path: '/tmp/prod-month-dark.png' });
// back to light via the same path
await page.click('#btn-settings');
await page.waitForTimeout(500);
await page.click('.settings-segment-button:has-text("Light")');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');

/* one create + delete round-trip on production */
const before = requests.length;
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'PROD-VERIFY (will self-delete)');
await page.click('button.button-primary:has-text("Save")');
await page.waitForTimeout(2500);
ok('live create = 1 PUT', requests.slice(before).filter((r) => r.startsWith('PUT')).length === 1, JSON.stringify(requests.slice(before)));
ok('created event visible', (await page.locator('.fc-event', { hasText: 'PROD-VERIFY' }).count()) >= 1);

const b2 = requests.length;
const chip = page.locator('.fc-event', { hasText: 'PROD-VERIFY' }).first();
const box = await chip.boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(1200);
await page.click('#event-popover button[title="Delete"]');
await page.waitForTimeout(2500);
ok('live delete = 1 DELETE', requests.slice(b2).filter((r) => r.startsWith('DELETE')).length === 1, JSON.stringify(requests.slice(b2)));
ok('deleted from UI', (await page.locator('.fc-event', { hasText: 'PROD-VERIFY' }).count()) === 0);

/* seeded data intact check */
ok('seeded Welcome still present', (await page.locator('.fc-event', { hasText: 'Welcome to Calendar v4.3' }).count()) >= 1);

console.log('\n=== PROD E2E: ' + pass + ' passed, ' + fail + ' failed | total requests: ' + requests.length + ' ===');
console.log('=== PAGE ERRORS (' + pageErrors.length + ') ===');
for (const e of pageErrors.slice(0, 10)) console.log('  ' + e.slice(0, 200));
await browser.close();
process.exit(fail > 0 ? 1 : 0);
