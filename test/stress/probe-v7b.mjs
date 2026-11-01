// probe-v7b — round 2: week view WITH events, slot lanes vs labels, resizers,
// navLink day numbers, list/agenda structure, year view, toolbar title.
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

// navigate to November in month view, then probe navLink day number
await page.click('#calendar button[aria-label="Month view"]');
await page.waitForTimeout(600);
await page.click('#calendar button[aria-label^="Next"]');
await page.waitForTimeout(800);

const navlink = await page.evaluate(() => {
  const cell = document.querySelector('[role="cell"][data-date="2026-11-04"]');
  if (!cell) return null;
  const link = cell.querySelector('[role="link"], a, [tabindex]');
  return {
    cellRole: cell.getAttribute('role'),
    linkTag: link?.tagName, linkRole: link?.getAttribute('role'),
    linkAria: link?.getAttribute('aria-label'), linkTabindex: link?.getAttribute('tabindex'),
    linkText: link?.textContent.trim(), linkCls: String(link?.className).slice(0, 60),
    nRoleLinks: cell.querySelectorAll('[role="link"]').length,
    nAnchors: cell.querySelectorAll('a').length,
  };
});
console.log('NAVLINK:', JSON.stringify(navlink, null, 2));

// all-day spanning chip geometry in month view
const monthChip = await page.evaluate(() => {
  const cell = document.querySelector('[role="cell"][data-date="2026-11-12"]');
  const chip = cell && [...cell.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 probe allday'));
  if (!chip) return null;
  const r = chip.getBoundingClientRect();
  const c = cell.getBoundingClientRect();
  return {
    chipW: Math.round(r.width), cellW: Math.round(c.width), spans: Math.round(r.width / c.width * 10) / 10,
    chipCls: String(chip.className).slice(0, 90), chipRole: chip.getAttribute('role'),
    chipText: chip.textContent.trim().slice(0, 40),
    mainChild: chip.querySelector('.fc-event-main') ? 'has-main' : 'no-main',
    kids: [...chip.children].map((k) => k.tagName + ':' + String(k.className).slice(0, 25)),
  };
});
console.log('MONTH-ALLDAY-CHIP:', JSON.stringify(monthChip, null, 2));

// click the day number -> day view
await page.click('[role="cell"][data-date="2026-11-04"] [role="link"]');
await page.waitForTimeout(800);
const dayView = await page.evaluate(() => {
  const out = {};
  out.heading = document.querySelector('#calendar [role="heading"]')?.textContent;
  out.headerCols = [...document.querySelectorAll('[role="columnheader"]')].map((c) => c.getAttribute('data-date'));
  out.datedNonHeader = [...document.querySelectorAll('[data-date]')].filter((e) => e.getAttribute('role') !== 'columnheader').map((e) => ({
    d: e.getAttribute('data-date'), role: e.getAttribute('role'), tag: e.tagName,
    cls: String(e.className).slice(0, 30),
  }));
  // slot lanes vs labels
  const times = [...document.querySelectorAll('[data-time]')];
  out.nTimes = times.length;
  out.emptyTimes = times.filter((e) => !e.textContent.trim()).length;
  out.textTimes = times.filter((e) => e.textContent.trim()).length;
  out.sampleEmpty = times.filter((e) => !e.textContent.trim()).slice(0, 2).map((e) => ({
    t: e.getAttribute('data-time'), tag: e.tagName, role: e.getAttribute('role'),
    parentTag: e.parentElement.tagName, parentRole: e.parentElement.getAttribute('role'),
    parentCls: String(e.parentElement.className).slice(0, 40),
    gpTag: e.parentElement.parentElement.tagName, gpRole: e.parentElement.parentElement.getAttribute('role'),
  }));
  out.sampleText = times.filter((e) => e.textContent.trim()).slice(0, 3).map((e) => ({
    t: e.getAttribute('data-time'), text: e.textContent.trim(), tag: e.tagName, role: e.getAttribute('role'),
    parentTag: e.parentElement.tagName, parentRole: e.parentElement.getAttribute('role'),
    parentCls: String(e.parentElement.className).slice(0, 40),
  }));
  // timed chip
  const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 probe timed'));
  out.timedChip = chip ? {
    tag: chip.tagName, role: chip.getAttribute('role'), cls: String(chip.className).slice(0, 90),
    text: chip.textContent.trim().slice(0, 40),
    kids: [...chip.children].map((k) => k.tagName + ':' + String(k.className).slice(0, 30)),
    hasMain: !!chip.querySelector('.fc-event-main'),
    parentTag: chip.parentElement.tagName,
    parentAttrs: [...chip.parentElement.attributes].map((a) => a.name + '=' + a.value).join(' ').slice(0, 120),
    rect: ((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))(chip.getBoundingClientRect()),
  } : null;
  // first empty-time lane geometry
  const lanes = times.filter((e) => !e.textContent.trim());
  if (lanes.length) {
    const first = lanes[0].getBoundingClientRect();
    const last = lanes[lanes.length - 1].getBoundingClientRect();
    out.laneCount = lanes.length;
    out.pxPerSlot = Math.round((last.y + last.height - first.y) / lanes.length * 100) / 100;
    out.firstLaneY = Math.round(first.y);
  }
  return out;
});
console.log('DAY-VIEW:', JSON.stringify(dayView, null, 2));

// hover the timed chip -> resizers
const hoverPt = await page.evaluate(() => {
  const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 probe timed'));
  if (!chip) return null;
  const r = chip.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(hoverPt.x, hoverPt.y);
await page.waitForTimeout(500);
const resizers = await page.evaluate(() => {
  const chip = [...document.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('V7 probe timed'));
  if (!chip) return null;
  const all = [...chip.querySelectorAll('*')];
  return all.map((e) => {
    const r = e.getBoundingClientRect();
    return { tag: e.tagName, cls: String(e.className).slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), pos: getComputedStyle(e).position };
  }).filter((e) => e.w > 0 || e.h > 0).slice(0, 16);
});
console.log('RESIZERS-AFTER-HOVER:', JSON.stringify(resizers, null, 2));

// toolbar title element
const title = await page.evaluate(() => {
  const h = document.querySelector('#calendar [role="heading"]');
  return { text: h?.textContent, tag: h?.tagName, attrs: h ? [...h.attributes].map((a) => a.name).join(',') : null };
});
console.log('TITLE:', JSON.stringify(title));

// week view (current real week has no events; switch weeks to Nov 2-8)
await page.click('#calendar button[aria-label="Week view"]');
await page.waitForTimeout(700);
await page.click('#calendar button[aria-label^="Next"]');
await page.waitForTimeout(700);
const week = await page.evaluate(() => {
  const out = {};
  out.headerCols = [...document.querySelectorAll('[role="columnheader"]')].map((c) => c.getAttribute('data-date'));
  // distinguish all-day row cells vs timegrid columns
  out.datedNonHeader = [...document.querySelectorAll('[data-date]')].filter((e) => e.getAttribute('role') !== 'columnheader').map((e) => ({
    d: e.getAttribute('data-date'), role: e.getAttribute('role'), tag: e.tagName, cls: String(e.className).slice(0, 26),
  }));
  const times = [...document.querySelectorAll('[data-time]')];
  out.nTimes = times.length; out.emptyTimes = times.filter((e) => !e.textContent.trim()).length;
  // timed chips in week view: any .fc-event whose parent chain includes a [data-time]?
  const chips = [...document.querySelectorAll('.fc-event')];
  out.chips = chips.map((c) => {
    const r = c.getBoundingClientRect();
    return {
      text: c.textContent.trim().slice(0, 24), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      parentTag: c.parentElement.tagName,
      parentDataDate: c.parentElement.getAttribute('data-date'),
      closestDate: c.closest('[data-date]')?.getAttribute('data-date'),
      closestDateRole: c.closest('[data-date]')?.getAttribute('role'),
      inAllDaySection: !!c.closest('[role="cell"]'),
    };
  });
  return out;
});
console.log('WEEK-NOV2-8:', JSON.stringify(week, null, 2));

// all-day chip in week view (Nov 12 is next week — nav via next again)
await page.click('#calendar button[aria-label^="Next"]');
await page.waitForTimeout(700);
const week2 = await page.evaluate(() => {
  const chips = [...document.querySelectorAll('.fc-event')].map((c) => {
    const r = c.getBoundingClientRect();
    return {
      text: c.textContent.trim().slice(0, 24), w: Math.round(r.width),
      closestDate: c.closest('[data-date]')?.getAttribute('data-date'),
      closestDateRole: c.closest('[data-date]')?.getAttribute('role'),
      inCell: !!c.closest('[role="cell"]'),
    };
  });
  const allDayCells = [...document.querySelectorAll('[role="cell"][data-date]')].map((c) => c.getAttribute('data-date'));
  return { chips, allDayCells };
});
console.log('WEEK-NOV9-15:', JSON.stringify(week2, null, 2));

console.log('ERRORS:', errs.length, errs.slice(0, 5));
await browser.close();
