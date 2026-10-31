// repro-user-flow.mjs — emulate the user's reported flow against the LOCAL dev
// worker, counting every network request. READ + WRITE on local dev only.
// Usage: node scripts/repro-user-flow.mjs
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';

const BASE = 'http://127.0.0.1:8080';
const SERVER = 'http://127.0.0.1:8787';
const AUTH_UI = '*SCRUBBED*<=';

const requests = [];
const consoleErrors = [];
const pageErrors = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

page.on('request', (r) => {
  const u = String(r.url());
  if (u.startsWith(SERVER)) {
    requests.push({ method: r.method(), url: u.replace(SERVER, '') });
  }
});
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));

function dumpReq(label) {
  const since = requests.slice(repro.mark);
  console.log(`\n>>> ${label}: ${since.length} requests`);
  const counts = {};
  for (const r of since) counts[r.method + ' ' + r.url.split('?')[0]] = (counts[r.method + ' ' + r.url.split('?')[0]] || 0) + 1;
  for (const [k, v] of Object.entries(counts)) console.log(`    ${v}x ${k}`);
  repro.mark = requests.length;
}
const repro = { mark: 0 };

async function unlockFlow() {
  await page.goto(BASE + '/?server=' + SERVER + '&setup=' + AUTH_UI);
  await page.waitForTimeout(500);
  await page.fill('#password', 'password');
  await page.click('button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
  await page.waitForTimeout(1500); // let initial sync settle
}

await unlockFlow();
dumpReq('UNLOCK + INITIAL SYNC');

// ---- create ONE simple event (the user's "saving ONE event") ----
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'Repro test event');
await page.click('button.button-primary:has-text("Save")');
await page.waitForTimeout(3000);
dumpReq('SAVE ONE EVENT (create + post-save syncAll)');

// ---- is it rendered? ----
const chipCount = await page.locator('.calendar-dayeventcell').count();
console.log('\nEvent chips rendered after save:', chipCount);

// ---- RELOAD: do events survive? (the "disappearing events" bug) ----
await page.reload();
await page.waitForTimeout(500);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(2500);
dumpReq('RELOAD + SYNC');
const chipCount2 = await page.locator('.calendar-dayeventcell').count();
console.log('Event chips rendered after reload:', chipCount2, chipCount2 === 0 ? '  <<<< DISAPPEARED!' : '');

// ---- manual Sync x3 (the "autosync freeze" complaint) ----
for (let i = 0; i < 3; i++) {
  await page.click('#btn-sync');
  await page.waitForTimeout(2500);
}
dumpReq('3x MANUAL SYNC');

const chipCount3 = await page.locator('.calendar-dayeventcell').count();
console.log('Event chips after 3 syncs:', chipCount3);

// ---- drag & drop ----
const chip = page.locator('.calendar-dayeventcell').first();
const box = await chip.boundingBox();
const target = await page.locator('.daygrid-rowevents').nth(1).boundingBox();
if (box && target) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width * 0.55, target.y + 10, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(2500);
}
dumpReq('DRAG & DROP ONE EVENT');
const chipCount4 = await page.locator('.calendar-dayeventcell').count();
console.log('Event chips after drag:', chipCount4);
await page.screenshot({ path: '/tmp/repro-after-drag.png' });

console.log('\n=== TOTAL requests:', requests.length, '===');
console.log('\n=== CONSOLE ERRORS (' + consoleErrors.length + ') ===');
for (const e of consoleErrors.slice(0, 20)) console.log('  ', e.slice(0, 300));
console.log('\n=== PAGE ERRORS (' + pageErrors.length + ') ===');
for (const e of pageErrors.slice(0, 20)) console.log('  ', e.slice(0, 300));

await browser.close();
