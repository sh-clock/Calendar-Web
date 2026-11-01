// debug-click.mjs — why doesn't clicking the rowevents area open the editor?
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8080';
const SERVER = 'http://127.0.0.1:8787';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });

await page.goto(BASE + '/#server=' + SERVER + '&setup=' + mat.auth_ui_hex);
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1200);

// Instrument: what element is at various points of row 0?
const probe = await page.evaluate(() => {
  const out = [];
  const rows = document.querySelectorAll('.daygrid-rowevents');
  rows.forEach((r, i) => {
    const b = r.getBoundingClientRect();
    for (const fx of [0.1, 0.25, 0.5, 0.75]) {
      const x = b.x + b.width * fx;
      const y = b.y + 6;
      const el = document.elementFromPoint(x, y);
      out.push({
        row: i, fx,
        hit: el ? (el.tagName + '.' + String(el.className).slice(0, 40) + ' dataRow=' + (el.dataset ? el.dataset.row : undefined)) : 'none',
        box: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      });
    }
  });
  return out;
});
for (const p of probe.slice(0, 8)) console.log('row ' + p.row + ' fx=' + p.fx + ' box=' + JSON.stringify(p.box) + ' → ' + p.hit);

// Now the actual click on row 0 middle:
const row0 = await page.locator('.daygrid-rowevents').nth(0).boundingBox();
await page.mouse.click(row0.x + row0.width * 0.5, row0.y + 6);
await page.waitForTimeout(800);
const d = await page.evaluate(() => ({
  editorHidden: document.querySelector('#editor-modal').hidden,
  editorChildren: document.querySelector('#editor-modal').children.length,
  popoverHidden: document.querySelector('#event-popover').hidden,
  recurHidden: document.querySelector('#recur-modal').hidden,
  toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
  activeOverlays: [...document.querySelectorAll('[aria-modal="true"]')].map((m) => m.id + ':' + m.hidden),
}));
console.log('after click:', JSON.stringify(d));
await page.screenshot({ path: '/tmp/debug-click.png' });
await browser.close();
