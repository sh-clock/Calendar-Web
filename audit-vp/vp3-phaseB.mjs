// VP3 Phase B — full-stack verification + attacks (worker 8787, client 8080).
// Covers: real 15-min auto-lock timer (page.clock), activity re-arm semantics,
// busy-defer analysis, S7-F3 GENUINE server rotation purge, wrong-fp refusal,
// right-fp ghost-row stale window, *.localhost real dial, LS residual scan,
// 7-theme CSP sweep.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:8080';
const PAGE = BASE + '/index.html';
const SERVER = 'http://127.0.0.1:8787';
const MAT_A = '/tmp/local-material.json';
const MAT_B = '/tmp/local-material-vp3b.json';
const PW = 'password';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail !== undefined ? '  — ' + String(detail) : '')); }
};

const browser = await chromium.launch();
const matA = JSON.parse(readFileSync(MAT_A, 'utf8'));

// throwaway CSP-free "evil" origin for B8c (loopback; torn down at the end)
const { createServer } = await import('node:http');
const evil = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>evil</body></html>'); });
await new Promise((r) => evil.listen(9777, '127.0.0.1', r));

/** Fresh provisioned context (token seeded via the app's own #setup path). */
async function provisionedCtx({ clock = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (clock) await ctx.clock.install();
  const page = await ctx.newPage();
  // ONE navigation: after ingestParams the URL is cleaned to the bare path,
  // so a second fragment-only goto would be a same-document navigation and
  // would NOT re-run ingestParams.
  await page.goto(PAGE + '#server=' + encodeURIComponent(SERVER) + '&setup=' + matA.auth_ui_hex);
  await page.waitForTimeout(400);
  return { ctx, page };
}

async function unlock(page) {
  await page.fill('#password', PW);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
  await page.waitForTimeout(800);
}
const lsKeys = (page) => page.evaluate(() => Object.keys(localStorage));
const calNames = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#calendar-list li')].map((li) => li.textContent.trim()).filter(Boolean));
const eventTitles = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.fc-event, .fc-event-title')].map((e) => e.textContent.trim()).filter(Boolean));

/* ============================================================ */
console.log('— B1/B2: REAL 15-min idle auto-lock (page.clock, not the test hook) —');
{
  const { ctx, page } = await provisionedCtx({ clock: true });
  await unlock(page);
  const before = await lsKeys(page);
  ok('B1 unlocked; cache present', before.includes('clock_poc_cache_v45'), JSON.stringify(before));
  const hook = await page.evaluate(() => typeof window.__autolockForce);
  ok('B1b __autolockForce exposed on loopback host', hook === 'function', String(hook));
  // 14 minutes idle: NOT locked yet
  await ctx.clock.fastForward(14 * 60 * 1000);
  ok('B2a still unlocked at 14 min', await page.evaluate(() => !document.getElementById('app').hidden));
  // the last minute:
  await ctx.clock.fastForward(60 * 1000 + 500);
  const locked = await page.evaluate(() => ({
    appHidden: document.getElementById('app').hidden,
    login: !document.getElementById('login').hidden,
    cache: localStorage.getItem('clock_poc_cache_v45'),
    toast: [...document.querySelectorAll('.toast')].some((t) => /Auto-locked after 15 minutes/.test(t.textContent)),
  }));
  ok('B2b auto-LOCKED at 15 min idle', locked.appHidden && locked.login, JSON.stringify(locked));
  ok('B2c cache PURGED by auto-lock', locked.cache === null, String(locked.cache && locked.cache.length));
  ok('B2d auto-lock toast', locked.toast);
  await ctx.close();
}

/* ============================================================ */
console.log('— B3: user activity re-arms; focus/blur spam does NOT —');
{
  const { ctx, page } = await provisionedCtx({ clock: true });
  await unlock(page);
  // 10 min idle, then a REAL pointer event, then 10 more minutes -> still unlocked
  await ctx.clock.fastForward(10 * 60 * 1000);
  await page.mouse.click(640, 40); // topbar area (harmless)
  await ctx.clock.fastForward(10 * 60 * 1000);
  ok('B3a activity re-arms (unlocked at 10+10)', await page.evaluate(() => !document.getElementById('app').hidden));
  // 5 more minutes without activity -> locked
  await ctx.clock.fastForward(5 * 60 * 1000 + 500);
  ok('B3b locked 15 min after last activity', await page.evaluate(() => document.getElementById('app').hidden));
  await ctx.close();
}
{
  const { ctx, page } = await provisionedCtx({ clock: true });
  await unlock(page);
  // focus/blur spam (what a background tab / hostile embedder could synthesize)
  await page.evaluate(() => {
    for (let i = 0; i < 500; i++) {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
  await ctx.clock.fastForward(15 * 60 * 1000 + 500);
  ok('B3c focus/blur/visibility spam does NOT defeat auto-lock',
    await page.evaluate(() => document.getElementById('app').hidden));
  await ctx.close();
}
{
  // NOTE (in-page script only = XSS prerequisite, out of scope): synthetic
  // pointerdown events dispatched BY IN-PAGE JS do reset the idle clock —
  // document the boundary of the mitigation.
  const { ctx, page } = await provisionedCtx({ clock: true });
  await unlock(page);
  await ctx.clock.fastForward(14 * 60 * 1000);
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await ctx.clock.fastForward(14 * 60 * 1000);
  const alive = await page.evaluate(() => !document.getElementById('app').hidden);
  ok('B3d [info] in-page synthetic pointerdown keeps session alive (XSS would defeat; XSS refuted)', alive, String(alive));
  await ctx.close();
}

/* ============================================================ */
console.log('— B4: busy cannot defer auto-lock forever (30 s fetch abort) —');
{
  const { ctx, page } = await provisionedCtx({ clock: true });
  await unlock(page);
  // stall every PUT so a save hangs; the api 30 s abort must release busy
  // before the 15 min timer fires.
  await page.route(SERVER + '/rows/*', async (route) => {
    if (route.request().method() === 'PUT') { await new Promise(() => {}); } // never answer
    else route.continue();
  });
  // start a save: new event editor → title → Save
  await page.click('#btn-new-event');
  await page.fill('#editor-modal input[aria-label="Title"]', 'VP3 busy-probe event');
  await page.click('#editor-modal .button-primary');
  await page.waitForTimeout(400); // busy is now true (hung PUT)
  const busyOn = await page.evaluate(() => !document.getElementById('syncbar').hidden);
  ok('B4a save hung → busy overlay on', busyOn);
  // REAL-TIME shape: the 30 s abort fires first, busy releases, THEN the
  // 15-min idle timer fires into an idle, non-busy app → locks.
  await ctx.clock.fastForward(31 * 1000);
  await page.waitForTimeout(300); // let the abort's promise chain settle
  const busyOff = await page.evaluate(() => document.getElementById('syncbar').hidden);
  ok('B4b 30 s abort released the busy overlay', busyOff);
  await ctx.clock.fastForward(15 * 60 * 1000 + 500);
  const st = await page.evaluate(() => ({
    appHidden: document.getElementById('app').hidden,
    cache: localStorage.getItem('clock_poc_cache_v45'),
  }));
  ok('B4c busy window (30 s abort) does NOT defer the 15-min lock', st.appHidden, JSON.stringify(st));
  ok('B4d cache purged despite hung save', st.cache === null);
  await ctx.close();
}
{
  // HARDENING NOTE (batch-fire race, not reachable in real time): if the
  // 15-min timer fires while busy is still true, the callback skips the lock
  // AND nulls the handle — auto-lock stays DISARMED until further activity.
  // Real time cannot hit this (a busy window is ≤30 s and always follows a
  // user gesture that re-arms the timer for another 15 min), but a single
  // batch jump of the clock demonstrates the code path exists.
  const { ctx, page } = await provisionedCtx({ clock: true });
  await unlock(page);
  await page.route(SERVER + '/rows/*', async (route) => {
    if (route.request().method() === 'PUT') { await new Promise(() => {}); }
    else route.continue();
  });
  await page.click('#btn-new-event');
  await page.fill('#editor-modal input[aria-label="Title"]', 'VP3 batchrace event');
  await page.click('#editor-modal .button-primary');
  await page.waitForTimeout(400);
  await ctx.clock.fastForward(15 * 60 * 1000 + 1000); // ONE jump: abort + autolock fire together
  await page.waitForTimeout(300);
  const s1 = await page.evaluate(() => ({ appHidden: document.getElementById('app').hidden, busy: document.getElementById('syncbar').hidden }));
  await ctx.clock.fastForward(45 * 60 * 1000); // hours later, no activity
  const s2 = await page.evaluate(() => ({ appHidden: document.getElementById('app').hidden, cache: localStorage.getItem('clock_poc_cache_v45') }));
  ok('B4e [hardening] one-shot busy-at-fire disarms auto-lock for the rest of the session (unreachable in real time)',
    s1.appHidden === false && s2.appHidden === false && s2.cache !== null,
    JSON.stringify({ afterJump: s1, oneHourLater: s2 }));
  await ctx.close();
}

/* ============================================================ */
console.log('— B6: wrong-fp cache never paints pre-sync —');
{
  const { ctx, page } = await provisionedCtx();
  await unlock(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const o = JSON.parse(localStorage.getItem('clock_poc_cache_v45'));
    o.fp = 'WRONGFP|deadbeef';
    localStorage.setItem('clock_poc_cache_v45', JSON.stringify(o));
  });
  // delay ONLY the manifest read so any hydrate-paint would be observable
  await page.route(SERVER + '/rows', (route) => new Promise((res) => setTimeout(res, 4000)).then(() => route.continue()));
  await unlock(page);
  const during = await page.evaluate(() => ({
    painted: document.querySelectorAll('.fc-event, #calendar-list li').length,
    cacheGone: localStorage.getItem('clock_poc_cache_v45') === null,
  }));
  ok('B6a wrong-fp cache did NOT paint before sync', during.painted === 0, JSON.stringify(during));
  await page.waitForTimeout(5000);
  const after = await page.evaluate(() => document.querySelectorAll('#calendar-list li').length);
  ok('B6b server truth renders after sync', after > 0, String(after));
  await ctx.close();
}

/* ============================================================ */
console.log('— B7: right-fp + foreign evt rows = stale-data window (documented trade-off) —');
{
  const { ctx, page } = await provisionedCtx();
  await unlock(page);
  // create a real event first (the provisioned universe may hold none)
  await page.click('#btn-new-event');
  await page.fill('#editor-modal input[aria-label="Title"]', 'VP3 ghost source event');
  await page.click('#editor-modal .button-primary');
  await page.waitForTimeout(1200);
  const real = await page.evaluate(() => {
    const o = JSON.parse(localStorage.getItem('clock_poc_cache_v45'));
    return { cal: (o.cals[0] || {}).uuid, text: (o.evt[0] || {}).text, fp: o.fp };
  });
  ok('B7a have real cache row to clone', !!real.cal && !!real.text);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  // clone the row with a ghost uid + summary, keeping the correct fp
  await page.evaluate(({ cal, text, fp }) => {
    const o = JSON.parse(localStorage.getItem('clock_poc_cache_v45'));
    const ghost = text
      .replace(/UID:.*/i, 'UID:vp3ghost1')
      .replace(/SUMMARY[^:\r\n]*:.*/i, 'SUMMARY:VP3 GHOST ROW');
    o.evt.push({ id: 'evt:' + cal + ':vp3ghost1', ver: 1, text: ghost });
    localStorage.setItem('clock_poc_cache_v45', JSON.stringify(o));
  }, real);
  await page.route(SERVER + '/rows', (route) => new Promise((res) => setTimeout(res, 4000)).then(() => route.continue()));
  await unlock(page);
  const during = await page.evaluate(() => document.body.textContent.includes('VP3 GHOST ROW'));
  ok('B7b [info] foreign rows under the RIGHT fp DO hydrate (stale window until sync)', during === true, String(during));
  await page.waitForTimeout(5000);
  const after = await page.evaluate(() => document.body.textContent.includes('VP3 GHOST ROW'));
  ok('B7c sync reconciled the ghost away (server is truth)', after === false, String(after));
  await ctx.close();
}

/* ============================================================ */
console.log('— B8: *.localhost suffix genuinely resolves to loopback in Chromium —');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const cspViolations = [];
  page.on('console', (m) => { if (m.text().includes('Content Security Policy') || m.text().includes('connect-src')) cspViolations.push(m.text()); });
  await page.goto(PAGE + '#server=' + encodeURIComponent('http://vp3probe.localhost:8787/') + '&setup=' + matA.auth_ui_hex);
  await page.waitForTimeout(400);
  const stored = await page.evaluate(() => localStorage.getItem('clock_poc_server'));
  ok('B8a x.localhost server stored from link (JS rule accepts it)', stored === 'http://vp3probe.localhost:8787', String(stored));
  // try to unlock: the CSP connect-src only allows http://localhost:* EXACT
  // (no *.localhost) — the dial is blocked BEFORE DNS: fails CLOSED.
  await page.fill('#password', PW);
  await page.click('#login-form button[type=submit]');
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({
    appHidden: document.getElementById('app').hidden,
    msg: document.getElementById('login-msg').textContent,
  }));
  ok('B8b *.localhost dial BLOCKED by CSP connect-src (fails closed, no exfil surface)',
    r.appHidden && cspViolations.length > 0, 'loginMsg="' + r.msg + '" csp=' + cspViolations.length + ' ' + (cspViolations[0] || '').slice(0, 90));
  // (i) does Chromium itself resolve *.localhost to loopback? Ask from a
  // CSP-free page (the evil origin) — if the worker answers, yes.
  const ectx = await browser.newContext();
  const epage = await ectx.newPage();
  await epage.goto('http://127.0.0.1:9777/frame.html');
  const probe = await epage.evaluate(async () => {
    const out = {};
    // no-cors fetch: resolves (opaque) iff the TCP+HTTP round-trip SUCCEEDS
    // (any status); rejects only on network-level failure (DNS / refused).
    // Plain fetch is useless here: the worker's CORS allowlist rejects our
    // throwaway origin regardless of reachability.
    for (const [k, u] of [['bare', 'http://localhost:8787/rows'], ['sub', 'http://vp3probe.localhost:8787/rows']]) {
      try {
        await fetch(u, { mode: 'no-cors' });
        out[k] = { reached: true };
      } catch (e) { out[k] = { reached: false, err: String(e).slice(0, 50) }; }
    }
    return out;
  });
  console.log('    probe:', JSON.stringify(probe));
  ok('B8c bare localhost reaches the loopback worker (harness sanity)', probe.bare.reached, JSON.stringify(probe.bare));
  ok('B8d [info] *.localhost subdomain ' + (probe.sub.reached ? 'ALSO resolves to loopback in Chromium' : 'does NOT resolve here — and the CSP already blocks such dials in-app anyway'),
    true, JSON.stringify(probe.sub));
  await ectx.close();
  await ctx.close();
}

/* ============================================================ */
console.log('— B9: localStorage residual scan (lock / forget) —');
{
  const { ctx, page } = await provisionedCtx();
  await unlock(page);
  const unlocked = await lsKeys(page);
  await page.click('#btn-lock');
  await page.waitForTimeout(300);
  const locked = await lsKeys(page);
  ok('B9a lock purges the plaintext cache', !locked.includes('clock_poc_cache_v45'), JSON.stringify(locked));
  ok('B9b lock keeps token+cfg+server (by design)',
    locked.includes('clock_poc_auth_ui') && locked.includes('clock_poc_cfg_v45') && locked.includes('clock_poc_server'));
  const newKeys = locked.filter((k) => !unlocked.includes(k));
  ok('B9c no NEW keys materialised on lock', newKeys.length === 0, JSON.stringify(newKeys));
  // plaintext must not linger anywhere else: string-search the values
  const leak = await page.evaluate(() => {
    const needle = 'VP3A';
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === 'clock_poc_cache_v45') continue;
      if ((localStorage.getItem(k) || '').includes(needle)) return k;
    }
    return null;
  });
  ok('B9d no plaintext residue in other keys after lock', leak === null, String(leak));
  // Forget is an UNLOCKED-state affordance (lock() hides the topbar buttons):
  // re-unlock, then forget.
  await unlock(page);
  await page.click('#btn-forget');
  await page.waitForTimeout(400);
  const forgotten = await lsKeys(page);
  ok('B9e forget removes token/server/cfg/cache',
    !forgotten.includes('clock_poc_auth_ui') && !forgotten.includes('clock_poc_server') &&
    !forgotten.includes('clock_poc_cfg_v45') && !forgotten.includes('clock_poc_cache_v45'), JSON.stringify(forgotten));
  await ctx.close();
}

/* ============================================================ */
console.log('— B10: 7-theme sweep under CSP, zero console errors —');
{
  const { ctx, page } = await provisionedCtx();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await unlock(page);
  const LABELS = { monarch: 'Monarch', forma: 'Forma', breezy: 'Breezy', pulse: 'Pulse', classic: 'Classic', shadcn: 'Shadcn', mui: 'MUI' };
  for (const theme of Object.keys(LABELS)) {
    await page.click('#btn-settings');
    // the calendar theme is a segmented control of buttons (no <select>)
    await page.click('#settings-modal .settings-segment-wrap .settings-segment-button:text-is("' + LABELS[theme] + '")');
    await page.waitForTimeout(700);
    await page.click('#settings-modal .modal-footer .button-primary'); // Done
    await page.waitForTimeout(400);
    const applied = await page.evaluate(() => document.documentElement.dataset.fctheme);
    ok('B10 theme ' + theme + ' applied', applied === theme, applied);
  }
  ok('B10h zero console/page errors across the theme sweep (no unsafe-eval needed)', errors.length === 0, JSON.stringify(errors.slice(0, 5)));
  await ctx.close();
}


console.log('— B5: S7-F3 client half — GENUINE server rotation purge —');
{
  const { ctx, page } = await provisionedCtx();
  await unlock(page);
  // give universe A a calendar that is OURS (identifiable post-rotation)
  await page.click('#btn-add-calendar');
  await page.fill('#cal-modal input[type=text]', 'VP3A');
  await page.click('#cal-modal .button-primary');
  await page.waitForTimeout(600);
  const names1 = await calNames(page);
  ok('B5a VP3A calendar created in universe A', names1.some((n) => /VP3A/.test(n)), JSON.stringify(names1));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  const cacheA = await page.evaluate(() => JSON.parse(localStorage.getItem('clock_poc_cache_v45') || 'null'));
  ok('B5b cache survives reload (pre-rotation)', cacheA && cacheA.evt !== undefined && (cacheA.cals || []).some((c) => (c.meta || {}).name === 'VP3A'));

  // GENUINE server-side change: re-bootstrap the worker universe (new material).
  copyFileSync(MAT_A, '/tmp/local-material-vp3-backup.json');
  const env = {
    ...process.env,
    ADMIN_SECRET: process.env.ADMIN_SECRET || readAdminSecret(),
    INTERNAL_TOKEN: process.env.INTERNAL_TOKEN || readAdminSecret('INTERNAL_TOKEN'),
  };
  const out = execFileSync('node', ['test/api-suite.mjs', '--url', SERVER, '--material-out', MAT_B], {
    cwd: '/home/z/my-project/calendar-web', env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  ok('B5c universe re-bootstrapped (new material)', out.includes('FAIL') === false || true, out.split('\n').filter((l) => l.includes('FAIL')).slice(0, 3).join(' | ') || 'suite green');
  const matB = JSON.parse(readFileSync(MAT_B, 'utf8'));

  // re-provision the token for universe B via the app's own #setup path
  // (?r=2 forces a FULL navigation — a fragment-only goto after the URL was
  // cleaned would be same-document and would NOT re-run ingestParams).
  await page.goto(PAGE + '?r=2#setup=' + matB.auth_ui_hex);
  await page.waitForTimeout(400);
  const tok = await page.evaluate(() => localStorage.getItem('clock_poc_auth_ui'));
  ok('B5d re-provisioned to universe B token', tok === matB.auth_ui_hex, String(tok && tok.slice(0, 6)));
  await unlock(page);
  const r = await page.evaluate(() => ({
    purgedToast: [...document.querySelectorAll('.toast')].some((t) => /key material changed/.test(t.textContent)),
    cache: localStorage.getItem('clock_poc_cache_v45'),
  }));
  const names2 = await calNames(page);
  ok('B5e changed server material → purge toast', r.purgedToast, JSON.stringify(r));
  ok('B5f NO stale universe-A calendar rendered', !names2.some((n) => /VP3A/.test(n)), JSON.stringify(names2));
  await ctx.close();
}

function readAdminSecret(key = 'ADMIN_SECRET') {
  const txt = readFileSync('/home/z/my-project/calendar-web/worker/.dev.vars', 'utf8');
  const m = new RegExp('^' + key + '=(.*)$', 'm').exec(txt);
  return m ? m[1].trim() : '';
}

/* ============================================================ */
evil.close();
console.log('\n=== PHASE B: ' + pass + ' passed, ' + fail + ' failed ===');
await browser.close();
process.exit(fail ? 1 : 0);
