// VP3 Phase A — static-only verification + loopback bypass matrix (no worker needed).
// Serves: app at http://127.0.0.1:8090 (repo, byte-identical to live), evil at http://127.0.0.1:9777.
import { chromium } from 'playwright';

const APP = 'http://127.0.0.1:8090/index.html';
const EVIL = 'http://127.0.0.1:9777';
const DUMMY_HEX = 'a'.repeat(64);
const results = [];
function res(id, ok, note) { results.push({ id, ok, note }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + id + (note ? '  — ' + note : '')); }

const browser = await chromium.launch();

// ---------- helpers ----------
async function newPage({ init } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (init) await page.addInitScript(init);
  return { ctx, page };
}
async function loadWithParams(page, qs) {
  await page.goto(APP + qs, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(350); // toasts + ingest
}
async function ls(page, k) { return page.evaluate((k) => localStorage.getItem(k), k); }
async function toasts(page) { return page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent)); }

// capture every request URL the page emits (route interception sees pre-network requests)
async function monitorRequests(page, log) {
  await page.route('**/*', (route) => {
    log.push({ url: route.request().url(), headers: route.request().headers() });
    return route.continue();
  });
}

// ---------- F-1: server param handling ----------
{
  const { ctx, page } = await newPage();
  // A1: ?server=https://evil.example/  → ignored + toast, LS_SERVER unset
  await loadWithParams(page, '?server=https%3A%2F%2Fevil.example%2F');
  const t1 = await toasts(page);
  res('A1 ?server=evil ignored',
    (await ls(page, 'clock_poc_server')) === null && /Ignored a server address/.test(t1.join(' ')),
    'toast="' + t1[0] + '"');
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  // A2: #server=https://evil.example/ → ignored + toast
  await loadWithParams(page, '#server=https%3A%2F%2Fevil.example%2F');
  const t2 = await toasts(page);
  res('A2 #server=evil ignored',
    (await ls(page, 'clock_poc_server')) === null && /Ignored a server address/.test(t2.join(' ')),
    'toast="' + t2[0] + '"');
  // A7: URL cleaned after ingest
  res('A7 URL bar cleaned', page.url().endsWith('/index.html') && !page.url().includes('server='),
    'url=' + page.url());
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  // A3: #server=http://localhost:8787/ → stored + toast
  await loadWithParams(page, '#server=http%3A%2F%2Flocalhost%3A8787%2F');
  const t3 = await toasts(page);
  res('A3 #server=http://localhost:8787 stored',
    (await ls(page, 'clock_poc_server')) === 'http://localhost:8787' && /Server set from link/.test(t3.join(' ')),
    'LS_SERVER=' + await ls(page, 'clock_poc_server'));
  await ctx.close();
}
{
  const { ctx, page } = await newPage({ init: () => localStorage.setItem('clock_poc_server', 'https://evil.example/') });
  // A4: pre-poisoned LS_SERVER → persistent login warning (server-note)
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(250);
  const note = page.locator('#server-note');
  const vis = await note.isVisible().catch(() => false);
  const txt = vis ? (await note.textContent()) : '';
  res('A4 poisoned-server warning', vis && /NON-DEFAULT server/.test(txt) && /evil\.example/.test(txt), (vis ? 'note visible' : 'note hidden') + ' "' + txt.slice(0, 80) + '…"');
  // warning persists across reload
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(250);
  res('A4b warning persists after reload', await page.locator('#server-note').isVisible());
  await ctx.close();
}
{
  const { ctx, page } = await newPage(); // fresh context: no init poison
  // A4c: default server → no warning (run in clean profile)
  await page.goto(APP, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(250);
  res('A4c no warning for default server', !(await page.locator('#server-note').isVisible()));
  await ctx.close();
}

// ---------- F-2: setup param ----------
{
  const { ctx, page } = await newPage();
  await loadWithParams(page, '#setup=' + DUMMY_HEX);
  const t = await toasts(page);
  res('F2a #setup=hex stores', (await ls(page, 'clock_poc_auth_ui')) === DUMMY_HEX && /Provisioning code stored/.test(t.join('')), 'toast="' + t[0] + '"');
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  await loadWithParams(page, '?setup=' + DUMMY_HEX);
  const t = await toasts(page);
  res('F2b ?setup=hex refused',
    (await ls(page, 'clock_poc_auth_ui')) === null && /query string/.test(t.join(' ')),
    'toast="' + t[0] + '"');
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  // hash wins over query when both present
  await loadWithParams(page, '?setup=' + 'b'.repeat(64) + '#setup=' + 'c'.repeat(64));
  res('F2c hash setup wins over query', (await ls(page, 'clock_poc_auth_ui')) === 'c'.repeat(64));
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  await loadWithParams(page, '#setup=ZZZnot-hex');
  const t = await toasts(page);
  res('F2d invalid setup refused', (await ls(page, 'clock_poc_auth_ui')) === null && /Ignored invalid provisioning/.test(t.join('')));
  await ctx.close();
}

// ---------- Loopback bypass matrix ----------
// Each crafted #server= URL: does the client accept it (LS_SERVER written),
// and if accepted, what host does the BROWSER actually dial for /config?
const matrix = [
  ['https://localhost.evil.example/', 'expect-ignore'],
  ['http://127.0.0.1.evil.example/', 'expect-ignore'],
  ['http://0x7f000001/', 'expect-accept(loopback-canonic)'], // WHATWG canonicalizes hex IPv4 -> 127.0.0.1
  ['http://2130706433/', 'expect-accept(loopback-canonic)'],  // decimal IPv4 -> 127.0.0.1
  ['http://127.1/', 'expect-accept(loopback-canonic)'],
  ['http://0177.0.0.1/', 'expect-accept(loopback-canonic)'],
  ['http://[::ffff:127.0.0.1]/', 'expect-ignore'],
  ['http://[::1]:8787/', 'expect-accept(loopback)'],
  ['http://LOCALHOST:8787/', 'expect-accept(loopback)'],
  ['http://localhost@evil.example/', 'expect-ignore'],
  ['https://evil.example%5C@localhost:8787/', 'expect-ignore'], // backslash -> slash
  ['http://localhost:evil-port/', 'expect-ignore'],
  ['http://%6c%6f%63%61%6c%68%6f%73%74:8787/', 'expect-accept(?loopback)'],
  ['http://ｌｏｃａｌｈｏｓｔ:8787/', 'expect-accept(?loopback)'], // fullwidth IDNA
  ['http://localhost.:8787/', 'expect-ignore'],
  ['http://x.localhost:8787/', 'expect-accept(loopback)'],
  ['http://user:pass@localhost:8787/', 'expect-accept(loopback+userinfo)'],
];
for (const [url, expect] of matrix) {
  const { ctx, page } = await newPage({ init: () => localStorage.setItem('clock_poc_auth_ui', 'd'.repeat(64)) });
  const reqLog = [];
  await monitorRequests(page, reqLog);
  await loadWithParams(page, '#server=' + encodeURIComponent(url));
  const stored = await ls(page, 'clock_poc_server');
  const accepted = stored !== null;
  // If accepted, drive an unlock so the app dials the server: capture the /config request URL.
  let dialed = null; let loginMsg = null;
  if (accepted) {
    await page.fill('#password', 'password');
    await page.click('#login-form button[type=submit]');
    await page.waitForTimeout(1200);
    const cfgReq = reqLog.find(r => { try { return /\/config$/.test(new URL(r.url).pathname); } catch { return false; } });
    if (cfgReq) { dialed = new URL(cfgReq.url); }
    else {
      loginMsg = await page.evaluate(() => document.querySelector('#login-msg').textContent).catch(() => null);
    }
  }
  // SECURITY INVARIANT: no request may ever leave for a non-loopback host
  const foreignDial = reqLog.find(r => {
    try {
      const h = new URL(r.url).hostname;
      return !(h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost'));
    } catch { return false; }
  });
  let verdictOk =
    (expect === 'expect-ignore' && !accepted) ||
    (expect.startsWith('expect-accept') && accepted);
  let note = accepted ? 'stored; browser dialed ' + (dialed ? dialed.host : 'nothing (' + loginMsg + ')') : 'ignored';
  if (accepted && dialed) {
    const h = dialed.hostname;
    const isLoop = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
    verdictOk = verdictOk && isLoop;
    note += ' [host=' + h + ' loopback=' + isLoop + ']';
  }
  if (foreignDial) { verdictOk = false; note += ' FOREIGN-DIAL=' + foreignDial.url; }
  res('LB ' + url, verdictOk, note);
  await ctx.close();
}

// ---------- summary ----------
const fails = results.filter(r => !r.ok);
console.log('\n=== PHASE A: ' + (results.length - fails.length) + '/' + results.length + ' passed ===');
await browser.close();
process.exit(fails.length ? 1 : 0);
