// seed-prod.mjs — create REAL test events on the PRODUCTION worker via the
// v4.3 protocol path (RMW PUT with AAD(id,ver)). Also performs the one-time
// cleanup of deprecated `cal:` bucket rows (protocol.md §13c: derived cache,
// never source of truth; the clock is unbuilt and the v4.3 client ignores them).
import { webcrypto } from 'node:crypto';
import { randomUUID } from 'node:crypto';

const BASE = 'https://calendar-poc.sh-clock.workers.dev';
const MAT = {
  kDataHex: '*SCRUBBED*<=',
  authUiHex: '*SCRUBBED*<=',
};
const K = Uint8Array.from(Buffer.from(MAT.kDataHex, 'hex'));
const AUTH = MAT.authUiHex;
const subtle = webcrypto.subtle;
const key = await subtle.importKey('raw', K, 'AES-GCM', false, ['encrypt', 'decrypt']);

const u32be = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
const aad = (id, ver) => Buffer.concat([Buffer.from(id, 'utf8'), u32be(ver)]);
const b64 = (u8) => Buffer.from(u8).toString('base64');

async function encRow(id, ver, payload) {
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  // §6: the plaintext is a JSON value — crypto.js encryptRow parity
  // (evt rows carry the VCALENDAR text JSON-encoded; cmeta rows carry
  // JSON.stringify(meta) JSON-encoded).
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad(id, ver) },
    key,
    Buffer.from(JSON.stringify(payload), 'utf8')
  );
  return { ver, nonce: b64(nonce), ct: b64(new Uint8Array(ct)) };
}

async function put(id, ver, payload) {
  const body = await encRow(id, ver, payload);
  const res = await fetch(BASE + '/rows/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + AUTH, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const stored = await res.json();
  if (stored.ver !== body.ver || stored.nonce !== body.nonce || stored.ct !== body.ct) {
    throw new Error('rebase on ' + id + ': ' + JSON.stringify(stored).slice(0, 120));
  }
  return stored;
}

async function del(id) {
  await fetch(BASE + '/rows/' + encodeURIComponent(id), { method: 'DELETE', headers: { authorization: 'Bearer ' + AUTH } });
}

const manifest = async () =>
  (await (await fetch(BASE + '/rows', { headers: { authorization: 'Bearer ' + AUTH } })).json()).rows;


// ---------- 0. repair: remove any rows written by the broken seed (raw-text payloads) ----------
{
  const rows = await manifest();
  const broken = [];
  for (const r of rows) {
    if (!r.id.startsWith('evt:') && !r.id.startsWith('cmeta:')) continue;
    const rr = await fetch(BASE + '/rows/' + encodeURIComponent(r.id), { headers: { authorization: 'Bearer ' + AUTH } });
    const env = await rr.json();
    try {
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(Buffer.from(env.nonce, 'base64')), additionalData: aad(r.id, env.ver) }, key, new Uint8Array(Buffer.from(env.ct, 'base64')));
      const v = JSON.parse(Buffer.from(pt).toString('utf8'));
      if (typeof v !== 'string') broken.push(r.id); // client rows decrypt to a STRING
    } catch {
      broken.push(r.id);
    }
  }
  for (const id of broken) await del(id);
  console.log('repaired (removed raw-payload rows):', broken.length);
}

// ---------- 1. one-time cleanup of deprecated cal: bucket rows ----------
{
  const rows = await manifest();
  const buckets = rows.filter((r) => r.id.startsWith('cal:'));
  for (const b of buckets) await del(b.id);
  console.log('deprecated cal: bucket rows removed:', buckets.length);
}

// ---------- 2. a second calendar ("Personal", different color) ----------
const personalUuid = randomUUID();
await put('cmeta:' + personalUuid, 1, JSON.stringify({ v: 1, name: 'Personal', color: '#EC3E7C' }));
console.log('created calendar: Personal (#EC3E7C)');

// The existing default calendar uuid (from the manifest)
const rows0 = await manifest();
const cmetas = rows0.filter((r) => r.id.startsWith('cmeta:') && r.id !== 'cmeta:' + personalUuid);
const mainUuid = cmetas.length ? cmetas[0].id.slice(6) : randomUUID();
console.log('main calendar uuid:', mainUuid);

// ---------- 3. test events (single-source UIDs; RFC 5545 payloads) ----------
const today = new Date();
const p = (n) => String(n).padStart(2, '0');
const iso = (d) => d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
const ical = (d) => iso(d).replaceAll('-', '') + 'T' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + 'Z';
const day = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d).replaceAll('-', ''); };

function vevent({ uid, dtstart, dtend, rrule, summary, description, location, transp, alarms }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//sh-clock//Calendar PoC//EN',
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:' + ical(today),
    dtstart,
    dtend,
  ];
  if (rrule) lines.push(rrule);
  lines.push('SUMMARY:' + summary);
  if (description) lines.push('DESCRIPTION:' + description);
  if (location) lines.push('LOCATION:' + location);
  if (transp) lines.push('TRANSP:' + transp);
  for (const a of alarms || []) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:' + a, 'END:VALARM');
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

const spec = [
  {
    cal: mainUuid, uid: 'welcome-v43-' + randomUUID().slice(0, 8),
    title: 'Welcome to Calendar v4.3',
    payload: vevent({
      uid: null, // filled below
      dtstart: 'DTSTART;VALUE=DATE:' + day(0),
      dtend: 'DTEND;VALUE=DATE:' + day(1),
      summary: 'Welcome to Calendar v4.3',
      description: 'Created through the v4.3 protocol with ONE PUT request. Drag it\, edit it\, or delete it — everything stays end-to-end encrypted.',
      transp: 'TRANSPARENT',
    }),
  },
  {
    cal: mainUuid, uid: 'standup-' + randomUUID().slice(0, 8),
    title: 'Team standup',
    payload: vevent({
      uid: null,
      dtstart: 'DTSTART:' + day(0) + 'T093000Z',
      dtend: 'DTEND:' + day(0) + 'T100000Z',
      rrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      summary: 'Team standup',
      description: 'A recurring weekday event (RRULE) — try editing or dragging ONE occurrence.',
      alarms: ['-PT10M'],
    }),
  },
  {
    cal: personalUuid, uid: 'lunch-' + randomUUID().slice(0, 8),
    title: 'Lunch with Alex',
    payload: vevent({
      uid: null,
      dtstart: 'DTSTART:' + day(1) + 'T123000Z',
      dtend: 'DTEND:' + day(1) + 'T133000Z',
      summary: 'Lunch with Alex',
      location: 'Café on the corner',
    }),
  },
  {
    cal: mainUuid, uid: 'review-' + randomUUID().slice(0, 8),
    title: 'Project review',
    payload: vevent({
      uid: null,
      dtstart: 'DTSTART:' + day(5) + 'T140000Z',
      dtend: 'DTEND:' + day(5) + 'T153000Z',
      summary: 'Project review',
      description: 'Timed event five days out — check the week view.',
      alarms: ['-PT1H'],
    }),
  },
  {
    cal: personalUuid, uid: 'trip-' + randomUUID().slice(0, 8),
    title: 'Weekend trip',
    payload: vevent({
      uid: null,
      dtstart: 'DTSTART;VALUE=DATE:' + day(6),
      dtend: 'DTEND;VALUE=DATE:' + day(9),
      summary: 'Weekend trip',
      description: 'A multi-day all-day event (DTEND is exclusive: 3 days).',
      transp: 'TRANSPARENT',
    }),
  },
  {
    cal: mainUuid, uid: 'monthly-' + randomUUID().slice(0, 8),
    title: 'Monthly retrospective',
    payload: vevent({
      uid: null,
      dtstart: 'DTSTART:' + day(12) + 'T160000Z',
      dtend: 'DTEND:' + day(12) + 'T170000Z',
      rrule: 'RRULE:FREQ=MONTHLY',
      summary: 'Monthly retrospective',
    }),
  },
];

for (const ev of spec) {
  // inject the single-source UID into the payload (line 6 of the built text)
  ev.payload = ev.payload.replace('UID:null', 'UID:' + ev.uid);
  const id = 'evt:' + ev.cal + ':' + ev.uid;
  await put(id, 1, ev.payload);
  console.log('created event:', ev.title, '→', id);
}

// ---------- 4. verify ----------
const final = await manifest();
console.log('\nfinal production manifest: ' + final.length + ' rows');
for (const r of final) console.log('  ' + r.id + ' (ver ' + r.ver + ')');
