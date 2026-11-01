// verify-dropdown.mjs — the split-button fix: caret height === main height
// across all 7 themes; group carries the 14px spacing; menu anchors fine.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('  FAIL ' + n + ' — ' + (d ?? '')); } };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://127.0.0.1:8080/#server=http://127.0.0.1:8787&setup=' + mat.auth_ui_hex);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1500);

const THEMES = ['Monarch', 'Forma', 'Breezy', 'Pulse', 'Classic', 'Shadcn', 'MUI'];
for (const theme of THEMES) {
  // switch theme via settings
  await page.click('#btn-settings');
  await page.waitForSelector('#settings-modal:not([hidden])');
  await page.click('.settings-segment-wrap .settings-segment-button:has-text("' + theme + '")');
  await page.waitForTimeout(theme === 'Shadcn' || theme === 'MUI' || theme === 'Monarch' ? 2200 : 1200);
  await page.click('#settings-modal .button-primary'); // Done
  await page.waitForTimeout(400);
  const g = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
    const group = r('.newevent-group'), main = r('#btn-new-event'), caret = r('#btn-new-task');
    const next = document.querySelector('#minicalendar');
    const nextTop = next ? next.getBoundingClientRect().y : null;
    const mb = getComputedStyle(document.querySelector('.newevent-group')).marginBottom;
    return { group: group?.toJSON(), main: main?.toJSON(), caret: caret?.toJSON(), nextTop, mb };
  });
  const dh = g.caret ? +(g.caret.height - g.main.height).toFixed(2) : null;
  ok(theme + ': caret height === main height (' + g.main.height.toFixed(1) + 'px)',
    Math.abs(dh) < 0.5, 'diff=' + dh);
  ok(theme + ': group bottom margin 14px', g.mb === '14px', g.mb);
  ok(theme + ': buttons top-aligned', Math.abs(g.caret.y - g.main.y) < 0.5);
  // the minicalendar keeps its spacing (group bottom + 14 = minical top)
  ok(theme + ': sidebar rhythm preserved', Math.abs(g.nextTop - (g.group.y + g.group.height + 14)) < 1.5,
    'nextTop=' + g.nextTop + ' groupBottom=' + (g.group.y + g.group.height));
}
// menu opens + anchors to the caret
await page.click('#btn-new-task');
await page.waitForTimeout(300);
const menu = await page.evaluate(() => {
  const m = document.getElementById('new-task-menu');
  if (!m) return null;
  const r = m.getBoundingClientRect();
  const c = document.querySelector('#btn-new-task').getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, caretX: c.x, caretBottom: c.y + c.height,
    items: [...m.querySelectorAll('button')].map((b) => b.textContent) };
});
ok('menu opens with 2 items', !!menu && menu.items.length === 2, JSON.stringify(menu && menu.items));
ok("menu anchored under the caret (+4px designed gap)", Math.abs(menu.x - menu.caretX) < 2 && Math.abs(menu.y - (menu.caretBottom + 4)) < 1,
  'x=' + menu.x + '/' + menu.caretX + ' y=' + menu.y + '/' + menu.caretBottom);
await page.screenshot({ path: '/tmp/dropdown-fixed.png', clip: { x: 0, y: 0, width: 300, height: 420 } });
ok('zero errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close();
console.log('verify-dropdown: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
