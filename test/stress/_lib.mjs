// _lib.mjs — shared harness for the A6 stress scripts (report-only; no app edits).
//
// MIGRATED FullCalendar v6.1.22 → v7.1.3 (E2E-MIG-B):
//  * BASE 8081 / SERVER 8788 / material /tmp/local-material-2.json (dedicated stack).
//  * Chromium is launched with --disable-web-security: the local worker's
//    ALLOWED_ORIGIN allowlist (worker/.dev.vars — owned by the app, not editable
//    from tests) does not include http://127.0.0.1:8081, so a stock browser
//    would block every cross-origin fetch with a CORS preflight failure. The
//    flag is TEST-HARNESS ONLY: requests/responses pass through the worker
//    verbatim (no route interception, no body rewriting); the only difference
//    is that the browser does not enforce the (irrelevant, environment-level)
//    CORS check. Server-side integrity oracles are unaffected.
//  * v7 stable-DOM helpers below: the v7 production DOM uses hashed theme
//    classes (fc-monarch-XXX etc.), so structural v6 hooks are replaced by
//    data attributes + ARIA roles, all verified empirically against the
//    running app (see test/stress/probe-v7*.mjs):
//      - month-view day cells  : [role="cell"][data-date] (42, row-major)
//      - week/day day columns  : [role="columnheader"][data-date] (header row)
//                                + the TALL [role="cell"][data-date] columns
//      - time slots            : [data-time] (lanes = empty text, labels = hourly text)
//      - toolbar buttons       : aria-labels ("Previous Month", "Month view", ...)
//      - events                : .fc-event (the app puts the class on its EventInput)
//      - resizers              : hashed class extracted from the vendored bundle
//      - week-number cells     : [aria-label^="Go to Week"] (nav links)
//      - active view           : #calendar [role="tab"][aria-selected="true"]
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const BASE = 'http://127.0.0.1:8081';
export const SERVER = 'http://127.0.0.1:8788';
const REPO = '/home/z/my-project/calendar-web';
const MATERIAL_PATH = '/tmp/local-material-2.json';

/* ---------------- universe material ---------------- */

export function material() {
  return JSON.parse(readFileSync(MATERIAL_PATH, 'utf8'));
}
export const MAT = material();
export const AUTH_UI = MAT.auth_ui_hex;
const K_DATA = Uint8Array.from(Buffer.from(MAT.k_data_hex, 'hex'));

/** Re-bootstrap the universe (destructive) and refresh MAT. */
export function rebootstrap() {
  const vars = readFileSync(REPO + '/worker/.dev.vars', 'utf8');
  const env = {};
  for (const line of vars.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  execFileSync('node', ['test/api-suite.mjs', '--url', SERVER, '--material-out', MATERIAL_PATH], {
    cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  Object.assign(MAT, material());
  return MAT;
}

/* ---------------- assertion plumbing ---------------- */

export function makeTally() {
  let pass = 0;
  let fail = 0;
  const failures = [];
  const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else {
      fail++;
      failures.push(name);
      console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 400) : ''));
    }
  };
  return {
    ok, get pass() { return pass; }, get fail() { return fail; }, failures,
    summary() { return pass + ' passed, ' + fail + ' failed'; },
  };
}

const R = (n) => Math.round(n);

/* ---------------- FullCalendar v7 stable-DOM selectors ---------------- */

/** Toolbar buttons (v7 renders view-aware aria-labels; roles: button/tab). */
export const TOOLBAR = {
  prev: '#calendar button[aria-label^="Previous"]',
  next: '#calendar button[aria-label^="Next"]',
  today: '#calendar button[aria-label^="This"]', // "This Month"/"This Week"/…
  day: '#calendar button[aria-label="Day view"]',
  week: '#calendar button[aria-label="Week view"]',
  month: '#calendar button[aria-label="Month view"]',
  year: '#calendar button[aria-label="Year view"]',
  agenda: '#calendar button[aria-label="Agenda view"]',
  custom: '#calendar button[aria-label="Custom view"]',
};

/** aria-label of the active toolbar view tab → FullCalendar view id. */
const VIEW_ID_OF_LABEL = {
  'Day view': 'timeGridDay', 'Week view': 'timeGridWeek', 'Month view': 'dayGridMonth',
  'Year view': 'multiMonthYear', 'Agenda view': 'listYear', 'Custom view': 'custom',
};

/**
 * Hashed class of the END (bottom / right-edge) event resizer in THIS build,
 * extracted from the vendored bundle (v7 hashes the structural class names,
 * so the literal must be discovered, not hard-coded). Returns e.g. 'fc-lw'.
 */
let _RZ_END = null;
export function resizerEndClass() {
  if (_RZ_END !== null) return _RZ_END;
  const src = readFileSync(REPO + '/js/vendor/fullcalendar/v7/all.global.js', 'utf8');
  _RZ_END = (/"internalEventResizerEnd":"(fc-[A-Za-z0-9]+)"/.exec(src) || [])[1] || null;
  return _RZ_END;
}

/* ---------------- in-page v7 DOM helpers ---------------- *
 * Injected through page.evaluate(); keep them self-contained (no closures). */

const IN_PAGE = {
  /** Timed (timegrid-body) event chips: .fc-event whose closest [role=cell]
   *  is a TALL timegrid column (~1800px), i.e. not the short all-day cell. */
  timedChips: `() => {
    const isTimed = (el) => {
      const cell = el.closest('[role="cell"]');
      return !!cell && !!cell.getAttribute('data-date') && cell.getBoundingClientRect().height > 300;
    };
    return [...document.querySelectorAll('.fc-event')].filter(isTimed);
  }`,
  /** 48 (slotDuration-dependent) empty [data-time] lane strips. */
  lanes: `() => [...document.querySelectorAll('[data-time]')].filter((e) => !e.textContent.trim())`,
  /** px-per-30min-slot from the lane strip geometry (v6 .fc-timegrid-slot-lane math). */
  pxPerSlot: `() => {
    const lanes = [...document.querySelectorAll('[data-time]')].filter((e) => !e.textContent.trim());
    if (!lanes.length) return null;
    const first = lanes[0].getBoundingClientRect();
    const last = lanes[lanes.length - 1].getBoundingClientRect();
    return { firstY: first.y, pxPerSlot: (last.y + last.height - first.y) / lanes.length, n: lanes.length };
  }`,
};

/** Month-view day cells covered GEOMETRICALLY by a chip containing `title`
 *  (v6: .fc-daygrid-day × .fc-daygrid-day .fc-event containment/overlap). */
export function monthDaysContaining(page, title) {
  return page.evaluate((t) => {
    const chips = [...document.querySelectorAll('[role="cell"][data-date] .fc-event')]
      .filter((e) => e.textContent.includes(t)).map((e) => e.getBoundingClientRect());
    const days = [];
    for (const cell of document.querySelectorAll('[role="cell"][data-date]')) {
      const d = cell.getAttribute('data-date');
      const r = cell.getBoundingClientRect();
      if (chips.some((c) => c.x < r.x + r.width - 2 && c.x + c.width > r.x + 2 && c.y < r.y + r.height && c.y + c.height > r.y)) days.push(d);
    }
    return days;
  }, title);
}

/** Timed chips in the week/day-view column of `date` whose text contains
 *  `title` (v6: .fc-timegrid-event × .fc-col-header-cell x-overlap), with
 *  slot geometry (topSlots measured from the first lane). */
export function columnTimedChips(page, date, title) {
  return page.evaluate(({ d, t }) => {
    const lanes = [...document.querySelectorAll('[data-time]')].filter((e) => !e.textContent.trim());
    if (!lanes.length) return [];
    const first = lanes[0].getBoundingClientRect();
    const last = lanes[lanes.length - 1].getBoundingClientRect();
    const pxPerSlot = (last.y + last.height - first.y) / lanes.length;
    const col = [...document.querySelectorAll('[role="columnheader"]')].find((c) => c.getAttribute('data-date') === d);
    const colR = col ? col.getBoundingClientRect() : null;
    const isTimed = (el) => {
      const cell = el.closest('[role="cell"]');
      return !!cell && !!cell.getAttribute('data-date') && cell.getBoundingClientRect().height > 300;
    };
    return [...document.querySelectorAll('.fc-event')]
      .filter((e) => isTimed(e) && e.textContent.includes(t) &&
        (!colR || (e.getBoundingClientRect().x + e.getBoundingClientRect().width > colR.x && e.getBoundingClientRect().x < colR.x + colR.width)))
      .map((e) => {
        const r = e.getBoundingClientRect();
        return {
          x: r.x + r.width / 2, y: r.y + r.height / 2,
          topSlots: (r.y - first.y) / pxPerSlot, heightSlots: r.height / pxPerSlot,
          pxPerSlot, text: e.textContent.trim(),
        };
      });
  }, { d: date, t: title });
}

/** Slot geometry of the single timed chip with `title` in the current
 *  timegrid view (v6 chipGeom): { topSlots, heightSlots, text } | null. */
export async function chipGeom(page, title) {
  const chips = await columnTimedChips(page, null, title);
  return chips.length ? chips[0] : null;
}

/** Active FullCalendar view id ("dayGridMonth", "timeGridWeek", …). */
export function activeViewType(page) {
  return page.evaluate((map) => {
    const t = document.querySelector('#calendar [role="tab"][aria-selected="true"]');
    return map[t?.getAttribute('aria-label') || ''] || t?.getAttribute('aria-label') || '?';
  }, VIEW_ID_OF_LABEL);
}

/* ---------------- browser harness ---------------- */

export async function harness({ viewport = { width: 1440, height: 900 } } = {}) {
  // NOTE: --disable-web-security — see the header comment. Harness-only.
  const browser = await chromium.launch({ args: ['--disable-web-security'] });
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();

  const requests = [];
  const pageErrors = [];
  const consoleErrors = [];
  page.on('request', (r) => {
    const u = String(r.url());
    if (u.startsWith(SERVER)) requests.push({ m: r.method(), u: u.replace(SERVER, ''), t: Date.now() });
  });
  page.on('pageerror', (e) => pageErrors.push(String((e && e.stack) || e)));
  page.on('console', (m) => {
    if (m.type() === 'error') {
      // favicon 404 is a static-server artifact, not an app error
      if (m.text().includes('/favicon.ico')) return;
      consoleErrors.push(m.text());
    }
  });

  const mark = () => requests.length;
  const since = (m) => requests.slice(m);
  const puts = (arr) => arr.filter((r) => r.m === 'PUT').length;

  /** Unlock, re-bootstrapping the universe once if the token went stale. */
  async function unlock() {
    await page.goto(BASE + '/#server=' + SERVER + '&setup=' + MAT.auth_ui_hex);
    await page.waitForTimeout(400);
    await page.fill('#password', 'password');
    await page.click('button[type=submit]');
    try {
      await page.waitForSelector('#app:not([hidden])', { timeout: 25000 });
    } catch {
      console.log('  ..   unlock failed — universe may have been re-bootstrapped by a parallel agent; re-bootstrapping and retrying');
      rebootstrap();
      await page.goto(BASE + '/#server=' + SERVER + '&setup=' + MAT.auth_ui_hex);
      await page.waitForTimeout(400);
      await page.fill('#password', 'password');
      await page.click('button[type=submit]');
      await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
    }
    await page.waitForTimeout(1400); // first sync + default-calendar bootstrap
  }

  const shot = (name) => page.screenshot({ path: '/tmp/stress-' + name + '.png' }).catch(() => {});

  return {
    browser, ctx, page, requests, pageErrors, consoleErrors,
    mark, since, puts, unlock, shot, R,
    TOOLBAR, monthDaysContaining, columnTimedChips, chipGeom, activeViewType,
    async close() { await browser.close(); },
  };
}

/* ---------------- server-side row decryption (integrity oracle) ---------------- */

const subtle = webcrypto.subtle;
let ROW_KEY = null;
async function rowKey() {
  if (!ROW_KEY) ROW_KEY = await subtle.importKey('raw', K_DATA, 'AES-GCM', false, ['decrypt', 'encrypt']);
  return ROW_KEY;
}
const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
export const aadFor = (id, ver) =>
  Buffer.concat([Buffer.from(id, 'utf8'), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(ver); return b; })()]);

/** GET+decrypt every row: { [id]: plaintext } (null when undecryptable). */
export async function decryptAll() {
  const key = await rowKey();
  const res = await fetch(SERVER + '/rows', { headers: { authorization: 'Bearer ' + MAT.auth_ui_hex } });
  const manifest = await res.json();
  const out = {};
  for (const r of manifest.rows) {
    const rr = await fetch(SERVER + '/rows/' + encodeURIComponent(r.id), { headers: { authorization: 'Bearer ' + MAT.auth_ui_hex } });
    if (!rr.ok) { out[r.id] = null; continue; }
    const env = await rr.json();
    try {
      const pt = await subtle.decrypt(
        { name: 'AES-GCM', iv: b64(env.nonce), additionalData: aadFor(r.id, env.ver) }, key, b64(env.ct));
      const raw = Buffer.from(pt).toString('utf8');
      // The client's encryptRow wraps payloads as JSON.stringify(payload) —
      // a decrypted row plaintext is a JSON string literal (crypto.js L168).
      let text = raw;
      try { const j = JSON.parse(raw); if (typeof j === 'string') text = j; } catch { /* raw payload */ }
      out[r.id] = text;
    } catch { out[r.id] = null; }
  }
  return out;
}

/** Encrypt+PUT a raw payload as a row (for adversarial writes).
 *  Mirrors crypto.js encryptRow: plaintext = JSON.stringify(payload) —
 *  unless { wrap: false } (raw bytes: decryptRow's JSON.parse then throws). */
export async function putRawRow(id, text, ver, { wrap = true } = {}) {
  const key = await rowKey();
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const pt = wrap ? JSON.stringify(text) : text;
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadFor(id, ver) }, key,
    new Uint8Array(Buffer.from(pt, 'utf8')));
  const body = {
    ver,
    nonce: Buffer.from(iv).toString('base64'),
    ct: Buffer.from(ct).toString('base64'),
  };
  const res = await fetch(SERVER + '/rows/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + MAT.auth_ui_hex, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

export async function deleteRawRow(id) {
  const res = await fetch(SERVER + '/rows/' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: { authorization: 'Bearer ' + MAT.auth_ui_hex },
  });
  return res.status;
}

export async function getRawRow(id) {
  const res = await fetch(SERVER + '/rows/' + encodeURIComponent(id), {
    headers: { authorization: 'Bearer ' + MAT.auth_ui_hex },
  });
  return { status: res.status, body: res.ok ? await res.json() : null };
}

/* ---------------- ical helpers (over decrypted text) ---------------- */

/** Unfold RFC 5545 continuation lines → array of logical lines. */
export function unfold(text) {
  const out = [];
  for (const raw of text.split('\r\n')) {
    if (raw.startsWith(' ') || raw.startsWith('\t')) out[out.length - 1] += raw.slice(1);
    else out.push(raw);
  }
  return out.filter((l) => l.length > 0);
}

/** Find the evt row whose SUMMARY (ANY VEVENT block) matches; returns
 *  {id, text, lines, dt: props}. Master/exception rows have several SUMMARYs. */
export function findEvt(rows, summaryContains) {
  for (const [id, text] of Object.entries(rows)) {
    if (!id.startsWith('evt:') || !text) continue;
    const lines = unfold(text);
    const sums = lines.filter((l) => l.startsWith('SUMMARY:'));
    if (!sums.some((s) => s.slice(8).includes(summaryContains))) continue;
    const prop = (name) => lines.find((l) => l.startsWith(name + ':') || l.startsWith(name + ';'));
    return {
      id, text, lines,
      dtstart: prop('DTSTART'), dtend: prop('DTEND'),
      rrule: prop('RRULE'), exdate: lines.filter((l) => l.startsWith('EXDATE')),
      recId: prop('RECURRENCE-ID'),
      uid: prop('UID'),
    };
  }
  return null;
}

/** All VEVENT blocks of a row (for exception/EXDATE analysis). */
export function veventsOf(row) {
  const lines = unfold(row.text);
  const blocks = [];
  let cur = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') cur = [];
    else if (l === 'END:VEVENT') { blocks.push(cur); cur = null; }
    else if (cur) cur.push(l);
  }
  return blocks.map((b) => ({
    lines: b,
    get: (name) => b.find((l) => l.startsWith(name + ':') || l.startsWith(name + ';')) || null,
  }));
}

/**
 * Navigate the MAIN calendar to a deterministic month (YYYY-MM) by reading
 * the toolbar title and clicking prev/next until it matches. The v6-era
 * scripts navigated RELATIVELY ("next month = November"), which breaks the
 * moment the clock crosses a month boundary — the hardcoded test data needs
 * the explicit month. Uses only the app's own toolbar buttons.
 */
export async function gotoMonth(page, ym, { timeoutSteps = 24 } = {}) {
  // Titles like "November 5, 2026" (day view) break the month regex — the
  // helper only ever navigates the MONTH view; switch to it first.
  await page.click(TOOLBAR.month);
  await page.waitForTimeout(350);
  const readTitle = () => page.evaluate(() => {
    const el = document.querySelector('#calendar h2, #calendar [role="heading"]');
    return el ? el.textContent.trim() : '';
  });
  for (let i = 0; i < timeoutSteps; i++) {
    const title = await readTitle();
    const m = /(\w+)\s+(\d{4})/.exec(title);
    if (m && m[2] + '-' + m[1] === String(ym.slice(0, 4)) + '-' + MONTH_OF[ym.slice(5, 7)]) return title;
    const cur = m ? (Number(m[2]) * 12 + MONTHS_EN.indexOf(m[1])) : null;
    const tgt = Number(ym.slice(0, 4)) * 12 + (Number(ym.slice(5, 7)) - 1);
    if (cur === null || tgt > cur) {
      await page.click(TOOLBAR.next);
    } else {
      await page.click(TOOLBAR.prev);
    }
    await page.waitForTimeout(350);
  }
  throw new Error('gotoMonth: could not reach ' + ym);
}
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const MONTH_OF = { '01': 'January', '02': 'February', '03': 'March', '04': 'April', '05': 'May', '06': 'June', '07': 'July', '08': 'August', '09': 'September', 10: 'October', 11: 'November', 12: 'December' };
