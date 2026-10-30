/**
 * calendar-core.js — pure calendar logic for PROTOCOL v4.1 §13 (calendar
 * buckets). NO DOM, NO fetch: this module is imported BOTH by the browser UI
 * and by the Node test suite, so the merge/ownership/cap rules are verified
 * against exactly the code that runs in production.
 *
 * §13 facts implemented here:
 *  - Row id "cal:{yyyymmdd}", sliding window of 23 live buckets
 *    [today-1 .. today+21] (client-enforced).
 *  - Payload { "events": [ { id:"d:{uuid}"|"t:{uuid}"|..., date, hh, mm,
 *    title, priority } ] }.
 *  - Ownership: a writer creates/edits ONLY entries carrying its own prefix.
 *    It NEVER rewrites another prefix's entries. The daily RMW is a union over
 *    both prefixes.
 *  - Capacity <= 16 events per bucket-day; a writer over cap drops ITS OWN
 *    lowest-priority entries (never the other writer's).
 *
 * WORKLOG D5: this PoC's web writer uses prefix "w:" (spec defines d:/t: for
 * the DAVx5/trudido phone forks, which do not exist in this PoC).
 */

export const WRITER_PREFIX = 'w';
export const CAP_PER_BUCKET = 16; // §13
export const WINDOW_BACK = 1; // [today-1 .. today+21] = 23 buckets (§13)
export const WINDOW_FWD = 21;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_ID_RE = /^[a-z]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A real calendar date in YYYY-MM-DD form (rejects 2026-13-01 etc.). */
export function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** "2026-11-03" -> "cal:20261103" (§13 id format). */
export function bucketId(dateStr) {
  if (!validDate(dateStr)) throw new Error('bad_date');
  return 'cal:' + dateStr.replaceAll('-', '');
}

/** "cal:20261103" -> "2026-11-03", or null if not a calendar bucket id. */
export function parseBucketId(id) {
  const m = /^cal:(\d{4})(\d{2})(\d{2})$/.exec(id);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** UTC date arithmetic on YYYY-MM-DD strings. */
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The 23-day sliding window [today-1 .. today+21] (§13). */
export function windowDays(today) {
  const out = [];
  for (let i = -WINDOW_BACK; i <= WINDOW_FWD; i++) out.push(addDays(today, i));
  return out;
}

/** Local calendar date of the browser (the clock/UI operate on local days). */
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

/** Strict event validation; returns the event or null. */
export function validateEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (typeof ev.id !== 'string' || !EVENT_ID_RE.test(ev.id)) return null;
  if (!validDate(ev.date)) return null;
  if (!Number.isInteger(ev.hh) || ev.hh < 0 || ev.hh > 23) return null;
  if (!Number.isInteger(ev.mm) || ev.mm < 0 || ev.mm > 59) return null;
  if (typeof ev.title !== 'string' || ev.title.length === 0 || ev.title.length > 500) return null;
  if (!Number.isInteger(ev.priority) || ev.priority < 0 || ev.priority > 255) return null;
  return { id: ev.id, date: ev.date, hh: ev.hh, mm: ev.mm, title: ev.title, priority: ev.priority };
}

/**
 * Strict bucket payload validation. Returns {events} or null when ANY event is
 * malformed — strictness is deliberate: a partially-corrupt bucket must be
 * surfaced as an error, never silently rewritten (which would lose data).
 */
export function normalizeBucket(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.events)) return null;
  const events = [];
  for (const ev of p.events) {
    const v = validateEvent(ev);
    if (!v) return null;
    events.push(v);
  }
  const ids = new Set(events.map((e) => e.id));
  if (ids.size !== events.length) return null; // duplicate ids = corrupt
  return { events };
}

/** New owned event (crypto.randomUUID is native in browsers & Node ≥ 16.7). */
export function makeEvent(fields) {
  const ev = validateEvent({
    id: WRITER_PREFIX + ':' + crypto.randomUUID(),
    date: fields.date,
    hh: fields.hh,
    mm: fields.mm,
    title: fields.title,
    priority: fields.priority,
  });
  if (!ev) throw new Error('invalid_event');
  return ev;
}

/** Display order: time, then priority (0 = highest), then id for stability. */
export function sortEvents(events) {
  return [...events].sort(
    (a, b) => a.hh - b.hh || a.mm - b.mm || a.priority - b.priority || (a.id < b.id ? -1 : 1)
  );
}

/**
 * §13 ownership: upsert an OWN event into a bucket's event list.
 * Throws on attempts to modify another writer's entry.
 */
export function applyEvent(events, ev, ownPrefix) {
  if (!ev.id.startsWith(ownPrefix + ':')) throw new Error('ownership_violation');
  const i = events.findIndex((e) => e.id === ev.id);
  if (i >= 0) {
    if (!events[i].id.startsWith(ownPrefix + ':')) throw new Error('ownership_violation');
    const copy = [...events];
    copy[i] = ev;
    return copy;
  }
  return [...events, ev];
}

/** §13 ownership: remove an OWN event. Throws for other writers' entries. */
export function removeEvent(events, id, ownPrefix) {
  const ev = events.find((e) => e.id === id);
  if (!ev) return { events, removed: false };
  if (!ev.id.startsWith(ownPrefix + ':')) throw new Error('ownership_violation');
  return { events: events.filter((e) => e.id !== id), removed: true };
}

/**
 * §13 capacity: <= 16 events per bucket-day. A writer over cap drops ITS OWN
 * lowest-priority entries (never the other writer's) and the drop is surfaced
 * to the caller. If the OTHER writers' entries alone exceed the cap, they are
 * all kept (a writer never deletes another writer's data) and all own entries
 * are dropped.
 */
export function capEvents(events, ownPrefix, cap = CAP_PER_BUCKET) {
  if (events.length <= cap) return { events: sortEvents(events), dropped: [] };
  const own = events.filter((e) => e.id.startsWith(ownPrefix + ':'));
  const other = events.filter((e) => !e.id.startsWith(ownPrefix + ':'));
  // Own entries kept by priority (0 = highest; ties broken deterministically).
  const ownSorted = [...own].sort(
    (a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1)
  );
  const keepCount = cap - other.length;
  if (keepCount <= 0) {
    return { events: sortEvents(other), dropped: own };
  }
  const kept = ownSorted.slice(0, keepCount);
  const dropped = ownSorted.slice(keepCount);
  return { events: sortEvents([...other, ...kept]), dropped };
}

/** §13 reader behaviour (the clock renders today + next 7 days). */
export function clockPreviewDays(today) {
  const out = [];
  for (let i = 0; i <= 7; i++) out.push(addDays(today, i));
  return out;
}

/** Human label for a writer prefix (ownership badge in the UI). */
export function writerLabel(prefix) {
  return (
    {
      w: 'this app',
      d: 'DAVx5',
      t: 'trudido',
    }[prefix] || 'ext'
  );
}

/** Prefix of an event id ("w:uuid" -> "w"). */
export function eventPrefix(ev) {
  const i = ev.id.indexOf(':');
  return i > 0 ? ev.id.slice(0, i) : '?';
}
