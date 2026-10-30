#!/usr/bin/env node
/**
 * core-unit.mjs — unit tests for js/calendar-core.js (the EXACT module the
 * browser runs). Window arithmetic, §13 ownership, 16/day cap, validation.
 */
import {
  bucketId, parseBucketId, addDays, windowDays, localToday, validDate,
  validateEvent, normalizeBucket, makeEvent, applyEvent, removeEvent,
  capEvents, sortEvents, clockPreviewDays, writerLabel, eventPrefix,
  WRITER_PREFIX, CAP_PER_BUCKET,
} from '../js/calendar-core.js';
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

/* ---- ids ---- */
eq('bucketId basic', bucketId('2026-11-03'), 'cal:20261103');
throws('bucketId rejects dashes-out', () => bucketId('20261103'));
throws('bucketId rejects bad month', () => bucketId('2026-13-01'));
throws('bucketId rejects bad day', () => bucketId('2026-11-32'));
throws('bucketId rejects 2026-02-30', () => bucketId('2026-02-30'));
ok('bucketId accepts 2028-02-29 (leap)', bucketId('2028-02-29') === 'cal:20280229');
eq('parseBucketId', parseBucketId('cal:20261103'), '2026-11-03');
eq('parseBucketId non-cal', parseBucketId('alm:abc'), null);
eq('parseBucketId short', parseBucketId('cal:2026113'), null);
eq('parseBucketId overflow', parseBucketId('cal:20261301'), '2026-13-01'); // regex-level; date reality checked by bucketId side

/* ---- dates ---- */
eq('addDays month end', addDays('2026-10-31', 1), '2026-11-01');
eq('addDays year end', addDays('2026-12-31', 1), '2027-01-01');
eq('addDays feb non-leap', addDays('2026-02-28', 1), '2026-03-01');
eq('addDays feb leap', addDays('2028-02-28', 1), '2028-02-29');
eq('addDays back', addDays('2026-03-01', -1), '2026-02-28');
ok('validDate rejects 2026-02-30', !validDate('2026-02-30'));
ok('validDate accepts 2026-02-28', validDate('2026-02-28'));
ok('localToday is a real date', validDate(localToday()));

/* ---- window (§13: 23 buckets [today-1 .. today+21]) ---- */
{
  const w = windowDays('2026-10-30');
  eq('window length', w.length, 23);
  eq('window first', w[0], '2026-10-29');
  eq('window last', w[22], '2026-11-20');
  ok('window includes today', w.includes('2026-10-30'));
}

/* ---- events ---- */
const ev = (over = {}) => ({
  id: 'w:' + randomUUID(), date: '2026-11-03', hh: 9, mm: 30,
  title: 'Standup', priority: 1, ...over,
});
ok('validateEvent ok', !!validateEvent(ev()));
ok('validateEvent rejects hh=24', !validateEvent(ev({ hh: 24 })));
ok('validateEvent rejects hh=-1', !validateEvent(ev({ hh: -1 })));
ok('validateEvent rejects mm=60', !validateEvent(ev({ mm: 60 })));
ok('validateEvent rejects empty title', !validateEvent(ev({ title: '' })));
ok('validateEvent rejects long title', !validateEvent(ev({ title: 'x'.repeat(501) })));
ok('validateEvent accepts 500-char title', !!validateEvent(ev({ title: 'x'.repeat(500) })));
ok('validateEvent rejects pri=256', !validateEvent(ev({ priority: 256 })));
ok('validateEvent rejects pri=-1', !validateEvent(ev({ priority: -1 })));
ok('validateEvent rejects bad id', !validateEvent(ev({ id: 'ww:' + randomUUID() })));
ok('validateEvent rejects non-uuid id', !validateEvent(ev({ id: 'w:not-a-uuid' })));
ok('validateEvent accepts other prefix', !!validateEvent(ev({ id: 'd:' + randomUUID() })));
ok('validateEvent rejects impossible date', !validateEvent(ev({ date: '2026-02-30' })));
ok('validateEvent rejects float hh', !validateEvent(ev({ hh: 9.5 })));

{
  const a = ev(), b = ev();
  eq('normalizeBucket ok', normalizeBucket({ events: [a, b] }), { events: [a, b] });
  eq('normalizeBucket rejects bad event', normalizeBucket({ events: [a, { junk: 1 }] }), null);
  eq('normalizeBucket rejects duplicate ids', normalizeBucket({ events: [a, a] }), null);
  eq('normalizeBucket rejects non-object', normalizeBucket(null), null);
  eq('normalizeBucket rejects missing events', normalizeBucket({}), null);
}
{
  const m = makeEvent({ date: '2026-11-03', hh: 8, mm: 0, title: 'Gym', priority: 2 });
  ok('makeEvent prefix w:', m.id.startsWith('w:'));
  ok('makeEvent valid', !!validateEvent(m));
  throws('makeEvent invalid fields', () => makeEvent({ date: '2026-11-03', hh: 25, mm: 0, title: 'x', priority: 0 }));
}

/* ---- §13 ownership ---- */
{
  const own = ev();
  const own2 = ev();
  const foreign = ev({ id: 'd:' + randomUUID() });
  const list = [foreign];
  eq('applyEvent appends own', applyEvent(list, own, 'w'), [foreign, own]);
  eq('applyEvent upserts own', applyEvent([own], { ...own, title: 'Renamed' }, 'w'), [{ ...own, title: 'Renamed' }]);
  throws('applyEvent rejects foreign upsert', () => applyEvent([], foreign, 'w'));
  throws('applyEvent rejects overwriting foreign slot', () => applyEvent([foreign], { ...foreign, title: 'Hacked' }, 'w'));
  eq('removeEvent removes own', removeEvent([own, own2], own.id, 'w'), { events: [own2], removed: true });
  eq('removeEvent missing', removeEvent([own], own2.id, 'w'), { events: [own], removed: false });
  throws('removeEvent rejects foreign', () => removeEvent([foreign], foreign.id, 'w'));
}

/* ---- §13 capacity: <=16/day, drop OWN lowest priority ---- */
{
  const mk = (p, i) => ev({ id: 'w:' + randomUUID(), priority: p, title: 'e' + i });
  const own17 = Array.from({ length: 17 }, (_, i) => mk(i % 5, i)); // priorities 0..4 spread
  const r = capEvents(own17, 'w');
  eq('cap 17 own -> 16', r.events.length, 16);
  eq('cap drops exactly 1', r.dropped.length, 1);
  ok('cap drops lowest priority', r.dropped.every((e) => e.priority === 4));

  const other14 = Array.from({ length: 14 }, () => ev({ id: 'd:' + randomUUID() }));
  const own10 = Array.from({ length: 10 }, (_, i) => mk(i % 4, i));
  const r2 = capEvents([...other14, ...own10], 'w');
  eq('cap mixed -> 16 total', r2.events.length, 16);
  eq('cap mixed keeps all 14 foreign', r2.events.filter((e) => e.id.startsWith('d:')).length, 14);
  eq('cap mixed drops 8 own', r2.dropped.length, 8);
  ok('cap never drops foreign', r2.dropped.every((e) => e.id.startsWith('w:')));

  const other17 = Array.from({ length: 17 }, () => ev({ id: 'd:' + randomUUID() }));
  const r3 = capEvents([...other17, ...own10], 'w');
  ok('cap over-cap foreign kept intact', r3.events.length === 17 && r3.events.every((e) => e.id.startsWith('d:')));
  eq('cap drops ALL own when foreign over cap', r3.dropped.length, 10);

  const under = Array.from({ length: 5 }, () => mk(1, 0));
  eq('cap under limit untouched', capEvents(under, 'w').dropped.length, 0);
}

/* ---- ordering / preview / labels ---- */
{
  const s = sortEvents([
    ev({ hh: 10, mm: 0, priority: 2 }),
    ev({ hh: 9, mm: 30, priority: 3 }),
    ev({ hh: 9, mm: 30, priority: 0 }),
  ]);
  ok('sortEvents by time then priority', s[0].priority === 0 && s[1].priority === 3 && s[2].hh === 10);
}
eq('clockPreviewDays length', clockPreviewDays('2026-10-30').length, 8);
eq('clockPreviewDays starts today', clockPreviewDays('2026-10-30')[0], '2026-10-30');
eq('writerLabel w', writerLabel('w'), 'this app');
eq('writerLabel d', writerLabel('d'), 'DAVx5');
eq('writerLabel t', writerLabel('t'), 'trudido');
eq('writerLabel unknown', writerLabel('q'), 'ext');
eq('eventPrefix', eventPrefix({ id: 'd:abc' }), 'd');
eq('CAP_PER_BUCKET', CAP_PER_BUCKET, 16);
eq('WRITER_PREFIX', WRITER_PREFIX, 'w');

console.log(`core-unit: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.error('  FAIL ' + f);
  process.exit(1);
}
