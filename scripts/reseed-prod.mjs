// reseed-prod.mjs — idempotent production reset for the SEEDED demo data:
// keeps the user's original "My calendar" (cmeta:ff1902f5…), removes every
// other evt/cmeta row, then creates ONE "Personal" calendar + 6 test events.
// All payloads follow the client wire format exactly (JSON-encoded §6
// plaintext, single-source UIDs, AAD(id,ver)).
import { webcrypto } from 'node:crypto';
import { randomUUID } from 'node:crypto';

// sec-S7-F1: material from the operator's git-ignored credentials file.
import { SERVER as BASE, K_DATA as K, AUTH_UI as AUTH } from './lib-prod-material.mjs';
const MAIN = 'ff1902f5-fa9e-4734-8090-44262abd0b1b';
const subtle = webcrypto.subtle;
const key = await subtle.importKey('raw', K, 'AES-GCM', false, ['encrypt']);

const u32be = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
const aad = (id, ver) => Buffer.concat([Buffer.from(id, 'utf8'), u32be(ver)]);
const b64 = (u8) => Buffer.from(u8).toString('base64');

async function put(id, ver, payload) {
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad(id, ver) },
    key,
    Buffer.from(JSON.stringify(payload), 'utf8') // §6: JSON value (crypto.js parity)
  );
  const body = { ver, nonce: b64(nonce), ct: b64(new Uint8Array(ct)) };
  const res = await fetch(BASE + '/rows/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + AUTH, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const stored = await res.json();
  if (stored.ver !== body.ver || stored.nonce !== body.nonce || stored.ct !== body.ct) {
    throw new Error('rebase on ' + id);
  }
}

async function del(id) {
  await fetch(BASE + '/rows/' + encodeURIComponent(id), { method: 'DELETE', headers: { authorization: 'Bearer ' + AUTH } });
}

const manifest = async () =>
  (await (await fetch(BASE + '/rows', { headers: { authorization: 'Bearer ' + AUTH } })).json()).rows;

// ---- 1. remove everything except the user's original calendar ----
{
  const rows = await manifest();
  let keptMain = false;
  for (const r of rows) {
    if (r.id === 'cmeta:' + MAIN) { keptMain = true; continue; }
    await del(r.id);
  }
  // A force re-bootstrap wipes EVERY row — the "original" cmeta included.
  // Recreate it so the MAIN-anchored events below always have their calendar
  // (the client drops events whose cmeta row is absent).
  if (!keptMain) {
    await put('cmeta:' + MAIN, 1, JSON.stringify({ v: 1, name: 'My calendar', color: '#0072BC' }));
    console.log('recreated calendar: My calendar (' + MAIN + ') — original was wiped by a rotation');
  } else {
    console.log('reset: kept My calendar');
  }
}

// ---- 2. one Personal calendar ----
const personal = randomUUID();
await put('cmeta:' + personal, 1, JSON.stringify({ v: 1, name: 'Personal', color: '#EC3E7C' }));
console.log('created calendar: Personal');

// ---- 3. events ----
const today = new Date();
const p = (n) => String(n).padStart(2, '0');
const iso = (d) => d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
const stamp = iso(today).replaceAll('-', '') + 'T' + p(today.getHours()) + p(today.getMinutes()) + p(today.getSeconds()) + 'Z';
const day = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d).replaceAll('-', ''); };

function vcal(uid, props) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//sh-clock//Calendar PoC//EN', 'BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:' + stamp];
  lines.push(...props);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

const mk = (cal, title, props) => {
  // sec-S6-F1: OPAQUE uid — a title slug leaks the summary into the
  // server-visible row id (manifest/URLs/D1 backup).
  const uid = randomUUID();
  return { id: 'evt:' + cal + ':' + uid, payload: vcal(uid, props) };
};

const events = [
  mk(MAIN, 'Welcome to Calendar v4.3', [
    'DTSTART;VALUE=DATE:' + day(0),
    'DTEND;VALUE=DATE:' + day(1),
    'SUMMARY:Welcome to Calendar v4.3',
    'DESCRIPTION:Created through the v4.3 protocol with ONE PUT request. Drag it\\, edit it\\, or delete it — everything stays end-to-end encrypted.',
    'TRANSP:TRANSPARENT',
  ]),
  mk(MAIN, 'Team standup', [
    'DTSTART:' + day(0) + 'T093000Z',
    'DTEND:' + day(0) + 'T100000Z',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    'SUMMARY:Team standup',
    'DESCRIPTION:A recurring weekday event (RRULE) — try editing or dragging ONE occurrence.',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM',
  ]),
  mk(personal, 'Lunch with Alex', [
    'DTSTART:' + day(1) + 'T123000Z',
    'DTEND:' + day(1) + 'T133000Z',
    'SUMMARY:Lunch with Alex',
    'LOCATION:Café on the corner',
  ]),
  mk(MAIN, 'Project review', [
    'DTSTART:' + day(5) + 'T140000Z',
    'DTEND:' + day(5) + 'T153000Z',
    'SUMMARY:Project review',
    'DESCRIPTION:Timed event five days out — check the week view.',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT1H', 'END:VALARM',
  ]),
  mk(personal, 'Weekend trip', [
    'DTSTART;VALUE=DATE:' + day(6),
    'DTEND;VALUE=DATE:' + day(9),
    'SUMMARY:Weekend trip',
    'DESCRIPTION:A multi-day all-day event (DTEND is exclusive: 3 days).',
    'TRANSP:TRANSPARENT',
  ]),
  mk(MAIN, 'Monthly retrospective', [
    'DTSTART:' + day(12) + 'T160000Z',
    'DTEND:' + day(12) + 'T170000Z',
    'RRULE:FREQ=MONTHLY',
    'SUMMARY:Monthly retrospective',
  ]),
];

for (const ev of events) {
  await put(ev.id, 1, ev.payload);
  console.log('created:', ev.id.split(':')[2].split('-').slice(0, 2).join('-'), '→', /SUMMARY:(.*)/.exec(ev.payload)[1]);
}

const final = await manifest();
console.log('\nfinal production manifest: ' + final.length + ' rows');
for (const r of final) console.log('  ' + r.id + ' (ver ' + r.ver + ')');
