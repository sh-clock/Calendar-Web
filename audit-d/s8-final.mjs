#!/usr/bin/env node
/** S8 final local checks: /internal/backup shape, 40MiB drain status, manifest cleanliness, cal: leftover check. */
import { readFileSync, writeFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:8787';
const MAT = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const UI = MAT.auth_ui_hex;
const INTERNAL = process.env.INTERNAL_TOKEN;
const out = [];
const rec = (n, c, d) => { out.push({ n, ok: !!c, d }); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + d)); };

// 1. /internal/backup with INTERNAL token
{
  const r = await fetch(BASE + '/internal/backup', { method: 'POST', headers: { authorization: 'Bearer ' + INTERNAL } });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  rec('F1 POST /internal/backup (internal token) -> 200 {ok,day,rows}',
    r.status === 200 && j && j.ok === true && typeof j.day === 'string' && typeof j.rows === 'number', r.status + ':' + t.slice(0, 80));
  rec('F1 backup response leaks no ids/params', j && Object.keys(j).length === 3, Object.keys(j || {}).join(','));
}
// 2. 40MiB streamed PUT: capture the status before body error
{
  try {
    const gen = async function* () { let sent = 0; const blk = Buffer.alloc(1024 * 1024, 0x41); while (sent < 40 * 1048576) { yield blk; sent += blk.length; } };
    const res = await fetch(BASE + '/rows/s8-drain', { method: 'PUT', headers: { authorization: 'Bearer ' + UI, 'content-type': 'application/json' }, body: gen(), duplex: 'half' });
    const status = res.status;
    let txt = '';
    try { txt = await res.text(); } catch (e) { txt = '(body read failed: ' + String(e).slice(0, 40) + ')'; }
    rec('F2 40MiB streamed PUT: status ' + status + ' (no hang)', status >= 400, status + ':' + txt.slice(0, 40));
  } catch (e) {
    rec('F2 40MiB streamed PUT: fetch threw (connection torn down, as designed)', /fetch failed|terminated|aborted/i.test(String(e)), String(e).slice(0, 80));
  }
}
// 3. manifest cleanliness on 8787 (my s8 rows all cleaned)
{
  const r = await fetch(BASE + '/rows', { headers: { authorization: 'Bearer ' + UI } });
  const j = JSON.parse(await r.text());
  const s8rows = j.rows.filter(x => x.id.startsWith('s8-')).map(x => x.id);
  rec('F3 local manifest has no leftover s8-* rows', s8rows.length === 0, JSON.stringify(s8rows));
}
writeFileSync('/home/z/my-project/calendar-web/audit-d/s8-final-local.json', JSON.stringify(out, null, 2));
