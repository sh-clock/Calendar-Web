// debug-resize.mjs — focused probe: why does the e2e resize gesture produce
// no PUT on the v7 stack? Instruments the resizer element's computed style,
// event delivery (mousedown/pointerdown), and the app's network activity.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8080';
const SERVER = 'http://127.0.0.1:8787';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const AUTH_UI = mat.auth_ui_hex;

const fcBundle = readFileSync('js/vendor/fullcalendar/v7/all.global.js', 'utf8');
const fcHash = (k) => (fcBundle.match(new RegExp('"internal' + k + '":"(fc-[A-Za-z0-9]+)"')) || [])[1];
const RZ_END = fcHash('EventResizerEnd');
const RZ_GEN = fcHash('EventResizer');
const EV_SEL = fcHash('Event');
console.log('RZ_END=' + RZ_END + ' RZ_GEN=' + RZ_GEN);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const nets = [];
page.on('request', (r) => { if (r.url().startsWith(SERVER)) nets.push(r.method() + ' ' + r.url().replace(SERVER, '')); });
page.on('console', (m) => console.log('[console:' + m.type() + '] ' + m.text()));
page.on('pageerror', (e) => console.log('[pageerror] ' + e));

await page.goto(BASE + '/?server=' + SERVER + '&setup=' + AUTH_UI);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1500);

// Create a timed event today via the UI (week view, drag-create is not needed:
// click an empty slot then save).
await page.click('#calendar button[aria-label="Week view"]');
await page.waitForTimeout(800);
const ev = await page.evaluate(() => {
  const sel = document.querySelectorAll('#calendar .fc-event');
  return sel.length;
});
console.log('existing events: ' + ev);

// Instead of creating via empty slot (fiddly), use the New event menu.
await page.click('#btn-new-task, #btn-new-event, [aria-label="New event"], #btn-new');
await page.waitForTimeout(400);
// find the editor
const edVisible = await page.locator('#editor-modal').isVisible().catch(() => false);
console.log('editor visible after new button: ' + edVisible);
if (!edVisible) {
  // maybe a menu opened
  const menus = await page.evaluate(() => [...document.querySelectorAll('[id$="-menu"]')].map((m) => ({ id: m.id, hidden: m.hidden })));
  console.log('menus: ' + JSON.stringify(menus));
  const nm = await page.$('#new-task-menu');
  if (nm) {
    const btns = await page.$$eval('#new-task-menu button', (bs) => bs.map((b) => b.textContent));
    console.log('new-task-menu buttons: ' + JSON.stringify(btns => btns(btns), btns => btns(btns)) ? '' : '');
    console.log('menu buttons: ' + JSON.stringify(await page.$$eval('#new-task-menu button', (bs) => bs.map((b) => b.textContent))));
    await page.click('#new-task-menu button:first-child'); // New event
    await page.waitForTimeout(400);
  }
}

await page.waitForTimeout(300);
const title = 'RZ debug event';
await page.fill('#editor-modal input[type=text]', title);
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1800);
console.log('toasts: ' + (await page.textContent('#toasts')).trim());
console.log('networks after create: ' + JSON.stringify(nets.slice(-3)));

// find the chip in the week view
const chip = page.locator('.fc-event', { hasText: title }).first();
await chip.scrollIntoViewIfNeeded();
await chip.hover();
await page.waitForTimeout(500);

const info = await page.evaluate(({ rzEnd, rzGen }) => {
  const out = {};
  for (const e of document.querySelectorAll('.fc-event')) {
    if (e.textContent.includes('RZ debug event')) {
      const z = e.querySelector('.' + rzEnd);
      if (z) {
        const cs = getComputedStyle(z);
        const r = z.getBoundingClientRect();
        out.resizer = {
          classes: z.className,
          pointerEvents: cs.pointerEvents,
          display: cs.display,
          position: cs.position,
          width: cs.width, height: cs.height,
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          parentClasses: z.parentElement.className,
          parentPE: getComputedStyle(z.parentElement).pointerEvents,
        };
        // instrument event delivery
        z.addEventListener('pointerdown', () => { window.__rzEvents = (window.__rzEvents || []).push('pointerdown'); }, true);
        z.addEventListener('mousedown', () => { window.__rzEvents = (window.__rzEvents || []).push('mousedown'); }, true);
      }
      const chipR = e.getBoundingClientRect();
      out.chip = { classes: e.className, rect: { x: chipR.x, y: chipR.y, w: chipR.width, h: chipR.height } };
      break;
    }
  }
  return out;
}, { rzEnd: RZ_END, rzGen: RZ_GEN });
console.log('resizer info: ' + JSON.stringify(info, null, 1));

if (info.resizer && info.resizer.rect.h > 0) {
  const mx = Math.round(info.resizer.rect.x + info.resizer.rect.w / 2);
  const my = Math.round(info.resizer.rect.y + info.resizer.rect.h / 2);
  console.log('drag from ' + mx + ',' + my);
  await page.mouse.move(mx, my);
  await page.mouse.down();
  await page.mouse.move(mx, my + 60, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(2500);
  const seen = await page.evaluate(() => window.__rzEvents);
  console.log('events seen by resizer: ' + JSON.stringify(seen));
  console.log('networks after resize: ' + JSON.stringify(nets.slice(-4)));
  console.log('toasts after resize: ' + (await page.textContent('#toasts')).trim().slice(0, 200));
  const chipAfter = await page.evaluate((t) => {
    for (const e of document.querySelectorAll('.fc-event')) {
      if (e.textContent.includes(t)) return { h: e.getBoundingClientRect().height, cls: e.className };
    }
    return null;
  }, title);
  console.log('chip after: ' + JSON.stringify(chipAfter));
} else {
  console.log('NO RESIZER — chip: ' + JSON.stringify(info.chip));
}

await browser.close();
