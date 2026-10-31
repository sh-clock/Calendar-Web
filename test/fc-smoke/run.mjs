// fc-smoke-run.mjs — verify the vendored FullCalendar bundles work together
// (construct, all view types incl. custom duration, DnD plugin present).
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const page1 = "http://127.0.0.1:8091/test/fc-smoke/index.html";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(page1);
await page.waitForTimeout(800);
const s = await page.evaluate(() => window.__fcsmoke);
console.log(JSON.stringify(s, null, 2));
let fail = 0;
const check = (name, cond) => { console.log((cond ? '  ok  ' : '  FAIL ') + name); if (!cond) fail++; };
check('global defined', s.loaded === 'object');
check('all plugin namespaces', Object.values(s.plugins).every(Boolean));
check('constructed', !!s.constructed);
check('events rendered', s.eventCount === 2);
check('week view', !!s.week);
check('year view', !!s.year);
check('list view', !!s.list);
check('custom 10-day view', !!s.custom);
check('no JS errors', errors.length === 0);
if (errors.length) console.log(errors.join('\n'));
await page.screenshot({ path: '/tmp/fc-smoke.png' });
await browser.close();
process.exit(fail ? 1 : 0);
