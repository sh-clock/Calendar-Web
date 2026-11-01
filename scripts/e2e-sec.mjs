// e2e-sec.mjs — client-side security regression suite (sec-S5/S7/S8 fixes).
// Runs against the local stack (worker 8787 + client 8080) provisioned by
// with-stack.sh. Covers:
//   S5-F1  ?server= crafted-link repoint  → loopback-only, remote IGNORED
//   S5-F2  ?setup= query-string            → fragment-only ingestion
//   S5-F3  framing (sandboxed iframe)      → frame-bust hides the app
//           CSP connect-src                → cross-origin fetch BLOCKED
//           CSP script-src 'self'          → injected inline script BLOCKED
//   S5-F4  idle auto-lock                  → __autolockForce locks + purges
//   S7-F3  cache fingerprint pinning       → foreign-fp cache never hydrates;
//           online cfg change purges the stale model cache
//   S8-F3  semver-tolerant version gate    → 4.3.1 keeps batch; 4.2 degrades
// Usage: node scripts/e2e-sec.mjs
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
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

/** Fresh context with the provisioning token pre-seeded (like a browser that
 *  already unlocked once — the F-1 attack precondition). */
async function freshCtx() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(([token, server]) => {
    localStorage.setItem('clock_poc_auth_ui', token);
    localStorage.setItem('clock_poc_server', server);
  }, [AUTH_UI, SERVER]);
  return ctx;
}

/* ============================================================ */
console.log('SEC-1 — S5-F1: ?server= crafted-link repoint (loopback-only)');
/* ============================================================ */
{
  const ctx = await freshCtx();
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html?server=https://evil.example/');
  const stored = await page.evaluate(() => localStorage.getItem('clock_poc_server'));
  ok('sec1.1 remote ?server= NOT stored (LS_SERVER untouched)', stored === SERVER, stored);
  const warned = await page.evaluate(() =>
    [...document.querySelectorAll('.toast')].some((t) => /Ignored a server address/.test(t.textContent)));
  ok('sec1.2 loud warning toast shown', warned);
  // The URL bar was still cleaned (no params left behind for sharing).
  const url = await page.evaluate(() => location.search);
  ok('sec1.3 query cleaned from the address bar', url === '', url);
  await ctx.close();
}
{
  const ctx = await freshCtx();
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html#server=http://127.0.0.1:8799');
  await page.waitForTimeout(300);
  const stored = await page.evaluate(() => localStorage.getItem('clock_poc_server'));
  ok('sec1.4 loopback #server= IS stored (dev pointing)', stored === 'http://127.0.0.1:8799', stored);
  await ctx.close();
}

/* ============================================================ */
console.log('SEC-2 — S5-F2: setup token via fragment only');
/* ============================================================ */
{
  const ctx = await browser.newContext(); // NOT provisioned
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html?setup=' + AUTH_UI);
  await page.waitForTimeout(300);
  const tok = await page.evaluate(() => localStorage.getItem('clock_poc_auth_ui'));
  ok('sec2.1 ?setup= query NOT stored', tok === null, tok);
  const warned = await page.evaluate(() =>
    [...document.querySelectorAll('.toast')].some((t) => /query string/.test(t.textContent)));
  ok('sec2.2 log-leak warning shown', warned);
  const reqLine = await page.evaluate(() => location.search);
  ok('sec2.3 query cleaned from the address bar', reqLine === '', reqLine);
  await ctx.close();
}
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html#setup=' + AUTH_UI);
  await page.waitForTimeout(300);
  const tok = await page.evaluate(() => localStorage.getItem('clock_poc_auth_ui'));
  ok('sec2.4 #setup= fragment IS stored', tok === AUTH_UI, tok);
  await ctx.close();
}

/* ============================================================ */
console.log('SEC-3 — S5-F3: frame-bust + CSP enforcement');
/* ============================================================ */
{
  // Attacker page served by a REAL throwaway loopback server (route
  // interception trips Chromium's local-network-access classification),
  // framing the app in a sandboxed iframe WITHOUT allow-top-navigation:
  // the frame-buster cannot escape → the app must HIDE itself.
  const { createServer } = await import('node:http');
  const attacker = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body style="margin:0;background:#222">' +
      '<iframe id="victim" sandbox="allow-scripts" src="' + BASE + '/index.html" style="width:900px;height:700px"></iframe></body></html>');
  });
  await new Promise((r) => attacker.listen(8098, '127.0.0.1', r));
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8098/');
  let frame = null;
  for (let i = 0; i < 40; i++) {
    frame = page.frames().find((f) => f.url().includes('index.html'));
    if (frame) break;
    await page.waitForTimeout(250);
  }
  ok('sec3.1 sandboxed frame renders the app page', !!frame);
  if (frame) {
    await page.waitForTimeout(800);
    const state = await frame.evaluate(() => {
      const html = document.documentElement;
      const cs = getComputedStyle(html);
      return {
        inlineHidden: html.style.visibility === 'hidden',
        computedHidden: cs.visibility === 'hidden',
        loginVisible: !document.getElementById('login').hidden,
      };
    });
    ok('sec3.2 frame-bust HIDES the framed app (visibility:hidden)',
      state.computedHidden === true || state.inlineHidden === true, JSON.stringify(state));
  }
  await ctx.close();
  attacker.close();
}
{
  // CSP connect-src: a fetch to a non-allowlisted host must be BLOCKED.
  const ctx = await freshCtx();
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html');
  await page.waitForTimeout(400);
  const r = await page.evaluate(async () => {
    try {
      const res = await fetch('https://example.com/');
      return { blocked: false, status: res.status };
    } catch (e) {
      return { blocked: true, err: String(e).slice(0, 80) };
    }
  });
  ok('sec3.3 CSP blocks fetch to a foreign host', r.blocked === true, JSON.stringify(r));
  const r2 = await page.evaluate(async () => {
    try {
      const res = await fetch(location.origin + '/css/style.css');
      return { blocked: false, status: res.status };
    } catch (e) { return { blocked: true, err: String(e) }; }
  });
  ok('sec3.4 same-origin fetch still works', r2.blocked === false && r2.status === 200, JSON.stringify(r2));
  await ctx.close();
}
{
  // CSP script-src 'self': an injected inline <script> must NOT execute.
  const ctx = await freshCtx();
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html');
  await page.waitForTimeout(400);
  const r = await page.evaluate(async () => {
    window.__xssProbe = 0;
    const s = document.createElement('script');
    s.textContent = 'window.__xssProbe = 1;';
    document.head.appendChild(s);
    await new Promise((res) => setTimeout(res, 200));
    return window.__xssProbe;
  });
  ok('sec3.5 CSP blocks injected inline script (XSS dead)', r === 0, 'xssProbe=' + r);
  await ctx.close();
}

/* ============================================================ */
console.log('SEC-4 — S5-F4: idle auto-lock');
/* ============================================================ */
{
  const ctx = await freshCtx();
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html');
  await page.fill('#password', 'password');
  await page.click('button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 25000 });
  await page.waitForTimeout(1500);
  const hadCache = await page.evaluate(() => !!localStorage.getItem('clock_poc_cache_v45'));
  ok('sec4.1 unlocked with plaintext cache present', hadCache);
  const hooked = await page.evaluate(() => typeof window.__autolockForce === 'function');
  ok('sec4.2 loopback test hook present', hooked);
  await page.evaluate(() => window.__autolockForce());
  await page.waitForTimeout(400);
  const locked = await page.evaluate(() => {
    return {
      appHidden: document.getElementById('app').hidden,
      loginVisible: !document.getElementById('login').hidden,
      cache: localStorage.getItem('clock_poc_cache_v45'),
      toast: [...document.querySelectorAll('.toast')].some((t) => /Auto-locked/.test(t.textContent)),
    };
  });
  ok('sec4.3 forced expiry LOCKS the app', locked.appHidden === true && locked.loginVisible === true, JSON.stringify(locked));
  ok('sec4.4 plaintext cache PURGED on auto-lock', locked.cache === null, String(locked.cache && locked.cache.length));
  ok('sec4.5 auto-lock toast shown', locked.toast === true);
  await ctx.close();
}

/* ============================================================ */
console.log('SEC-5 — S7-F3: cache fingerprint pinning');
/* ============================================================ */
{
  // (VP5-Q1: the ORIGINAL version of this test clicked #btn-lock — which
  // PURGES the cache, so the fp pin was never exercised. Reload instead:
  // the poisoned cache survives, and the pin must refuse to paint it.)
  const ctx = await freshCtx();
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html');
  await page.fill('#password', 'password');
  await page.click('button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 25000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    // Poison the cache with a FOREIGN fingerprint + a sentinel event.
    const o = JSON.parse(localStorage.getItem('clock_poc_cache_v45'));
    o.fp = 'ffffffff|AAAAAAAA';
    o.evt = [{ id: 'evt:99999999-9999-9999-9999-999999999999:ghost-uid', ver: 1,
      text: JSON.stringify({ v: 1, summary: 'GHOST EVENT', dtstart: '2099-01-01T00:00:00Z', dtend: '2099-01-01T01:00:00Z' }) }];
    localStorage.setItem('clock_poc_cache_v45', JSON.stringify(o));
  });
  // RELOAD with the poisoned cache still on disk, then re-unlock: the ghost
  // must NEVER paint (sample the DOM continuously through the unlock).
  await page.reload();
  await page.fill('#password', 'password');
  await page.click('button[type=submit]');
  let ghostSeen = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    ghostSeen = ghostSeen || (await page.locator('.fc-event, .fc-list-event', { hasText: 'GHOST' }).count()) > 0;
  }
  ok('sec5.1 foreign-fp cache NEVER paints (reload path, fp pin exercised)', ghostSeen === false, 'ghostSeen=' + ghostSeen);
  await ctx.close();
}
{
  // Online cfg change (simulated rewrap of the SAME universe with new
  // material) must PURGE the model cache before derivation.
  const ctx = await freshCtx();
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html');
  await page.fill('#password', 'password');
  await page.click('button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 25000 });
  await page.waitForTimeout(1500);
  const realWrapped = await page.evaluate(() => JSON.parse(localStorage.getItem('clock_poc_cfg_v45')).wrapped);
  // Stale the cached cfg: pretend the last cached material was different.
  await page.evaluate((w) => {
    const cfg = JSON.parse(localStorage.getItem('clock_poc_cfg_v45'));
    cfg.wrapped = w.slice(0, -4) + 'AAAA'; // different bytes
    localStorage.setItem('clock_poc_cfg_v45', JSON.stringify(cfg));
  }, realWrapped);
  await page.click('#btn-lock');
  await page.waitForTimeout(300);
  // server still has the ORIGINAL material: unlock succeeds; the mismatched
  // cached cfg must be detected + the model cache purged (toast).
  await page.fill('#password', 'password');
  await page.click('button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 25000 });
  await page.waitForTimeout(600);
  const r = await page.evaluate((w) => ({
    purgedToast: [...document.querySelectorAll('.toast')].some((t) => /key material changed/.test(t.textContent)),
    // (VP5-Q2: pin the REFRESH, not a self-comparison — LS_CFG must now
    // carry the server's real wrapped bytes again)
    cfgRefreshed: JSON.parse(localStorage.getItem('clock_poc_cfg_v45')).wrapped === w,
  }), realWrapped);
  ok('sec5.2 changed server material → purge toast + cfg refreshed to server bytes', r.purgedToast === true && r.cfgRefreshed === true, JSON.stringify(r));
  await ctx.close();
}

/* ============================================================ */
console.log('SEC-6 — S8-F3: semver-tolerant version gate');
/* ============================================================ */
{
  for (const [proto, expectBatch] of [['4.3.1', true], ['4.4', true], ['4.2', false], ['5.0', true]]) {
    const ctx = await freshCtx();
    const page = await ctx.newPage();
    await page.route(SERVER + '/version', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ proto }) }));
    await page.goto(BASE + '/index.html');
    await page.fill('#password', 'password');
    await page.click('button[type=submit]');
    await page.waitForSelector('#app:not([hidden])', { timeout: 25000 });
    await page.waitForTimeout(600);
    const degraded = await page.evaluate(() =>
      [...document.querySelectorAll('.toast')].some((t) => /falls back to per-row reads/.test(t.textContent)));
    ok(`sec6 proto ${proto} → batch ${expectBatch ? 'KEPT' : 'degraded'}`,
      expectBatch ? degraded === false : degraded === true, 'degraded=' + degraded);
    await ctx.close();
  }
}

await browser.close();
console.log(`\ne2e-sec: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
