// probe-xss.mjs — S5 client-side XSS audit.
// Writes CRAFTED encrypted rows (evt:sec-S5:*, cmeta for an S5 calendar) on the
// disposable A6 stack (8788), then drives the real client (8081) with Playwright:
// injects HTML/JS payloads into SUMMARY / DESCRIPTION / LOCATION / calendar NAME /
// custom RRULE, renders every sink (grid chip, popover, editor prefill, freq-modal
// label, task checkbox, agenda list, calendar-list, local-first cache reload) and
// checks window.__xss for execution. Also verifies payloads render as TEXT.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = process.env.S5_BASE || 'http://127.0.0.1:8081';
const SERVER = process.env.S5_SERVER || 'http://127.0.0.1:8788';
const MAT = JSON.parse(readFileSync(process.env.S5_MAT || '/tmp/local-material-2.json', 'utf8'));
const AUTH_UI = MAT.auth_ui_hex;
const K_DATA = Uint8Array.from(Buffer.from(MAT.k_data_hex, 'hex'));

// pre-flight: is the worker alive? (concurrent agents pkill workerd between runs)
try {
  const pf = await fetch(SERVER + '/config', { headers: { authorization: 'Bearer ' + AUTH_UI } });
  if (!pf.ok) throw new Error('status ' + pf.status);
} catch (e) {
  console.log('WORKER-DIED before start: ' + e);
  process.exit(2);
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
};

/* ---------- row writer (mirrors test/stress/_lib.mjs putRawRow) ---------- */
const subtle = webcrypto.subtle;
const ROW_KEY = await subtle.importKey('raw', K_DATA, 'AES-GCM', false, ['encrypt', 'decrypt']);
const aadFor = (id, ver) =>
  Buffer.concat([Buffer.from(id, 'utf8'), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(ver); return b; })()]);
async function putRawRow(id, payloadText, ver) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const pt = JSON.stringify(payloadText);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadFor(id, ver) }, ROW_KEY,
    new Uint8Array(Buffer.from(pt, 'utf8')));
  const res = await fetch(SERVER + '/rows/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + AUTH_UI, 'content-type': 'application/json' },
    body: JSON.stringify({ ver, nonce: Buffer.from(iv).toString('base64'), ct: Buffer.from(ct).toString('base64') }),
  });
  return res.status;
}

/* ---------- crafted payloads ---------- */
const P = {
  imgSummary: `<img src=x onerror="window.__xss.push('summary-img')">`,
  svgBreakout: `"><svg onload=window.__xss.push('summary-svg')>`,
  quoteOnclick: `x' onclick='window.__xss.push(42)`,
  jsLocation: `javascript:window.__xss.push('loc-js-url')`,
  descPayload: `<iframe srcdoc="&lt;script&gt;window.__xss.push('iframe-srcdoc')&lt;/script&gt;"></iframe><img src=x onerror=window.__xss.push('desc-img')>`,
  taskSummary: `<img src=x onerror=window.__xss.push('task-img')">`,
  calName: `<img src=x onerror=window.__xss.push('calname')"><b>S5</b>`,
};
const CAL = '11111111-2222-3333-4444-555555555555';

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const today = new Date().toISOString().slice(0, 10);
const d = (off) => addDays(today, off).replaceAll('-', '');

function ics({ type = 'VEVENT', uid, day, summary, description = null, location = null, rrule = null, status = null }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//sec-S5//xss//EN',
    'BEGIN:' + type, 'UID:' + uid, 'DTSTAMP:20260101T000000Z',
    'DTSTART:' + day + 'T100000Z'];
  if (type === 'VEVENT') lines.push('DTEND:' + day + 'T110000Z');
  if (rrule) lines.push('RRULE:' + rrule);
  lines.push('SUMMARY:' + summary);
  if (description) lines.push('DESCRIPTION:' + description);
  if (location) lines.push('LOCATION:' + location);
  if (status) lines.push('STATUS:' + status);
  lines.push('END:' + type, 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

console.log('== planting crafted rows on ' + SERVER + ' ==');
ok('cmeta row (XSS calendar name) PUT ok',
  [200, 201].includes(await putRawRow('cmeta:' + CAL, JSON.stringify({ v: 1, name: P.calName, color: '#8080FF' }), 1)));
ok('evt sec-S5-1 (img summary)',
  [200, 201].includes(await putRawRow('evt:' + CAL + ':sec-S5-1', ics({ uid: 'sec-S5-1', day: d(0), summary: P.imgSummary }), 1)));
ok('evt sec-S5-2 (svg breakout summary)',
  [200, 201].includes(await putRawRow('evt:' + CAL + ':sec-S5-2', ics({ uid: 'sec-S5-2', day: d(1), summary: P.svgBreakout }), 1)));
ok('evt sec-S5-3 (quote summary + js: location + desc iframe/img)',
  [200, 201].includes(await putRawRow('evt:' + CAL + ':sec-S5-3', ics({
    uid: 'sec-S5-3', day: d(2), summary: P.quoteOnclick,
    description: P.descPayload, location: P.jsLocation }), 1)));
ok('evt sec-S5-4 (VTODO task img summary)',
  [200, 201].includes(await putRawRow('evt:' + CAL + ':sec-S5-4', ics({ type: 'VTODO', uid: 'sec-S5-4', day: d(3), summary: P.taskSummary }), 1)));
ok('evt sec-S5-5 (custom RRULE label)',
  [200, 201].includes(await putRawRow('evt:' + CAL + ':sec-S5-5', ics({
    uid: 'sec-S5-5', day: d(4), summary: 'recur custom', rrule: 'FREQ=WEEKLY;INTERVAL=3;BYDAY=TU' }), 1)));

/* ---------- drive the real client ---------- */
const browser = await chromium.launch({ args: ['--disable-web-security'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.addInitScript(() => { window.__xss = []; });
const page = await ctx.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto(BASE + '/#server=' + SERVER + '&setup=' + AUTH_UI);
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
try {
  await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
} catch {
  const srvMsg = await page.textContent('#login-msg').catch(() => '');
  console.log('WORKER-DIED mid-run (unlock failed): ' + srvMsg);
  await browser.close(); process.exit(2);
}
await page.waitForSelector('#calendar [data-date]', { timeout: 20000 });
await page.waitForTimeout(2000); // sync + render

const xss = () => page.evaluate(() => window.__xss);
const overlaysClosed = () => page.evaluate(() => {
  for (const id of ['popover-backdrop', 'editor-backdrop', 'recur-backdrop', 'cal-backdrop', 'freq-backdrop', 'settings-backdrop']) {
    const b = document.getElementById(id);
    if (b && !b.hidden) return false;
  }
  return document.getElementById('event-popover').hidden;
});
async function closeOverlays() {
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  // belt & braces: clear any stray popover surface state the app left
  await page.evaluate(() => { const b = document.getElementById('popover-backdrop'); if (b) b.hidden = true; });
}

/* --- 1. grid render (month view chips) --- */
ok('month grid: no payload executed', (await xss()).length === 0, JSON.stringify(await xss()));
ok('month grid: no <img> element injected', await page.evaluate(() => document.images.length) === 0);
ok('chip renders payload as TEXT', await page.evaluate((t) => {
  return [...document.querySelectorAll('.fc-event')].some((e) => e.textContent.includes(t));
}, 'summary-img'));

/* --- 2. calendar-list (sidebar) --- */
ok('sidebar calendar name rendered as text', await page.evaluate((t) => {
  const n = document.querySelector('#calendar-list .cal-name');
  return !!n && n.textContent === t && !n.querySelector('img,b,svg');
}, P.calName));
ok('sidebar: no XSS from calendar name', (await xss()).length === 0);

/* --- 3. popover --- */
async function clickChipByText(t) {
  const box = await page.evaluate((tt) => {
    const el = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes(tt));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 10) };
  }, t);
  if (!box) throw new Error('chip not found: ' + t);
  await page.mouse.click(box.x, box.y);
}
// E1: title-only checks
await clickChipByText('summary-img');
await page.waitForSelector('#event-popover:not([hidden])', { timeout: 5000 });
await page.waitForTimeout(300);
ok('popover: title is TEXT (textContent === payload)', await page.evaluate((t) => {
  const h = document.querySelector('#event-popover .eventpopover-title');
  return !!h && h.textContent === t;
}, P.imgSummary));
ok('popover: no iframe/img injected', await page.evaluate(() =>
  document.querySelectorAll('#event-popover iframe, #event-popover img').length === 0));
ok('popover: no payload executed', (await xss()).length === 0);
await closeOverlays();
ok('overlays closed before next step', await overlaysClosed());

// E3: location + description rows
await clickChipByText('push(42)');
await page.waitForSelector('#event-popover:not([hidden])', { timeout: 5000 });
await page.waitForTimeout(300);
ok('popover: location javascript: URL shown as text', await page.evaluate((t) => {
  return [...document.querySelectorAll('#event-popover .popover-iconrow .content')].some((c) => c.textContent === t);
}, P.jsLocation));
ok('popover: description payload shown as text', await page.evaluate(() => {
  return [...document.querySelectorAll('#event-popover .popover-iconrow .content')].some((c) => c.textContent.includes('iframe srcdoc'));
}));
ok('popover (E3): no payload executed', (await xss()).length === 0);

/* --- 4. editor prefill (E3 has all fields) --- */
await page.click('#event-popover .eventpopover-actions button[title="Edit"]');
await page.waitForSelector('#editor-modal:not([hidden])', { timeout: 5000 });
await page.waitForTimeout(300);
ok('editor: title input VALUE is the literal payload (no attribute breakout)', await page.evaluate((t) => {
  const i = document.querySelector('#editor-modal input[type=text]');
  return !!i && i.value === t && !i.getAttribute('onclick');
}, P.quoteOnclick));
ok('editor: location input value = javascript: string (inert)', await page.evaluate((t) => {
  const ins = [...document.querySelectorAll('#editor-modal input[type=text]')];
  return ins.some((i) => i.value === t);
}, P.jsLocation));
ok('editor: description textarea holds payload as text', await page.evaluate(() => {
  const ta = document.querySelector('#editor-modal textarea');
  return !!ta && ta.value.includes('iframe srcdoc') && ta.value.includes('desc-img');
}));
ok('editor: no payload executed', (await xss()).length === 0);
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('#editor-modal .modal-footer .button-ghost')].filter((b) => !b.classList.contains('left'));
  btns[btns.length - 1].click();
});
await page.waitForTimeout(300);
await closeOverlays();
ok('overlays closed before freq-modal step', await overlaysClosed());

/* --- 5. freq-modal CUSTOM label (recurring event) --- */
await clickChipByText('recur custom');
await page.waitForSelector('#event-popover:not([hidden])', { timeout: 5000 });
await page.click('#event-popover .eventpopover-actions button[title="Edit"]');
await page.waitForSelector('#recur-modal:not([hidden])', { timeout: 5000 });
await page.click('#recur-modal .recur-choices button:first-child'); // All events
await page.waitForSelector('#editor-modal:not([hidden])', { timeout: 5000 });
await page.waitForTimeout(300);
ok('editor freq select = CUSTOM', await page.evaluate(() => {
  const s = document.querySelector('#editor-modal select[aria-label="Frequency"]');
  return !!s && s.value === 'CUSTOM';
}));
ok('freq option label contains the raw rrule as text', await page.evaluate(() => {
  const s = document.querySelector('#editor-modal select[aria-label="Frequency"]');
  const o = [...(s ? s.options : [])].find((x) => x.value === 'CUSTOM');
  return !!o && o.textContent.includes('FREQ=WEEKLY;INTERVAL=3;BYDAY=TU');
}));
// also open the CUSTOM modal itself (initial rrule prefilled)
await page.selectOption('#editor-modal select[aria-label="Frequency"]', 'CUSTOM');
await page.waitForSelector('#freq-modal:not([hidden])', { timeout: 5000 }).catch(() => {});
ok('freq modal opened for the crafted rrule', await page.$('#freq-modal:not([hidden])') !== null);
await page.waitForTimeout(300);
ok('freq modal: no payload executed', (await xss()).length === 0);
await closeOverlays();

/* --- 6. task checkbox path (fc-task-check) --- */
await closeOverlays();
const taskChip = await page.evaluate(() => {
  const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('task-img'));
  const box = chip && chip.querySelector('.fc-task-check');
  return box ? true : false;
});
ok('task checkbox (.fc-task-check) present on task chip', taskChip);
const taskBox = await page.$('.fc-task-check');
await taskBox.click();
await page.waitForTimeout(1500); // RMW round-trip
const toasts = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent));
ok('task completion RMW succeeded (toast)', toasts.some((t) => t.includes('Task marked')), JSON.stringify(toasts));
ok('task checkbox path: no payload executed', (await xss()).length === 0);
ok('task row still renders (payload as text)', await page.evaluate((t) =>
  [...document.querySelectorAll('.fc-event')].some((e) => e.textContent.includes(t)), 'task-img'));
await closeOverlays();
ok('overlays closed before agenda step', await overlaysClosed());

/* --- 7. agenda (listYear) view --- */
await page.click('#calendar button[aria-label="Agenda view"]');
await page.waitForTimeout(900);
ok('agenda view: payload rendered as text rows', await page.evaluate((t) =>
  document.body.textContent.includes(t), 'summary-img'));
ok('agenda view: no payload executed', (await xss()).length === 0);

/* --- 8. reload → local-first cache path (hydrate + re-render) --- */
await page.reload();
await page.waitForTimeout(500);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(2500);
ok('after reload (cache hydrate): no payload executed', (await xss()).length === 0, JSON.stringify(await xss()));
ok('after reload: cache holds payload as plain JSON text', await page.evaluate(() => {
  const c = localStorage.getItem('clock_poc_cache_v45') || '';
  return c.includes('summary-img');
}));

/* --- 9. cleanup my rows (leave universe tidy) --- */
for (const id of ['evt:' + CAL + ':sec-S5-1', 'evt:' + CAL + ':sec-S5-2', 'evt:' + CAL + ':sec-S5-3',
  'evt:' + CAL + ':sec-S5-4', 'evt:' + CAL + ':sec-S5-5', 'cmeta:' + CAL]) {
  await fetch(SERVER + '/rows/' + encodeURIComponent(id), { method: 'DELETE', headers: { authorization: 'Bearer ' + AUTH_UI } }).catch(() => {});
}

ok('no console errors during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
ok('no page errors during the whole run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await page.screenshot({ path: '/tmp/s5-xss-final.png' }).catch(() => {});
await browser.close();
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
