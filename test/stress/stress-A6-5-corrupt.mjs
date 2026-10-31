// stress-A6-5-corrupt.mjs — GROUP 5: CORRUPT DATA.
// (A) raw non-JSON garbage evt row (decryptRow's JSON.parse throws -> decrypt_failed)
// (B) JSON-wrapped payload that decrypts+parses but is NOT a VCALENDAR (bad_payload)
// Reload -> corrupt toast + sidebar note, app functional; healthy event in the
// SAME calendar still works; delete the calendar -> corrupt rows deleted server-side.
import { harness, decryptAll, findEvt, makeTally, putRawRow, getRawRow, MAT, SERVER } from './_lib.mjs';

const T = makeTally();
const h = await harness();
const { page } = h;
const sleep = (ms) => page.waitForTimeout(ms);

const manifestIds = async () => {
  const res = await fetch(SERVER + '/rows', { headers: { authorization: 'Bearer ' + MAT.auth_ui_hex } });
  return (await res.json()).rows.map((r) => r.id);
};

try {
  await h.unlock();

  /* ---- 5.1 create a second calendar + a healthy event inside it ---- */
  await page.click('#btn-add-calendar');
  await page.fill('#cal-modal input[aria-label="Name"]', 'A6 Corrupt Cal');
  let m = h.mark();
  await page.click('#cal-modal .button-primary');
  await sleep(1300);
  T.ok('calendar create = 1 PUT (cmeta)', h.puts(h.since(m)) === 1, JSON.stringify(h.since(m).map((r) => r.m)));

  const ids1 = await manifestIds();
  const cmetaIds = ids1.filter((i) => i.startsWith('cmeta:'));
  T.ok('two calendars exist server-side', cmetaIds.length === 2, cmetaIds.join(','));
  // identify the new calendar's uuid by decrypting its cmeta row
  const rows0 = await decryptAll();
  let calUuid = null;
  for (const id of cmetaIds) {
    const text = rows0[id];
    if (!text) continue;
    try { if (JSON.parse(text).name === 'A6 Corrupt Cal') calUuid = id.slice('cmeta:'.length); } catch { /* not meta */ }
  }
  T.ok('new calendar uuid resolved', !!calUuid, String(calUuid));

  await page.click('#btn-new-event');
  await page.fill('input[aria-label="Title"]', 'A6 healthy evt');
  await page.fill('input[aria-label="Starts date"]', '2026-11-19');
  await page.fill('input[aria-label="Starts time"]', '16:00');
  await page.fill('input[aria-label="Ends date"]', '2026-11-19');
  await page.fill('input[aria-label="Ends time"]', '17:00');
  await page.selectOption('select[aria-label="Calendar"]', { label: 'A6 Corrupt Cal' });
  m = h.mark();
  await page.click('#editor-modal .button-primary');
  await sleep(1300);
  T.ok('healthy event in new calendar = 1 PUT', h.puts(h.since(m)) === 1, JSON.stringify(h.since(m).map((r) => r.m)));

  /* ---- 5.2 write two corrupt rows into that calendar via the API ---- */
  const rawId = 'evt:' + calUuid + ':a6-raw-garbage';
  const jsonId = 'evt:' + calUuid + ':a6-json-bad';
  const rA = await putRawRow(rawId, 'definitely not a vcalendar, and not JSON either', 1, { wrap: false });
  T.ok('raw-garbage row PUT accepted (ver 1, 200)', rA.status === 200, rA.status + ' ' + rA.body.slice(0, 80));
  const rB = await putRawRow(jsonId, 'JSON-wrapped but NOT a VCALENDAR at all', 1);
  T.ok('json-bad row PUT accepted (ver 1, 200)', rB.status === 200, rB.status + ' ' + rB.body.slice(0, 80));
  const ids2 = await manifestIds();
  T.ok('manifest lists both corrupt rows', ids2.includes(rawId) && ids2.includes(jsonId));

  /* ---- 5.3 reload: corrupt toast + sidebar note + app functional ---- */
  await page.reload();
  await sleep(600);
  await page.fill('#password', 'password');
  await page.click('button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });

  let corruptToast = '';
  for (let i = 0; i < 20 && !corruptToast; i++) {
    await sleep(500);
    corruptToast = await page.evaluate(() =>
      [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).find((t) => t.includes('could not be decrypted')) || '');
  }
  T.ok('corrupt toast: "2 row(s) could not be decrypted — flagged, never rewritten."',
    corruptToast.includes('2 row(s) could not be decrypted'), corruptToast);
  const note = await page.evaluate(() => document.querySelector('.corrupt-note .cal-name')?.textContent || null);
  T.ok('sidebar note: "2 unreadable row(s)"', note === '2 unreadable row(s)', String(note));

  // no events rendered from the corrupt rows; no errors
  const corruptChips = await page.locator('.fc-event', { hasText: 'NOT a VCALENDAR' }).count()
    + await page.locator('.fc-event', { hasText: 'not a vcalendar' }).count();
  T.ok('corrupt rows render no chips', corruptChips === 0, 'chips=' + corruptChips);
  T.ok('no page errors after ingesting corrupt rows', h.pageErrors.length === 0, h.pageErrors.join('|').slice(0, 200));
  T.ok('no console errors after ingesting corrupt rows', h.consoleErrors.length === 0, h.consoleErrors.join('|').slice(0, 200));

  // app functional: healthy event of the SAME calendar renders + a new save works
  await page.click('.fc-dayGridMonth-button'); await sleep(500);
  await page.click('.fc-next-button'); await sleep(700); // November
  const healthy = await page.locator('.fc-event', { hasText: 'A6 healthy evt' }).count();
  T.ok('healthy event of the corrupt calendar still renders', healthy === 1, 'chips=' + healthy);

  await page.click('#btn-new-event');
  await page.fill('input[aria-label="Title"]', 'A6 post-corrupt evt');
  await page.fill('input[aria-label="Starts date"]', '2026-11-25');
  await page.fill('input[aria-label="Starts time"]', '12:00');
  await page.fill('input[aria-label="Ends date"]', '2026-11-25');
  await page.fill('input[aria-label="Ends time"]', '13:00');
  await page.selectOption('select[aria-label="Calendar"]', { label: 'A6 Corrupt Cal' });
  m = h.mark();
  await page.click('#editor-modal .button-primary');
  await sleep(1400);
  T.ok('new event save works with corrupt rows present (1 PUT)', h.puts(h.since(m)) === 1, JSON.stringify(h.since(m).map((r) => r.m)));
  const postChips = await page.locator('.fc-event', { hasText: 'A6 post-corrupt evt' }).count();
  T.ok('new event renders', postChips === 1, 'chips=' + postChips);

  // sync button still fine (no busy hang)
  m = h.mark();
  await page.click('#btn-sync');
  await sleep(1500);
  T.ok('manual sync with corrupt rows completes (manifest read)', h.since(m).some((r) => r.u.includes('/rows')), JSON.stringify(h.since(m).map((r) => r.m + r.u).slice(0, 3)));
  T.ok('corrupt rows NOT rewritten by sync (no PUT/DELETE)', h.since(m).every((r) => r.m === 'GET' || r.m === 'POST'), JSON.stringify(h.since(m).map((r) => r.m)));

  /* ---- 5.4 delete the calendar -> corrupt rows deleted server-side ---- */
  await page.click('.calendar-list li:has-text("A6 Corrupt Cal") .item-more');
  await sleep(400);
  await page.click('.item-menu button.danger');
  await sleep(500);
  T.ok('delete-calendar confirm modal shown', await page.locator('#recur-modal').isVisible());
  m = h.mark();
  await page.click('#recur-modal button:has-text("Delete")');
  await sleep(2500);
  const delReqs = h.since(m).filter((r) => r.m === 'DELETE');
  T.ok('calendar delete fired 4 DELETEs (2 corrupt + 1 healthy + 1 new evt) + 1 cmeta = 5',
    delReqs.length === 5, JSON.stringify(delReqs.map((r) => r.u)));
  T.ok('DELETEs include the two CORRUPT row ids',
    delReqs.some((r) => r.u.includes('a6-raw-garbage')) && delReqs.some((r) => r.u.includes('a6-json-bad')),
    JSON.stringify(delReqs.map((r) => r.u)));

  const g1 = await getRawRow(rawId);
  const g2 = await getRawRow(jsonId);
  T.ok('raw-garbage row gone server-side (GET 404)', g1.status === 404, 'status=' + g1.status);
  T.ok('json-bad row gone server-side (GET 404)', g2.status === 404, 'status=' + g2.status);
  const ids3 = await manifestIds();
  T.ok('manifest no longer lists the corrupt rows', !ids3.includes(rawId) && !ids3.includes(jsonId));

  const noteAfter = await page.evaluate(() => document.querySelector('.corrupt-note .cal-name')?.textContent || null);
  T.ok('sidebar corrupt note cleared after calendar deletion', noteAfter === null, String(noteAfter));
  const calGone = await page.locator('.calendar-list li', { hasText: 'A6 Corrupt Cal' }).count();
  T.ok('calendar removed from sidebar', calGone === 0, 'items=' + calGone);
  await h.shot('g5-after-delete');
} catch (e) {
  T.ok('group 5 ran to completion', false, String(e));
  await h.shot('g5-crash');
}

T.ok('no page errors during group 5', h.pageErrors.length === 0, h.pageErrors.join(' | ').slice(0, 400));
T.ok('no console errors during group 5', h.consoleErrors.length === 0, h.consoleErrors.join(' | ').slice(0, 400));

console.log('\n=== GROUP 5 (CORRUPT DATA): ' + T.summary() + ' ===');
if (T.fail > 0) console.log('FAILURES: ' + T.failures.join(' ; ').slice(0, 600));
await h.close();
process.exit(T.fail > 0 ? 1 : 0);
