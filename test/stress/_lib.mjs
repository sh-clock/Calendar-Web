// _lib.mjs — shared harness for the A6 stress scripts (report-only; no app edits).
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const BASE = 'http://127.0.0.1:8080';
export const SERVER = 'http://127.0.0.1:8787';
const REPO = '/home/z/my-project/calendar-web';

/* ---------------- universe material ---------------- */

export function material() {
  return JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
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
  execFileSync('node', ['test/api-suite.mjs', '--url', SERVER, '--material-out', '/tmp/local-material.json'], {
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

/* ---------------- browser harness ---------------- */

export async function harness({ viewport = { width: 1440, height: 900 } } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();

  const requests = [];
  const pageErrors = [];
  const consoleErrors = [];
  page.on('request', (r) => {
    const u = String(r.url());
    if (u.startsWith(SERVER)) requests.push({ m: r.method(), u: u.replace(SERVER, ''), t: Date.now() });
  });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
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
    await page.goto(BASE + '/?server=' + SERVER + '&setup=' + MAT.auth_ui_hex);
    await page.waitForTimeout(400);
    await page.fill('#password', 'password');
    await page.click('button[type=submit]');
    try {
      await page.waitForSelector('#app:not([hidden])', { timeout: 25000 });
    } catch {
      console.log('  ..   unlock failed — universe may have been re-bootstrapped by a parallel agent; re-bootstrapping and retrying');
      rebootstrap();
      await page.goto(BASE + '/?server=' + SERVER + '&setup=' + MAT.auth_ui_hex);
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
