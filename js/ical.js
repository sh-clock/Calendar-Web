/**
 * ical.js — minimal strict RFC 5545 iCalendar codec for PROTOCOL v4.2 rows.
 *
 * Scope: VCALENDAR wrapper containing VEVENT components (master +
 * RECURRENCE-ID exceptions) and nested VALARM. Unknown properties are
 * round-tripped verbatim (never dropped — another client's fields must
 * survive a web-client edit). No DOM, no fetch: imported by the browser UI
 * and by the Node test suite (same code as production).
 *
 * Time model: every date-time is a WALL time {date:'YYYY-MM-DD',
 * time:'HH:MM:SS'|null, tz:'IANA name'|'UTC'|null}. time === null means a
 * DATE value (all-day, floating day granularity). tz === null means
 * floating local time (the web client never writes those; tolerated on
 * parse). UTC instants are only materialized where unavoidable (UNTIL
 * comparison) via the Intl-based helpers below.
 */

/* ---------------- line folding / unfolding (§3.1) ---------------- */

/** Unfold: CRLF (or LF) followed by SPACE/TAB continues the previous line. */
export function unfoldLines(text) {
  if (typeof text !== 'string') throw new Error('bad_ical');
  const raw = text.split(/\r\n|\n|\r/);
  const out = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  // A trailing newline at EOF is file termination, not content — drop
  // trailing empty lines only (mid-content blank lines stay and fail parsing).
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/** Fold content lines at 75 OCTETS (UTF-8 aware), continuation = CRLF + space. */
export function foldLine(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const chunks = [];
  let start = 0;
  while (start < bytes.length) {
    // Find a cut ≤ 75 octets that does not split a UTF-8 sequence.
    let end = Math.min(start + (start === 0 ? 75 : 74), bytes.length);
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(new TextDecoder().decode(bytes.subarray(start, end)));
    start = end;
  }
  return chunks.join('\r\n ');
}

/* ---------------- TEXT escaping (§3.3.11) ---------------- */

export function escapeText(s) {
  return String(s)
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll('\r\n', '\\n')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\n');
}

export function unescapeText(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === 'n' || n === 'N') out.push('\n');
      else if (n === '\\' || n === ';' || n === ',') out.push(n);
      else if (n === undefined) throw new Error('bad_escape');
      else throw new Error('bad_escape');
      i++;
    } else out.push(c);
  }
  return out.join('');
}

/* ---------------- property line parse (§3.1 / §3.2) ---------------- */

/**
 * Split one content line into {name, params:[[k,v]], value}.
 * Parameter values may be quoted (DQUOTE-quoted when they contain : ; ,).
 */
export function parseContentLine(line) {
  let name = '';
  let i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === ';' || c === ':') break;
    if (c === '"') throw new Error('bad_prop_name');
    name += c;
  }
  if (i === line.length) throw new Error('bad_line');
  if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error('bad_prop_name');
  const params = [];
  while (line[i] === ';') {
    i++;
    let key = '';
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === '=') break;
      if (c === ';' || c === ':' || c === '"') throw new Error('bad_param');
      key += c;
    }
    if (line[i] !== '=' || key.length === 0) throw new Error('bad_param');
    i++;
    let value = '';
    if (line[i] === '"') {
      i++;
      for (; i < line.length; i++) {
        const c = line[i];
        if (c === '"') break;
        value += c;
      }
      if (line[i] !== '"') throw new Error('bad_param');
      i++;
    } else {
      for (; i < line.length; i++) {
        const c = line[i];
        if (c === ';' || c === ':') break;
        value += c;
      }
    }
    params.push([key.toUpperCase(), value]);
  }
  if (line[i] !== ':') throw new Error('bad_line');
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

/** Serialize {name, params, value} back to one (unfolded) content line. */
export function formatContentLine(prop) {
  let s = prop.name;
  for (const [k, v] of prop.params || []) {
    const needsQuote = /[:;,]/.test(v);
    s += ';' + k + '=' + (needsQuote ? '"' + v + '"' : v);
  }
  return s + ':' + prop.value;
}

/* ---------------- value types: DATE / DATE-TIME (§3.3.4, §3.3.5) ---------------- */

const DT_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;
const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;

function validYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Parse a DATE or DATE-TIME value with its parameters.
 * Returns {date:'YYYY-MM-DD', time:'HH:MM:SS'|null, tz:string|null}.
 */
export function parseDTValue(value, params) {
  let tzid = null;
  let isDate = false;
  for (const [k, v] of params) {
    if (k === 'TZID') tzid = v;
    else if (k === 'VALUE' && v.toUpperCase() === 'DATE') isDate = true;
    else if (k === 'VALUE' && v.toUpperCase() === 'DATE-TIME') isDate = false;
  }
  const v = String(value);
  const m = DT_RE.exec(v);
  if (m && !isDate) {
    const [, y, mo, d, hh, mi, ss, z] = m;
    if (!validYmd(+y, +mo, +d) || +hh > 23 || +mi > 59 || +ss > 60) throw new Error('bad_dt');
    if (z && tzid) throw new Error('bad_dt'); // UTC form must not carry TZID
    return { date: `${y}-${mo}-${d}`, time: `${hh}:${mi}:${ss === '60' ? '59' : ss}`, tz: z ? 'UTC' : tzid };
  }
  const dm = DATE_RE.exec(v);
  if (dm) {
    const [, y, mo, d] = dm;
    if (!validYmd(+y, +mo, +d)) throw new Error('bad_dt');
    return { date: `${y}-${mo}-${d}`, time: null, tz: null };
  }
  throw new Error('bad_dt');
}

/** Format {date,time,tz} into {value, params} (params entries [k,v]). */
export function formatDTValue(dt) {
  if (!dt || typeof dt.date !== 'string') throw new Error('bad_dt');
  const d = dt.date.replaceAll('-', '');
  if (dt.time === null || dt.time === undefined) {
    return { value: d, params: [['VALUE', 'DATE']] };
  }
  const t = dt.time.replaceAll(':', '');
  if (dt.tz === 'UTC') return { value: d + 'T' + t + 'Z', params: [] };
  if (dt.tz) return { value: d + 'T' + t, params: [['TZID', dt.tz]] };
  return { value: d + 'T' + t, params: [] };
}

/** Wall-time equality (date + time), timezone-insensitive. */
export function sameWall(a, b) {
  return !!a && !!b && a.date === b.date && (a.time || '') === (b.time || '');
}

/* ---------------- value type: DURATION (§3.3.6) ---------------- */

const DUR_RE = /^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export function parseDuration(v) {
  const m = DUR_RE.exec(String(v));
  if (!m) throw new Error('bad_duration');
  const [, sign, w, d, h, mi, s] = m;
  const secs = (+(w || 0) * 604800 + +(d || 0) * 86400 + +(h || 0) * 3600 + +(mi || 0) * 60 + +(s || 0));
  if (secs === 0 && !/[1-9]/.test(String(v).slice(1))) throw new Error('bad_duration');
  return sign === '-' ? -secs : secs;
}

/** Seconds → RFC 5545 DURATION (canonical PnDTnHnMnS form, sign only when negative). */
export function formatDuration(secs) {
  if (!Number.isInteger(secs) || secs === 0) throw new Error('bad_duration');
  const sign = secs < 0 ? '-' : '';
  let s = Math.abs(secs);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  let out = sign + 'P';
  if (d) out += d + 'D';
  if (h || m || s || out.endsWith('P')) out += 'T' + (h ? h + 'H' : '') + (m ? m + 'M' : '') + (s ? s + 'S' : '');
  return out;
}

/** TRIGGER value → minutes-before-start (positive int), or null when absolute/unsupported. */
export function triggerMinutes(v) {
  try {
    const secs = parseDuration(v);
    if (secs >= 0) return null; // only negative (before-start) durations map to reminders
    return Math.round(-secs / 60);
  } catch {
    return null;
  }
}

/* ---------------- timezone helpers (native Intl; no library) ---------------- */

const dtfCache = new Map();

function dtfFor(tz) {
  let dtf = dtfCache.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, dtf);
  }
  return dtf;
}

/** Offset (minutes east of UTC) of `tz` at the given instant. */
export function tzOffsetMinutes(tz, instant) {
  const parts = dtfFor(tz).formatToParts(instant);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUTC - instant.getTime()) / 60000);
}

/**
 * Wall time in `tz` → UTC instant. Handles DST (iterates to a fixed point;
 * ambiguous wall times resolve to the SECOND (later) offset, non-existent
 * times to the transition instant).
 */
export function wallToInstantUTC(dt, tz) {
  if (dt.time === null) throw new Error('all_day_has_no_instant');
  const wall = Date.UTC(
    +dt.date.slice(0, 4), +dt.date.slice(5, 7) - 1, +dt.date.slice(8, 10),
    +dt.time.slice(0, 2), +dt.time.slice(3, 5), +dt.time.slice(6, 8)
  );
  if (tz === 'UTC' || tz === null) return new Date(wall);
  const o1 = tzOffsetMinutes(tz, new Date(wall));
  const t1 = wall - o1 * 60000;
  const o2 = tzOffsetMinutes(tz, new Date(t1));
  if (o1 === o2) return new Date(t1);
  const o3 = tzOffsetMinutes(tz, new Date(wall - o2 * 60000));
  return new Date(wall - o3 * 60000); // fixed point (ambiguous → later offset)
}

/* ---------------- VEVENT model ---------------- */

const KNOWN = new Set([
  'UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'DURATION', 'RECURRENCE-ID',
  'RRULE', 'EXDATE', 'RDATE', 'SUMMARY', 'DESCRIPTION', 'LOCATION',
  'STATUS', 'TRANSP', 'SEQUENCE',
]);

/**
 * Parse one VEVENT's property list (already unfolded, component-stripped).
 * props: [{name, params, value}] (VALARM blocks come in as
 * {name:'VALARM', props:[...]} pseudo-properties).
 */
function veventFromProps(props) {
  const ev = {
    uid: null,
    dtstamp: null,
    dtstart: null,
    dtend: null,
    duration: null,
    recurrenceId: null,
    rrule: null,
    exdates: [],
    rdates: [],
    summary: '',
    description: null,
    location: null,
    status: null,
    transp: null,
    sequence: null,
    alarms: [], // {action, triggerRaw, extra:[prop]}
    extra: [],
  };
  for (const p of props) {
    switch (p.name) {
      case 'VALARM':
        ev.alarms.push(alarmFromProps(p.props));
        break;
      case 'UID': ev.uid = unescapeText(p.value); break;
      case 'DTSTAMP': ev.dtstamp = parseDTValue(p.value, p.params); break;
      case 'DTSTART': ev.dtstart = parseDTValue(p.value, p.params); break;
      case 'DTEND': ev.dtend = parseDTValue(p.value, p.params); break;
      case 'DURATION': ev.duration = parseDuration(p.value); break;
      case 'RECURRENCE-ID': ev.recurrenceId = parseDTValue(p.value, p.params); break;
      case 'RRULE': ev.rrule = p.value.toUpperCase(); break;
      case 'EXDATE':
      case 'RDATE':
        for (const v of p.value.split(',')) {
          (p.name === 'EXDATE' ? ev.exdates : ev.rdates).push(parseDTValue(v, p.params));
        }
        break;
      case 'SUMMARY': ev.summary = unescapeText(p.value); break;
      case 'DESCRIPTION': ev.description = unescapeText(p.value); break;
      case 'LOCATION': ev.location = unescapeText(p.value); break;
      case 'STATUS': {
        const s = p.value.toUpperCase();
        if (s !== 'CONFIRMED' && s !== 'TENTATIVE' && s !== 'CANCELLED') throw new Error('bad_status');
        ev.status = s;
        break;
      }
      case 'TRANSP': {
        const s = p.value.toUpperCase();
        if (s !== 'OPAQUE' && s !== 'TRANSPARENT') throw new Error('bad_transp');
        ev.transp = s;
        break;
      }
      case 'SEQUENCE': {
        if (!/^\d+$/.test(p.value)) throw new Error('bad_sequence');
        ev.sequence = Number(p.value);
        break;
      }
      default: ev.extra.push(p); // round-trip unknown properties verbatim
    }
  }
  if (typeof ev.uid !== 'string' || ev.uid.length === 0 || ev.uid.includes(':')) {
    throw new Error('bad_uid'); // v4.2 row-id grammar: UID must not contain ':'
  }
  if (!ev.dtstart) throw new Error('missing_dtstart');
  if (!ev.dtstamp) {
    // RFC 5545 requires DTSTAMP; tolerate on parse (treat as corrupt-free),
    // serializers always write one.
    ev.dtstamp = { date: '1970-01-01', time: '00:00:00', tz: 'UTC' };
  }
  if (ev.dtend && ev.duration) throw new Error('dtend_and_duration');
  if (ev.dtend && ev.dtstart && (ev.dtstart.time === null) !== (ev.dtend.time === null)) {
    throw new Error('dt_type_mismatch');
  }
  return ev;
}

function alarmFromProps(props) {
  const a = { action: null, triggerRaw: null, extra: [] };
  for (const p of props) {
    if (p.name === 'ACTION') a.action = p.value.toUpperCase();
    else if (p.name === 'TRIGGER') a.triggerRaw = p.value;
    else a.extra.push(p);
  }
  if (a.action === null || a.triggerRaw === null) throw new Error('bad_alarm');
  return a;
}

/**
 * Parse a full VCALENDAR text → { prodId, events:[VEvent], extra:[prop] }.
 * Strict: structural errors throw (the caller treats the row as corrupt);
 * the v4.2 row rule (all VEVENTs share one UID) is NOT enforced here (it is
 * a row-level rule enforced by the calendar core).
 */
export function parseVCalendar(text) {
  const lines = unfoldLines(text);
  let i = 0;
  const next = () => (i < lines.length ? lines[i++] : null);
  const expect = (name) => {
    const l = next();
    if (l !== 'BEGIN:' + name) throw new Error('bad_structure');
  };

  expect('VCALENDAR');
  const cal = { prodId: null, events: [], extra: [] };
  let line = next();
  while (line !== null && line !== 'END:VCALENDAR') {
    const prop = parseContentLine(line);
    if (prop.name === 'BEGIN' && prop.value === 'VEVENT') {
      const props = [];
      let l = next();
      while (l !== null && !(l === 'END:VEVENT')) {
        if (l.startsWith('BEGIN:VALARM')) {
          const alarmProps = [];
          let al = next();
          while (al !== null && al !== 'END:VALARM') {
            alarmProps.push(parseContentLine(al));
            al = next();
          }
          if (al !== 'END:VALARM') throw new Error('bad_structure');
          props.push({ name: 'VALARM', props: alarmProps });
        } else {
          props.push(parseContentLine(l));
        }
        l = next();
      }
      if (l !== 'END:VEVENT') throw new Error('bad_structure');
      cal.events.push(veventFromProps(props));
    } else if (prop.name === 'BEGIN' && prop.value === 'VTIMEZONE') {
      // VTIMEZONE blocks are not stored by v4.2 clients; skip verbatim.
      let l = next();
      while (l !== null && l !== 'END:VTIMEZONE') {
        if (l.startsWith('BEGIN:')) {
          const sub = l.slice(6);
          l = next();
          while (l !== null && l !== 'END:' + sub) l = next();
          if (l === null) throw new Error('bad_structure');
        }
        l = next();
      }
      if (l !== 'END:VTIMEZONE') throw new Error('bad_structure');
    } else if (prop.name === 'VERSION') {
      if (prop.value.trim() !== '2.0') throw new Error('bad_version');
    } else if (prop.name === 'PRODID') {
      cal.prodId = prop.value;
    } else {
      cal.extra.push(prop); // e.g. CALSCALE — round-tripped
    }
    line = next();
  }
  if (line !== 'END:VCALENDAR') throw new Error('bad_structure');
  if (next() !== null) throw new Error('trailing_content');
  if (cal.events.length === 0) throw new Error('no_vevent');
  return cal;
}

/* ---------------- serialization ---------------- */

const PRODID = '-//sh-clock//Calendar PoC//EN';

function dtProp(name, dt) {
  const { value, params } = formatDTValue(dt);
  return { name, params, value };
}

/** Serialize one VEvent's property list (order: RFC-recommended). */
function veventToProps(ev) {
  const props = [];
  props.push({ name: 'UID', params: [], value: escapeText(ev.uid) });
  props.push(dtProp('DTSTAMP', ev.dtstamp));
  if (ev.recurrenceId) props.push(dtProp('RECURRENCE-ID', ev.recurrenceId));
  props.push(dtProp('DTSTART', ev.dtstart));
  if (ev.dtend) props.push(dtProp('DTEND', ev.dtend));
  else if (ev.duration !== null && ev.duration !== undefined) {
    props.push({ name: 'DURATION', params: [], value: formatDuration(ev.duration) });
  }
  if (ev.rrule) props.push({ name: 'RRULE', params: [], value: ev.rrule });
  if (ev.exdates.length > 0) {
    // Group EXDATEs by their parameter form so each line stays uniform.
    const groups = new Map();
    for (const dt of ev.exdates) {
      const { value, params } = formatDTValue(dt);
      const key = JSON.stringify(params);
      if (!groups.has(key)) groups.set(key, { params, values: [] });
      groups.get(key).values.push(value);
    }
    for (const g of groups.values()) {
      props.push({ name: 'EXDATE', params: g.params, value: g.values.join(',') });
    }
  }
  if (ev.rdates.length > 0) {
    // RDATE groups mirror EXDATE (RFC 5545 §3.8.5.2/§3.8.5.1).
    const groups = new Map();
    for (const dt of ev.rdates) {
      const { value, params } = formatDTValue(dt);
      const key = JSON.stringify(params);
      if (!groups.has(key)) groups.set(key, { params, values: [] });
      groups.get(key).values.push(value);
    }
    for (const g of groups.values()) {
      props.push({ name: 'RDATE', params: g.params, value: g.values.join(',') });
    }
  }
  if (ev.summary !== '') props.push({ name: 'SUMMARY', params: [], value: escapeText(ev.summary) });
  if (ev.description !== null && ev.description !== undefined && ev.description !== '') {
    props.push({ name: 'DESCRIPTION', params: [], value: escapeText(ev.description) });
  }
  if (ev.location !== null && ev.location !== undefined && ev.location !== '') {
    props.push({ name: 'LOCATION', params: [], value: escapeText(ev.location) });
  }
  if (ev.status) props.push({ name: 'STATUS', params: [], value: ev.status });
  if (ev.transp) props.push({ name: 'TRANSP', params: [], value: ev.transp });
  if (ev.sequence !== null && ev.sequence !== undefined) {
    props.push({ name: 'SEQUENCE', params: [], value: String(ev.sequence) });
  }
  for (const a of ev.alarms) {
    const alarmProps = [{ name: 'ACTION', params: [], value: a.action }];
    alarmProps.push({ name: 'TRIGGER', params: a.triggerParams || [], value: a.triggerRaw });
    for (const p of a.extra || []) alarmProps.push(p);
    props.push({ name: 'VALARM', props: alarmProps });
  }
  for (const p of ev.extra || []) {
    if (KNOWN.has(p.name) || p.name === 'BEGIN' || p.name === 'END') continue; // never duplicate knowns
    props.push(p);
  }
  return props;
}

export function serializeVCalendar(cal) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:' + (cal.prodId || PRODID)];
  for (const p of cal.extra || []) lines.push(formatContentLine(p));
  for (const ev of cal.events) {
    lines.push('BEGIN:VEVENT');
    for (const p of veventToProps(ev)) {
      if (p.name === 'VALARM') {
        lines.push('BEGIN:VALARM');
        for (const ap of p.props) lines.push(formatContentLine(ap));
        lines.push('END:VALARM');
      } else {
        lines.push(formatContentLine(p));
      }
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export { PRODID };
