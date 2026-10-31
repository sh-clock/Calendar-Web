// check-seed.mjs — decrypt the production seeded rows and run them through
// the REAL client parser (core.parseEvtPayload) to see why they don't render.
import { webcrypto } from 'node:crypto';

const BASE = 'https://calendar-poc.sh-clock.workers.dev';
const K = Uint8Array.from(Buffer.from('*SCRUBBED*<=', 'hex'));
const AUTH = '*SCRUBBED*<=';
const subtle = webcrypto.subtle;
const key = await subtle.importKey('raw', K, 'AES-GCM', false, ['decrypt']);
const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
const aad = (id, ver) => Buffer.concat([Buffer.from(id, 'utf8'), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(ver); return b; })()]);

const { parseEvtPayload } = await import('../js/calendar-core.js');

const res = await fetch(BASE + '/rows', { headers: { authorization: 'Bearer ' + AUTH } });
const manifest = await res.json();
for (const r of manifest.rows.filter((x) => x.id.startsWith('evt:'))) {
  const rr = await fetch(BASE + '/rows/' + encodeURIComponent(r.id), { headers: { authorization: 'Bearer ' + AUTH } });
  const env = await rr.json();
  let txt;
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64(env.nonce), additionalData: aad(r.id, env.ver) }, key, b64(env.ct));
    txt = Buffer.from(pt).toString('utf8');
  } catch (e) { console.log(r.id, 'DECRYPT FAIL', e.message); continue; }
  let verdict = '?';
  try {
    const parsed = parseEvtPayload(txt);
    verdict = parsed ? 'PARSE OK (' + (parsed.master.rrule || 'non-recurring') + ')' : 'PARSE NULL (corrupt)';
  } catch (e) { verdict = 'PARSE THREW: ' + e.message; }
  console.log('=== ' + r.id.slice(0, 60) + ' → ' + verdict);
  console.log(txt.split('\r\n').filter((l) => /^(UID|DTSTART|DTEND|RRULE|SUMMARY)/.test(l)).join(' | '));
}
