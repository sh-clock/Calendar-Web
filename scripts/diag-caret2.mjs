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
  const out = [];
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    const walk = (rs) => {
      for (const r of rs) {
        if (r.selectorText) {
          try {
            if (document.querySelector(r.selectorText)) {
              const el = document.querySelector(r.selectorText);
              if (el === document.getElementById('btn-new-task') || el?.closest?.('.newevent-group')) {
                if (/button|newtask|newevent/.test(r.selectorText)) {
                  out.push((sheet.href ? sheet.href.split('/').slice(-2).join('/') : 'inline') + ' :: ' + r.selectorText + ' { ' + r.style.cssText.slice(0, 150) + ' }');
                }
              }
            }
          } catch { /* selector may be unsupported */ }
        }
        if (r.cssRules) walk(r.cssRules);
      }
    };
    walk(rules);
  }
  return out;
});
console.log(diag.join('\n'));
await browser.close();
