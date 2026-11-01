// reverify3 — disambiguate the Escape-desync: assert the choice modal is
// ACTUALLY open before dismissing; then Escape; sample chip position at
// 0/2/5 s. Repeat with backdrop click. Reference: Cancel button.
import { harness, decryptAll, findEvt, makeTally, gotoMonth } from './_lib.mjs';

const T = makeTally();
const h = await harness();
const { page } = h;
const sleep = (ms) => page.waitForTimeout(ms);

try {
  await h.unlock();
  await page.click('#btn-new-event');
  await page.fill('input[aria-label="Title"]', 'RV3 daily');
  await page.fill('input[aria-label="Starts date"]', '2026-11-05');
  await page.fill('input[aria-label="Starts time"]', '10:00');
  await page.fill('input[aria-label="Ends date"]', '2026-11-05');
  await page.fill('input[aria-label="Ends time"]', '11:00');
  await page.selectOption('select[aria-label="Frequency"]', 'DAILY');
  await page.click('#editor-modal .button-primary');
  await sleep(1200);
  await gotoMonth(page, '2026-11'); await sleep(600); // November (deterministic)

  const chipCount = (day) => page.evaluate((d) => {
    const cell = document.querySelector('[data-date="' + d + '"]');
    return cell ? [...cell.querySelectorAll('.fc-event')].filter((e) => e.textContent.includes('RV3 daily')).length : -1;
  }, day);

  async function monthDrag(fromDay, toDay) {
    const g = await page.evaluate(({ from, to }) => {
      const fromCell = document.querySelector('[data-date="' + from + '"]');
      const toCell = document.querySelector('[data-date="' + to + '"]');
      const chip = fromCell && [...fromCell.querySelectorAll('.fc-event')].find((e) => e.textContent.includes('RV3 daily'));
      if (!chip || !toCell) return null;
      const cb = chip.getBoundingClientRect();
      const tb = toCell.getBoundingClientRect();
      return { fx: cb.x + cb.width / 2, fy: cb.y + cb.height / 2, tx: tb.x + tb.width / 2, ty: tb.y + 10 };
    }, { from: fromDay, to: toDay });
    if (!g) throw new Error('geometry missing ' + fromDay + '->' + toDay);
    await page.mouse.move(h.R(g.fx), h.R(g.fy));
    await page.mouse.down();
    await page.mouse.move(h.R(g.tx), h.R(g.ty), { steps: 15 });
    await page.mouse.up();
  }

  const cases = [
    { name: 'Escape', dismiss: () => page.keyboard.press('Escape') },
    { name: 'backdrop', dismiss: () => page.mouse.click(5, 500) },
    { name: 'Cancel-btn', dismiss: () => page.click('#recur-modal button:has-text("Cancel")') },
  ];
  const targets = { Escape: '2026-11-07', backdrop: '2026-11-08', 'Cancel-btn': '2026-11-09' };

  for (const c of cases) {
    const target = targets[c.name];
    const m = h.mark();
    await monthDrag('2026-11-05', target);
    await sleep(900);
    const modalWasOpen = await page.locator('#recur-modal').isVisible();
    T.ok(c.name + ': choice modal WAS open after drag', modalWasOpen);
    await c.dismiss();
    await sleep(700);
    const putN = h.puts(h.since(m));
    const src = await chipCount('2026-11-05');
    const tgt = await chipCount(target);
    T.ok(c.name + ': 0 PUTs after dismissal', putN === 0, 'puts=' + putN);
    T.ok(c.name + ': chip back on Nov 5 immediately', src === 1 && tgt === 1, 'Nov5=' + src + ' ' + target + '=' + tgt);
    if (!(src === 1 && tgt === 1)) {
      await h.shot('rv3-' + c.name.replace(/[^a-z]/gi, '') + '-desync');
      await sleep(4000); // would autosync/renderAll heal it within 60s? sample at +5s
      const src5 = await chipCount('2026-11-05');
      const tgt5 = await chipCount(target);
      console.log('  ..   ' + c.name + ': +5s Nov5=' + src5 + ' ' + target + '=' + tgt5 + ' (still desynced unless 1/1)');
    }
    // restore view truth for the next case if the chip is stuck visually
    await page.click('#calendar button[aria-label="Agenda view"]'); await sleep(500);
    await page.click('#calendar button[aria-label="Month view"]'); await sleep(700);
  }

  const rows = await decryptAll();
  const ev = findEvt(rows, 'RV3 daily');
  T.ok('row intact after all 3 dismissals (1 VEVENT, no EXDATE)',
    !!ev && (ev.text.match(/BEGIN:VEVENT/g) || []).length === 1 && ev.exdate.length === 0,
    'vevents=' + (ev ? (ev.text.match(/BEGIN:VEVENT/g) || []).length : '?'));
} catch (e) {
  T.ok('reverify3 ran to completion', false, String(e));
  await h.shot('rv3-crash');
}

console.log('\n=== REVERIFY3: ' + T.summary() + ' ===');
if (T.fail > 0) console.log('FAILURES: ' + T.failures.join(' ; '));
await h.close();
process.exit(T.fail > 0 ? 1 : 0);
