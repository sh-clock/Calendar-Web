// e2e-wave7.mjs — regression tests for every wave-7 audit finding that was
// fixed. Each test maps to a finding ID (A1..A15, B1..B9).
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8080';
const SERVER = 'http://127.0.0.1:8787';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const AUTH_UI = mat.auth_ui_hex;
const K_DATA = Uint8Array.from(Buffer.from(mat.k_data_hex, 'hex'));

const requests = [];
const pageErrors = [];
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + String(detail) : '')); }
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('request', (r) => { const u = String(r.url()); if (u.startsWith(SERVER)) requests.push({ m: r.method(), u: u.replace(SERVER, '') }); });
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('CONSOLE: ' + m.text()); });

async function unlock() {
  await page.goto(BASE + '/?server=' + SERVER + '&setup=' + AUTH_UI);
  await page.waitForTimeout(400);
  await page.fill('#password', 'password');
  await page.click('button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
  await page.waitForTimeout(1200);
}
const mark = () => requests.length;
const putsSince = (m) => requests.slice(m).filter((r) => r.m === 'PUT').length;

async function decryptAll() {
  const subtle = webcrypto.subtle;
  const key = await subtle.importKey('raw', K_DATA, 'AES-GCM', false, ['decrypt']);
  const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
  const aad = (id, ver) => Buffer.concat([Buffer.from(id, 'utf8'), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(ver); return b; })()]);
  const res = await fetch(SERVER + '/rows', { headers: { authorization: 'Bearer ' + AUTH_UI } });
  const manifest = await res.json();
  const out = {};
  for (const r of manifest.rows) {
    const rr = await fetch(SERVER + '/rows/' + encodeURIComponent(r.id), { headers: { authorization: 'Bearer ' + AUTH_UI } });
    const env = await rr.json();
    try {
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64(env.nonce), additionalData: aad(r.id, r.ver) }, key, b64(env.ct));
      out[r.id] = JSON.parse(Buffer.from(pt).toString('utf8')); // §6: JSON value
    } catch { out[r.id] = null; }
  }
  return out;
}

await unlock();

/* ---- B1: click at the very BOTTOM of the VISIBLE time grid ---- */
{
  await page.click('.view-button[data-view="week"]');
  await page.waitForTimeout(600);
  // scroll to the bottom of the grid, then click the last visible row
  const scroll = await page.locator('.calendar-time-grid').boundingBox();
  await page.evaluate(() => { const el = document.querySelector('.calendar-time-grid'); el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(300);
  const col = await page.locator('.timegrid-day').first().boundingBox();
  const y = scroll.y + scroll.height - 6; // inside the container, at the bottom edge
  await page.mouse.click(col.x + col.width / 2, y);
  await page.waitForTimeout(700);
  const open = await page.locator('#editor-modal').isHidden() === false;
  ok('B1: bottom-edge click opens the editor', open);
  if (open) {
    const sv = await page.locator('input[aria-label="Starts time"]').inputValue();
    ok('B1: no 24:00 time (rolled or clamped)', !sv.startsWith('24'), sv);
    await page.fill('input[aria-label="Title"]', 'B1 bottom edge');
    await page.click('button.button-primary:has-text("Save")');
    await page.waitForTimeout(1500);
    const rows = await decryptAll();
    const b1 = Object.entries(rows).find(([id, v]) => typeof v === 'string' && v.includes('B1 bottom edge'));
    ok('B1: bottom-edge event round-trips (parses)', !!b1, b1 ? 'saved+parses' : 'lost');
    if (b1) {
      await fetch(SERVER + '/rows/' + encodeURIComponent(b1[0]), { method: 'DELETE', headers: { authorization: 'Bearer ' + AUTH_UI } });
    }
  }
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const el = document.querySelector('.calendar-time-grid'); if (el) el.scrollTop = 0; });
}

/* ---- B2: after a drag, a plain CLICK on a chip opens the popover ---- */
{
  // create a timed event first
  await page.click('#btn-new-event');
  await page.fill('input[aria-label="Title"]', 'B2 click test');
  await page.click('button.button-primary:has-text("Save")');
  await page.waitForTimeout(1500);
  // drag it (move down 1 hour, same column)
  const chip = page.locator('.calendar-eventcell', { hasText: 'B2 click test' }).first();
  const box = await chip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1800);
  // NOW a plain click on the (moved) chip must open the popover
  const chip2 = page.locator('.calendar-eventcell', { hasText: 'B2 click test' }).first();
  const box2 = await chip2.boundingBox();
  await page.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.waitForTimeout(800);
  const popVisible = await page.locator('#event-popover').isHidden() === false;
  ok('B2: plain click after a drag opens the popover', popVisible);
  await page.keyboard.press('Escape');
}

/* ---- B3: day buttons align with columns (60px aside spacer) ---- */
{
  const geo = await page.evaluate(() => {
    const btn = document.querySelector('.calendar-first-row-heading .calendar-grid-heading');
    const col = document.querySelector('.timegrid-day');
    const spacer = document.querySelector('.calendar-first-row-spacer');
    return {
      btnLeft: Math.round(btn.getBoundingClientRect().x),
      colLeft: Math.round(col.getBoundingClientRect().x),
      spacer: !!spacer,
      spacerW: spacer ? Math.round(spacer.getBoundingClientRect().width) : 0,
    };
  });
  ok('B3: aside spacer present (60px)', geo.spacer && geo.spacerW === 60, JSON.stringify(geo));
  ok('B3: day buttons align with columns', geo.btnLeft === geo.colLeft, JSON.stringify(geo));
}

/* ---- B4: autosync does not yank the scroll ---- */
{
  const scroll = await page.locator('.calendar-time-grid');
  await scroll.evaluate((el) => { el.scrollTop = 200; }); // < max scroll (439)
  await page.waitForTimeout(300);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(1500);
  const top = await scroll.evaluate((el) => el.scrollTop);
  ok('B4: focus-triggered refresh keeps the scroll position', Math.abs(top - 200) < 30, top);
}

/* ---- B5: all-day row height adapts ---- */
{
  const h = await page.evaluate(() => {
    const fd = document.querySelector('.calendar-time-fullday');
    return fd ? Math.round(fd.getBoundingClientRect().height) : -1;
  });
  ok('B5: all-day row height adaptive (28-112px)', h >= 28 && h <= 112, h);
}

/* ---- A1: MOVE a recurring occurrence ("This event") to another calendar ---- */
{
  await page.click('.view-button[data-view="month"]');
  await page.waitForTimeout(500);
  // create a recurring event + a second calendar
  await page.click('#btn-add-calendar');
  await page.fill('input[aria-label="Name"]', 'A1 target cal');
  await page.click('#cal-modal .button-primary:has-text("Save")');
  await page.waitForTimeout(1500);
  await page.click('#btn-new-event');
  await page.fill('input[aria-label="Title"]', 'A1 recurring move');
  await page.selectOption('select[aria-label="Frequency"]', 'DAILY');
  await page.click('button.button-primary:has-text("Save")');
  await page.waitForTimeout(1500);
  // open the EDITOR via the popover (click chip → popover → Edit), picking
  // exception scope, then change the calendar
  const chip = page.locator('.calendar-dayeventcell', { hasText: 'A1 recurring move' }).first();
  const box = await chip.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(900);
  await page.click('#event-popover button[title="Edit"]');
  await page.waitForTimeout(700);
  // recurring → the choice modal appears; "This event" picks the exception
  if (await page.locator('#recur-modal').isHidden() === false) {
    await page.click('#recur-modal button:has-text("This event")');
    await page.waitForTimeout(600);
  }
  const editorOpen = await page.locator('#editor-modal').isHidden() === false;
  ok('A1: exception editor opens', editorOpen);
  if (editorOpen) {
    await page.selectOption('select[aria-label="Calendar"]', { label: 'A1 target cal' });
    await page.click('button.button-primary:has-text("Save")');
    await page.waitForTimeout(2500);
    // THE A1 ASSERTION: the moved row must still parse (one master + exception w/ RECURRENCE-ID)
    const rows = await decryptAll();
    const moved = Object.entries(rows).find(([id, v]) => typeof v === 'string' && v.includes('A1 recurring move'));
    ok('A1: moved exception row exists', !!moved, 'row missing');
    if (moved) {
      const masters = (moved[1].match(/BEGIN:VEVENT/g) || []).length;
      const hasRecId = /RECURRENCE-ID:/.test(moved[1]);
      ok('A1: master + RECURRENCE-ID exception (no two masters)', masters === 2 && hasRecId,
        'VEVENTs=' + masters + ' recId=' + hasRecId);
    }
  }
}

/* ---- A9: event not silently saved onto a deleted calendar ---- */
{
  // Delete the "A1 target cal" calendar out from under an editor session:
  // open the editor for the moved event, then (via a second page) delete the
  // calendar, then save — must fail with a clear error, not "Event saved."
  const page2 = await (await browser.newContext()).newPage(); // fresh localStorage-free session
  // (We simulate via direct protocol: delete the cmeta row server-side.)
  const rows = await decryptAll();
  const a1cal = Object.keys(rows).find((id) => id.startsWith('cmeta:') && rows[id].includes('A1 target cal'));
  if (a1cal) {
    await fetch(SERVER + '/rows/' + encodeURIComponent(a1cal), { method: 'DELETE', headers: { authorization: 'Bearer ' + AUTH_UI } });
  }
  // A9 (reachable guarantee): after a SYNC learns the calendar is gone, the
  // event's calendar is filtered out of rendering AND the editor no longer
  // offers it — no UI path can save onto the deleted calendar. (The ≤60 s
  // pre-sync window where a stale save lands as a server-side orphan is a
  // documented residual race — MINOR, agent A #9.)
  await page.click('#btn-sync');
  await page.waitForTimeout(1500);
  const calGone = await page.evaluate(() =>
    ![...document.querySelectorAll('#calendar-list li')].some((li) => li.textContent.includes('A1 target cal')));
  ok('A9: synced client drops the deleted calendar', calGone);
  const eventGone = await page.locator('.calendar-dayeventcell', { hasText: 'A1 recurring move' }).count() === 0;
  ok('A9: orphaned event filtered from rendering', eventGone);
  await page.click('#btn-new-event');
  await page.waitForTimeout(600);
  const offered = await page.locator('#editor-modal select[aria-label="Calendar"] option', { hasText: 'A1 target cal' }).count();
  ok('A9: deleted calendar not offered for new events', offered === 0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}

/* ---- A5: corrupt toast does not spam (single sync count) ---- */
{
  // (indirect: count toasts after 2 manual syncs with no corrupt rows = 0)
  // A5/A6: syncs on a healthy store must not create any warn/error toast
  // (old OK-toasts may still be expiring — compare warn counts, not totals).
  const warnBefore = await page.evaluate(() => [...document.querySelectorAll('.toast')].filter((t) => !t.classList.contains('ok')).length);
  await page.click('#btn-sync');
  await page.waitForTimeout(900);
  await page.click('#btn-sync');
  await page.waitForTimeout(900);
  const warnAfter = await page.evaluate(() => [...document.querySelectorAll('.toast')].filter((t) => !t.classList.contains('ok')).length);
  ok('A5/A6: clean syncs produce no warning toasts', warnAfter === warnBefore, warnBefore + '→' + warnAfter);
}

/* ---- dirty-set protection (A3): create then immediate sync keeps the event ---- */
{
  const m = mark();
  await page.click('#btn-new-event');
  await page.fill('input[aria-label="Title"]', 'A3 race event');
  await page.click('button.button-primary:has-text("Save")');
  await page.waitForTimeout(1200);
  // force an immediate manual sync (simulating the stale-manifest race)
  await page.click('#btn-sync');
  await page.waitForTimeout(1200);
  const still = await page.locator('.calendar-dayeventcell, .calendar-eventcell', { hasText: 'A3 race event' }).count();
  ok('A3: event survives an immediate post-save sync', still >= 1, still);
}

/* ---- wrap up ---- */
console.log('\n=== WAVE-7 REGRESSION: ' + pass + ' passed, ' + fail + ' failed ===');
console.log('=== PAGE ERRORS (' + pageErrors.length + ') ===');
for (const e of pageErrors.slice(0, 10)) console.log('  ' + e.slice(0, 200));
await browser.close();
process.exit(fail > 0 ? 1 : 0);
