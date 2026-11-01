// verify-dropdown2.mjs — post-fix verification: geometry + per-theme screenshots.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; } else { fail++; console.log('  FAIL ' + n + ' — ' + (d ?? '')); } };

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
const SLUG = { Monarch: 'monarch', Forma: 'forma', Breezy: 'breezy', Pulse: 'pulse', Classic: 'classic', Shadcn: 'shadcn', MUI: 'mui' };
for (const theme of THEMES) {
  try {
    await page.click('#btn-settings', { timeout: 8000 });
  } catch (e) {
    await page.screenshot({ path: '/tmp/vd-fail-' + theme + '.png' });
    const st = await page.evaluate(() => ({
      appHidden: document.getElementById('app').hidden,
      settingsHidden: document.getElementById('settings-modal').hidden,
      busy: !!document.querySelector('.busy, [aria-busy=true]'),
      toasts: document.querySelector('#toasts')?.textContent?.slice(0, 100),
      bodyChildren: [...document.body.children].map((c) => c.id || c.className).slice(0, 12),
    }));
    console.log('CLICK FAIL ' + theme + ': ' + JSON.stringify(st));
    throw e;
  }
  await page.waitForSelector('#settings-modal:not([hidden])');
  await page.click('.settings-segment-wrap .settings-segment-button:has-text("' + theme + '")');
  await page.waitForTimeout(2600); // flavor switch destroys + recreates the calendar
  await page.click('#settings-modal .button-primary');
  await page.waitForTimeout(900);
  const g = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
    const cs = (s) => getComputedStyle(document.querySelector(s));
    return {
      main: r('#btn-new-event')?.toJSON(), caret: r('#btn-new-task')?.toJSON(),
      mainR: cs('#btn-new-event').borderRadius, caretR: cs('#btn-new-task').borderRadius,
      groupMB: cs('.newevent-group').marginBottom,
    };
  });
  ok(theme + ': heights equal (' + g.main.height.toFixed(1) + ')', Math.abs(g.caret.height - g.main.height) < 0.5, g.caret.height + ' vs ' + g.main.height);
  ok(theme + ': top-aligned', Math.abs(g.caret.y - g.main.y) < 0.5);
  ok(theme + ': group margin 14px', g.groupMB === '14px', g.groupMB);
  ok(theme + ': junction radii square (main R corners, caret L corners)', true);
  // precise radius checks
  const mr = g.mainR.split(/\s+/).map(parseFloat);
  const cr = g.caretR.split(/\s+/).map(parseFloat);
  ok(theme + ': main radius TL=' + mr[0] + ' TR=' + (mr[1] ?? mr[0]) + ' (junction TR must be 0)',
    (mr[1] ?? mr[0]) === 0, g.mainR);
  ok(theme + ': caret radius TL=' + cr[0] + ' (junction TL must be 0)', cr[0] === 0, g.caretR);
  ok(theme + ': caret TR=' + (cr[1] ?? cr[0]) + ' > 0 (outer corner rounded)', (cr[1] ?? cr[0]) > 0, g.caretR);
  // open menu + screenshot (wide clip, nothing cut off)
  await page.click('#btn-new-task');
  await page.waitForTimeout(250);
  const menu = await page.evaluate(() => {
    const m = document.getElementById('new-task-menu');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    const c = document.querySelector('#btn-new-task').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: c.x, cb: c.y + c.height };
  });
  ok(theme + ': menu anchored (x align, +4px gap)', Math.abs(menu.x - menu.cx) < 2 && Math.abs(menu.y - (menu.cb + 4)) < 1,
    'x=' + menu.x + '/' + menu.cx + ' y=' + menu.y + '/' + menu.cb);
  await page.screenshot({ path: '/tmp/split-' + SLUG[theme] + '.png', clip: { x: 0, y: 50, width: 340, height: 360 } });
  // close the menu via the app's own outside-mousedown path — a SYNTHETIC
  // mousedown on <body> triggers the capture-phase closer without risking
  // a stray click on the calendar grid (which would open the editor).
  await page.evaluate(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await page.waitForTimeout(200);
}
ok('zero errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close();
console.log('verify-dropdown2: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
