/**
 * calendar-core.js — pure calendar logic for PROTOCOL v4.2 (calendar
 * domain). NO DOM, NO fetch: imported by the browser UI and the Node test
 * suite, so every rule below is verified against exactly the code that runs
 * in production.
 *
 * v4.2 model (docs/PROTOCOL-v4.2.md):
 *  - `cmeta:{uuid}` rows — calendar metadata {v:1, name, color}.
 *  - `evt:{cal}:{uid}` rows — payload = RFC 5545 VCALENDAR text (one UID:
 *    master VEVENT + RECURRENCE-ID exceptions). Source of truth.
 *  - `cal:{yyyymmdd}` day buckets — DERIVED projection for the clock,
 *    v4.1 §13 format preserved; entry ids use the `x:{uid}` derived
 *    namespace. 23-day window rotation unchanged.
 *
 * v4.1 helpers retained verbatim: bucketId/parseBucketId, windowDays,
 * addDays, validDate, localToday, clockPreviewDays, normalizeBucket.
 */

import { RRule } from './vendor/rrule.mjs';
import {
  parseVCalendar, serializeVCalendar, parseDTValue, sameWall,
  triggerMinutes, wallToInstantUTC, formatDuration, tzOffsetMinutes,
} from './ical.js';

export const CAP_PER_BUCKET = 16; // §13
export const WINDOW_BACK = 1;     // [today-1 .. today+21] = 23 buckets (§13)
export const WINDOW_FWD = 21;
export const PROJ_PREFIX = 'x';   // v4.2 derived-projection namespace

/** Proton ACCENT_COLORS (WebClients packages/shared/lib/colors.ts, GPL-3.0). */
export const PALETTE = [
  '#8080FF', '#DB60D6', '#EC3E7C', '#F78400', '#936D58',
  '#5252CC', '#A839A4', '#BA1E55', '#C44800', '#54473F',
  '#415DF0', '#179FD9', '#1DA583', '#3CBB3A', '#B4A40E',
  '#273EB2', '#0A77A6', '#0F735A', '#258723', '#807304',
];

/* ---------------- date helpers (v4.1 verbatim) ---------------- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function bucketId(dateStr) {
  if (!validDate(dateStr)) throw new Error('bad_date');
  return 'cal:' + dateStr.replaceAll('-', '');
}

export function parseBucketId(id) {
  const m = /^cal:(\d{4})(\d{2})(\d{2})$/.exec(id);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function windowDays(today) {
  const out = [];
  for (let i = -WINDOW_BACK; i <= WINDOW_FWD; i++) out.push(addDays(today, i));
  return out;
}

export function localToday() {
  const d = new Date();
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

export function clockPreviewDays(today) {
  const out = [];
  for (let i = 0; i <= 7; i++) out.push(addDays(today, i));
  return out;
}

/* ---------------- row id grammar (v4.2) ---------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UID_MAX = 200; // docs/PROTOCOL-v4.2.md id budget

export function cmetaId(uuid) {
  if (!UUID_RE.test(uuid)) throw new Error('bad_uuid');
  return 'cmeta:' + uuid;
}

/** "cmeta:{uuid}" → uuid, or null. */
export function parseCmetaId(id) {
  const m = /^cmeta:([0-9a-f-]{36})$/.exec(id);
  return m ? m[1] : null;
}

export function evtId(calUuid, uid) {
  if (!UUID_RE.test(calUuid) || typeof uid !== 'string' || !uid || uid.includes(':') || uid.length > UID_MAX) {
    throw new Error('bad_evt_id');
  }
  return 'evt:' + calUuid + ':' + uid;
}

/** "evt:{cal}:{uid}" → {cal, uid}, or null. */
export function parseEvtId(id) {
  const m = /^evt:([0-9a-f-]{36}):([^:]{1,200})$/.exec(id);
  return m ? { cal: m[1], uid: m[2] } : null;
}

/* ---------------- calendar metadata ---------------- */

export function validateCalendarMeta(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.v !== 1) return null;
  if (typeof p.name !== 'string' || p.name.length === 0 || p.name.length > 100) return null;
  if (typeof p.color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(p.color)) return null;
  return { v: 1, name: p.name, color: p.color.toUpperCase() };
}

export function newCalendarMeta(name, color) {
  const m = validateCalendarMeta({ v: 1, name, color });
  if (!m) throw new Error('invalid_calendar');
  return m;
}

/* ---------------- evt row payload ---------------- */

/**
 * Validate + parse an evt row payload (VCALENDAR text).
 * Returns { calendar, master, exceptions:[], uids:[..] } or null when
 * structurally invalid (corrupt row: surfaced, never rewritten).
 * Enforces the v4.2 one-UID-per-row rule.
 */
export function parseEvtPayload(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 200000) return null;
  let cal;
  try {
    cal = parseVCalendar(text);
  } catch {
    return null;
  }
  const uids = new Set(cal.events.map((e) => e.uid));
  if (uids.size !== 1) return null;
  const uid = cal.events[0].uid;
  const master = cal.events.find((e) => e.recurrenceId === null);
  const exceptions = cal.events.filter((e) => e.recurrenceId !== null);
  if (!master) return null; // every row needs the master
  if (new Set(exceptions.map((e) => e.recurrenceId.date + 'T' + (e.recurrenceId.time || ''))).size !== exceptions.length) {
    return null; // duplicate RECURRENCE-ID = corrupt
  }
  if (master.rrule && !/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)([;].*)?$/.test(master.rrule)) {
    return null; // FREQ required first (RFC 5545 §3.3.10); SECONDLY/MINUTELY/HOURLY rejected (clock ecosystem scale)
  }
  return { calendar: cal, uid, master, exceptions };
}

/** Serialize an evt payload from {calendar} (round-trips unknown props). */
export function serializeEvtPayload(parsed) {
  return serializeVCalendar(parsed.calendar);
}

/* ---------------- wall-time helpers ---------------- */

const T240 = /^(\d{2}):(\d{2}):(\d{2})$/;

function wallToNaiveUTC(w) {
  const m = T240.exec(w.time || '00:00:00');
  if (!m) return null;
  return Date.UTC(+w.date.slice(0, 4), +w.date.slice(5, 7) - 1, +w.date.slice(8, 10), +m[1], +m[2], +m[3]);
}

function naiveUTCToWall(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
  };
}

/** Effective end wall time of a VEVENT (RFC 5545 §3.6.1 defaults). */
export function effectiveEnd(ev) {
  if (ev.dtend) return ev.dtend;
  if (ev.duration !== null && ev.duration !== undefined) {
    const startMs = wallToNaiveUTC(ev.dtstart);
    // Duration arithmetic on wall-naive times is DST-naive; acceptable for
    // the display path (real instants are only materialized for UNTIL).
    const endMs = startMs + ev.duration * 1000;
    return { ...naiveUTCToWall(endMs), tz: ev.dtstart.tz };
  }
  if (ev.dtstart.time === null) {
    return { date: addDays(ev.dtstart.date, 1), time: null, tz: null }; // DATE: ends next day
  }
  return { ...ev.dtstart }; // zero-length timed event
}

/**
 * Days a (possibly multi-day/all-day) event covers, inclusive (display).
 * RFC 5545 §3.6.1: a DATE-value DTEND is NOT inclusive (event covers
 * [DTSTART, DTEND)); a DATE-TIME end at 00:00:00 likewise excludes that
 * day. Zero/negative spans clamp to the start day (defensive).
 */
export function spanDays(ev) {
  const end = effectiveEnd(ev);
  const lastDay =
    end.time === null || end.time === '00:00:00'
      ? addDays(end.date, -1)
      : end.date;
  return { first: ev.dtstart.date, last: lastDay >= ev.dtstart.date ? lastDay : ev.dtstart.date };
}

/* ---------------- recurrence expansion ---------------- */

/**
 * Build an RRule for a master VEVENT operating on NAIVE WALL times
 * (occurrence Dates are wall components as-if-UTC; the DST-correct
 * expansion idiom for rrule.js). UNTIL in UTC (Z) form is converted to the
 * event's timezone wall form first so the comparison stays instant-exact.
 * Returns null when the rule cannot be used.
 */
function buildRRule(master) {
  if (!master.rrule) return null;
  const startMs = wallToNaiveUTC(master.dtstart);
  if (startMs === null) return null;
  let options;
  try {
    options = RRule.parseString(master.rrule);
  } catch {
    return null;
  }
  if (!options) return null;
  const untilZ = /UNTIL=(\d{8}T\d{6}Z?)([;]|$)/.exec(master.rrule);
  if (untilZ && untilZ[1].endsWith('Z')) {
    try {
      const untilInstant = new Date(
        Date.UTC(
          +untilZ[1].slice(0, 4), +untilZ[1].slice(4, 6) - 1, +untilZ[1].slice(6, 8),
          +untilZ[1].slice(9, 11), +untilZ[1].slice(11, 13), +untilZ[1].slice(13, 15)
        )
      );
      const tz = master.dtstart.tz && master.dtstart.tz !== 'UTC' ? master.dtstart.tz : 'UTC';
      const off = tzOffsetCached(tz, untilInstant);
      const wallMs = untilInstant.getTime() + off * 60000;
      options.until = new Date(wallMs); // naive wall form
    } catch {
      return null;
    }
  } else if (untilZ) {
    const u = untilZ[1];
    options.until = new Date(Date.UTC(+u.slice(0, 4), +u.slice(4, 6) - 1, +u.slice(6, 8), 0, 0, 0));
  }
  options.dtstart = new Date(startMs);
  try {
    return new RRule(options);
  } catch {
    return null;
  }
}

const offsetCache = new Map();
function tzOffsetCached(tz, instant) {
  const key = tz + '|' + Math.floor(instant.getTime() / 1800000); // 30-min buckets
  let v = offsetCache.get(key);
  if (v === undefined) {
    v = tzOffsetMinutes(tz, instant);
    offsetCache.set(key, v);
  }
  return v;
}

/**
 * Build the per-occurrence component for a master at a shifted start: the
 * master's DTEND (when present) moves by the SAME whole-day offset so the
 * component is self-consistent — the occurrence's dtstart AND dtend belong
 * to that occurrence (DURATION is relative and needs no shift).
 */
function occurrenceComponent(master, occStart) {
  const comp = { ...master, dtstart: occStart };
  if (master.dtend) {
    const dayShift = dayDiff(master.dtstart.date, occStart.date);
    comp.dtend = { date: addDays(master.dtend.date, dayShift), time: master.dtend.time, tz: master.dtend.tz };
  }
  return comp;
}

function dayDiff(a, b) {
  return Math.round(
    (new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000
  );
}

/**
 * Expand one evt row's occurrences overlapping [fromDay, toDay] (inclusive,
 * YYYY-MM-DD). Returns occurrence objects:
 *  { rowId, calId, uid, recId:{date,time}|null, start:{date,time},
 *    end:{date,time}, allDay:bool, isException:bool, isCancelled:bool,
 *    master:VEvent (the component this occurrence renders from) }
 * Overridden instances are replaced by their exception components; EXDATE'd
 * instances are dropped; exceptions moved outside the master's series are
 * still listed at their own date.
 */
export function expandEvtRow(parsed, rowId, fromDay, toDay) {
  const { uid, master, exceptions } = parsed;
  const out = [];
  const mkOcc = (comp, recId, isException) => ({
    rowId,
    calId: (parseEvtId(rowId) || { cal: null }).cal,
    uid,
    recId,
    start: { date: comp.dtstart.date, time: comp.dtstart.time },
    end: (function () {
      const e = effectiveEnd(comp);
      return { date: e.date, time: e.time };
    })(),
    allDay: comp.dtstart.time === null,
    isException,
    isCancelled: comp.status === 'CANCELLED',
    master: comp,
  });

  const overlaps = (occ) => {
    const span = spanDays(occ.master);
    return span.first <= toDay && span.last >= fromDay;
  };

  if (!master.rrule) {
    const occ = mkOcc(master, null, false);
    if (overlaps(occ)) out.push(occ);
  } else {
    const rule = buildRRule(master);
    if (rule) {
      // Upper bound = last microsecond OF toDay (not the next midnight):
      // rrule.between(from, to, inc=true) includes instants EQUAL to the
      // bounds, so a next-midnight bound would pull in toDay+1 occurrences.
      const fromMs = Date.UTC(+fromDay.slice(0, 4), +fromDay.slice(5, 7) - 1, +fromDay.slice(8, 10), 0, 0, 0);
      const toMs = Date.UTC(+toDay.slice(0, 4), +toDay.slice(5, 7) - 1, +toDay.slice(8, 10), 24, 0, 0) - 1;
      let occs;
      try {
        occs = rule.between(new Date(fromMs), new Date(toMs), true);
      } catch {
        occs = [];
      }
      const isAllDayMaster = master.dtstart.time === null;
      const overridden = new Set(exceptions.map((e) => e.recurrenceId.date + '|' + (e.recurrenceId.time || '')));
      for (const o of occs) {
        const naiveWall = naiveUTCToWall(o.getTime()); // '00:00:00' even for all-day
        const key = naiveWall.date + '|' + (isAllDayMaster ? '' : naiveWall.time);
        const exdateHits = (x) =>
          isAllDayMaster
            ? x.time === null && x.date === naiveWall.date // DATE-valued EXDATE
            : sameWall(x, naiveWall);
        if (master.exdates.some(exdateHits)) continue; // EXDATE removal
        if (overridden.has(key)) continue; // replaced by its exception below
        // All-day masters keep DATE semantics on every occurrence (the
        // naive expansion yields 00:00:00; the model needs time === null).
        const occStart = isAllDayMaster
          ? { date: naiveWall.date, time: null, tz: null }
          : { ...naiveWall, tz: master.dtstart.tz };
        const comp = occurrenceComponent(master, occStart);
        out.push(mkOcc(comp, isAllDayMaster ? { date: naiveWall.date, time: null } : naiveWall, false));
      }
    } else {
      // Unusable rule: fall back to the master's own start only (flagged
      // upstream as an expansion limitation, never silently dropped).
      const occ = mkOcc(master, null, false);
      if (overlaps(occ)) out.push(occ);
    }
  }

  // RDATE: additional explicit occurrence starts (RFC 5545 §3.8.5.2), with
  // or without an RRULE. Match the master's value type (all-day RDATEs pair
  // with DATE masters). EXDATE'd or exception-overridden instances are
  // skipped; every other RDATE overlapping the range is an occurrence.
  {
    const overriddenSet = new Set(exceptions.map((e) => e.recurrenceId.date + '|' + (e.recurrenceId.time || '')));
    for (const rd of master.rdates || []) {
      if ((rd.time === null) !== (master.dtstart.time === null)) continue; // type mismatch: ignored
      const wall = { date: rd.date, time: rd.time === null ? null : rd.time };
      if (master.exdates.some((x) => sameWall(x, wall))) continue;
      if (overriddenSet.has(wall.date + '|' + (wall.time || ''))) continue;
      const comp = occurrenceComponent(master, { date: rd.date, time: rd.time, tz: master.dtstart.tz });
      const occ = mkOcc(comp, { date: rd.date, time: rd.time }, false);
      if (overlaps(occ)) out.push(occ);
    }
  }

  // Exceptions render at their own (possibly moved) date.
  for (const ex of exceptions) {
    const occ = mkOcc(ex, { date: ex.recurrenceId.date, time: ex.recurrenceId.time }, true);
    if (overlaps(occ)) out.push(occ);
  }
  return out;
}

/* ---------------- §13 day-bucket derivation (v4.2) ---------------- */

const BUCKET_EVENT_ID_RE = /^[a-z]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** v4.1 §13 bucket payload validation (verbatim semantics). */
export function validateBucketEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (typeof ev.id !== 'string' || !BUCKET_EVENT_ID_RE.test(ev.id)) return null;
  if (!validDate(ev.date)) return null;
  if (!Number.isInteger(ev.hh) || ev.hh < 0 || ev.hh > 23) return null;
  if (!Number.isInteger(ev.mm) || ev.mm < 0 || ev.mm > 59) return null;
  if (typeof ev.title !== 'string' || ev.title.length === 0 || ev.title.length > 500) return null;
  if (!Number.isInteger(ev.priority) || ev.priority < 0 || ev.priority > 255) return null;
  return { id: ev.id, date: ev.date, hh: ev.hh, mm: ev.mm, title: ev.title, priority: ev.priority };
}

export function normalizeBucket(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.events)) return null;
  const events = [];
  for (const ev of p.events) {
    const v = validateBucketEvent(ev);
    if (!v) return null;
    events.push(v);
  }
  const ids = new Set(events.map((e) => e.id));
  if (ids.size !== events.length) return null;
  return { events };
}

/**
 * Derive one day's bucket entries from occurrence objects (as produced by
 * expandEvtRow). Deterministic (same inputs → same bytes): entries are the
 * §13 projection; cancelled events are excluded; all-day events project at
 * 00:00 with priority 1; timed events at their wall time with priority 2.
 */
export function deriveBucketEntries(occurrences, day) {
  const entries = [];
  for (const occ of occurrences) {
    if (occ.isCancelled) continue;
    if (!(occ.start.date <= day && day <= spanDays(occ.master).last)) continue;
    const t = occ.start.time || '00:00:00';
    entries.push({
      id: PROJ_PREFIX + ':' + occ.uid,
      date: day,
      hh: +t.slice(0, 2),
      mm: +t.slice(3, 5),
      title: occ.master.summary || '(untitled)',
      priority: occ.allDay ? 1 : 2,
    });
  }
  return capDerived(entries);
}

/** Deterministic §13 cap: keep (priority, id) order, drop the tail. */
export function capDerived(entries, cap = CAP_PER_BUCKET) {
  const sorted = [...entries].sort(
    (a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  return sorted.slice(0, cap);
}

/** Display order for clock/UI lists: time, priority, id (§13 v4.1 order). */
export function sortBucketEvents(events) {
  return [...events].sort(
    (a, b) => a.hh - b.hh || a.mm - b.mm || a.priority - b.priority || (a.id < b.id ? -1 : 1)
  );
}

/** Derive the full 23-day window's buckets from a parsed-row map. */
export function deriveWindowBuckets(parsedRows, today) {
  const days = windowDays(today);
  const fromDay = days[0];
  const toDay = days[days.length - 1];
  const byDay = new Map(days.map((d) => [d, []]));
  for (const [rowId, parsed] of parsedRows) {
    // Expand only over the window (occurrences carry their own spans).
    const occs = expandEvtRow(parsed, rowId, fromDay, toDay);
    for (const occ of occs) {
      const span = spanDays(occ.master);
      for (const d of days) {
        if (occ.start.date <= d && d <= span.last) byDay.get(d).push(occ);
      }
    }
  }
  const out = new Map();
  for (const d of days) out.set(d, deriveBucketEntries(byDay.get(d), d));
  return out;
}

export { triggerMinutes, formatDuration, parseDTValue, sameWall, wallToInstantUTC };
