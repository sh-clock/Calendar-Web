import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:8080/?server=http://127.0.0.1:8787&setup=' + mat.auth_ui_hex);
await page.fill('#password', 'password');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1200);
const diag = await page.evaluate(() => {
  const c = document.querySelector('#btn-new-task');
  const m = document.querySelector('#btn-new-event');
  const g = document.querySelector('.newevent-group');
  const cs = getComputedStyle(c);
  const ms = getComputedStyle(m);
  const out = {
    caret: { height: cs.height, minHeight: cs.minHeight, lineHeight: cs.lineHeight, display: cs.display, alignItems: cs.alignItems, alignSelf: cs.alignSelf, boxSizing: cs.boxSizing, border: cs.border, fontSize: cs.fontSize, pad: cs.padding, flexBasis: cs.flexBasis, width: cs.width },
    main: { height: ms.height, minHeight: ms.minHeight, lineHeight: ms.lineHeight, boxSizing: ms.boxSizing },
    group: { display: getComputedStyle(g).display, alignItems: getComputedStyle(g).alignItems, height: getComputedStyle(g).height },
  };
  // scan all stylesheets for rules mentioning newtask-caret or newevent-group
  const hits = [];
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    const walk = (rs) => {
      for (const r of rs) {
        if (r.styleSheets) continue;
        if (r.selectorText && /newtask|newevent|sidebar/.test(r.selectorText)) {
          hits.push(sheet.href ? sheet.href.split('/').slice(-2).join('/') + ' ' : '(inline) ' + r.selectorText + ' { ' + r.style.cssText.slice(0, 120) + ' }');
        }
        if (r.cssRules) walk(r.cssRules);
      }
    };
    walk(rules);
  }
  out.rules = hits;
  return out;
});
console.log(JSON.stringify(diag, null, 1));
await browser.close();
