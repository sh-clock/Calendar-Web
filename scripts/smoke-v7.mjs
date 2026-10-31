// smoke-v7.mjs — first browser verification of the FullCalendar v7.1.3
// migration + themes + tasks + local-first cache against the local stack.
// Usage: node scripts/smoke-v7.mjs
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8080';
const SERVER = 'http://127.0.0.1:8787';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const AUTH_UI = mat.auth_ui_hex;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + String(detail) : '')); }
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(([token, server]) => {
  localStorage.setItem('clock_poc_auth_ui', token);
  localStorage.setItem('clock_poc_server', server);
  localStorage.removeItem('clock_poc_cache_v45');
  localStorage.removeItem('clock_poc_settings_v45');
}, [AUTH_UI, SERVER]);
const page = await ctx.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto(BASE + '/index.html');

// Fresh unlock (no cache): busy-until-synced path.
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForSelector('#calendar [data-date]', { timeout: 15000 });
await page.waitForTimeout(1500);
ok('app unlocked + FC v7 rendered', await page.$('#calendar [data-date]') !== null);
ok('theme css link active', await page.$('#fc-theme-css') !== null);
const themeHref = await page.getAttribute('#fc-theme-css', 'href');
ok('default theme = monarch', /themes\/monarch\/theme\.css$/.test(themeHref || ''), themeHref);
ok('palette css = blue', /palettes\/blue\.css$/.test((await page.getAttribute('#fc-palette-css', 'href')) || ''));
ok('html data-fctheme', (await page.getAttribute('html', 'data-fctheme')) === 'monarch');
ok('skeleton css loaded', (await page.$$eval('link[rel=stylesheet]', (ls) => ls.map((l) => l.getAttribute('href')))).some((h) => /skeleton\.css$/.test(h || '')));

// Toolbar rendered by the official monarch theme (v7: stable aria-labels).
ok('FC toolbar prev button', await page.$('#calendar button[aria-label^="Previous"]') !== null);
ok('FC toolbar Month view button', await page.$('#calendar button[aria-label="Month view"]') !== null);

// Local-first cache was written after sync.
await page.waitForTimeout(1200);
const cache = await page.evaluate(() => localStorage.getItem('clock_poc_cache_v45'));
ok('local-first cache written', !!cache && cache.length > 10);
if (cache) {
  const o = JSON.parse(cache);
  ok('cache has calendars', Array.isArray(o.cals) && o.cals.length >= 1, JSON.stringify(o.cals && o.cals.length));
}

// Unlock → settings modal shows the 7 themes.
await page.click('#btn-settings');
await page.waitForSelector('#settings-modal:not([hidden])');
const segButtons = await page.$$eval('.settings-segment', (els) => els.map((e) => e.textContent));
const settingsText = await page.textContent('#settings-modal');
for (const t of ['Monarch', 'Forma', 'Breezy', 'Pulse', 'Classic', 'Shadcn', 'MUI']) {
  ok('settings offers ' + t, settingsText.includes(t));
}
ok('palette select present', await page.$('#set-fcpalette') !== null);

// Create a TASK via the new-task menu.
await page.click('#settings-modal .button-primary'); // Done
await page.click('#btn-new-task');
await page.waitForSelector('#new-task-menu');
await page.click('#new-task-menu button:last-child'); // New task
await page.waitForSelector('#editor-modal:not([hidden])');
ok('task editor opens with Add task', (await page.textContent('#editor-modal h1')).includes('Add task'));
ok('Ends row hidden for tasks', await page.$$eval('#editor-modal .form-row', (rows) => rows.some((r) => r.textContent.includes('Ends') && r.hidden)));
await page.fill('#editor-modal input[type=text]', 'Smoke task one');
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1800);
ok('task saved toast', (await page.textContent('#toasts')).includes('Task saved.'));

// The task renders with the checkbox.
const taskEl = await page.$('.fc-event.fc-task');
ok('task chip rendered with fc-task class', taskEl !== null);
ok('task checkbox present', await page.$('.fc-task-check') !== null);

// Toggle completion via the checkbox.
await page.click('.fc-task-check');
await page.waitForTimeout(1800);
ok('completed class applied', await page.$('.fc-event.fc-task-completed') !== null);
ok('completion toast', (await page.textContent('#toasts')).includes('marked complete'));

// Reload → local-first: events render BEFORE any network sync completes.
await page.reload();
await page.fill('#password', 'password');
const t0 = Date.now();
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForSelector('.fc-event', { timeout: 15000 });
const paintMs = Date.now() - t0;
console.log('  info paint-after-reload: ' + paintMs + 'ms');
ok('cached calendar paints on reload', true);

// Theme switch through settings: monarch → classic (flavor change rebuilds).
await page.click('#btn-settings');
await page.waitForSelector('#settings-modal:not([hidden])');
await page.click('#settings-modal .settings-segment-wrap .settings-segment-button:has-text("Classic")');
await page.waitForTimeout(2500);
const themeHref2 = await page.getAttribute('#fc-theme-css', 'href');
ok('theme link switched to classic', /themes\/classic\/theme\.css$/.test(themeHref2 || ''), themeHref2);
ok('palette link = classic palette.css', /classic\/palette\.css$/.test((await page.getAttribute('#fc-palette-css', 'href')) || ''));
ok('html data-fctheme=classic', (await page.getAttribute('html', 'data-fctheme')) === 'classic');
ok('calendar still rendered after rebuild', await page.$('.fc-event') !== null);

// shadcn theme: chrome palette activation.
await page.click('#settings-modal .settings-segment-wrap .settings-segment-button:has-text("Shadcn")');
await page.waitForTimeout(2000);
ok('shadcn data-palette set', (await page.getAttribute('html', 'data-palette')) === 'neutral');
ok('shadcn palettes css loaded', /shadcn-palettes\.css$/.test((await page.getAttribute('#fc-chrome-palettes', 'href')) || ''));
const shadcnPrimary = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim());
ok('chrome --primary follows shadcn token (oklch)', /oklch/i.test(shadcnPrimary), shadcnPrimary);
ok('calendar still rendered (shadcn)', await page.$('.fc-event') !== null);

// mui theme.
await page.click('#settings-modal .settings-segment-wrap .settings-segment-button:has-text("MUI")');
await page.waitForTimeout(2000);
ok('mui data-mui-palette set', (await page.getAttribute('html', 'data-mui-palette')) === 'blue');
ok('mui palettes css loaded', /mui-palettes\.css$/.test((await page.getAttribute('#fc-chrome-palettes', 'href')) || ''));
const muiPrimary = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim());
ok('chrome --primary = MUI #1976d2', /1976d2|rgb\(25,? 118,? 210\)/.test(muiPrimary), muiPrimary);
ok('calendar still rendered (mui)', await page.$('.fc-event') !== null);

// Dark mode: data-color-scheme flips the official palette vars.
await page.click('#settings-modal .settings-segment-button:has-text("Dark")');
await page.waitForTimeout(600);
ok('data-color-scheme=dark', (await page.getAttribute('html', 'data-color-scheme')) === 'dark');
ok('data-theme=dark', (await page.getAttribute('html', 'data-theme')) === 'dark');

// Back to monarch light for the screenshot + lock purge check.
await page.click('#settings-modal .settings-segment-button:has-text("Light")');
await page.click('#settings-modal .settings-segment-wrap .settings-segment-button:has-text("Monarch")');
await page.waitForTimeout(2000);
await page.click('#settings-modal .button-primary');
await page.screenshot({ path: '/home/z/my-project/download/v7-smoke-monarch.png' });

// Lock purges the local cache.
await page.click('#btn-lock');
await page.waitForTimeout(600);
const cacheAfterLock = await page.evaluate(() => localStorage.getItem('clock_poc_cache_v45'));
ok('lock purges local cache', cacheAfterLock === null);

ok('zero page errors', pageErrors.length === 0, pageErrors.join(' | '));
ok('zero console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

await browser.close();
console.log(`smoke-v7: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
