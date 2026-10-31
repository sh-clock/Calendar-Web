// probe10: replicate group-6 flow step by step; log WHEN the first RangeError lands.
import { harness } from './_lib.mjs';
const h = await harness();
const { page } = h;
const sleep = (ms) => page.waitForTimeout(ms);
const errs = [];
page.on('pageerror', (e) => errs.push(String((e && e.stack) || e)));
const step = (name) => console.log((errs.length ? '!!! ' : '    ') + name + '  [errors=' + errs.length + ']');

await h.unlock();
step('unlock');

// 6.1 keyboard create
await page.keyboard.press('n'); await sleep(600);
await page.keyboard.type('A6 keyboard evt');
await page.evaluate(() => document.querySelector('#editor-modal input[aria-label="Starts date"]').focus());
await page.keyboard.press('Control+a'); await page.keyboard.type('2026-11-26');
await page.evaluate(() => document.querySelector('#editor-modal input[aria-label="Starts time"]').focus());
await page.keyboard.press('Control+a'); await page.keyboard.type('08:00');
await page.evaluate(() => document.querySelector('#editor-modal input[aria-label="Ends date"]').focus());
await page.keyboard.press('Control+a'); await page.keyboard.type('2026-11-26');
await page.evaluate(() => document.querySelector('#editor-modal input[aria-label="Ends time"]').focus());
await page.keyboard.press('Control+a'); await page.keyboard.type('09:00');
await page.keyboard.press('Enter'); await sleep(1300);
step('keyboard create (Enter)');
if (await page.locator('#editor-modal').isVisible()) {
  await page.click('#editor-modal .button-primary'); await sleep(1300);
  step('fallback Save click');
}

// 6.2 escape-create
await page.keyboard.press('n'); await sleep(500);
await page.keyboard.type('A6 never saved');
await page.keyboard.press('Escape'); await sleep(500);
step('escape editor');

// 6.3 chip focus attempt — dump chip attrs too
await page.click('.fc-dayGridMonth-button'); await sleep(500);
await page.click('.fc-next-button'); await sleep(700);
const chipInfo = await page.evaluate(() => {
  const chip = [...document.querySelectorAll('.fc-daygrid-day .fc-event')].find((e) => e.textContent.includes('A6 keyboard evt'));
  if (!chip) return null;
  return { attrs: [...chip.attributes].map((a) => a.name + '=' + a.value).join(' '), tag: chip.tagName, focusable: chip.focus === undefined ? null : (chip.focus(), document.activeElement === chip) };
});
console.log('chip:', JSON.stringify(chipInfo));
await page.keyboard.press('Enter'); await sleep(700);
step('Enter on (unfocused) chip');
await page.keyboard.press('Escape'); await sleep(400);
step('Escape (no popover)');

// 6.4 Tab x40
for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
const foc = await page.evaluate(() => document.activeElement ? (document.activeElement.id || document.activeElement.getAttribute('aria-label') || document.activeElement.tagName) : 'none');
console.log('focused after 40 tabs:', foc);
step('Tab x40');
await page.click('#btn-settings'); await sleep(400);
await page.keyboard.press('Escape'); await sleep(300);
step('settings open + Escape');

// 6.5 editor + blocked keys
await page.keyboard.press('n'); await sleep(400);
for (const key of ['d', 'w', 'm', 'y', 'v', 'a']) await page.keyboard.press(key);
await sleep(400);
step('blocked keys with editor open');
await page.keyboard.press('Escape'); await sleep(300);
await page.evaluate(() => {
  const chip = [...document.querySelectorAll('.fc-daygrid-day .fc-event')].find((e) => e.textContent.includes('A6 keyboard evt'));
  if (chip) chip.focus();
});
await page.keyboard.press('Enter'); await sleep(600);
step('chip.focus + Enter (2nd attempt)');
for (const key of ['d', 'w', 'm', 'y', 'v', 'a']) await page.keyboard.press(key);
await sleep(400);
step('keys with (no) popover open');
console.log('view now:', await page.evaluate(() => document.querySelector('.fc-view')?.className?.split(' ').find((c) => c.endsWith('-view'))));

// 6.6 first toolbar batch
for (let i = 0; i < 20; i++) { await page.click('.fc-prev-button'); await sleep(15); }
await sleep(400);
step('20x prev');
if (errs.length) console.log('FIRST STACK:\n' + errs[0]);
console.log('total errors:', errs.length);
await h.close();
