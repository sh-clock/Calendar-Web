#!/usr/bin/env node
/**
 * core-tasks.mjs — unit tests for the v4.5 VTODO (task) extension:
 * js/ical.js (VTODO component codec, STATUS vocabularies per component
 * type, VTODO-property round-trip) and js/calendar-core.js (task rows,
 * recurrence expansion with per-occurrence completion, §13 derivation
 * excluding completed tasks). These are the EXACT modules the browser runs.
 *
 * Semantics source: FossifyOrg/Calendar (GPL-3.0, semantics referenced
 * only): a task is an event-shaped component marked BEGIN:VTODO whose
 * completion is STATUS:COMPLETED (IcsExporter.writeTask); per-occurrence
 * completion for repeatable tasks. Our RFC-native analogue of Fossify's
 * per-occurrence rows: a RECURRENCE-ID exception with STATUS:COMPLETED.
 */
import {
  parseEvtPayload, serializeEvtPayload, expandEvtRow,
  deriveBucketEntries, deriveWindowBuckets, spanDays, evtId,
} from '../js/calendar-core.js';
import { parseVCalendar, serializeVCalendar } from '../js/ical.js';
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
function isNull(name, v) {
  if (v === null) pass++;
  else fails.push(`${name}: expected null, got ${JSON.stringify(v)}`);
}

/* ---------------- helpers ---------------- */

const VTODO_BASIC = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//sh-clock//Calendar PoC//EN',
  'BEGIN:VTODO',
  'UID:task-1',
  'DTSTAMP:20261101T000000Z',
  'DTSTART;TZID=Australia/Sydney:20261103T090000',
  'SUMMARY:Buy milk',
  'STATUS:NEEDS-ACTION',
  'END:VTODO',
  'END:VCALENDAR',
].join('\r\n');

const VTODO_COMPLETED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//sh-clock//Calendar PoC//EN',
  'BEGIN:VTODO',
  'UID:task-2',
  'DTSTAMP:20261101T000000Z',
  'DTSTART;VALUE=DATE:20261102',
  'SUMMARY:File taxes',
  'STATUS:COMPLETED',
  'END:VTODO',
  'END:VCALENDAR',
].join('\r\n');

/** A repeating task with its 2026-11-04 occurrence completed. */
const VTODO_RECURRING_PARTIAL = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//sh-clock//Calendar PoC//EN',
  'BEGIN:VTODO',
  'UID:task-3',
  'DTSTAMP:20261101T000000Z',
  'DTSTART;VALUE=DATE:20261102',
  'SUMMARY:Water plants',
  'STATUS:NEEDS-ACTION',
  'RRULE:FREQ=DAILY',
  'END:VTODO',
  'BEGIN:VTODO',
  'UID:task-3',
  'DTSTAMP:20261101T000000Z',
  'RECURRENCE-ID;VALUE=DATE:20261104',
  'DTSTART;VALUE=DATE:20261104',
  'SUMMARY:Water plants',
  'STATUS:COMPLETED',
  'END:VTODO',
  'END:VCALENDAR',
].join('\r\n');

const VTODO_WITH_FOREIGN_PROPS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//sh-clock//Calendar PoC//EN',
  'BEGIN:VTODO',
  'UID:task-4',
  'DTSTAMP:20261101T000000Z',
  'DTSTART;TZID=Australia/Sydney:20261103T090000',
  'DUE;TZID=Australia/Sydney:20261105T170000',
  'PRIORITY:5',
  'PERCENT-COMPLETE:40',
  'COMPLETED:20261103T120000Z',
  'STATUS:IN-PROCESS',
  'SUMMARY:Ship release',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT30M',
  'END:VALARM',
  'END:VTODO',
  'END:VCALENDAR',
].join('\r\n');

const taskRowId = (cal) => evtId(cal, 'task-1');

/* ---------------- ical.js: VTODO codec ---------------- */

{
  const cal = parseVCalendar(VTODO_BASIC);
  eq('vtodo parse: one component', cal.events.length, 1);
  eq('vtodo parse: type', cal.events[0].type, 'VTODO');
  eq('vtodo parse: summary', cal.events[0].summary, 'Buy milk');
  eq('vtodo parse: status', cal.events[0].status, 'NEEDS-ACTION');
  eq('vtodo parse: dtstart date', cal.events[0].dtstart.date, '2026-11-03');
  eq('vtodo parse: dtstart time', cal.events[0].dtstart.time, '09:00:00');
  eq('vtodo parse: dtstart tz', cal.events[0].dtstart.tz, 'Australia/Sydney');
}
{
  // Round-trip: parse → serialize → parse is stable (component kind kept).
  const cal = parseVCalendar(VTODO_BASIC);
  const text = serializeVCalendar(cal);
  ok('vtodo round-trip: BEGIN:VTODO emitted', text.includes('BEGIN:VTODO\r\n'));
  ok('vtodo round-trip: END:VTODO emitted', text.includes('END:VTODO\r\n'));
  ok('vtodo round-trip: no BEGIN:VEVENT', !text.includes('BEGIN:VEVENT'));
  const cal2 = parseVCalendar(text);
  eq('vtodo round-trip: type stable', cal2.events[0].type, 'VTODO');
  eq('vtodo round-trip: status stable', cal2.events[0].status, 'NEEDS-ACTION');
}
{
  // VEVENT payloads keep their kind through the same codec (regression).
  const evtText = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//sh-clock//Calendar PoC//EN',
    'BEGIN:VEVENT', 'UID:e1', 'DTSTAMP:20261101T000000Z',
    'DTSTART;TZID=Australia/Sydney:20261103T090000', 'SUMMARY:Meeting',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const cal = parseVCalendar(evtText);
  eq('vevent parse: type', cal.events[0].type, 'VEVENT');
  const text = serializeVCalendar(cal);
  ok('vevent round-trip: still VEVENT', text.includes('BEGIN:VEVENT\r\n') && !text.includes('BEGIN:VTODO'));
}
{
  // STATUS vocabularies are per component type (RFC 5545 §3.8.1.11).
  const mk = (type, status) => [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:x',
    'BEGIN:' + type, 'UID:s1', 'DTSTAMP:20261101T000000Z',
    'DTSTART:20261103T090000Z', 'STATUS:' + status,
    'END:' + type, 'END:VCALENDAR',
  ].join('\r\n');
  ok('status: VTODO NEEDS-ACTION ok', !!parseVCalendar(mk('VTODO', 'NEEDS-ACTION')));
  ok('status: VTODO COMPLETED ok', !!parseVCalendar(mk('VTODO', 'COMPLETED')));
  ok('status: VTODO IN-PROCESS ok', !!parseVCalendar(mk('VTODO', 'IN-PROCESS')));
  ok('status: VTODO CANCELLED ok', !!parseVCalendar(mk('VTODO', 'CANCELLED')));
  throws('status: VTODO CONFIRMED rejected', () => parseVCalendar(mk('VTODO', 'CONFIRMED')));
  ok('status: VEVENT CONFIRMED ok', !!parseVCalendar(mk('VEVENT', 'CONFIRMED')));
  throws('status: VEVENT COMPLETED rejected', () => parseVCalendar(mk('VEVENT', 'COMPLETED')));
  throws('status: VEVENT NEEDS-ACTION rejected', () => parseVCalendar(mk('VEVENT', 'NEEDS-ACTION')));
}
{
  // VTODO-specific properties round-trip VERBATIM through `extra`
  // (never dropped — a davx5-synced DUE/COMPLETED must survive our edits).
  const cal = parseVCalendar(VTODO_WITH_FOREIGN_PROPS);
  const text = serializeVCalendar(cal);
  ok('vtodo props: DUE round-trips', text.includes('DUE;TZID=Australia/Sydney:20261105T170000'));
  ok('vtodo props: PRIORITY round-trips', text.includes('PRIORITY:5'));
  ok('vtodo props: PERCENT-COMPLETE round-trips', text.includes('PERCENT-COMPLETE:40'));
  ok('vtodo props: COMPLETED round-trips', text.includes('COMPLETED:20261103T120000Z'));
  ok('vtodo props: STATUS IN-PROCESS kept', text.includes('STATUS:IN-PROCESS'));
  ok('vtodo props: VALARM round-trips', text.includes('TRIGGER:-PT30M'));
}
{
  // DTSTART is required for tasks too (this ecosystem's display constraint).
  const noStart = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:x',
    'BEGIN:VTODO', 'UID:t9', 'DTSTAMP:20261101T000000Z', 'SUMMARY:no start',
    'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
  throws('vtodo: missing DTSTART rejected', () => parseVCalendar(noStart));
}
{
  // Empty component set still rejected (renamed error, same semantics).
  const empty = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nEND:VCALENDAR';
  let err = null;
  try { parseVCalendar(empty); } catch (e) { err = e.message; }
  ok('empty calendar: no_components', err === 'no_components');
}

/* ---------------- calendar-core.js: task rows ---------------- */

{
  const p = parseEvtPayload(VTODO_BASIC);
  ok('task row: parses', !!p);
  ok('task row: isTask', p.isTask === true);
  eq('task row: master type', p.master.type, 'VTODO');
  eq('task row: exceptions', p.exceptions.length, 0);

  // Expansion: occurrence carries task + completion flags.
  const occs = expandEvtRow(p, taskRowId(randomUUID()), '2026-11-01', '2026-11-10');
  eq('task expand: one occurrence', occs.length, 1);
  ok('task expand: isTask', occs[0].isTask === true);
  ok('task expand: not completed', occs[0].isCompleted === false);
  ok('task expand: not cancelled', occs[0].isCancelled === false);
  eq('task expand: start date', occs[0].start.date, '2026-11-03');
}
{
  const p = parseEvtPayload(VTODO_COMPLETED);
  ok('completed task row: parses', !!p);
  const occs = expandEvtRow(p, evtId(randomUUID(), 'task-2'), '2026-11-01', '2026-11-10');
  eq('completed task expand: one occurrence', occs.length, 1);
  ok('completed task expand: isCompleted', occs[0].isCompleted === true);
}
{
  // Repeating task with ONE completed occurrence (Fossify's per-occurrence
  // semantics via the RFC-native exception mechanism).
  const p = parseEvtPayload(VTODO_RECURRING_PARTIAL);
  ok('recurring task row: parses', !!p);
  eq('recurring task row: one exception', p.exceptions.length, 1);
  const occs = expandEvtRow(p, evtId(randomUUID(), 'task-3'), '2026-11-01', '2026-11-10');
  eq('recurring task expand: 9 occurrences (daily 02..10)', occs.length, 9);
  const done = occs.filter((o) => o.isCompleted);
  eq('recurring task expand: exactly one completed', done.length, 1);
  eq('recurring task expand: completed on its day', done[0].start.date, '2026-11-04');
  ok('recurring task expand: others incomplete', occs.every((o) => o.start.date === '2026-11-04' ? o.isCompleted : !o.isCompleted));
}
{
  // MIXED component kinds in one row = corrupt (v4.5 row rule).
  const mixed = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:x',
    'BEGIN:VEVENT', 'UID:m1', 'DTSTAMP:20261101T000000Z',
    'DTSTART:20261103T090000Z', 'SUMMARY:evt', 'END:VEVENT',
    'BEGIN:VTODO', 'UID:m1', 'DTSTAMP:20261101T000000Z',
    'DTSTART:20261103T100000Z', 'SUMMARY:task', 'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');
  isNull('mixed row: rejected', parseEvtPayload(mixed));
}
{
  // A VTODO exception WITHOUT a recurring master is corrupt (same as events).
  const badEx = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:x',
    'BEGIN:VTODO', 'UID:t8', 'DTSTAMP:20261101T000000Z',
    'DTSTART;VALUE=DATE:20261102', 'SUMMARY:x', 'END:VTODO',
    'BEGIN:VTODO', 'UID:t8', 'DTSTAMP:20261101T000000Z',
    'RECURRENCE-ID;VALUE=DATE:20261103',
    'DTSTART;VALUE=DATE:20261103', 'SUMMARY:y', 'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');
  isNull('task exception without rrule: rejected', parseEvtPayload(badEx));
}
{
  // Serialize round-trip of a parsed task row is byte-stable.
  const p = parseEvtPayload(VTODO_RECURRING_PARTIAL);
  const t1 = serializeEvtPayload(p);
  const p2 = parseEvtPayload(t1);
  const t2 = serializeEvtPayload(p2);
  eq('task row serialize: byte-stable round-trip', t2, t1);
  ok('task row serialize: VTODO kind kept', p2.isTask === true);
}

/* ---------------- §13 derivation with tasks ---------------- */

{
  const cal = randomUUID();
  const pTask = parseEvtPayload(VTODO_BASIC);            // 2026-11-03 09:00, open
  const pDone = parseEvtPayload(VTODO_COMPLETED);        // 2026-11-02 all-day, COMPLETED
  const occTask = expandEvtRow(pTask, evtId(cal, 'task-1'), '2026-11-01', '2026-11-10');
  const occDone = expandEvtRow(pDone, evtId(cal, 'task-2'), '2026-11-01', '2026-11-10');

  const day3 = deriveBucketEntries([...occTask, ...occDone], '2026-11-03');
  eq('buckets: open task projected on its day', day3.length, 1);
  eq('buckets: open task priority (timed)', day3[0].priority, 2);
  eq('buckets: open task hour', day3[0].hh, 9);

  const day2 = deriveBucketEntries([...occTask, ...occDone], '2026-11-02');
  eq('buckets: completed task NOT projected', day2.length, 0);

  // All-day task projects at 00:00 with priority 1.
  const pAllDay = parseEvtPayload([
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:x',
    'BEGIN:VTODO', 'UID:task-5', 'DTSTAMP:20261101T000000Z',
    'DTSTART;VALUE=DATE:20261102', 'SUMMARY:All-day task', 'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n'));
  const occAD = expandEvtRow(pAllDay, evtId(cal, 'task-5'), '2026-11-01', '2026-11-10');
  const day2b = deriveBucketEntries(occAD, '2026-11-02');
  eq('buckets: all-day task projected', day2b.length, 1);
  eq('buckets: all-day task priority', day2b[0].priority, 1);
  eq('buckets: all-day task hh', day2b[0].hh, 0);

  // Window derivation end-to-end (what renderClockPreview consumes).
  const rows = new Map([
    [evtId(cal, 'task-1'), pTask],
    [evtId(cal, 'task-2'), pDone],
  ]);
  const win = deriveWindowBuckets(rows, '2026-11-01');
  eq('window: day 3 has the open task', (win.get('2026-11-03') || []).length, 1);
  eq('window: day 2 empty (completed task)', (win.get('2026-11-02') || []).length, 0);
}

/* ---------------- spanDays on tasks (no DTEND) ---------------- */

{
  const p = parseEvtPayload(VTODO_BASIC);
  eq('task span: single day', JSON.stringify(spanDays(p.master)), JSON.stringify({ first: '2026-11-03', last: '2026-11-03' }));
}

/* ---------------- report ---------------- */

console.log(`core-tasks: ${pass} passed, ${fails.length} failed`);
if (fails.length > 0) {
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(1);
}
