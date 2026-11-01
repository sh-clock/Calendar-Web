// vp3r3-idna.mjs — follow-up probes for the loopback matrix:
//  F1 where does `*.localhost` actually connect WITHOUT the app CSP? (evil
//     origin page, no CSP) — is Chromium's .localhost→loopback mapping real?
//  F2 fullwidth-digit / unicode host forms evaluated with REAL codepoints
//     (the main matrix's candidates were double-escaped literals)
//  F3 https://localhost under CSP — confirmed allowed by route evidence;
//     re-verify with a clean probe
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';

const EVIL_PORT = 9778;
const hits = [];
const evil = createServer((req, res) => {
  hits.push(req.method + ' ' + req.url);
  res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' });
  res.end('evil');
});
await new Promise((r) => evil.listen(EVIL_PORT, '127.0.0.1', r));
try { const e6 = createServer((req, res) => { hits.push('[::1] ' + req.method + ' ' + req.url); res.writeHead(200); res.end('evil6'); }); await new Promise((r, e) => { e6.on('error', e); e6.listen(EVIL_PORT, '::1', r); }); } catch {}

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const seen = [];
await ctx.route('**/*', async (route) => {
  seen.push(route.request().url());
  return route.continue();
});

// F1 — a page on the EVIL origin (no CSP of any kind)
await page.goto('http://127.0.0.1:' + EVIL_PORT + '/');
const f1 = await page.evaluate(async (port) => {
  const out = {};
  for (const [k, u] of Object.entries({
    star: 'http://evil.localhost:' + port + '/F1-star',
    deep: 'http://a.b.localhost:' + port + '/F1-deep',
    trailingdot: 'http://localhost.:' + port + '/F1-dot',
  })) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    try { const r = await fetch(u, { signal: ctrl.signal }); out[k] = { ok: true, status: r.status }; }
    catch (e) { out[k] = { ok: false, err: String(e).slice(0, 70) }; }
    clearTimeout(t);
  }
  return out;
}, EVIL_PORT);
console.log('F1 (no-CSP evil origin): ' + JSON.stringify(f1));
console.log('F1 routes: ' + seen.filter((u) => u.includes('F1-')).join(' | '));
console.log('F1 evil hits: ' + hits.filter((h) => h.includes('F1-')).join(' | ') || '(none)');

// F2 — real unicode host forms (fromCodePoint, not escaped literals)
const f2 = await page.evaluate(() => {
  const cps = (s) => s; // identity; build with fromCodePoint below
  const cand = [
    String.fromCodePoint(0xFF11, 0xFF12, 0xFF17) + '.0.0.1',            // １２７.0.0.1
    '127' + String.fromCodePoint(0xFF0E) + '0.0.1',                      // 127．0.0.1 (fullwidth full stop)
    '127' + String.fromCodePoint(0x3002) + '0' + String.fromCodePoint(0x3002) + '0' + String.fromCodePoint(0x3002) + '1',
    'localhost' + String.fromCodePoint(0x3002) + 'evil.example',
    'evil' + String.fromCodePoint(0x3002) + 'example' + String.fromCodePoint(0x3002) + 'localhost',
    'LOCALHOST',
    'loc\u00e1lhost',                                                    // á
    'localhost\u0000.evil.example',
  ];
  return cand.map((h) => {
    try {
      const u = new URL('http://' + h + ':9778/');
      const passes = (u.hostname === 'localhost' || u.hostname === '127.0.0.1' ||
        u.hostname === '[::1]' || u.hostname.endsWith('.localhost'));
      return { input: h, hostname: u.hostname, passes };
    } catch (e) { return { input: h, throws: true, passes: false }; }
  });
});
console.log('F2 unicode hosts: ' + JSON.stringify(f2, null, 1));

await browser.close();
evil.close();
process.exit(0);
