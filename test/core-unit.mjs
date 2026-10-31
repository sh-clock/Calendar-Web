#!/usr/bin/env node
/**
 * core-unit.mjs — unit tests for the v4.2 client core: js/ical.js (RFC 5545
 * codec) and js/calendar-core.js (row model, recurrence expansion, §13
 * derivation). These are the EXACT modules the browser runs.
 */
import {
  bucketId, parseBucketId, addDays, windowDays, localToday, validDate,
  clockPreviewDays, cmetaId, parseCmetaId, evtId, parseEvtId,
  validateCalendarMeta, newCalendarMeta, parseEvtPayload, serializeEvtPayload,
  effectiveEnd, spanDays, expandEvtRow, validateBucketEvent, normalizeBucket,
  deriveBucketEntries, capDerived, sortBucketEvents, deriveWindowBuckets,
  PALETTE, CAP_PER_BUCKET, PROJ_PREFIX, projIdHash,
} from '../js/calendar-core.js';
import {
  unfoldLines, foldLine, escapeText, unescapeText, parseContentLine,
  formatContentLine, parseDTValue, formatDTValue, sameWall, parseDuration,
  formatDuration, triggerMinutes, parseVCalendar, serializeVCalendar,
} from '../js/ical.js';
import { randomUUID } from 'node:crypto';

let pass = 0;
const fails = [];
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else fails.push(`${name}: got ${a}, want ${e}`);
}
function ok(name, cond, detail) {
  if (cond) pass++;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}
function throws(name, fn) {
  try {
    fn();
    fails.push(`${name}: expected throw`);
  } catch {
    pass++;
  }
}

const V = (lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN', ...lines, 'END:VCALENDAR'].join('\r\n');
const evLines = (o) => {
  const l = ['BEGIN:VEVENT', 'UID:' + (o.uid || randomUUID())];
  if (o.dtstamp) l.push(o.dtstamp);
  if (o.recId) l.push(o.recId);
  l.push(o.dtstart);
  if (o.dtend) l.push(o.dtend);
  if (o.rrule) l.push('RRULE:' + o.rrule);
  if (o.exdate) l.push(o.exdate);
  if (o.rdate) l.push(o.rdate);
  if (o.summary) l.push('SUMMARY:' + o.summary);
  if (o.extra) l.push(o.extra);
  if (o.alarmLines) l.push(...o.alarmLines); // INSIDE the VEVENT (RFC 5545)
  l.push('END:VEVENT');
  return l;
};

/* ================ ical.js: folding ================ */
eq('unfold joins continuation lines', unfoldLines('A:1\r\n B\r\n\tC'), ['A:1BC']);
eq('unfold accepts LF endings', unfoldLines('A:1\n B'), ['A:1B']);
eq('unfold drops only trailing empties', unfoldLines('A:1\r\n\r\n'), ['A:1']);
ok('foldLine no-op under 75', foldLine('A:' + 'x'.repeat(60)) === 'A:' + 'x'.repeat(60));
{
  const long = 'SUMMARY:' + 'é'.repeat(50); // 2-byte chars: 8+100 octets
  const folded = foldLine(long);
  const parts = folded.split('\r\n ');
  ok('foldLine splits multibyte at 75 octets', parts.length >= 2 && new TextEncoder().encode(parts[0]).length <= 75, parts[0].length);
  eq('foldLine round-trips', parts.join(''), long);
}
/* ================ ical.js: TEXT escaping (§3.3.11) ================ */
eq('escapeText', escapeText('a;b,c\nd\\e'), 'a\\;b\\,c\\nd\\\\e');
eq('unescapeText', unescapeText('a\\;b\\,c\\nd\\\\e'), 'a;b,c\nd\\e');
eq('unescapeText accepts \\N', unescapeText('a\\Nb'), 'a\nb');
throws('unescapeText rejects dangling escape', () => unescapeText('a\\'));
throws('unescapeText rejects unknown escape', () => unescapeText('a\\q'));
/* ================ ical.js: content lines ================ */
eq('parseContentLine simple', parseContentLine('DTSTART:20261028T100000'), { name: 'DTSTART', params: [], value: '20261028T100000' });
eq('parseContentLine params', parseContentLine('DTSTART;TZID=Europe/Berlin;VALUE=DATE-TIME:20261028T100000'), {
  name: 'DTSTART', params: [['TZID', 'Europe/Berlin'], ['VALUE', 'DATE-TIME']], value: '20261028T100000',
});
eq('parseContentLine quoted param', parseContentLine('ATTENDEE;CN="Smith, John":mailto:a@b'), {
  name: 'ATTENDEE', params: [['CN', 'Smith, John']], value: 'mailto:a@b',
});
eq('formatContentLine quotes when needed', formatContentLine({ name: 'X', params: [['A', 'b;c']], value: 'v' }), 'X;A="b;c":v');
eq('formatContentLine plain', formatContentLine({ name: 'X', params: [['A', 'b']], value: 'v' }), 'X;A=b:v');
throws('parseContentLine rejects quote in name', () => parseContentLine('BAD"NAME:1'));
throws('parseContentLine rejects missing colon', () => parseContentLine('NOSEMICOLON'));
/* ================ ical.js: DATE / DATE-TIME ================ */
eq('parseDTValue datetime UTC', parseDTValue('20261028T100000Z', []), { date: '2026-10-28', time: '10:00:00', tz: 'UTC' });
eq('parseDTValue datetime TZID', parseDTValue('20261028T100000', [['TZID', 'Australia/Sydney']]), { date: '2026-10-28', time: '10:00:00', tz: 'Australia/Sydney' });
eq('parseDTValue floating', parseDTValue('20261028T100000', []), { date: '2026-10-28', time: '10:00:00', tz: null });
eq('parseDTValue DATE', parseDTValue('20261028', [['VALUE', 'DATE']]), { date: '2026-10-28', time: null, tz: null });
throws('parseDTValue rejects DATE param with datetime value (RFC mismatch)', () => parseDTValue('20261028T100000', [['VALUE', 'DATE']]));
throws('parseDTValue rejects UTC + TZID', () => parseDTValue('20261028T100000Z', [['TZID', 'X']]));
throws('parseDTValue rejects bad date', () => parseDTValue('20261131T100000', []));
throws('parseDTValue rejects hour 24', () => parseDTValue('20261028T240000', []));
eq('formatDTValue DATE', formatDTValue({ date: '2026-10-28', time: null, tz: null }), { value: '20261028', params: [['VALUE', 'DATE']] });
eq('formatDTValue UTC', formatDTValue({ date: '2026-10-28', time: '10:00:00', tz: 'UTC' }), { value: '20261028T100000Z', params: [] });
eq('formatDTValue TZID', formatDTValue({ date: '2026-10-28', time: '10:00:00', tz: 'Australia/Sydney' }), { value: '20261028T100000', params: [['TZID', 'Australia/Sydney']] });
eq('sameWall ignores tz', sameWall({ date: '2026-10-28', time: '10:00:00', tz: 'A' }, { date: '2026-10-28', time: '10:00:00', tz: 'B' }), true);
/* ================ ical.js: DURATION ================ */
eq('parseDuration simple', parseDuration('PT30M'), 1800);
eq('parseDuration weeks+days', parseDuration('P2W1DT3H'), 2 * 604800 + 86400 + 10800);
eq('parseDuration negative', parseDuration('-PT10M'), -600);
eq('parseDuration accepts zero (RFC grammar)', parseDuration('PT0S'), 0);
eq('formatDuration zero canonical', formatDuration(0), 'PT0S');
eq('formatDuration canonical', formatDuration(3661), 'PT1H1M1S');
eq('formatDuration day', formatDuration(86400), 'P1D');
eq('formatDuration negative', formatDuration(-600), '-PT10M');
eq('triggerMinutes', triggerMinutes('-PT15M'), 15);
eq('triggerMinutes null for positive', triggerMinutes('PT15M'), null);
eq('triggerMinutes null for garbage', triggerMinutes('XYZ'), null);
/* ================ ical.js: VCALENDAR structure ================ */
{
  const text = V([
    ...evLines({ dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART;TZID=Australia/Sydney:20261028T100000', dtend: 'DTEND;TZID=Australia/Sydney:20261028T110000', summary: 'Tea\\, with comma' }),
  ]);
  const cal = parseVCalendar(text);
  eq('parseVCalendar events count', cal.events.length, 1);
  eq('parseVCalendar summary unescaped', cal.events[0].summary, 'Tea, with comma');
  eq('parseVCalendar dtstart', cal.events[0].dtstart, { date: '2026-10-28', time: '10:00:00', tz: 'Australia/Sydney' });
  const rt = serializeVCalendar(cal);
  const cal2 = parseVCalendar(rt);
  eq('serialize round-trip: events', JSON.stringify(cal2.events), JSON.stringify(cal.events));
  ok('serialize emits CRLF + VERSION + PRODID', rt.includes('VERSION:2.0') && rt.includes('PRODID:') && rt.endsWith('END:VCALENDAR\r\n'));
}
{
  // Unknown properties + VALARM round-trip (VALARM nested inside VEVENT)
  const text = V([
    ...evLines({
      dtstamp: 'DTSTAMP:20260101T000000Z',
      dtstart: 'DTSTART:20261028T100000Z',
      extra: 'X-CUSTOM-FIELD;P=1:some\\,value',
      alarmLines: ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT30M', 'DESCRIPTION:Reminder', 'END:VALARM'],
    }),
  ]);
  const cal = parseVCalendar(text);
  eq('VALARM parsed', cal.events[0].alarms.length, 1);
  eq('VALARM trigger raw', cal.events[0].alarms[0].triggerRaw, '-PT30M');
  eq('unknown prop kept', cal.events[0].extra.length, 1);
  const cal2 = parseVCalendar(serializeVCalendar(cal));
  eq('alarm + unknown round-trip', JSON.stringify(cal2.events[0].alarms), JSON.stringify(cal.events[0].alarms));
  eq('unknown prop round-trip', cal2.events[0].extra[0].value, 'some\\,value');
}
{
  // EXDATE/RDATE grouping round-trip
  const text = V([
    ...evLines({
      dtstamp: 'DTSTAMP:20260101T000000Z',
      dtstart: 'DTSTART:20261028T100000Z',
      rrule: 'FREQ=DAILY',
      exdate: 'EXDATE:20261029T100000Z,20261030T100000Z',
      rdate: 'RDATE:20261101T100000Z,20261102T100000Z',
    }),
  ]);
  const cal = parseVCalendar(text);
  eq('EXDATE multi-value parsed', cal.events[0].exdates.length, 2);
  eq('RDATE multi-value parsed', cal.events[0].rdates.length, 2);
  const cal2 = parseVCalendar(serializeVCalendar(cal));
  eq('EXDATE round-trip', JSON.stringify(cal2.events[0].exdates), JSON.stringify(cal.events[0].exdates));
  eq('RDATE round-trip (regression: was dropped pre-fix)', JSON.stringify(cal2.events[0].rdates), JSON.stringify(cal.events[0].rdates));
}
throws('parseVCalendar rejects no VEVENT', () => parseVCalendar(V(['X-A:1'])));
throws('parseVCalendar rejects trailing content', () => parseVCalendar(V([...evLines({ dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z' })]) + '\r\nJUNK'));
throws('parseVCalendar rejects dtend+duration', () => parseVCalendar(V([
  ...evLines({ dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z', dtend: 'DTEND:20261028T110000Z', extra: 'DURATION:PT30M' }),
])));
throws('parseVCalendar rejects DATE/DATE-TIME mismatch', () => parseVCalendar(V([
  ...evLines({ dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART;VALUE=DATE:20261028', dtend: 'DTEND:20261028T110000Z' }),
])));

/* ================ core: ids & window (v4.1 retained) ================ */
eq('bucketId basic', bucketId('2026-11-03'), 'cal:20261103');
throws('bucketId rejects bad month', () => bucketId('2026-13-01'));
ok('addDays leap', addDays('2028-02-28', 1) === '2028-02-29');
eq('windowDays size', windowDays('2026-10-31').length, 23);
eq('windowDays bounds', [windowDays('2026-10-31')[0], windowDays('2026-10-31')[22]], ['2026-10-30', '2026-11-21']);
eq('clockPreviewDays size', clockPreviewDays('2026-10-31').length, 8);
eq('cmetaId/parseCmetaId', parseCmetaId(cmetaId('01234567-89ab-cdef-0123-456789abcdef')), '01234567-89ab-cdef-0123-456789abcdef');
throws('cmetaId rejects non-uuid', () => cmetaId('nope'));
{
  const { cal, uid } = { cal: '01234567-89ab-cdef-0123-456789abcdef', uid: 'abc-123@x' };
  eq('evtId/parseEvtId', parseEvtId(evtId(cal, uid)), { cal, uid });
  throws('evtId rejects colon in uid', () => evtId(cal, 'a:b'));
  throws('evtId rejects overlong uid', () => evtId(cal, 'x'.repeat(201)));
  eq('parseEvtId non-match', parseEvtId('evt:not-a-uid:x'), null);
}
eq('validateCalendarMeta ok', validateCalendarMeta({ v: 1, name: 'Work', color: '#8080ff' }), { v: 1, name: 'Work', color: '#8080FF' });
eq('validateCalendarMeta rejects bad color', validateCalendarMeta({ v: 1, name: 'W', color: '8080FF' }), null);
eq('validateCalendarMeta rejects v2', validateCalendarMeta({ v: 2, name: 'W', color: '#8080FF' }), null);
throws('newCalendarMeta throws on invalid', () => newCalendarMeta('', '#8080FF'));
eq('PALETTE size (Proton ACCENT_COLORS)', PALETTE.length, 20);

/* ================ core: parseEvtPayload ================ */
const CALID = '01234567-89ab-cdef-0123-456789abcdef';
{
  const p = parseEvtPayload(V(evLines({ dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z', summary: 'SUMMARY:One' })));
  ok('parseEvtPayload ok', !!p && p.calendar.events.length === 1 && p.master === p.calendar.events[0]);
}
ok('parseEvtPayload rejects 2 UIDs', !parseEvtPayload(V([
  ...evLines({ uid: 'a@x', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z' }),
  ...evLines({ uid: 'b@x', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261029T100000Z' }),
])));
ok('parseEvtPayload rejects missing master', !parseEvtPayload(V([
  ...evLines({ uid: 'a@x', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261029T100000Z', recId: 'RECURRENCE-ID:20261028T100000Z' }),
])));
ok('parseEvtPayload rejects duplicate RECURRENCE-ID', !parseEvtPayload(V([
  ...evLines({ uid: 'a@x', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z', rrule: 'FREQ=DAILY' }),
  ...evLines({ uid: 'a@x', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261029T100000Z', recId: 'RECURRENCE-ID:20261029T100000Z' }),
  ...evLines({ uid: 'a@x', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261030T100000Z', recId: 'RECURRENCE-ID:20261029T100000Z' }),
])));
ok('parseEvtPayload rejects SECONDLY', !parseEvtPayload(V(evLines({ dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z', rrule: 'FREQ=SECONDLY' }))));
ok('parseEvtPayload accepts FREQ-first with extras', !!parseEvtPayload(V(evLines({ dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10' }))));
ok('parseEvtPayload rejects garbage', !parseEvtPayload('not ical at all'));
ok('serializeEvtPayload round-trips', (() => {
  const p = parseEvtPayload(V(evLines({ dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z', rrule: 'FREQ=DAILY', exdate: 'EXDATE:20261029T100000Z' })));
  return JSON.stringify(parseEvtPayload(serializeEvtPayload(p)).calendar.events) === JSON.stringify(p.calendar.events);
})());

/* ================ core: effectiveEnd / spanDays (RFC 5545) ================ */
{
  const oneDay = { dtstart: { date: '2026-10-28', time: null, tz: null }, dtend: { date: '2026-10-29', time: null, tz: null } };
  eq('1-day all-day (DTEND exclusive) spans 1 day', spanDays(oneDay), { first: '2026-10-28', last: '2026-10-28' });
  const twoDay = { dtstart: { date: '2026-10-28', time: null, tz: null }, dtend: { date: '2026-10-30', time: null, tz: null } };
  eq('2-day all-day spans 2 days', spanDays(twoDay), { first: '2026-10-28', last: '2026-10-29' });
  const noEnd = { dtstart: { date: '2026-10-28', time: null, tz: null } };
  eq('all-day no DTEND defaults to 1 day', spanDays(noEnd), { first: '2026-10-28', last: '2026-10-28' });
  const midnight = { dtstart: { date: '2026-10-28', time: '22:00:00', tz: 'UTC' }, dtend: { date: '2026-10-29', time: '00:00:00', tz: 'UTC' } };
  eq('timed ending midnight ends on start day', spanDays(midnight), { first: '2026-10-28', last: '2026-10-28' });
  const overnight = { dtstart: { date: '2026-10-28', time: '22:00:00', tz: 'UTC' }, dtend: { date: '2026-10-29', time: '02:00:00', tz: 'UTC' } };
  eq('overnight event ends next day', spanDays(overnight), { first: '2026-10-28', last: '2026-10-29' });
  const dur = { dtstart: { date: '2026-10-28', time: '10:00:00', tz: 'UTC' }, duration: 7200 };
  eq('DURATION effectiveEnd', effectiveEnd(dur), { date: '2026-10-28', time: '12:00:00', tz: 'UTC' });
  const zero = { dtstart: { date: '2026-10-28', time: '10:00:00', tz: 'UTC' } };
  eq('timed no end = zero length', effectiveEnd(zero), { date: '2026-10-28', time: '10:00:00', tz: 'UTC' });
}

/* ================ core: expandEvtRow ================ */
const rowOf = (lines) => { const p = parseEvtPayload(V(lines)); return p; };
{
  // single timed event
  const p = rowOf(evLines({ uid: 's1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z', dtend: 'DTEND:20261028T110000Z', summary: 'SUMMARY:Single' }));
  const occs = expandEvtRow(p, evtId(CALID, 's1'), '2026-10-01', '2026-10-31');
  eq('single event expanded once', occs.length, 1);
  eq('single event start/end', [occs[0].start.date, occs[0].start.time, occs[0].end.time], ['2026-10-28', '10:00:00', '11:00:00']);
  eq('single event not exception', occs[0].isException, false);
  eq('expand outside range = empty', expandEvtRow(p, evtId(CALID, 's1'), '2026-11-01', '2026-11-30').length, 0);
}
{
  // weekly recurrence with EXDATE + exception override
  const p = rowOf([
    ...evLines({
      uid: 'r1', dtstamp: 'DTSTAMP:20260101T000000Z',
      dtstart: 'DTSTART;TZID=UTC:20261005T090000', dtend: 'DTEND;TZID=UTC:20261005T093000',
      rrule: 'FREQ=WEEKLY;BYDAY=MO', exdate: 'EXDATE;TZID=UTC:20261019T090000',
    }),
    ...evLines({
      uid: 'r1', dtstamp: 'DTSTAMP:20260101T000000Z', recId: 'RECURRENCE-ID;TZID=UTC:20261026T090000',
      dtstart: 'DTSTART;TZID=UTC:20261027T140000', dtend: 'DTEND;TZID=UTC:20261027T143000', summary: 'SUMMARY:Moved',
    }),
  ]);
  const occs = expandEvtRow(p, evtId(CALID, 'r1'), '2026-10-01', '2026-11-10');
  const days = occs.map((o) => o.start.date + (o.start.time ? 'T' + o.start.time : '')).sort();
  // Mondays in range: Oct 5,12,19(EXDATE),26(exception moved to Oct27 14:00), Nov 2,9
  eq('weekly: EXDATE dropped, exception moved, others present', days, [
    '2026-10-05T09:00:00', '2026-10-12T09:00:00', '2026-10-27T14:00:00', '2026-11-02T09:00:00', '2026-11-09T09:00:00',
  ]);
  const moved = occs.find((o) => o.start.date === '2026-10-27');
  eq('exception flagged', moved.isException, true);
  eq('exception recId preserved', [moved.recId.date, moved.recId.time], ['2026-10-26', '09:00:00']);
}
{
  // all-day recurring + cancelled exception
  const p = rowOf([
    ...evLines({ uid: 'r2', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART;VALUE=DATE:20261001', dtend: 'DTEND;VALUE=DATE:20261002', rrule: 'FREQ=DAILY' }),
    ...evLines({ uid: 'r2', dtstamp: 'DTSTAMP:20260101T000000Z', recId: 'RECURRENCE-ID;VALUE=DATE:20261003', dtstart: 'DTSTART;VALUE=DATE:20261003', dtend: 'DTEND;VALUE=DATE:20261004', extra: 'STATUS:CANCELLED' }),
  ]);
  const occs = expandEvtRow(p, evtId(CALID, 'r2'), '2026-10-01', '2026-10-05');
  // Contract: master occurrences in series order, then exceptions at their
  // own (possibly moved) dates; consumers sort before layout.
  eq('all-day daily occurrences', occs.map((o) => o.start.date), ['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-05', '2026-10-03']);
  eq('all-day occurrence dedup (no double Oct-3)', occs.filter((o) => o.start.date === '2026-10-03').length, 1);
  ok('all-day occurrence time is null', occs.every((o) => o.start.time === null && o.allDay));
  eq('cancelled exception flagged', occs.find((o) => o.start.date === '2026-10-03').isCancelled, true);
}
{
  // UNTIL (date form, all-day) and UNTIL (UTC form, timed)
  const pD = rowOf(evLines({ uid: 'u1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART;VALUE=DATE:20261001', dtend: 'DTEND;VALUE=DATE:20261002', rrule: 'FREQ=DAILY;UNTIL=20261003' }));
  eq('UNTIL date inclusive', expandEvtRow(pD, evtId(CALID, 'u1'), '2026-10-01', '2026-10-31').map((o) => o.start.date), ['2026-10-01', '2026-10-02', '2026-10-03']);
  const pT = rowOf(evLines({ uid: 'u2', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261001T120000Z', rrule: 'FREQ=DAILY;UNTIL=20261003T120000Z' }));
  eq('UNTIL UTC inclusive', expandEvtRow(pT, evtId(CALID, 'u2'), '2026-10-01', '2026-10-31').length, 3);
  const pC = rowOf(evLines({ uid: 'u3', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261001T120000Z', rrule: 'FREQ=DAILY;COUNT=2' }));
  eq('COUNT honored', expandEvtRow(pC, evtId(CALID, 'u3'), '2026-10-01', '2026-10-31').length, 2);
}
{
  // Recurring master occurrences carry their OWN shifted DTEND (regression:
  // occurrence components used to inherit the master's unshifted DTEND).
  const p = rowOf(evLines({
    uid: 'dtshift', dtstamp: 'DTSTAMP:20260101T000000Z',
    dtstart: 'DTSTART:20261005T093000Z', dtend: 'DTEND:20261005T100000Z',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
  }));
  const occs = expandEvtRow(p, evtId(CALID, 'dtshift'), '2026-10-01', '2026-10-31');
  const o12 = occs.find((o) => o.start.date === '2026-10-12');
  eq('occurrence end shifts with start (Oct 12)', [o12.start.time, o12.end.time, o12.end.date], ['09:30:00', '10:00:00', '2026-10-12']);
  const o19 = occs.find((o) => o.start.date === '2026-10-19');
  eq('occurrence end shifts with start (Oct 19)', [o19.end.date, o19.end.time], ['2026-10-19', '10:00:00']);
  // Multi-day all-day master: every occurrence spans one day at its own date.
  const p2 = rowOf(evLines({
    uid: 'dtshift2', dtstamp: 'DTSTAMP:20260101T000000Z',
    dtstart: 'DTSTART;VALUE=DATE:20261005', dtend: 'DTEND;VALUE=DATE:20261007', rrule: 'FREQ=WEEKLY;BYDAY=MO',
  }));
  const occs2 = expandEvtRow(p2, evtId(CALID, 'dtshift2'), '2026-10-01', '2026-10-31');
  const o12b = occs2.find((o) => o.start.date === '2026-10-12');
  // Master spans Oct 5-6 (DTEND Oct 7 exclusive); the Oct 12 occurrence
  // carries the SAME 2-day span at its own date.
  eq('multi-day occurrence span shifts (Oct 12-13)', spanDays(o12b.master), { first: '2026-10-12', last: '2026-10-13' });
}
{
  // monthly on day 31 (short months skip) + yearly
  const pM = rowOf(evLines({ uid: 'm1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261031T120000Z', rrule: 'FREQ=MONTHLY' }));
  const occs = expandEvtRow(pM, evtId(CALID, 'm1'), '2026-10-01', '2027-01-31');
  eq('monthly day-31 skips short months', occs.map((o) => o.start.date), ['2026-10-31', '2026-12-31', '2027-01-31']);
  const pY = rowOf(evLines({ uid: 'y1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20240229T120000Z', rrule: 'FREQ=YEARLY' }));
  eq('yearly leap day', expandEvtRow(pY, evtId(CALID, 'y1'), '2026-01-01', '2030-12-31').map((o) => o.start.date), ['2028-02-29']);
}
{
  // RDATE additional occurrences (regression: RDATE was not expanded pre-fix)
  const p = rowOf(evLines({
    uid: 'rd1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261005T090000Z',
    rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=2', rdate: 'RDATE:20261007T090000Z,20261101T090000Z',
  }));
  const occs = expandEvtRow(p, evtId(CALID, 'rd1'), '2026-10-01', '2026-11-30');
  eq('RDATE adds occurrences', occs.map((o) => o.start.date).sort(), ['2026-10-05', '2026-10-07', '2026-10-12', '2026-11-01']);
  // EXDATE on an RDATE date removes it
  const p2 = rowOf(evLines({
    uid: 'rd2', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261005T090000Z',
    rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=1', rdate: 'RDATE:20261007T090000Z', exdate: 'EXDATE:20261007T090000Z',
  }));
  eq('EXDATE removes RDATE occurrence', expandEvtRow(p2, evtId(CALID, 'rd2'), '2026-10-01', '2026-10-31').map((o) => o.start.date), ['2026-10-05']);
}
{
  // multi-day all-day spanning into range from before
  const p = rowOf(evLines({ uid: 'md1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART;VALUE=DATE:20260930', dtend: 'DTEND;VALUE=DATE:20261003' }));
  const occs = expandEvtRow(p, evtId(CALID, 'md1'), '2026-10-01', '2026-10-31');
  eq('multi-day overlapping range included', occs.length, 1);
  eq('multi-day span', spanDays(occs[0].master), { first: '2026-09-30', last: '2026-10-02' });
}

/* ================ core: §13 bucket derivation ================ */
{
  const mkOcc = (date, time, uid, summary, cancelled) => ({
    rowId: evtId(CALID, uid), calId: CALID, uid, recId: null,
    start: { date, time }, end: { date, time }, allDay: time === null,
    isException: false, isCancelled: !!cancelled,
    master: { dtstart: { date, time, tz: null }, dtend: { date, time: time === null ? null : time, tz: null }, summary, status: cancelled ? 'CANCELLED' : null, exdates: [], rdates: [], alarms: [], extra: [] },
  });
  const entries = deriveBucketEntries([
    mkOcc('2026-10-31', null, 'a1', 'AllDay'),
    mkOcc('2026-10-31', '10:00:00', 'b2', 'Ten'),
    mkOcc('2026-10-31', '09:30:00', 'c3', 'NineHalf'),
    mkOcc('2026-10-31', '08:00:00', 'd4', 'Cancelled', true),
  ], '2026-10-31');
  const pid = (uid) => 'x:' + projIdHash(CALID, uid);
  eq('deriveBucketEntries: cancelled excluded, (priority,id) derivation order', entries, [
    { id: pid('a1'), date: '2026-10-31', hh: 0, mm: 0, title: 'AllDay', priority: 1 },
    { id: pid('b2'), date: '2026-10-31', hh: 10, mm: 0, title: 'Ten', priority: 2 },
    { id: pid('c3'), date: '2026-10-31', hh: 9, mm: 30, title: 'NineHalf', priority: 2 },
  ]);
  eq('derived ids are UUID-shaped (§13 grammar)', entries.every((e) => /^[a-z]:[0-9a-f-]{36}$/.test(e.id)), true);
  eq('deriveBucketEntries display order via sortBucketEvents', sortBucketEvents(entries).map((e) => e.id), [pid('a1'), pid('c3'), pid('b2')]);
  eq('deriveBucketEntries validate (foreign UID now safe)', entries.every((e) => validateBucketEvent(e) !== null), true);
  const many = Array.from({ length: 20 }, (_, i) => mkOcc('2026-10-31', `0${Math.floor(i / 6)}:${(i * 7) % 60 < 10 ? '0' : ''}${(i * 7) % 60}:00`.replace(/^0(\d\d)/, '$1'), 'u' + i, 'E' + i));
  const capped = deriveBucketEntries(many, '2026-10-31');
  eq('deriveBucketEntries caps at 16', capped.length, 16);
  const sorted = [...capped].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
  eq('cap keeps (priority,id) head', JSON.stringify(capped), JSON.stringify(sorted));
}
eq('capDerived cap=16 default', capDerived(Array.from({ length: 20 }, (_, i) => ({ id: 'x:' + i, date: 'd', hh: 0, mm: 0, title: 't', priority: 2 }))).length, 16);
{
  const ev = { id: 'x:01234567-89ab-cdef-0123-456789abcdef', date: '2026-10-31', hh: 9, mm: 30, title: 'ok', priority: 2 };
  eq('validateBucketEvent ok', validateBucketEvent(ev), ev);
  eq('validateBucketEvent rejects bad id', validateBucketEvent({ ...ev, id: 'w:short' }), null);
  eq('validateBucketEvent rejects hh 24', validateBucketEvent({ ...ev, hh: 24 }), null);
  eq('validateBucketEvent rejects priority 256', validateBucketEvent({ ...ev, priority: 256 }), null);
  eq('normalizeBucket rejects dup ids', normalizeBucket({ events: [ev, ev] }), null);
  eq('normalizeBucket ok', normalizeBucket({ events: [ev] }), { events: [ev] });
  eq('sortBucketEvents order', sortBucketEvents([
    { id: 'b', hh: 10, mm: 0, priority: 2, title: 'x', date: 'd' },
    { id: 'a', hh: 9, mm: 30, priority: 2, title: 'x', date: 'd' },
    { id: 'c', hh: 9, mm: 30, priority: 1, title: 'x', date: 'd' },
  ]).map((e) => e.id), ['c', 'a', 'b']);
}
{
  // Full window derivation: recurring event + one-off; empty days stay empty.
  const today = '2026-10-31';
  const rows = new Map([
    [evtId(CALID, 'w1'), rowOf(evLines({ uid: 'w1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261102T080000Z', dtend: 'DTEND:20261102T083000Z', rrule: 'FREQ=DAILY;COUNT=3' }))],
    [evtId(CALID, 'o1'), rowOf(evLines({ uid: 'o1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART;VALUE=DATE:20261105', dtend: 'DTEND;VALUE=DATE:20261106' }))],
  ]);
  const buckets = deriveWindowBuckets(rows, today);
  eq('window size', buckets.size, 23);
  eq('day0 empty (today-1)', buckets.get('2026-10-30'), []);
  eq('today empty', buckets.get(today), []);
  eq('Nov2 1 entry', buckets.get('2026-11-02'), [{ id: 'x:' + projIdHash(CALID, 'w1'), date: '2026-11-02', hh: 8, mm: 0, title: '(untitled)', priority: 2 }]);
  eq('Nov3 1 entry', buckets.get('2026-11-03')[0].id, 'x:' + projIdHash(CALID, 'w1'));
  eq('Nov4 (COUNT=3 end) 1 entry', buckets.get('2026-11-04')[0].id, 'x:' + projIdHash(CALID, 'w1'));
  eq('Nov5 all-day entry priority 1', buckets.get('2026-11-05'), [{ id: 'x:' + projIdHash(CALID, 'o1'), date: '2026-11-05', hh: 0, mm: 0, title: '(untitled)', priority: 1 }]);
  eq('Nov6 empty (after all-day)', buckets.get('2026-11-06'), []);
  eq('last day empty', buckets.get('2026-11-21'), []);
}
eq('PROJ_PREFIX is x', PROJ_PREFIX, 'x');
eq('CAP_PER_BUCKET 16', CAP_PER_BUCKET, 16);
eq('localToday shape', localToday().match(/^\d{4}-\d{2}-\d{2}$/) !== null, true);

/* ================ wave-4 regressions ================ */
{
  // W4-1: occurrence starting BEFORE fromDay whose span overlaps the window.
  const p = rowOf(evLines({
    uid: 'span1', dtstamp: 'DTSTAMP:20260101T000000Z',
    dtstart: 'DTSTART;VALUE=DATE:20261005', dtend: 'DTEND;VALUE=DATE:20261008', rrule: 'FREQ=WEEKLY',
  }));
  const occs = expandEvtRow(p, evtId(CALID, 'span1'), '2026-10-06', '2026-10-28');
  eq('span-overlap at leading edge: Oct 5 occurrence included', occs.some((o) => o.start.date === '2026-10-05'), true);
  const buckets = deriveWindowBuckets(new Map([[evtId(CALID, 'span1'), p]]), '2026-10-07');
  eq('deriveWindowBuckets leading edge: Oct 6 + Oct 7 covered', [
    buckets.get('2026-10-06').length, buckets.get('2026-10-07').length,
  ], [1, 1]);
}
{
  // W4-2: UTC (Z) EXDATE and RECURRENCE-ID against a TZID master.
  const p = rowOf([
    ...evLines({
      uid: 'tz1', dtstamp: 'DTSTAMP:20260101T000000Z',
      dtstart: 'DTSTART;TZID=Australia/Sydney:20261005T090000', dtend: 'DTEND;TZID=Australia/Sydney:20261005T093000',
      rrule: 'FREQ=DAILY', exdate: 'EXDATE:20261018T220000Z', // = Oct 19 09:00 Sydney
    }),
    ...evLines({
      uid: 'tz1', dtstamp: 'DTSTAMP:20260101T000000Z', recId: 'RECURRENCE-ID:20261016T220000Z', // = Oct 17 09:00 Sydney
      dtstart: 'DTSTART;TZID=Australia/Sydney:20261017T140000', dtend: 'DTEND;TZID=Australia/Sydney:20261017T143000',
    }),
  ]);
  const occs = expandEvtRow(p, evtId(CALID, 'tz1'), '2026-10-05', '2026-10-25');
  const days = occs.map((o) => o.start.date + 'T' + (o.start.time || ''));
  eq('Z-form EXDATE removed (Oct 19 absent)', days.includes('2026-10-19T09:00:00'), false);
  eq('Z-form RECURRENCE-ID overridden (Oct 17 original absent)', days.includes('2026-10-17T09:00:00'), false);
  eq('moved exception present', days.includes('2026-10-17T14:00:00'), true);
  eq('neighbor days intact', days.includes('2026-10-16T09:00:00') && days.includes('2026-10-20T09:00:00'), true);
}
{
  // W4-3: foreign (non-UUID) UID derives a valid bucket; two calendars differ.
  const mk = (cal, uid) => ({
    rowId: evtId(cal, uid), calId: cal, uid, recId: null,
    start: { date: '2026-10-31', time: '10:00:00' }, end: { date: '2026-10-31', time: '11:00:00' },
    allDay: false, isException: false, isCancelled: false,
    master: { dtstart: { date: '2026-10-31', time: '10:00:00', tz: null }, exdates: [], rdates: [], alarms: [], extra: [], summary: 'Foreign' },
  });
  const CAL2 = '89abcdef-89ab-cdef-89ab-cdef89abcdef';
  const entries = deriveBucketEntries([mk(CALID, '6a1r2fa3d8b9c0d1e2f3@google.com'), mk(CAL2, '6a1r2fa3d8b9c0d1e2f3@google.com')], '2026-10-31');
  eq('foreign UID derives 2 valid entries', entries.length, 2);
  eq('both entries pass validateBucketEvent', entries.every((e) => validateBucketEvent(e) !== null), true);
  eq('different calendars -> different ids', entries[0].id !== entries[1].id, true);
  eq('same input -> same hash (deterministic)', projIdHash(CALID, 'x@y') === projIdHash(CALID, 'x@y'), true);
  eq('hash is UUID-shaped', /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/.test(projIdHash(CALID, 'x@y')), true);
}
{
  // W4-4: RDATE duplicating an RRULE occurrence collapses (RFC union).
  const p = rowOf(evLines({
    uid: 'dup1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261005T090000Z',
    rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=1', rdate: 'RDATE:20261005T090000Z',
  }));
  const occs = expandEvtRow(p, evtId(CALID, 'dup1'), '2026-10-01', '2026-10-31');
  eq('RDATE=RRULE start collapses to one occurrence', occs.length, 1);
}
{
  // W4-5: TRIGGER params survive the round-trip.
  const text = V(evLines({
    uid: 'al1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z',
    alarmLines: ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;RELATED=END:-PT30M', 'DESCRIPTION:Before end', 'END:VALARM'],
  }));
  const cal = parseVCalendar(text);
  const rt = parseVCalendar(serializeVCalendar(cal));
  eq('TRIGGER params round-trip', JSON.stringify(rt.events[0].alarms[0].triggerParams), JSON.stringify([['RELATED', 'END']]));
}
{
  // W4-6: known TEXT property params survive the round-trip.
  const text = V(evLines({
    uid: 'pp1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z',
    extra: 'SUMMARY;LANGUAGE=en:Param summary',
  }));
  const cal = parseVCalendar(text);
  const rt = parseVCalendar(serializeVCalendar(cal));
  eq('SUMMARY params round-trip', JSON.stringify(rt.events[0].summaryParams), JSON.stringify([['LANGUAGE', 'en']]));
}
{
  // A8: floating UNTIL keeps its time-of-day.
  const p = rowOf(evLines({ uid: 'fu1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261001T120000', rrule: 'FREQ=DAILY;UNTIL=20261003T120000' }));
  eq('floating UNTIL keeps time (3 occurrences)', expandEvtRow(p, evtId(CALID, 'fu1'), '2026-10-01', '2026-10-31').length, 3);
}
{
  // A9: two masters rejected; A11a: exception without RRULE rejected.
  ok('two masters rejected', !parseEvtPayload(V([
    ...evLines({ uid: 'mm', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z' }),
    ...evLines({ uid: 'mm', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261029T100000Z' }),
  ])));
  ok('exception without RRULE rejected', !parseEvtPayload(V([
    ...evLines({ uid: 'nx', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z' }),
    ...evLines({ uid: 'nx', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261029T100000Z', recId: 'RECURRENCE-ID:20261028T100000Z' }),
  ])));
  throws('duplicate RRULE rejected', () => parseVCalendar(V([
    ...evLines({ uid: 'dr', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z', rrule: 'FREQ=DAILY', extra: 'RRULE:FREQ=WEEKLY' }),
  ])));
}
{
  // A10: PT0S accepted; RDATE;VALUE=PERIOD preserved verbatim (row survives).
  const p = parseEvtPayload(V(evLines({
    uid: 'pz', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z', extra: 'DURATION:PT0S',
  })));
  ok('PT0S accepted (zero-length event)', !!p);
  const p2 = parseEvtPayload(V(evLines({
    uid: 'per', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z',
    extra: 'RDATE;VALUE=PERIOD:20261029T090000Z/PT2H',
  })));
  ok('RDATE PERIOD tolerated (row parses)', !!p2);
  ok('RDATE PERIOD preserved verbatim', (() => {
    const rt = serializeVCalendar(p2.calendar);
    return rt.includes('RDATE;VALUE=PERIOD:20261029T090000Z/PT2H');
  })());
}
{
  // A13: derived title truncated to §13 cap; A14: UID > 200 rejected.
  const longTitle = 'T'.repeat(600);
  const occ = {
    rowId: evtId(CALID, 'tt'), calId: CALID, uid: 'tt', recId: null,
    start: { date: '2026-10-31', time: '10:00:00' }, end: { date: '2026-10-31', time: '11:00:00' },
    allDay: false, isException: false, isCancelled: false,
    master: { dtstart: { date: '2026-10-31', time: '10:00:00', tz: null }, exdates: [], rdates: [], alarms: [], extra: [], summary: longTitle },
  };
  const [entry] = deriveBucketEntries([occ], '2026-10-31');
  eq('derived title capped at 500', entry.title.length, 500);
  eq('capped entry validates', validateBucketEvent(entry) !== null, true);
  ok('UID > 200 rejected', !parseEvtPayload(V(evLines({ uid: 'u'.repeat(201), dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z' }))));
}

/* ================ wave-5 regressions ================ */
{
  // D1: RECURRENCE-ID value-type mismatch vs DTSTART rejected.
  ok('all-day master + datetime RECURRENCE-ID rejected', !parseEvtPayload(V([
    ...evLines({ uid: 'tm1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART;VALUE=DATE:20261001', dtend: 'DTEND;VALUE=DATE:20261002', rrule: 'FREQ=DAILY' }),
    ...evLines({ uid: 'tm1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART;VALUE=DATE:20261003', dtend: 'DTEND;VALUE=DATE:20261004', recId: 'RECURRENCE-ID:20261003T000000Z' }),
  ])));
  ok('timed master + DATE RECURRENCE-ID rejected', !parseEvtPayload(V([
    ...evLines({ uid: 'tm2', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261001T090000Z', rrule: 'FREQ=DAILY' }),
    ...evLines({ uid: 'tm2', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261003T140000Z', recId: 'RECURRENCE-ID;VALUE=DATE:20261003' }),
  ])));
}
{
  // D2: mixed valid+unparseable EXDATE/RDATE — all-or-nothing (no growth).
  const text = V(evLines({
    uid: 'mx1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261005T090000Z',
    rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=1', rdate: 'RDATE:20260101T120000Z,20260102T120000/PT1H',
  }));
  const p1 = parseEvtPayload(text);
  ok('mixed RDATE row parses', !!p1);
  const t2 = serializeVCalendar(p1.calendar);
  const p2 = parseEvtPayload(t2);
  const t3 = serializeVCalendar(p2.calendar);
  eq('mixed RDATE round-trip is byte-stable (no growth)', t2, t3);
  eq('no partial rdate entries from mixed property', p1.master.rdates.length, 0);
}
{
  // D3: PT0S + DTEND rejected (mutual exclusion covers zero).
  throws('DTEND + DURATION PT0S rejected', () => parseVCalendar(V([
    ...evLines({ uid: 'pz2', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z', dtend: 'DTEND:20261028T110000Z', extra: 'DURATION:PT0S' }),
  ])));
}
{
  // D4: duplicate RECURRENCE-ID in different forms (Z + TZID) rejected.
  ok('instant-equal duplicate RECURRENCE-ID rejected', !parseEvtPayload(V([
    ...evLines({ uid: 'dk1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART;TZID=UTC:20261005T090000', rrule: 'FREQ=DAILY' }),
    ...evLines({ uid: 'dk1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261006T140000Z', recId: 'RECURRENCE-ID:20261005T090000Z' }),
    ...evLines({ uid: 'dk1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261007T140000Z', recId: 'RECURRENCE-ID;TZID=UTC:20261005T090000' }),
  ])));
}
{
  // D5: duplicate TRIGGER in one VALARM rejected.
  throws('duplicate TRIGGER rejected', () => parseVCalendar(V([
    ...evLines({ uid: 'da1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261028T100000Z',
      alarmLines: ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT30M', 'TRIGGER:-PT10M', 'END:VALARM'] }),
  ])));
}
{
  // D6: RECURRENCE-ID RANGE=THISANDFUTURE param survives the round-trip.
  const text = V([
    ...evLines({ uid: 'rp1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261005T090000Z', rrule: 'FREQ=DAILY;COUNT=3' }),
    ...evLines({ uid: 'rp1', dtstamp: 'DTSTAMP:20260101T000000Z', dtstart: 'DTSTART:20261006T140000Z', recId: 'RECURRENCE-ID;RANGE=THISANDFUTURE:20261006T090000Z' }),
  ]);
  const p = parseEvtPayload(text);
  const rt = parseVCalendar(serializeVCalendar(p.calendar));
  const params = rt.events.find((e) => e.recurrenceId).recurrenceIdParams;
  eq('RANGE=THISANDFUTURE param round-trips', JSON.stringify(params), JSON.stringify([['RANGE', 'THISANDFUTURE']]));
}
{
  // D7: surrogate-safe title cap.
  const astral = '𝕏'.repeat(300); // 600 UTF-16 units, 300 code points
  const occ = {
    rowId: evtId(CALID, 'sg'), calId: CALID, uid: 'sg', recId: null,
    start: { date: '2026-10-31', time: '10:00:00' }, end: { date: '2026-10-31', time: '11:00:00' },
    allDay: false, isException: false, isCancelled: false,
    master: { dtstart: { date: '2026-10-31', time: '10:00:00', tz: null }, exdates: [], rdates: [], alarms: [], extra: [], summary: astral },
  };
  const entry = deriveBucketEntries([occ], '2026-10-31')[0];
  eq('astral title capped at 500 UTF-16 units', entry.title.length, 500);
  eq('cap lands on a code-point boundary', entry.title.endsWith(String.fromCodePoint(0x1D54F)), true);
  eq('capped entry validates', validateBucketEvent(entry) !== null, true);
}

/* ================ report ================ */
console.log(`core-unit: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(1);
}
