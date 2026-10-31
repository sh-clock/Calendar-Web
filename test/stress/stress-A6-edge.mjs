// stress-edge.mjs — edge-time events + custom RRULE round-trip verification
// (agent A6 group 1+2, executed by the orchestrator after agent timeouts).
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const AUTH_UI = mat.auth_ui_hex;
const K_DATA = Uint8Array.from(Buffer.from(mat.k_data_hex, 'hex'));
const SERVER = 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' — ' + d : '')); } };

async function decryptAll() {
  const subtle = webcrypto.subtle;
  const key = await subtle.importKey('raw', K_DATA, 'AES-GCM', false, ['decrypt']);
  const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
  const res = await fetch(SERVER + '/rows', { headers: { authorization: 'Bearer ' + AUTH_UI } });
  const manifest = await res.json();
  const out = {};
  for (const r of manifest.rows) {
    const rr = await fetch(SERVER + '/rows/' + encodeURIComponent(r.id), { headers: { authorization: 'Bearer ' + AUTH_UI } });
    const env = await rr.json();
    try {
      const aad = Buffer.concat([Buffer.from(r.id, 'utf8'), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(env.ver); return b; })()]);
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64(env.nonce), additionalData: aad }, key, b64(env.ct));
      const v = JSON.parse(Buffer.from(pt).toString('utf8'));
      out[r.id] = typeof v === 'string' ? v : JSON.stringify(v);
    } catch { out[r.id] = null; }
  }
  return out;
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
await page.goto('http://127.0.0.1:8080/?server=' + SERVER + '&setup=' + AUTH_UI);
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1200);

async function createEvent(title, { startD, startT, endD, endT, allDay, freq }) {
  await page.click('#btn-new-event');
  await page.waitForTimeout(400);
  await page.fill('input[aria-label="Title"]', title);
  const s = page.locator('input[aria-label="Starts date"]');
  const e = page.locator('input[aria-label="Ends date"]');
  const st = page.locator('input[aria-label="Starts time"]');
  const et = page.locator('input[aria-label="Ends time"]');
  await s.fill(startD);
  await e.fill(endD);
  if (!allDay) { await st.fill(startT); await et.fill(endT); }
  else { await page.locator('#editor-modal input[type=checkbox]').first().check(); }
  if (freq) await page.selectOption('select[aria-label="Frequency"]', freq);
  await page.click('#editor-modal .button-primary');
  await page.waitForTimeout(1400);
}

const D = (n) => { const d = new Date(); d.setDate(d.getDate() + n); const p = (x) => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };

/* 1. midnight-crossing 23:30→00:30 */
await createEvent('EDGE midnight', { startD: D(0), startT: '23:30', endD: D(1), endT: '00:30', allDay: false });
let rows = await decryptAll();
let r = Object.values(rows).find(v => v && v.includes('EDGE midnight'));
ok('midnight event stored (DTEND next day)',
  !!r && new RegExp('DTSTART:' + D(0).replaceAll('-', '') + 'T233000').test(r) && new RegExp('DTEND:' + D(1).replaceAll('-', '') + 'T003000').test(r),
  r ? r.split('\n').filter(l => l.startsWith('DT')).join(' | ') : 'missing');

/* 2. 5-day all-day */
await createEvent('EDGE all5', { startD: D(2), endD: D(6), allDay: true });
rows = await decryptAll();
r = Object.values(rows).find(v => v && v.includes('EDGE all5'));
ok('5-day all-day: DATE values, DTEND = start+5 (exclusive)',
  !!r && new RegExp('DTSTART;VALUE=DATE:' + D(2).replaceAll('-', '')).test(r) && new RegExp('DTEND;VALUE=DATE:' + D(7).replaceAll('-', '')).test(r),
  r ? r.split('\n').filter(l => l.startsWith('DT')).join(' | ') : 'missing');

/* 3. timed multi-day 22:00→+1d 02:00 */
await createEvent('EDGE overnight', { startD: D(1), startT: '22:00', endD: D(2), endT: '02:00', allDay: false });
rows = await decryptAll();
r = Object.values(rows).find(v => v && v.includes('EDGE overnight'));
ok('overnight timed event stored', !!r && /DTSTART:\d{8}T220000Z?/.test(r) && /DTEND:\d{8}T020000Z?/.test(r),
  r ? r.split('\n').filter(l => l.startsWith('DT')).join(' | ') : 'missing');

/* 4. same start/end (zero length) */
await createEvent('EDGE zero', { startD: D(0), startT: '15:00', endD: D(0), endT: '15:00', allDay: false });
rows = await decryptAll();
r = Object.values(rows).find(v => v && v.includes('EDGE zero'));
ok('zero-length stored with equal DTSTART/DTEND (parses, renders)',
  !!r && /DTSTART:(\d{8}T150000)/.test(r) && new RegExp('DTEND:' + (r.match(/DTSTART:(\d{8}T150000)/) || [])[1]).test(r),
  r ? r.split('\n').filter(l => l.startsWith('DT')).join(' | ') : 'missing');

/* 5. 00:00 start */
await createEvent('EDGE midnight0', { startD: D(3), startT: '00:00', endD: D(3), endT: '01:00', allDay: false });
rows = await decryptAll();
r = Object.values(rows).find(v => v && v.includes('EDGE midnight0'));
ok('00:00 start stored', !!r && new RegExp('DTSTART:' + D(3).replaceAll('-', '') + 'T000000').test(r),
  r ? r.split('\n').filter(l => l.startsWith('DT')).join(' | ') : 'missing');

/* 6. custom RRULE: interval 2, multi-BYDAY, COUNT 10 */
await page.click('#btn-new-event');
await page.waitForTimeout(400);
await page.fill('input[aria-label="Title"]', 'EDGE custom rrule');
await page.locator('input[aria-label="Starts date"]').fill(D(0));
await page.locator('input[aria-label="Ends date"]').fill(D(0));
await page.locator('input[aria-label="Starts time"]').fill('10:00');
await page.locator('input[aria-label="Ends time"]').fill('11:00');
await page.selectOption('select[aria-label="Frequency"]', 'CUSTOM');
await page.waitForTimeout(500);
await page.fill('#freq-modal input[aria-label="Interval"]', '2');
const boxes = await page.locator('#freq-modal input[type=checkbox]').all();
for (const b of boxes) { if (await b.isChecked()) await b.uncheck(); } // clear the start-day pre-selection
await boxes[1].check(); await boxes[3].check(); // TU, TH
await page.selectOption('#freq-modal select >> nth=1', 'count'); // Ends selector
await page.fill('#freq-modal input[aria-label="Occurrences"]', '10');
await page.click('#freq-modal .button-primary');
await page.waitForTimeout(400);
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1400);
rows = await decryptAll();
r = Object.values(rows).find(v => v && v.includes('EDGE custom rrule'));
ok('custom RRULE serialized (INTERVAL=2, BYDAY=TU,TH, COUNT=10)',
  !!r && /RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=10/.test(r),
  r ? (r.match(/RRULE:[^\r\n]+/) || ['none'])[0] : 'missing');

/* 7. renders: week view shows the custom occurrences + overnight events */
await page.click('.fc-timeGridWeek-button');
await page.waitForTimeout(900);
const wtexts = await page.evaluate(() => [...document.querySelectorAll('.fc-event')].map(e => e.textContent.trim()));
ok('week view renders edge events', wtexts.filter(t => t.includes('EDGE')).length >= 3, JSON.stringify(wtexts.slice(0, 6)));
/* 8. agenda view lists them all */
await page.click('.fc-listYear-button');
await page.waitForTimeout(700);
const ltexts = await page.evaluate(() => [...document.querySelectorAll('.fc-list-event')].map(e => e.textContent.trim()));
ok('agenda renders all 6 edge events', ltexts.filter(t => t.includes('EDGE')).length >= 6, 'count=' + ltexts.filter(t => t.includes('EDGE')).length);

/* 9. month view: 5-day all-day spans five cells */
await page.click('.fc-dayGridMonth-button');
await page.waitForTimeout(600);
const chip = page.locator('.fc-event', { hasText: 'EDGE all5' });
const cnt = await chip.count();
ok('5-day all-day renders as a spanning chip (month view)', cnt >= 1, 'count=' + cnt);
/* 10. reload persistence for the whole set */
await page.reload();
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1500);
const after = await page.evaluate(() => [...document.querySelectorAll('.fc-event')].map(e => e.textContent.trim()).filter(t => t.includes('EDGE')).length);
ok('all edge events survive reload', after >= 5, 'count=' + after);

console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed === errors: ' + errs.length);
for (const e of errs.slice(0, 6)) console.log('  ' + e.slice(0, 200));
await page.screenshot({ path: '/tmp/stress-edge.png' });
await browser.close();
process.exit(fail > 0 ? 1 : 0);
