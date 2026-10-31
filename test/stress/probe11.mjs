// probe11: exact mechanics of keyboard-typing into the editor date/time inputs.
import { harness } from './_lib.mjs';
const h = await harness();
const { page } = h;
const sleep = (ms) => page.waitForTimeout(ms);
const errs = [];
page.on('pageerror', (e) => errs.push(String((e && e.stack) || e).split('\n').slice(0, 2).join(' <<')));
await h.unlock();

await page.keyboard.press('n'); await sleep(600);
await page.keyboard.type('P11 probe');

const val = (label) => page.evaluate((l) => document.querySelector('#editor-modal input[aria-label="' + l + '"]').value, label);

// date input: focus, clear, type char by char, log value after each
await page.evaluate(() => document.querySelector('#editor-modal input[aria-label="Starts date"]').focus());
await page.evaluate(() => document.execCommand('selectAll'));
const dateLog = [];
for (const ch of '2026-11-26') {
  await page.keyboard.type(ch);
  await sleep(40);
  dateLog.push(ch + '=>' + (await val('Starts date')));
}
console.log('DATE keystroke log:');
for (const l of dateLog) console.log('   ' + l);

// time input
await page.evaluate(() => document.querySelector('#editor-modal input[aria-label="Starts time"]').focus());
const timeLog = [];
for (const ch of '08:00') {
  await page.keyboard.type(ch);
  await sleep(40);
  timeLog.push(ch + '=>' + (await val('Starts time')));
}
console.log('TIME keystroke log:');
for (const l of timeLog) console.log('   ' + l);
console.log('pageerrors so far: ' + errs.length);
for (const e of errs) console.log('   ERR: ' + e);

// blur both (commit)
await page.evaluate(() => document.querySelector('#editor-modal input[aria-label="Ends date"]').focus());
await sleep(200);
console.log('after blur — Starts date:', await val('Starts date'), '| Starts time:', await val('Starts time'));
await page.keyboard.press('Escape');
await h.close();
