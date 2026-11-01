// probe-v7c — round 3: resizers (fc-lw/fc-ik), weekNumbers elements, active
// tab detection, timed-vs-allday chip discrimination, drag ghost shape.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const mat = JSON.parse(readFileSync('/tmp/local-material-2.json', 'utf8'));
const BASE = 'http://127.0.0.1:8081';
const SERVER = 'http://127.0.0.1:8788';

const browser = await chromium.launch({ args: ['--disable-web-security'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 300)); });

await page.goto(BASE + '/#server=' + SERVER + '&setup=' + mat.auth_ui_hex);
await page.waitForTimeout(400);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1800);

// create the probe events (fresh universe)
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'V7 probe timed');
await page.fill('input[aria-label="Starts date"]', '2026-11-04');
await page.fill('input[aria-label="Starts time"]', '22:00');
await page.fill('input[aria-label="Ends date"]', '2026-11-05');
await page.fill('input[aria-label="Ends time"]', '02:00');
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1500);
await page.click('#btn-new-event');
await page.fill('input[aria-label="Title"]', 'V7 probe allday');
await page.fill('input[aria-label="Starts date"]', '2026-11-12');
await page.fill('input[aria-label="Ends date"]', '2026-11-16');
await page.check('#editor-modal .fullday-recurrency input[type=checkbox]');
await page.click('#editor-modal .button-primary');
await page.waitForTimeout(1500);

// month view Nov, day view Nov 4 (has the timed 22:00-02:00 event)
await page.click('#calendar button[aria-label="Month view"]');
await page.waitForTimeout(500);
await page.click('#calendar button[aria-label^="Next"]');
await page.waitForTimeout(700);
await page.click('[role="cell"][data-date="2026-11-04"] [role="link"]');
await page.waitForTimeout(800);

// active tab
const tab = await page.evaluate(() => {
  const t = document.querySelector('#calendar [role="tab"][aria-selected="true"]');
  return { label: t?.getAttribute('aria-label'), text: t?.textContent.trim() };
});
console.log('ACTIVE-TAB:', JSON.stringify(tab));

// hover via Playwright .hover() on the timed chip, then dump ALL descendants
const chipLoc = page.locator('.fc-event', { hasText: 'V7 probe timed' }).first();
await chipLoc.hover();
await page.waitForTimeout(600);
const chipDump = await page.evaluate(() => {
  const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 probe timed'));
  if (!chip) return null;
  const dumpEl = (el, depth) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      depth, tag: el.tagName, cls: String(el.className).slice(0, 70),
      w: Math.round(r.width), h: Math.round(r.height),
      pos: cs.position, display: cs.display,
      cursor: cs.cursor, pe: cs.pointerEvents,
      kids: [...el.children].map((k) => dumpEl(k, depth + 1)),
    };
  };
  return dumpEl(chip, 0);
});
const findCls = (node, needle, acc = []) => {
  if (String(node.cls || '').includes(needle)) acc.push({ depth: node.depth, cls: node.cls, w: node.w, h: node.h, cursor: node.cursor });
  for (const k of node.kids || []) findCls(k, needle, acc);
  return acc;
};
console.log('CHIP-TREE-DEPTH2:', JSON.stringify({
  root: { cls: chipDump.cls, w: chipDump.w, h: chipDump.h },
  kids: (chipDump.kids || []).map((k) => ({ cls: k.cls, w: k.w, h: k.h, cursor: k.cursor, nkk: (k.kids || []).length })),
}));
console.log('FC-LW (end resizer):', JSON.stringify(findCls(chipDump, 'fc-lw')));
console.log('FC-IK (start resizer):', JSON.stringify(findCls(chipDump, 'fc-ik')));

// start a resize gesture: down on fc-lw, move, then CANCEL with Escape
const rz = await page.evaluate(() => {
  const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 probe timed'));
  const z = chip && chip.querySelector('.fc-lw');
  if (!z) return null;
  const r = z.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
});
console.log('RESIZER-RECT:', JSON.stringify(rz));
if (rz) {
  await page.mouse.move(rz.x, rz.y);
  await page.waitForTimeout(200);
  const rz2 = await page.evaluate(() => {
    const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 probe timed'));
    const z = chip && chip.querySelector('.fc-lw');
    if (!z) return null;
    const r = z.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  });
  console.log('RESIZER-RECT2 (hover):', JSON.stringify(rz2));
}

// week view Nov 9-15: timed vs allday discrimination
await page.click('#calendar button[aria-label="Week view"]');
await page.waitForTimeout(700);
await page.click('#calendar button[aria-label^="Next"]');
await page.waitForTimeout(700);
const wk = await page.evaluate(() => {
  const out = {};
  const chips = [...document.querySelectorAll('.fc-event')];
  out.chips = chips.map((c) => ({
    text: c.textContent.trim().slice(0, 22),
    parentRole: c.parentElement.getAttribute('role'),
    parentTag: c.parentElement.tagName,
    closestCellDate: c.closest('[role="cell"]')?.getAttribute('data-date'),
    closestCellCls: String(c.closest('[role="cell"]')?.className).slice(0, 30),
    inCell: !!c.closest('[role="cell"]'),
  }));
  // the two role=cell sets for 2026-11-12
  const cells = [...document.querySelectorAll('[role="cell"][data-date="2026-11-12"]')];
  out.cellSets = cells.map((c) => {
    const r = c.getBoundingClientRect();
    return { h: Math.round(r.height), y: Math.round(r.y), w: Math.round(r.width), containsChip: !!c.querySelector('.fc-event'), cls: String(c.className).slice(0, 40) };
  });
  return out;
});
console.log('WEEK-CHIPS:', JSON.stringify(wk, null, 2));

// week numbers ON
await page.click('#btn-settings');
await page.waitForSelector('#settings-modal:not([hidden])');
await page.check('#set-weeknumbers');
await page.waitForTimeout(300);
await page.click('#settings-modal button:has-text("Done")');
await page.waitForTimeout(400);
const wn = await page.evaluate(() => {
  const out = {};
  // in week view? switch to month
  out.weekViewWN = document.querySelectorAll('[data-week-number]').length;
  return out;
});
await page.click('#calendar button[aria-label="Month view"]');
await page.waitForTimeout(700);
const wnMonth = await page.evaluate(() => {
  const out = { n: document.querySelectorAll('[data-week-number]').length };
  const all = [...document.querySelectorAll('*')].filter((e) => /week/i.test(String(e.className)) || /week/i.test(e.getAttribute('aria-label') || ''));
  out.weekish = all.slice(0, 6).map((e) => ({ tag: e.tagName, cls: String(e.className).slice(0, 40), aria: e.getAttribute('aria-label'), text: e.textContent.trim().slice(0, 12) }));
  // any element whose text is a 1-2 digit number in the first column area?
  const cells = [...document.querySelectorAll('[role="cell"]')];
  const firstCol = cells.filter((c) => c.getBoundingClientRect().x < 400);
  out.firstColTexts = firstCol.slice(0, 8).map((c) => c.textContent.trim().slice(0, 10));
  return out;
});
console.log('WEEKNUMBERS:', JSON.stringify(wn), JSON.stringify(wnMonth, null, 2));
await page.screenshot({ path: '/tmp/probe-v7c-wn.png' });

// turn week numbers back off
await page.click('#btn-settings');
await page.waitForSelector('#settings-modal:not([hidden])');
await page.uncheck('#set-weeknumbers');
await page.click('#settings-modal button:has-text("Done")');

console.log('ERRORS:', errs.length, errs.slice(0, 5));
await browser.close();
