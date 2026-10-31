/**
 * app.js — web client orchestration for PROTOCOL v4.3 (calendar domain),
 * UI ported from Proton Calendar (ProtonMail WebClients, GPL-3.0).
 *
 * Provenance of ported logic (see docs/PROVENANCE.md):
 *  - Month-grid layout: applications/calendar/src/app/components/calendar/
 *    layout.ts + useDayGridEventLayout.ts + splitDayEventsInInterval.ts
 *    (GPL-3.0) — ported verbatim below (layout(), dayGridRowLayout()).
 *  - Drag & drop (month): .../calendar/interactions/dayGridMouseHandler.ts +
 *    mouseHelpers/{mathHelpers,domHelpers}.ts (GPL-3.0) — ported verbatim
 *    (dayGridMouseDown(), getTargetIndex(), blockClick()).
 *  - Week/day/custom time grid: .../calendar/TimeGrid.tsx + TimeGrid/* +
 *    splitTimeGridEventsPerDay.ts + interactions/timeGridMouseHandler.ts +
 *    mouseHelpers/dateHelpers.ts (GPL-3.0) — ported below
 *    (splitTimeGridEventsPerDay(), getTargetMinutes(), getSnappedDate(),
 *    timeGridMouseDown()).
 *  - Event colors: packages/colors/gen-accent-shades.ts formula.
 *  - Default calendar name/color: packages/shared/lib/calendar/constants.ts
 *    DEFAULT_CALENDAR = { name: 'My calendar', color: ACCENT_COLORS[0] }.
 *  - Default event duration: DEFAULT_EVENT_DURATION = 30 (minutes).
 *  - Dark theme tokens: packages/colors/themes/src/lumo-dark/dark-base.css.
 *  Visual tokens live in css/style.css (verbatim values, commented).
 *
 * v4.3 model (protocol.md — REPOSITORY ROOT, normative):
 *  - `cmeta:{uuid}` rows → calendars (name, color).
 *  - `evt:{cal}:{uid}` rows → source of truth, RFC 5545 payloads.
 *  - `cal:{yyyymmdd}` day buckets → DEPRECATED: never read or written by
 *    this client; the clock preview is a LOCAL derivation (§13c).
 *  - Sync = read-only manifest diff + POST /rows:batch (§9b) — 1–2 requests,
 *    failure-tolerant, ALWAYS renders. Mutations RMW the row directly,
 *    update local state and re-render — NO post-mutation sync chain (§5).
 *  - Autosync: 60 s poll + focus/visibility (never blocks the UI).
 */

import { deriveKeys, importRowKey, encryptRow, decryptRow } from './crypto.js';
import { Api, ApiError } from './api.js';
import * as core from './calendar-core.js';
import { serializeVCalendar, triggerMinutes, formatDuration } from './ical.js';

const DEFAULT_SERVER_URL = 'https://calendar-poc.sh-clock.workers.dev';
const LS_TOKEN = 'clock_poc_auth_ui';
const LS_SERVER = 'clock_poc_server';
const LS_CALVIS = 'clock_poc_calvis_v42';
const LS_VIEW = 'clock_poc_view_v43';
const LS_THEME = 'clock_poc_theme';
const REBASE_MAX = 8;
const DAY_EVENT_HEIGHT = 28;   // Proton DAY_EVENT_HEIGHT (px)
const CREATE_SENSITIVITY = 20; // Proton dayGridMouseHandler CREATE_SENSITIVITY
const AUTOSYNC_MS = 60000;     // v4.3 §5.3: 60 s poll while visible
const TOTAL_MINUTES = 24 * 60; // Proton TimeGrid totalMinutes
const MIN_DURATION = 15;       // Proton splitTimeGridEventsPerDay MIN_DURATION
const TIMEGRID_INTERVAL = 30;  // Proton TimeGrid interval (30 min snapping)

const VIEWS = ['day', 'week', 'month', 'custom', 'year'];

const state = {
  api: null,
  rowKey: null,
  cals: new Map(),      // uuid -> { ver, meta }   (cmeta rows)
  evt: new Map(),       // rowId -> { ver, parsed } (evt rows)
  corrupt: new Map(),   // rowId -> reason (undecryptable/unparseable rows)
  today: null,
  viewYM: null,
  selectedDate: null,
  view: 'month',        // 'day' | 'week' | 'month' | 'custom' | 'year'
  customDays: 5,        // custom-view day count (2..14)
  gridRows: 3,          // measured visible chip rows (Proton useLayoutEffect)
  busy: false,
  batchOk: true,        // false when the server predates v4.3 (§5.1c fallback)
  syncing: false,       // one background sync at a time (§5.3)
};

/* ---------------- tiny DOM helpers ---------------- */

const $ = (sel) => document.querySelector(sel);

/** Create an element with class/props/children (no innerHTML for data). */
function el(tag, cls, props = {}) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') n.textContent = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  }
  return n;
}

function toast(msg, kind = 'info', ms = 4200) {
  const t = el('div', 'toast ' + kind, { text: msg });
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function setBusy(busy, msg) {
  state.busy = busy;
  const bar = $('#syncbar');
  bar.hidden = !busy;
  if (busy) $('#syncmsg').textContent = msg || 'Working…';
}

/* ---------------- overlay stack (Escape closes topmost) ---------------- */

const overlayStack = [];
function pushOverlay(node, close) {
  overlayStack.push({ node, close });
}
function popOverlay(node) {
  const i = overlayStack.findIndex((o) => o.node === node);
  if (i !== -1) overlayStack.splice(i, 1);
}
function closeTopOverlay() {
  const top = overlayStack[overlayStack.length - 1];
  if (top) top.close();
  return !!top;
}
function closeAllOverlays() {
  while (overlayStack.length) overlayStack[overlayStack.length - 1].close();
}

/* ---------------- formatting (user locale, like Proton) ---------------- */

const locale = undefined; // browser default
const fmtTime = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
const fmtTimeSec = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const fmtDateLong = new Intl.DateTimeFormat(locale, {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
});
const fmtDateMed = new Intl.DateTimeFormat(locale, {
  weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
});
const fmtDayMonth = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' });

function wallToDate(dt) { // wall {date,time} -> Date carrying wall comps (display only)
  if (dt.time === null) return new Date(dt.date + 'T00:00:00');
  return new Date(dt.date + 'T' + dt.time);
}
const showTime = (dt) => (dt.time === null ? '' : fmtTime.format(wallToDate(dt)));

/** "Wed, Oct 28, 2026 · 10:00 – 11:00" / "All day" (Proton date header shape). */
function eventDateHeader(ev) {
  const s = wallToDate(ev.start);
  const e = wallToDate(ev.end);
  if (ev.isAllDay) {
    if (ev.start.date === ev.spanLast) return fmtDateLong.format(s) + ' · All day';
    // ev.end is the RFC-EXCLUSIVE DTEND; display the inclusive last day.
    return fmtDateMed.format(s) + ' – ' + fmtDayMonth.format(new Date(ev.spanLast + 'T00:00:00')) + ' · All day';
  }
  if (ev.start.date === ev.spanLast) {
    return `${fmtDateMed.format(s)} · ${fmtTime.format(s)} – ${fmtTime.format(e)}`;
  }
  return `${fmtDateMed.format(s)}, ${fmtTime.format(s)} – ${fmtDayMonth.format(e)}, ${fmtTime.format(e)}`;
}

const WEEKDAY_LONG = (() => {
  const out = [];
  // Monday-first ordering (2023-01-02 was a Monday); every consumer indexes
  // this array Monday-first, matching the grid layout.
  for (let i = 0; i < 7; i++) {
    out.push(new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(new Date(2023, 0, 2 + i)));
  }
  return out;
})();

/* ---------------- Proton colors: gen-accent-shades port ----------------
 * packages/colors/gen-accent-shades.ts (GPL-3.0): [base, s-.05/l-.05, s-.1/l-.1]
 * via tinycolor HSL. We implement the identical HSL math for hex in/out. */

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function rgbToHex(r, g, b) {
  const p = (n) => Math.round(n).toString(16).padStart(2, '0');
  return '#' + p(r) + p(g) + p(b);
}
function hexToHsl(hex) {
  let [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}
function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let [r, g, b] = [0, 0, 0];
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}
/** [main, alt] — alt is Proton's 2nd shade (s−0.05, l−0.05). */
function genAccentShades(hex) {
  const { h, s, l } = hexToHsl(hex);
  return [
    hex.toUpperCase(),
    hslToHex(h, Math.max(0, s - 0.05), Math.max(0, l - 0.05)).toUpperCase(),
  ];
}

/* ---------------- calendar visibility (UI-local preference) ----------------
 * Stored as a per-uuid boolean map so "unchecked" is distinguishable from
 * "never seen": new calendars default visible; unchecking persists. */

function loadCalVis() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_CALVIS) || 'null');
    return o && typeof o === 'object' ? new Map(Object.entries(o).map(([k, v]) => [k, !!v])) : null;
  } catch {
    return null;
  }
}
function saveCalVis() {
  const o = {};
  for (const [uuid, on] of calVis) o[uuid] = on;
  localStorage.setItem(LS_CALVIS, JSON.stringify(o));
}
let calVis = loadCalVis() || new Map();
const calVisible = new Set();
function syncCalVisible() {
  calVisible.clear();
  for (const [uuid, on] of calVis) if (on && state.cals.has(uuid)) calVisible.add(uuid);
}

/* ---------------- provisioning & boot (unchanged from v4.1 client) ---------------- */

function serverUrl() {
  return localStorage.getItem(LS_SERVER) || DEFAULT_SERVER_URL;
}

function ingestParams() {
  const params = new URLSearchParams(location.search);
  const hash = new URLSearchParams(
    location.hash.startsWith('#') ? location.hash.slice(1) : location.hash
  );
  const setup = hash.get('setup') || params.get('setup');
  if (setup && /^[0-9a-f]{64}$/.test(setup)) {
    localStorage.setItem(LS_TOKEN, setup);
    toast('Provisioning code stored in this browser.', 'ok');
  } else if (setup) {
    toast('Ignored invalid provisioning code (must be 64 lowercase hex chars).', 'err');
  }
  const srv = hash.get('server') || params.get('server');
  if (srv && /^https?:\/\//.test(srv)) localStorage.setItem(LS_SERVER, srv.replace(/\/+$/, ''));
  if (setup || srv) history.replaceState(null, '', location.pathname);
}

/* ---------------- unlock (§3) ---------------- */

async function unlock() {
  if (state.busy) return;
  const token = localStorage.getItem(LS_TOKEN);
  const password = $('#password').value;
  const url = $('#server').value.trim().replace(/\/+$/, '');
  localStorage.setItem(LS_SERVER, url);
  $('#login-msg').textContent = '';
  if (!token) {
    $('#login-msg').textContent = 'No provisioning code in this browser — paste one below first.';
    return;
  }
  setBusy(true, 'Deriving keys (PBKDF2 100000 iterations)…');
  try {
    const probe = new Api(url, token);
    const cfg = await probe.getConfig();
    const { aes1, kData, authUiHex } = await deriveKeys(password, cfg.salt, cfg.iters, cfg.wrapped);
    if (authUiHex !== token) {
      toast('Warning: stored provisioning code does not match the derived AUTH_UI. Using derived token.', 'warn', 8000);
    }
    state.api = new Api(url, authUiHex);
    state.rowKey = await importRowKey(kData);
    state.today = core.localToday();
    state.viewYM = state.viewYM || state.today.slice(0, 7);
    state.selectedDate = state.selectedDate || state.today;
    // v4.3 §5.4 — SOFT version gate: a mismatch degrades features (per-row
    // GETs instead of §9b batch) but NEVER locks the user out of their data.
    state.batchOk = true;
    try {
      const ver = await state.api.getVersion();
      $('#proto-badge').textContent = 'protocol ' + ver.proto;
      if (ver.proto !== '4.3') {
        state.batchOk = false;
        toast('Server reports protocol ' + ver.proto + ' (this client targets 4.3). ' +
          'Sync falls back to per-row reads. Deploy the updated worker for batch sync.', 'warn', 9000);
      }
    } catch {
      $('#proto-badge').textContent = 'protocol ?';
      toast('Could not read /version — continuing with per-row reads.', 'warn', 7000);
      state.batchOk = false;
    }
    await syncAll();
    $('#password').value = '';
    showApp();
  } catch (e) {
    const srvErr =
      e instanceof ApiError && e.body && e.body.error ? ` (server said "${e.body.error}")` : '';
    const msg =
      e instanceof ApiError && e.kind === 'silent'
        ? 'Authentication failed (silent 404): the provisioning code is not valid on this server.'
        : e && e.message === 'unlock_failed'
          ? 'Unlock failed: wrong password (or the server config does not match this deployment).'
          : 'Login failed: ' + (e && e.message ? e.message : String(e)) + srvErr;
    $('#login-msg').textContent = msg;
  } finally {
    setBusy(false);
  }
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#btn-sync').hidden = false;
  $('#btn-lock').hidden = false;
  $('#btn-forget').hidden = false;
}

function lock() {
  if (state.busy) return;
  closeAllOverlays();
  state.api = null;
  state.rowKey = null;
  state.cals.clear();
  state.evt.clear();
  state.corrupt.clear();
  state.today = null;
  $('#password').value = '';
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#btn-sync').hidden = true;
  $('#btn-lock').hidden = true;
  $('#btn-forget').hidden = true;
}

function forgetBrowser() {
  if (state.busy) return;
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_SERVER);
  localStorage.removeItem(LS_CALVIS);
  calVis = new Map();
  calVisible.clear();
  lock();
  refreshLoginUi();
  toast('Provisioning code forgotten on this browser.', 'ok');
}

/* ---------------- sync: v4.3 read-only manifest diff + §9b batch ---------------- */

/** GET+decrypt+parse one row by id. Returns {ver, payload}|{ver, corrupt:reason}. */
async function fetchRow(id) {
  const env = await state.api.getRow(id);
  if (!env) return { missing: true };
  let payload;
  try {
    payload = await decryptRow(state.rowKey, id, env.ver, env.nonce, env.ct);
  } catch {
    return { ver: env.ver, corrupt: 'decrypt_failed' };
  }
  return { ver: env.ver, payload };
}

/** Ingest one decrypted envelope into state (failure-tolerant, per-row). */
async function ingestRow(id, ver, nonce, ct) {
  let payload;
  try {
    payload = await decryptRow(state.rowKey, id, ver, nonce, ct);
  } catch {
    state.corrupt.set(id, 'decrypt_failed');
    state.evt.delete(id);
    const cu = core.parseCmetaId(id);
    if (cu) state.cals.delete(cu);
    return;
  }
  if (core.parseEvtId(id)) {
    const parsed = core.parseEvtPayload(payload);
    if (!parsed) {
      state.corrupt.set(id, 'bad_payload');
      state.evt.delete(id);
    } else {
      state.evt.set(id, { ver, parsed });
      state.corrupt.delete(id);
    }
  } else {
    const uuid = core.parseCmetaId(id);
    let meta = null;
    try { meta = JSON.parse(payload); } catch { /* corrupt */ }
    const v = core.validateCalendarMeta(meta);
    if (!uuid || !v) {
      state.corrupt.set(id, 'bad_payload');
      if (uuid) state.cals.delete(uuid);
    } else {
      state.cals.set(uuid, { ver, meta: v });
      state.corrupt.delete(id);
    }
  }
}

/**
 * Fetch the given row ids into state: one POST /rows:batch (§9b) when the
 * server supports it, else per-row GETs (v4.2 fallback, §5.1c). Individual
 * failures NEVER abort the batch — the row is flagged corrupt instead.
 */
async function fetchRowsIntoState(ids) {
  let envelopes = null;
  if (state.batchOk && ids.length > 0) {
    try {
      const res = await state.api.batchRows(ids);
      envelopes = (res && res.rows) || [];
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'silent') {
        state.batchOk = false; // v4.2 server: degrade to per-row GETs
      } else if (e instanceof ApiError && e.status === 400) {
        throw e; // malformed request — a bug, surface it loudly
      } else {
        throw e; // network/other — the sync layer catches and toasts once
      }
    }
  }
  if (!envelopes) {
    envelopes = await Promise.all(ids.map(async (id) => {
      const env = await state.api.getRow(id); // null when missing
      return env || { id, missing: true };
    }));
  }
  for (const env of envelopes) {
    if (!env || !env.id) continue;
    if (env.missing) {
      state.evt.delete(env.id);
      state.corrupt.delete(env.id);
      const cu = core.parseCmetaId(env.id);
      if (cu) state.cals.delete(cu);
      continue;
    }
    await ingestRow(env.id, env.ver, env.nonce, env.ct);
  }
}

/**
 * v4.3 §5.1 sync — READ-ONLY, failure-tolerant, always renders.
 * 1 request when nothing changed; 2 when anything did. Never writes rows;
 * never lets one bad row (corrupt/unparseable) abort the others.
 */
async function syncAll() {
  if (!state.api || state.syncing) return;
  state.syncing = true;
  const errors = [];
  try {
    const manifest = await state.api.getManifest();
    const rows = manifest.rows || [];
    const seen = new Set();
    const toFetch = [];

    for (const r of rows) {
      const id = r.id;
      // `cal:` day buckets are DEPRECATED in v4.3 (protocol.md §13c):
      // never read, never written, ignored entirely.
      if (core.parseEvtId(id)) {
        seen.add(id);
        const local = state.evt.get(id);
        if (!local || local.ver !== r.ver || state.corrupt.has(id)) toFetch.push(id);
      } else if (core.parseCmetaId(id)) {
        seen.add(id);
        const uuid = core.parseCmetaId(id);
        const local = state.cals.get(uuid);
        if (!local || local.ver !== r.ver || state.corrupt.has(id)) toFetch.push(id);
      }
    }

    if (toFetch.length > 0) {
      // ≤256 ids per call (protocol.md §9b); chunk larger sets.
      for (let i = 0; i < toFetch.length; i += 256) {
        await fetchRowsIntoState(toFetch.slice(i, i + 256));
      }
    }

    // Locally-known rows absent from the manifest were deleted elsewhere.
    for (const id of [...state.evt.keys()]) if (!seen.has(id)) state.evt.delete(id);
    for (const [uuid] of state.cals) {
      if (!seen.has(core.cmetaId(uuid))) state.cals.delete(uuid);
    }
    for (const id of [...state.corrupt.keys()]) if (!seen.has(id)) state.corrupt.delete(id);

    /* ---- calendar visibility: unchecking persists; new calendars visible ---- */
    const stored = loadCalVis();
    for (const uuid of state.cals.keys()) {
      if (!stored || !stored.has(uuid)) calVis.set(uuid, true);
    }
    for (const uuid of [...calVis.keys()]) {
      if (!state.cals.has(uuid)) calVis.delete(uuid);
    }
    syncCalVisible();

    /* ---- default calendar bootstrap (Proton DEFAULT_CALENDAR) ---- */
    if (state.cals.size === 0 && state.evt.size === 0) {
      const uuid = crypto.randomUUID();
      const meta = core.newCalendarMeta('My calendar', core.PALETTE[0]);
      const res = await putRowRMW(core.cmetaId(uuid), () => JSON.stringify(meta), {
        allowCreate: true, local: null,
      });
      applyRowLocally(core.cmetaId(uuid), res.ver, res.text);
      calVis.set(uuid, true);
      saveCalVis();
      syncCalVisible();
    }
  } catch (e) {
    errors.push(e);
  } finally {
    state.syncing = false;
  }

  // §5.1d: render ALWAYS runs after a sync, with whatever succeeded.
  renderAll();
  if (state.corrupt.size > 0) {
    toast(`${state.corrupt.size} row(s) could not be decrypted — flagged, never rewritten.`, 'warn', 8000);
  }
  if (errors.length > 0) {
    const e = errors[0];
    toast('Sync problem: ' + (e && e.message ? e.message : String(e)) + ' — will retry automatically.', 'warn', 7000);
  }
  return !errors.length;
}

/** v4.3 §5.3 background autosync — never blocks the UI, never shows an overlay. */
function autosync() {
  if (!state.api || state.busy || state.syncing) return;
  syncAll().catch(() => {}); // syncAll itself is failure-tolerant
}

/**
 * v4.3 §5.2c — after an accepted RMW, update local state from the payload we
 * just wrote (no re-fetch, no sync) and re-render.
 */
function applyRowLocally(id, ver, text) {
  if (core.parseEvtId(id)) {
    const parsed = core.parseEvtPayload(text);
    if (parsed) {
      state.evt.set(id, { ver, parsed });
      state.corrupt.delete(id);
    }
  } else {
    const uuid = core.parseCmetaId(id);
    let meta = null;
    try { meta = JSON.parse(text); } catch { /* should not happen */ }
    const v = core.validateCalendarMeta(meta);
    if (uuid && v) {
      state.cals.set(uuid, { ver, meta: v });
      state.corrupt.delete(id);
    }
  }
}

/* ---------------- generic RMW for evt/cmeta rows (v4.3 §5.2) ---------------- */

/**
 * Read-modify-write a row whose payload is produced by build(payload, ver)
 * (pure — re-applied on each rebase attempt). Acceptance is detected by
 * envelope identity (nonce echo, WORKLOG D14).
 *
 * v4.3 fast path: when `local` ({ver, payload} — the caller's trusted view of
 * the row, straight from state) is provided, the first PUT is sent WITHOUT a
 * preceding GET (the manifest already vouched for that ver). A rebase echoes
 * the stored envelope; only then do we fetch and re-apply `build`.
 */
async function putRowRMW(id, build, { allowCreate = true, local = null } = {}) {
  let ver;
  let payload;
  if (local && Number.isInteger(local.ver) && local.ver >= 0 && local.ver <= 4294967295) {
    // v4.3 fast path: local.ver === 0 means "row known absent" (create path
    // straight after a sync-verified manifest); no pre-GET is needed.
    ver = local.ver;
    payload = local.payload;
  } else {
    const res = await fetchRow(id);
    if (res.corrupt) throw new Error('row_corrupt: refusing to rewrite a corrupt row');
    if (res.missing) {
      if (!allowCreate) throw new Error('not_found: ' + id);
      ver = 0;
      payload = null;
    } else {
      ver = res.ver;
      payload = res.payload;
    }
  }
  for (let attempt = 0; attempt < REBASE_MAX; attempt++) {
    const text = build(payload, ver);
    const newVer = ver + 1;
    const enc = await encryptRow(state.rowKey, id, newVer, text);
    const submitted = { ver: newVer, nonce: enc.nonce, ct: enc.ct };
    const stored = await state.api.putRow(id, submitted);
    if (stored.ver === submitted.ver && stored.nonce === submitted.nonce && stored.ct === submitted.ct) {
      return { ver: newVer, text };
    }
    // Rebased: refresh from the server and re-apply the pure build.
    const res = await fetchRow(id);
    if (res.missing) {
      // Deleted concurrently (e.g. calendar deleted elsewhere): an allowed
      // create retries from scratch; an edit of a vanished row fails loudly.
      if (!allowCreate) throw new Error('not_found: ' + id);
      ver = 0;
      payload = null;
      continue;
    }
    if (res.corrupt) throw new Error('row_corrupt: refusing to rewrite a corrupt row');
    ver = res.ver;
    payload = res.payload;
  }
  throw new Error('rebase_exhausted: ' + id);
}


/* ---------------- occurrence → view event model ---------------- */

const diffDays = (a, b) =>
  Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);
const shiftDay = (d, n) => core.addDays(d, n);

function wallShift(dt, days) {
  return { date: shiftDay(dt.date, days), time: dt.time, tz: dt.tz };
}

/** Hours between two wall {date,time} (naive; display-classification only). */
function wallHours(a, b) {
  const t = (x) => (x.time === null ? 0 : Date.UTC(1970, 0, 1, +x.time.slice(0, 2), +x.time.slice(3, 5), +x.time.slice(6, 8)));
  return (t(b) - t(a)) / 3600000 + diffDays(b.date, a.date) * 24;
}

/**
 * All view events overlapping [firstDay, lastDay] (inclusive), from visible
 * calendars only. Mirrors Proton's CalendarViewEvent essentials.
 */
function viewEventsForRange(firstDay, lastDay) {
  const out = [];
  for (const [rowId, rec] of state.evt) {
    const { cal } = core.parseEvtId(rowId) || {};
    if (!cal || !state.cals.has(cal) || !calVisible.has(cal)) continue;
    const occs = core.expandEvtRow(rec.parsed, rowId, shiftDay(firstDay, -7), shiftDay(lastDay, +7));
    for (const occ of occs) {
      const span = core.spanDays(occ.master);
      const isAllDay = occ.allDay;
      const isAllPartDay = !isAllDay && wallHours(occ.start, occ.end) >= 24;
      const dispFirst = occ.start.date < firstDay ? firstDay : occ.start.date;
      const dispLast = span.last > lastDay ? lastDay : span.last;
      if (dispFirst > dispLast) continue;
      out.push({
        uniqueId: rowId + '#' + (occ.recId ? occ.recId.date + 'T' + (occ.recId.time || '') : 'm'),
        rowId,
        calUuid: cal,
        uid: occ.uid,
        occ,
        recId: occ.recId,
        isException: occ.isException,
        isCancelled: occ.isCancelled,
        isAllDay,
        isAllPartDay,
        isRecurring: !!rec.parsed.master.rrule,
        start: occ.start,
        end: occ.end,
        spanLast: span.last,
        dispFirst,
        dispLast,
        title: occ.master.summary,
        component: occ.master,
        parsed: rec.parsed,
      });
    }
  }
  // Deterministic order for layout(): start, then all-day first, then title.
  out.sort((a, b) => {
    if (a.start.date !== b.start.date) return a.start.date < b.start.date ? -1 : 1;
    const at = a.start.time || '00:00';
    const bt = b.start.time || '00:00';
    if (at !== bt) return at < bt ? -1 : 1;
    const aBlock = a.isAllDay || a.isAllPartDay ? 1 : 0;
    const bBlock = b.isAllDay || b.isAllPartDay ? 1 : 0;
    if (aBlock !== bBlock) return bBlock - aBlock; // all-day first
    if ((a.title || '') === (b.title || '')) return 0;
    return (a.title || '') < (b.title || '') ? -1 : 1;
  });
  return out;
}

/* ---------------- Proton month-grid layout (VERBATIM PORT) ----------------
 * layout.ts (GPL-3.0): collision groups + columns; the "column" result is the
 * chip STACK ROW within the week, "columns" the group's stack depth. */

function getCollisionGroups(events) {
  let maxEnd = -1;
  let tmp = [];
  const out = [];
  events.forEach((event, i, arr) => {
    const { start, end } = event;
    const isIntersect = start < maxEnd;
    if (isIntersect) {
      maxEnd = Math.max(maxEnd, end);
      tmp.push(event);
    } else {
      if (tmp.length) out.push(tmp);
      maxEnd = end;
      tmp = [event];
    }
    if (arr.length - 1 === i) out.push(tmp);
  });
  return out;
}

function getColumns(group) {
  return group.reduce((columns, event, i) => {
    for (let j = 0; j < columns.length; ++j) {
      const column = columns[j];
      const isIntersect = event.start < column.end;
      if (!isIntersect) {
        column.indices.push(i);
        column.end = Math.max(column.end, event.end);
        return columns;
      }
    }
    columns.push({ indices: [i], end: event.end });
    return columns;
  }, []);
}

/** Proton layout(): events (sorted by start) → [{column, columns}] per event. */
function layout(events) {
  const groups = getCollisionGroups(events);
  return groups.reduce((acc, group) => {
    const columns = getColumns(group);
    group.forEach((event, j) => {
      const columnIndex = columns.findIndex(({ indices }) => indices.indexOf(j) !== -1);
      acc.push({ column: columnIndex, columns: columns.length });
    });
    return acc;
  }, []);
}

/** splitDayEventsInInterval port: view events → day-index ranges in a week row. */
function splitDayEventsInInterval(events, minDay, maxDay) {
  return events.reduce((acc, ev, i) => {
    const startDate = ev.start.date < minDay ? minDay : ev.start.date;
    const isDisplayedMultipleDays = ev.isAllDay || ev.isAllPartDay;
    let endDay = isDisplayedMultipleDays ? (ev.spanLast > maxDay ? maxDay : ev.spanLast) : startDate;
    if (startDate > endDay) return acc;
    // Part-day events starting before the row range are shown in a previous row.
    if (!isDisplayedMultipleDays && startDate > ev.start.date) return acc;
    const startIndex = diffDays(startDate, minDay);
    const calendarDaysDifference = isDisplayedMultipleDays ? diffDays(endDay, startDate) : 0;
    acc.push({ idx: i, start: startIndex, end: startIndex + calendarDaysDifference + 1, id: ev.uniqueId });
    return acc;
  }, []);
}

/** useDayGridEventLayout port (one week row). Returns chip placement list. */
function dayGridRowLayout(eventsInRow, numberOfRows) {
  const laidOut = layout(eventsInRow);
  const getIsAllSingle = (summary, start, end) => {
    for (let i = start; i < end; ++i) {
      if (!summary[i] || summary[i].more !== 1) return false;
    }
    return true;
  };
  let maxRows = 0;
  const summary = {};
  laidOut.forEach(({ column: eventRow }, i) => {
    const { start, end } = eventsInRow[i];
    maxRows = Math.max(maxRows, eventRow + 1);
    for (let d = start; d < end; ++d) {
      if (!summary[d]) summary[d] = { more: 0, events: [] };
      summary[d].events.push(i);
      if (eventRow >= numberOfRows) summary[d].more++;
    }
  });
  const styles = [];
  laidOut.forEach(({ column: eventRow }, i) => {
    const { start, end } = eventsInRow[i];
    const isHidden = eventRow >= numberOfRows;
    const isAllSingle = isHidden && getIsAllSingle(summary, start, end);
    if (isAllSingle) {
      for (let d = start; d < end; ++d) summary[d].more = 0;
    }
    if (summary[start] && summary[start].more > 0 && isHidden) return;
    styles.push({ idx: i, dayIdx: start, type: 'event', row: eventRow, start, end });
  });
  const moreDays = [];
  for (const d of Object.keys(summary)) {
    const dayIdx = +d;
    if (summary[dayIdx].more > 0) moreDays.push({ idx: dayIdx, dayIdx, type: 'more' });
  }
  // Proton getSortedEventsAndMoreDays: by dayIdx, events before more.
  const sorted = [...styles, ...moreDays].sort((a, b) => {
    if (a.dayIdx !== b.dayIdx) return a.dayIdx - b.dayIdx;
    if (a.type === b.type) return 0;
    return a.type === 'event' ? -1 : 1;
  });
  return { eventsInRow, styles: sorted, summary, maxRows };
}

/* ---------------- rendering ---------------- */

/* ---------------- view system (v4.3: day / week / month / custom / year) ---------------- */

/** Proton VIEWS — the subset this client implements (constants.ts). */

function renderAll() {
  state.today = state.today || core.localToday();
  const root = viewRoot();
  root.replaceChildren();
  if (state.view === 'month') {
    renderMonth(root);
  } else if (state.view === 'year') {
    renderYear(root);
  } else {
    renderTimeGrid(root, viewRangeDays());
  }
  renderToolbar();
  renderMiniCalendar();
  renderCalendarList();
  renderClockPreview();
}

function viewRoot() {
  return $('#view-root');
}

/** Days shown by the active view (Proton eachDayOfInterval(dateRange)). */
function viewRangeDays() {
  const sel = state.selectedDate || state.today || core.localToday();
  if (state.view === 'day') return [sel];
  if (state.view === 'week') {
    const dow = (new Date(sel + 'T00:00:00Z').getUTCDay() + 6) % 7; // Monday = 0
    const monday = shiftDay(sel, -dow);
    const out = [];
    for (let i = 0; i < 7; i++) out.push(shiftDay(monday, i));
    return out;
  }
  // custom: N consecutive days starting at the selected date (2..14)
  const n = Math.max(2, Math.min(14, state.customDays));
  const out = [];
  for (let i = 0; i < n; i++) out.push(shiftDay(sel, i));
  return out;
}

/** Navigate the active view one step (Proton navigation arrows). */
function navView(delta) {
  if (state.view === 'month' || state.view === 'year') {
    const step = state.view === 'month' ? delta : delta * 12;
    const [y, m] = state.viewYM.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + step, 1));
    state.viewYM = d.toISOString().slice(0, 7);
    // keep the selected date inside the shown month (Proton clamps)
    const [ny, nm] = state.viewYM.split('-').map(Number);
    const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    const day = Math.min(Number((state.selectedDate || core.localToday()).slice(8)), last);
    state.selectedDate = state.viewYM + '-' + String(day).padStart(2, '0');
  } else {
    const step = state.view === 'day' ? delta : delta * viewRangeDays().length;
    state.selectedDate = shiftDay(state.selectedDate || core.localToday(), step);
    state.viewYM = state.selectedDate.slice(0, 7);
  }
  renderAll();
}

/** Toolbar label for the active view (Proton current-range). */
function viewLabel() {
  const today = state.today || core.localToday();
  if (state.view === 'month') {
    return MONTHS[Number(state.viewYM.slice(5)) - 1] + ' ' + state.viewYM.slice(0, 4);
  }
  if (state.view === 'year') {
    return state.viewYM.slice(0, 4);
  }
  const days = viewRangeDays();
  const a = days[0];
  const b = days[days.length - 1];
  if (state.view === 'day') {
    return fmtDateLong.format(new Date(a + 'T00:00:00')) + (a === today ? ' · today' : '');
  }
  const fmtRange = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
  const yr = new Intl.DateTimeFormat(locale, { year: 'numeric' });
  const sameYear = a.slice(0, 4) === b.slice(0, 4);
  return (
    fmtRange.format(new Date(a + 'T00:00:00')) +
    ' – ' +
    (sameYear ? '' : yr.format(new Date(a + 'T00:00:00')) + ' ') +
    fmtRange.format(new Date(b + 'T00:00:00')) +
    ', ' + yr.format(new Date(b + 'T00:00:00'))
  );
}

/** Segmented view switcher + custom-day picker (Proton ViewSelector). */
function renderToolbar() {
  $('#month-label').textContent = viewLabel();
  const seg = $('#view-selector');
  if (!seg.dataset.bound) {
    seg.dataset.bound = '1';
    for (const v of VIEWS) {
      const b = el('button', 'view-button', {
        type: 'button',
        text: v === 'custom' ? 'Custom' : v.charAt(0).toUpperCase() + v.slice(1),
        'aria-pressed': 'false',
        title: v + ' view',
        dataset: { view: v },
      });
      b.addEventListener('click', () => setView(v));
      seg.appendChild(b);
    }
    const pick = el('select', 'custom-days-select', {
      'aria-label': 'Custom view days', title: 'Custom view — number of days',
    });
    for (let n = 2; n <= 14; n++) {
      pick.appendChild(el('option', null, { value: String(n), text: n + ' days' }));
    }
    pick.value = String(state.customDays);
    pick.addEventListener('change', () => {
      state.customDays = Math.max(2, Math.min(14, Number(pick.value) || 5));
      setView('custom');
    });
    seg.appendChild(pick);
  }
  for (const b of seg.querySelectorAll('.view-button')) {
    b.classList.toggle('is-selected', b.dataset.view === state.view);
    b.setAttribute('aria-pressed', b.dataset.view === state.view ? 'true' : 'false');
  }
  seg.querySelector('.custom-days-select').hidden = state.view !== 'custom';
}

function setView(v) {
  if (!VIEWS.includes(v)) return;
  state.view = v;
  try { localStorage.setItem(LS_VIEW, v); } catch { /* ignore */ }
  renderAll();
}

const MONTHS = (() => {
  const out = [];
  for (let m = 0; m < 12; m++) out.push(new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(2026, m, 15)));
  return out;
})();

/** Weeks (Mon-first) covering the month of viewYM, each row = 7 day strings. */
function monthRows(ym) {
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = [];
  for (let d = 1; d <= n; d++) days.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  const lead = (first.getUTCDay() + 6) % 7; // Monday = 0
  const pre = [];
  for (let i = lead; i > 0; i--) pre.push(shiftDay(days[0], -i));
  const total = pre.length + days.length;
  const trail = (7 - (total % 7)) % 7;
  const post = [];
  for (let i = 1; i <= trail; i++) post.push(shiftDay(days[days.length - 1], i));
  const all = [...pre, ...days, ...post];
  const rows = [];
  for (let i = 0; i < all.length; i += 7) rows.push(all.slice(i, i + 7));
  return { rows, monthDays: new Set(days) };
}

function renderMonth(root) {
  root = root || viewRoot();
  root.replaceChildren(); // ALWAYS start clean (the rAF re-render appends)
  const wrap = el('div', 'daygrid-wrap is-month-view');
  const head = el('div', 'calendar-daygrid-days');
  head.id = 'grid-head';
  const rowsWrap = el('div', 'calendar-daygrid-rows');
  rowsWrap.id = 'grid-rows';
  rowsWrap.dataset.dnd = 'daygrid';
  wrap.append(head, rowsWrap);
  root.appendChild(wrap);
  head.replaceChildren();
  rowsWrap.replaceChildren();

  const today = state.today || core.localToday();
  const todayDow = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7;
  const isTodayMonth = state.viewYM === today.slice(0, 7);

  // Weekday header (Proton: long name; today's weekday highlighted).
  for (let i = 0; i < 7; i++) {
    const d = el('div', i === todayDow && isTodayMonth ? 'is-today' : '');
    d.append(
      el('span', 'day-fullname', { text: WEEKDAY_LONG[i] }),
      el('span', 'day-shortname', { text: WEEKDAY_LONG[i][0] })
    );
    head.appendChild(d);
  }

  const { rows, monthDays } = monthRows(state.viewYM);
  const events = viewEventsForRange(rows[0][0], rows[rows.length - 1][6]);
  const numberOfRows = Math.max(state.gridRows, 0);

  rows.forEach((days, rowIndex) => {
    const week = el('div', 'daygrid-week');
    const cols = el('div', 'calendar-daygrid-columns');
    for (const day of days) cols.appendChild(el('div', 'calendar-daygrid-column'));
    week.appendChild(cols);

    // Day buttons (Proton DayButtons: number, aria-current for today).
    const buttons = el('div', 'daygrid-daybuttons');
    for (const day of days) {
      const inMonth = monthDays.has(day);
      const b = el('button', 'calendar-monthgrid-day' +
        (inMonth ? '' : ' is-outside-month') +
        (day === state.selectedDate ? ' selected' : ''), {
        type: 'button',
        'aria-current': day === today ? 'date' : null,
        'aria-pressed': day === state.selectedDate ? 'true' : null,
        'aria-label': fmtDateMed.format(new Date(day + 'T00:00:00')),
        title: fmtDateLong.format(new Date(day + 'T00:00:00')),
      });
      b.addEventListener('click', () => {
        state.selectedDate = day;
        renderMonth();
        renderMiniCalendar();
        openMorePopover(day, b.getBoundingClientRect());
      });
      b.appendChild(el('span', 'calendar-monthgrid-day-number', { text: String(Number(day.slice(8))) }));
      buttons.appendChild(b);
    }
    week.appendChild(buttons);

    // Event chips area — the DnD row element (data-row).
    const rowEventsEl = el('div', 'daygrid-rowevents unstyled', { role: 'list', 'data-row': String(rowIndex) });
    // NOTE: splitDayEventsInInterval indexes into the array it is GIVEN —
    // keep one filtered array and index into THAT (never the full list).
    const rowEvents = events.filter((ev) => !(ev.dispFirst > days[6] || ev.dispLast < days[0]));
    const eventsInRow = splitDayEventsInInterval(rowEvents, days[0], days[6]);
    const laid = dayGridRowLayout(eventsInRow, numberOfRows);
    for (const s of laid.styles) {
      if (s.type === 'more') {
        rowEventsEl.appendChild(moreChip(s.dayIdx, days, laid.summary, rowEvents, eventsInRow, numberOfRows));
      } else {
        rowEventsEl.appendChild(eventChip(s, eventsInRow[s.idx] ? rowEvents[eventsInRow[s.idx].idx] : null, days));
      }
    }
    week.appendChild(rowEventsEl);
    rowsWrap.appendChild(week);
  });

  $('#month-label').textContent = viewLabel();

  // Proton useLayoutEffect: measure the first row, derive the visible chip rows.
  requestAnimationFrame(() => {
    const first = rowsWrap.querySelector('.daygrid-rowevents');
    if (!first) return;
    const h = first.getBoundingClientRect().height || 100;
    const n = Math.max(Math.floor(h / DAY_EVENT_HEIGHT), 1) - 1;
    if (n !== state.gridRows) {
      state.gridRows = n;
      renderMonth();
    }
  });
}

/** One event chip (Proton FullDayEvent / PartDayEvent, month view). */
function eventChip(style, ev, days) {
  if (!ev) return el('div');
  const [colorMain, colorAlt] = genAccentShades(calendarColor(ev.calUuid));
  const n = (days && days.length) || 7; // row day count (7 in month/week)
  const chip = el('div', 'calendar-dayeventcell', {
    style:
      `--top-custom:${style.row * DAY_EVENT_HEIGHT}px;` +
      `--left-custom:${(style.start / n) * 100}%;` +
      `--w-custom:${((style.end - style.start) / n) * 100}%;` +
      `--h-custom:${DAY_EVENT_HEIGHT}px;` +
      `--color-main:${colorMain};--color-alt:${colorAlt};--foreground:#fff;`,
    tabindex: '0',
    role: 'listitem',
  });
  const inner = el('div', 'calendar-dayeventcell-inner' +
    (ev.isAllDay || ev.isAllPartDay ? '' : ' isNotAllDay') +
    (ev.isCancelled ? ' isCancelled' : ''));
  const line = el('div', 'flex-line');
  if (!ev.isAllDay && !ev.isAllPartDay) {
    line.appendChild(el('span', 'calendar-dayeventcell-circle'));
    const t = ev.start.time === null ? '' : showTime(ev.start);
    if (t) line.appendChild(el('span', 'calendar-dayeventcell-time', { text: t }));
  } else if (!ev.isAllDay && ev.isAllPartDay && ev.start.time !== null) {
    const t = showTime(ev.start);
    if (t) line.appendChild(el('span', 'calendar-dayeventcell-time', { text: t }));
  }
  line.appendChild(el('span', 'calendar-dayeventcell-title chip-text', { text: ev.title || '' }));
  inner.appendChild(line);
  chip.appendChild(inner);
  chip.addEventListener('mouseup', (e) => {
    // DnD owns mousedown; a plain mouseup without drag opens the popover.
    if (!dragState.moved) {
      e.stopPropagation();
      openEventPopover(ev, chip.getBoundingClientRect());
    }
  });
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const r = chip.getBoundingClientRect();
      openEventPopover(ev, { left: r.left + 5, right: r.left + 5, top: r.top, bottom: r.bottom });
    }
  });
  return chip;
}

/** The "+N more" chip (Proton MoreFullDayEvent trigger). */
function moreChip(dayIdx, days, summary, events, eventsInRow, numberOfRows) {
  const more = summary[dayIdx].more;
  const n = (days && days.length) || 7; // row day count (7 in month/week)
  const chip = el('div', 'calendar-dayeventcell', {
    style:
      `--top-custom:${numberOfRows * DAY_EVENT_HEIGHT}px;` +
      `--left-custom:${(dayIdx / n) * 100}%;` +
      `--w-custom:${(1 / n) * 100}%;` +
      `--h-custom:${DAY_EVENT_HEIGHT}px;`,
  });
  const b = el('button', 'button button-ghost calendar-dayeventcell-more', {
    type: 'button', text: '+' + more + ' more',
  });
  b.addEventListener('mouseup', (e) => {
    if (!dragState.moved) {
      e.stopPropagation();
      openMorePopover(days[dayIdx], chip.getBoundingClientRect());
    }
  });
  chip.appendChild(b);
  return chip;
}

/* ---------------- TimeGrid (day / week / custom views) — Proton port ----------------
 * applications/calendar/src/app/components/calendar/TimeGrid.tsx +
 * TimeGrid/{DayButtons,DayEvents,HourLines,HourTexts}.tsx +
 * splitTimeGridEventsPerDay.ts (GPL-3.0), adapted to the wall-time model. */

const minutesOf = (dt) => (dt.time === null ? 0 : +dt.time.slice(0, 2) * 60 + +dt.time.slice(3, 5));

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/** Rendered-model cache for the time-grid mouse handler (Proton passes the
 * same data into handleTimeGridMouseDown at mousedown time). */
const timeGridModel = { days: [], timeEvents: [], perDay: new Map(), gridEl: null };

/**
 * splitTimeGridEventsPerDay.ts port (verbatim semantics): events → per-day
 * LayoutEvent [{idx, start(minutes), end(minutes), id}], clamped into the
 * day range, MIN_DURATION=15 floor, midnight-end special case skipped.
 */
function splitTimeGridEventsPerDay(events, days) {
  const byDay = new Map(days.map((d) => [d, []]));
  const minDate = days[0];
  const maxDate = days[days.length - 1];
  events.forEach((ev, i) => {
    // Clamp like startOfDay(max(start, min)) / endOfDay(min(end, max)).
    const startDay = ev.start.date < minDate ? minDate : ev.start.date;
    const endInstantDay = ev.end.date; // the day the END wall time falls on
    const endDay = endInstantDay > maxDate ? maxDate : endInstantDay;
    if (startDay > endDay) return;
    for (let d = startDay; d <= endDay; d = shiftDay(d, 1)) {
      if (!byDay.has(d)) continue; // day not shown in this view
      const startTime = d === ev.start.date ? minutesOf(ev.start) : 0;
      const endTime = d === endInstantDay ? minutesOf(ev.end) : TOTAL_MINUTES;
      // Special case: part-day event ending at midnight shows nothing on the
      // second day (Proton: endTime === 0 && !isSameDay(start, end)).
      if (endTime === 0 && d !== ev.start.date) continue;
      const startTimeWithMin =
        TOTAL_MINUTES - startTime < MIN_DURATION ? TOTAL_MINUTES - MIN_DURATION : startTime;
      const endTimeWithMin =
        endTime - startTimeWithMin < MIN_DURATION ? startTimeWithMin + MIN_DURATION : endTime;
      byDay.get(d).push({ idx: i, start: startTimeWithMin, end: endTimeWithMin, id: ev.uniqueId });
    }
  });
  return byDay;
}

/**
 * DayEvents.tsx getEventsLaidOut port: layout() (the verbatim month-grid
 * collision/columns engine) over a day's minute-ranges → absolute CSS props.
 * Returns size ('sm'|'xs'|'2xs') for short events (Proton getSize).
 */
function timeGridEventStyles(eventsInDay) {
  return layout(eventsInDay).map(({ column, columns }, i) => {
    const { start, end } = eventsInDay[i];
    const duration = end - start;
    const size =
      duration < 30 && duration >= 25 ? 'sm' :
      duration < 25 && duration >= 20 ? 'xs' :
      duration < 20 ? '2xs' : undefined;
    const toP = (n) => (n * 100).toFixed(4) + '%';
    return {
      idx: eventsInDay[i].idx,
      size,
      style: {
        top: toP(start / TOTAL_MINUTES),
        left: toP(column / columns),
        height: toP(duration / TOTAL_MINUTES),
        width: toP(1 / columns),
      },
    };
  });
}

/** One part-day chip (Proton PartDayEvent / PartDayRegularEvent). */
function partDayChip(ls, ev) {
  const [colorMain, colorAlt] = genAccentShades(calendarColor(ev.calUuid));
  const duration = ls.style.height; // keep style pure; duration text from ev
  const chip = el('div', 'calendar-eventcell' +
    (ls.size ? ' size-' + ls.size : '') +
    (ev.isCancelled ? ' isCancelled' : ''), {
    style:
      `top:${ls.style.top};left:${ls.style.left};width:${ls.style.width};height:${ls.style.height};` +
      `--color-main:${colorMain};--color-alt:${colorAlt};--foreground:#fff;`,
    tabindex: '0',
    role: 'listitem',
  });
  const inner = el('div', 'calendar-eventcell-inner');
  const timeText = ev.start.time === null
    ? ''
    : showTime(ev.start) + (ev.end.time !== null && wallHours(ev.start, ev.end) >= 0.75
        ? ' – ' + showTime(ev.end)
        : '');
  if (timeText) inner.appendChild(el('div', 'calendar-eventcell-time', { text: timeText }));
  inner.appendChild(el('div', 'calendar-eventcell-title', { text: ev.title || '' }));
  chip.appendChild(inner);
  chip.addEventListener('mouseup', (e) => {
    if (!dragState.moved) {
      e.stopPropagation();
      openEventPopover(ev, chip.getBoundingClientRect());
    }
  });
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const r = chip.getBoundingClientRect();
      openEventPopover(ev, { left: r.left + 5, right: r.left + 5, top: r.top, bottom: r.bottom });
    }
  });
  return chip;
}

/** TimeGrid DayButtons.tsx port (weekday + date number button). */
function timeGridDayButton(day, today) {
  const d = new Date(day + 'T00:00:00');
  const b = el('button', 'calendar-grid-heading', {
    type: 'button',
    'aria-current': day === today ? 'date' : null,
    'aria-pressed': day === state.selectedDate ? 'true' : null,
    'aria-label': fmtDateLong.format(d),
    title: fmtDateLong.format(d),
  });
  b.appendChild(el('span', 'calendar-grid-heading-day', { text: WEEKDAY_LONG[(d.getDay() + 6) % 7] }));
  b.appendChild(el('span', 'calendar-grid-heading-number', { text: String(d.getDate()) }));
  b.addEventListener('click', () => {
    state.selectedDate = day;
    state.viewYM = day.slice(0, 7);
    renderAll();
  });
  return b;
}

/** The primary-timezone label (Proton shows the tz name in the aside). */
function tzShort() {
  try {
    return Intl.DateTimeFormat(locale, { timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName').value;
  } catch {
    return '';
  }
}

/** Render day/week/custom views (TimeGrid.tsx structure, verbatim layout). */
function renderTimeGrid(root, days) {
  const today = state.today || core.localToday();
  const events = viewEventsForRange(days[0], days[days.length - 1]);
  // Proton: time events must be chronologically ordered for the layout.
  const timeEvents = events
    .filter((ev) => !ev.isAllDay)
    .sort((a, b) => (a.start.date + (a.start.time || '')).localeCompare(b.start.date + (b.start.time || '')));
  const dayEvents = events.filter((ev) => ev.isAllDay);

  const viewClass = days.length > 2 ? 'is-week-view' : 'is-day-view';

  /* ---- heading: day buttons row + all-day row (Proton calendar-row-heading) ---- */
  const heading = el('div', 'calendar-row-heading shrink-0 ' + viewClass);
  const firstRow = el('div', 'calendar-first-row-heading');
  for (const day of days) firstRow.appendChild(timeGridDayButton(day, today));
  heading.appendChild(firstRow);

  const fulldayRow = el('div', 'calendar-fullday-row');
  const aside = el('div', 'calendar-aside calendar-primary-timezone-cell');
  aside.appendChild(el('div', 'calendar-primary-timezone-cell--header', { text: tzShort() }));
  fulldayRow.appendChild(aside);
  const fdWrap = el('div', 'flex-1 relative');
  const fdList = el('ul', 'calendar-time-fullday unstyled daygrid-rowevents', {
    role: 'list', 'data-row': '0', 'data-dnd': 'daygrid',
  });
  const eventsInRow = splitDayEventsInInterval(dayEvents, days[0], days[days.length - 1]);
  const laid = dayGridRowLayout(eventsInRow, 3); // Proton: numberOfRows = 3
  for (const s of laid.styles) {
    if (s.type === 'more') {
      fdList.appendChild(moreChip(s.dayIdx, days, laid.summary, dayEvents, eventsInRow, 3));
    } else {
      fdList.appendChild(eventChip(s, eventsInRow[s.idx] ? dayEvents[eventsInRow[s.idx].idx] : null, days));
    }
  }
  fdWrap.appendChild(fdList);
  fulldayRow.appendChild(fdWrap);
  heading.appendChild(fulldayRow);
  root.appendChild(heading);

  /* ---- scrollable time grid ---- */
  const scroll = el('div', 'calendar-time-grid flex-1 ' + viewClass);
  const content = el('div', 'relative main-area-content');
  const flex = el('div', 'timegrid-flex');
  const hourTexts = el('div', 'calendar-aside calendar-primary-timezone-cell hour-texts');
  for (let h = 0; h < 24; h++) {
    const block = el('div', 'calendar-grid-timeBlock');
    if (h !== 0) {
      block.appendChild(el('span', 'calendar-grid-timeText', {
        text: fmtTime.format(new Date(2000, 0, 1, h)),
      }));
    }
    hourTexts.appendChild(block);
  }
  const columns = el('div', 'calendar-grid-gridcells timegrid-columns');
  const hoursEl = el('div', 'calendar-grid-hours');
  for (let h = 0; h < 24; h++) hoursEl.appendChild(el('div', 'calendar-grid-hourLine'));
  columns.appendChild(hoursEl);
  const perDay = splitTimeGridEventsPerDay(timeEvents, days);
  for (const day of days) {
    const col = el('div', 'calendar-grid-gridcell timegrid-day', {
      role: 'region',
      'aria-label': fmtDateLong.format(new Date(day + 'T00:00:00')),
    });
    for (const ls of timeGridEventStyles(perDay.get(day) || [])) {
      col.appendChild(partDayChip(ls, timeEvents[ls.idx]));
    }
    if (day === today) {
      col.appendChild(el('div', 'calendar-grid-nowHourLine', {
        style: `top:${((nowMinutes() / TOTAL_MINUTES) * 100).toFixed(4)}%;`,
      }));
    }
    columns.appendChild(col);
  }
  flex.append(hourTexts, columns);
  content.appendChild(flex);
  scroll.appendChild(content);
  root.appendChild(scroll);

  timeGridModel.days = days;
  timeGridModel.timeEvents = timeEvents;
  timeGridModel.perDay = perDay;
  timeGridModel.gridEl = columns;

  // Proton useLayoutEffect: scrollToNow on mount (scrollToTime port).
  requestAnimationFrame(() => {
    const timeTop = nowMinutes() / TOTAL_MINUTES;
    const timeRect = columns.getBoundingClientRect();
    const headingRect = heading.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    scroll.scrollTop = timeRect.height * timeTop - scrollRect.height / 2 + headingRect.height / 2;
  });
}

/* ---- TimeGrid interactions: timeGridMouseHandler.ts port (GPL-3.0) ---- */

/** dateHelpers.ts getSnappedMinutes (verbatim). */
function getSnappedMinutes(minutes, interval) {
  return Math.floor((minutes / 60) * (60 / interval)) * interval;
}

/** dateHelpers.ts getTargetMinutes (verbatim). */
function getTargetMinutes(pageY, top, height, totalMinutes, interval) {
  const targetMinutes = getRelativePosition(pageY, top, height) * totalMinutes;
  const hourInMinutes = Math.floor(targetMinutes / 60) * 60;
  const snappedMinutes = getSnappedMinutes(targetMinutes % 60, interval);
  return hourInMinutes + snappedMinutes;
}

/** Ghost chip while time-grid dragging (Proton renders a temporary event). */
let tgGhost = null;
function drawTimeGridGhost(day, startMin, endMin, title, isCreate) {
  removeTimeGridGhost();
  const col = [...timeGridModel.gridEl.querySelectorAll('.timegrid-day')].find(
    (c) => c.getAttribute('aria-label') === fmtDateLong.format(new Date(day + 'T00:00:00'))
  );
  if (!col) return;
  const g = el('div', 'calendar-eventcell chip-ghost-time' + (isCreate ? ' is-create' : ''), {
    style:
      `top:${((startMin / TOTAL_MINUTES) * 100).toFixed(4)}%;` +
      `height:${((Math.max(MIN_DURATION, endMin - startMin) / TOTAL_MINUTES) * 100).toFixed(4)}%;` +
      `left:2%;width:96%;`,
  });
  g.appendChild(el('div', 'calendar-eventcell-inner', {}));
  g.appendChild(el('div', 'calendar-eventcell-title', { text: title || '' }));
  col.appendChild(g);
  tgGhost = g;
}
function removeTimeGridGhost() {
  if (tgGhost && tgGhost.parentNode) tgGhost.remove();
  tgGhost = null;
}

/** timeGridMouseHandler.ts — capture-phase entry (document mousedown). */
function handleTimeGridMouseDown(e) {
  if (e.button !== 0) return;
  const gridEl = timeGridModel.gridEl;
  if (!gridEl) return;
  if (!(e.target instanceof HTMLElement)) return;
  if (!gridEl.contains(e.target)) return;
  const days = timeGridModel.days;
  if (!days.length) return;

  const rect = gridEl.getBoundingClientRect();
  const targetDate = getTargetIndex(e.pageX, rect.left, rect.width, days.length);
  const targetMinutes = getTargetMinutes(e.pageY, rect.top, rect.height, TOTAL_MINUTES, TIMEGRID_INTERVAL);

  const dayContainer = gridEl.children[targetDate + 1]; // +1 for the hour lines

  // If hitting the days container or the day container itself → CREATE.
  if (gridEl === e.target || dayContainer === e.target) {
    return createDragCreateTimeGrid({ e, targetDate, targetMinutes, days });
  }

  const targetIndex = findContainingParent(dayContainer, e.target);
  if (targetIndex < 0) return;

  const day = days[targetDate];
  if (!day) return;
  const eventsInDay = timeGridModel.perDay.get(day) || [];
  if (targetIndex >= eventsInDay.length) return;
  const { idx } = eventsInDay[targetIndex];
  const ev = timeGridModel.timeEvents[idx];
  if (!ev) return;
  // Proton getType: normal events only get DRAG_EVENT_MOVE (resize is
  // booking-only) — verbatim behaviour.
  createDragMoveTimeGrid({ e, ev, targetDate, targetMinutes, days });
}

/** timeGridMouseHandler.ts createDragCreateMouseDown (ported). */
function createDragCreateTimeGrid({ e, targetDate, targetMinutes, days }) {
  const startDate = days[targetDate];
  let endTargetMinutes;
  let oldMouseY = -1; // CREATE_STATE_INIT
  let result = null;

  e.preventDefault();
  e.stopPropagation();

  const handleMouseMove = (me) => {
    me.preventDefault();
    me.stopPropagation();
    if (oldMouseY === -1) oldMouseY = me.pageY;
    if (oldMouseY !== -2 && Math.abs(oldMouseY - me.pageY) < CREATE_SENSITIVITY) return;
    oldMouseY = -2; // CREATE_STATE_ACTIVE
    dragState.moved = true;

    const rect = timeGridModel.gridEl.getBoundingClientRect();
    const newEndTargetDate = getTargetIndex(me.pageX, rect.left, rect.width, days.length);
    const newEndTargetMinutes = getTargetMinutes(me.pageY, rect.top, rect.height, TOTAL_MINUTES, TIMEGRID_INTERVAL);
    if (newEndTargetDate === targetDate && newEndTargetMinutes === endTargetMinutes) return;
    endTargetMinutes = newEndTargetMinutes;
    // Proton: only allow d&d on the same day — endTargetDate = targetDate.
    const isAfter = endTargetMinutes >= targetMinutes;
    if (isAfter) {
      const newEnd = Math.min(TOTAL_MINUTES, endTargetMinutes + TIMEGRID_INTERVAL);
      result = { startMinutes: targetMinutes, endMinutes: newEnd };
    } else {
      result = { startMinutes: endTargetMinutes, endMinutes: targetMinutes };
    }
    drawTimeGridGhost(startDate, result.startMinutes, result.endMinutes, '', true);
  };

  const handleMouseUp = () => {
    document.removeEventListener('mouseup', handleMouseUp, true);
    document.removeEventListener('mousemove', handleMouseMove, true);
    removeTimeGridGhost();
    if (result) {
      beginCreateTimeGrid(startDate, result.startMinutes, result.endMinutes);
    } else {
      // Simple click: default 30-minute event at the snapped time.
      const end = Math.min(TOTAL_MINUTES, targetMinutes + 30);
      beginCreateTimeGrid(startDate, targetMinutes, Math.max(end, targetMinutes + MIN_DURATION));
    }
  };

  document.addEventListener('mouseup', handleMouseUp, true);
  document.addEventListener('mousemove', handleMouseMove, true);
  blockClick();
}

/** Open the editor for a timed event created on the time grid. */
function beginCreateTimeGrid(day, startMinutes, endMinutes) {
  closeAllOverlays();
  const uuid = defaultCalendarUuid();
  if (!uuid) { toast('Create a calendar first.', 'warn'); return; }
  const p2 = (n) => String(Math.floor(n)).padStart(2, '0');
  editor.mode = 'create';
  editor.scope = null;
  editor.target = null;
  editor.custom = null;
  openEditor({
    title: '',
    allDay: false,
    start: { date: day, time: p2(startMinutes / 60) + ':' + p2(startMinutes % 60) },
    end: { date: day, time: p2(endMinutes / 60) + ':' + p2(endMinutes % 60) },
    freq: '',
    calUuid: uuid,
    location: '',
    notifs: [],
    description: '',
  });
}

/** timeGridMouseHandler.ts createDragMoveEvent (ported; MOVE type only). */
function createDragMoveTimeGrid({ e, ev, targetDate, targetMinutes, days }) {
  let oldTargetDate = targetDate;
  let oldTargetMinutes = targetMinutes;
  let currentTargetDate;
  let currentTargetMinutes;
  let result = null;

  e.preventDefault();
  e.stopPropagation();

  const handleMouseMove = (me) => {
    const rect = timeGridModel.gridEl.getBoundingClientRect();
    currentTargetDate = getTargetIndex(me.pageX, rect.left, rect.width, days.length);
    currentTargetMinutes = getTargetMinutes(me.pageY, rect.top, rect.height, TOTAL_MINUTES, TIMEGRID_INTERVAL);
    if (oldTargetDate === currentTargetDate && oldTargetMinutes === currentTargetMinutes) return;
    oldTargetDate = currentTargetDate;
    oldTargetMinutes = currentTargetMinutes;
    dragState.moved = true;

    const diffDate = currentTargetDate - targetDate;
    const diffMinutes = currentTargetMinutes - targetMinutes;
    result = { diffDate, diffMinutes };

    // Ghost at the shifted position (same day column as the pointer).
    const day = days[Math.max(0, Math.min(days.length - 1, currentTargetDate))];
    const startMin = Math.max(0, minutesOf(ev.start) + diffMinutes);
    const endMin = Math.min(TOTAL_MINUTES, minutesOf(ev.end) + diffMinutes);
    drawTimeGridGhost(day, startMin, Math.max(endMin, startMin + MIN_DURATION), ev.title || '', false);
  };

  const handleMouseUp = () => {
    document.removeEventListener('mouseup', handleMouseUp, true);
    document.removeEventListener('mousemove', handleMouseMove, true);
    removeTimeGridGhost();
    timeGridModel.gridEl.querySelectorAll('.isDragging').forEach((n) => n.classList.remove('isDragging'));
    if (result) {
      finishTimeGridMove(ev, result.diffDate, result.diffMinutes);
    }
    // else: plain click — the chip's own mouseup opens the popover.
  };

  document.addEventListener('mouseup', handleMouseUp, true);
  document.addEventListener('mousemove', handleMouseMove, true);
  blockClick();
  const chip = e.target.closest('.calendar-eventcell');
  if (chip) chip.querySelector('.calendar-eventcell-inner')?.classList.add('isDragging');
}

async function finishTimeGridMove(ev, diffDate, diffMinutes) {
  if (!diffDate && !diffMinutes) return;
  const apply = async (scope) => {
    try {
      setBusy(true, 'Moving event…');
      await applyDayShift(ev, diffDate, scope, diffMinutes);
      toast('Event moved.', 'ok', 2000);
    } catch (e) {
      toast('Move failed: ' + (e && e.message ? e.message : String(e)), 'err', 7000);
    } finally {
      setBusy(false);
    }
  };
  if (ev.isRecurring || ev.isException) {
    openRecurringChoice('Move recurring event', apply);
  } else {
    await apply('master');
  }
}

/* ---------------- year view (Proton YEAR: 12 month grids) ---------------- */

function renderYear(root) {
  const year = state.viewYM.slice(0, 4);
  const today = state.today || core.localToday();
  const wrap = el('div', 'yeargrid-wrap');
  const events = viewEventsForRange(year + '-01-01', year + '-12-31');
  const daysWithEvents = new Map(); // day -> [calUuid…]
  for (const ev of events) {
    for (let d = ev.dispFirst; d <= ev.dispLast; d = shiftDay(d, 1)) {
      if (!daysWithEvents.has(d)) daysWithEvents.set(d, []);
      daysWithEvents.get(d).push(ev.calUuid);
    }
  }
  for (let m = 1; m <= 12; m++) {
    const ym = year + '-' + String(m).padStart(2, '0');
    const box = el('div', 'yeargrid-month');
    box.appendChild(el('div', 'yeargrid-month-label', { text: MONTHS[m - 1] }));
    const grid = el('div', 'minicalendar-grid yeargrid-grid');
    for (let i = 0; i < 7; i++) {
      grid.appendChild(el('div', 'wd', { text: WEEKDAY_LONG[i].slice(0, 2) }));
    }
    const { rows, monthDays } = monthRows(ym);
    for (const week of rows) {
      for (const day of week) {
        const calIds = daysWithEvents.get(day) || [];
        const b = el('button', 'minicalendar-day' +
          (monthDays.has(day) ? '' : ' out') +
          (day === today ? ' today' : '') +
          (day === state.selectedDate ? ' selected' : ''), {
          type: 'button',
          text: String(Number(day.slice(8))),
          'aria-label': fmtDateMed.format(new Date(day + 'T00:00:00')),
        });
        if (calIds.length > 0) {
          const dot = el('span', 'yearday-dot');
          dot.style.background = calendarColor(calIds[0]);
          b.appendChild(dot);
        }
        b.addEventListener('click', () => {
          state.selectedDate = day;
          state.viewYM = day.slice(0, 7);
          setView('month');
        });
        grid.appendChild(b);
      }
    }
    box.appendChild(grid);
    wrap.appendChild(box);
  }
  root.appendChild(wrap);
}

/* ---------------- mini calendar ---------------- */

function renderMiniCalendar() {
  const grid = $('#minical-grid');
  grid.replaceChildren();
  const ym = state.viewYM;
  $('#minical-label').textContent = MONTHS[Number(ym.slice(5)) - 1] + ' ' + ym.slice(0, 4);

  const { rows, monthDays } = monthRows(ym);
  const today = state.today || core.localToday();
  for (let i = 0; i < 7; i++) {
    grid.appendChild(el('div', 'wd', { text: WEEKDAY_LONG[i].slice(0, 2) }));
  }
  for (const week of rows) {
    for (const day of week) {
      const cls = [
        'minicalendar-day',
        monthDays.has(day) ? '' : 'out',
        day === today ? 'today' : '',
        day === state.selectedDate ? 'selected' : '',
      ].filter(Boolean).join(' ');
      const b = el('button', cls, {
        type: 'button', text: String(Number(day.slice(8))),
        'aria-label': fmtDateMed.format(new Date(day + 'T00:00:00')),
      });
      b.addEventListener('click', () => {
        state.selectedDate = day;
        state.viewYM = day.slice(0, 7);
        renderAll();
      });
      grid.appendChild(b);
    }
  }
}

/* ---------------- calendar list (sidebar) ---------------- */

function calendarColor(uuid) {
  const c = state.cals.get(uuid);
  return c ? c.meta.color : '#8080FF';
}

function renderCalendarList() {
  const ul = $('#calendar-list');
  ul.replaceChildren();
  $('#no-calendars').hidden = state.cals.size > 0;
  let openMenu = null;
  const closeMenu = () => { if (openMenu) { openMenu.remove(); openMenu = null; } };

  for (const [uuid, { meta }] of state.cals) {
    const li = el('li');
    const check = el('input', 'cal-check', { type: 'checkbox' });
    check.style.color = meta.color;
    check.style.borderColor = meta.color;
    check.checked = calVisible.has(uuid);
    check.setAttribute('aria-label', 'Show ' + meta.name);
    check.addEventListener('change', () => {
      calVis.set(uuid, check.checked);
      saveCalVis();
      syncCalVisible();
      renderAll();
    });
    const name = el('span', 'cal-name', { text: meta.name });
    const more = el('button', 'item-more', { type: 'button', 'aria-label': 'Calendar options', title: 'Options', text: '⋯' });
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openMenu) { closeMenu(); return; }
      const menu = el('div', 'item-menu');
      const edit = el('button', { type: 'button', text: 'Edit' });
      edit.addEventListener('click', () => { closeMenu(); openCalendarModal(uuid); });
      const del = el('button', 'danger', { type: 'button', text: 'Delete' });
      del.addEventListener('click', () => { closeMenu(); confirmDeleteCalendar(uuid); });
      menu.append(edit, del);
      const r = more.getBoundingClientRect();
      menu.style.top = r.bottom + 4 + 'px';
      menu.style.left = Math.min(r.left, window.innerWidth - 160) + 'px';
      document.body.appendChild(menu);
      openMenu = menu;
      setTimeout(() => {
        const closer = (ev) => {
          if (!menu.contains(ev.target)) { closeMenu(); document.removeEventListener('mousedown', closer, true); }
        };
        document.addEventListener('mousedown', closer, true);
      }, 0);
    });
    li.append(check, name, more);
    ul.appendChild(li);
  }

  if (state.corrupt.size > 0) {
    const li = el('li', 'corrupt-note');
    li.appendChild(el('span', 'cal-name', { text: state.corrupt.size + ' unreadable row(s)' }));
    ul.appendChild(li);
  }
}

/* ---------------- clock preview (§13c LOCAL derivation, read-only) ---------------- */

function renderClockPreview() {
  const panel = $('#clock-list');
  panel.replaceChildren();
  const today = state.today || core.localToday();
  // v4.3: derived in-memory from evt rows (protocol.md §13c) — ZERO requests,
  // exactly the §13 format the (unbuilt) clock would cache.
  const parsedRows = new Map();
  for (const [id, rec] of state.evt) parsedRows.set(id, rec.parsed);
  const derived = core.deriveWindowBuckets(parsedRows, today);
  for (const day of core.clockPreviewDays(today)) {
    const entries = core.sortBucketEvents(derived.get(day) || []);
    const item = el('div', 'clock-item' + (day === today ? ' today' : ''));
    item.appendChild(el('div', 'clock-date', {
      text: fmtDayMonth.format(new Date(day + 'T00:00:00')) + (day === today ? ' (today)' : ''),
    }));
    if (entries.length === 0) {
      item.appendChild(el('div', 'clock-ev none', { text: '—' }));
    } else {
      for (const ev of entries) {
        item.appendChild(el('div', 'clock-ev', {
          text: `${String(ev.hh).padStart(2, '0')}:${String(ev.mm).padStart(2, '0')} — ${ev.title} [p${ev.priority}]`,
        }));
      }
    }
    panel.appendChild(item);
  }
}

/* ---------------- event popover (read-only, Proton EventPopover port) ---------------- */

function popoverSurface() { return $('#event-popover'); }

function positionPopover(pop, anchor) {
  pop.hidden = false;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = anchor.right + 8;
  if (left + pw > window.innerWidth - 12) left = anchor.left - pw - 8;
  if (left < 12) left = Math.max(12, window.innerWidth - pw - 12);
  let top = anchor.top;
  if (top + ph > window.innerHeight - 12) top = window.innerHeight - ph - 12;
  if (top < 12) top = 12;
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

function openPopover(content) {
  const pop = popoverSurface();
  pop.replaceChildren(content);
  $('#popover-backdrop').hidden = false;
  pop.hidden = false;
  pushOverlay(pop, closePopover);
  return pop;
}

function closePopover() {
  const pop = popoverSurface();
  pop.hidden = true;
  pop.replaceChildren();
  $('#popover-backdrop').hidden = true;
  popOverlay(pop);
}

function openEventPopover(ev, anchor) {
  closeAllOverlays();
  const cal = state.cals.get(ev.calUuid);
  const box = el('div', 'eventpopover-inner');

  // Header: calendar color bar + title + date + frequency; actions right.
  const head = el('div', 'eventpopover-head');
  const bar = el('span', 'eventpopover-calendar-border');
  bar.style.background = calendarColor(ev.calUuid);
  const headMain = el('div');
  headMain.style.flex = '1';
  if (ev.isCancelled) {
    headMain.appendChild(el('span', 'badge proto', { text: 'canceled' }));
  }
  const title = el('h1', 'eventpopover-title', { text: ev.title || '' });
  headMain.appendChild(title);
  headMain.appendChild(el('div', 'eventpopover-date', { text: eventDateHeader(ev) }));
  const freq = frequencyString(ev);
  if (freq) headMain.appendChild(el('div', 'eventpopover-date freq', { text: freq }));
  head.append(bar, headMain);
  const actions = el('div', 'eventpopover-actions');
  const btnEdit = el('button', 'button button-ghost icon-only', {
    type: 'button', title: 'Edit', 'aria-label': 'Edit',
  });
  btnEdit.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 13.5l.9-3.2 7.4-7.4 2.3 2.3-7.4 7.4-3.2.9zM10 4l2 2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  btnEdit.addEventListener('click', () => { closePopover(); beginEdit(ev); });
  const btnDel = el('button', 'button button-ghost icon-only button-danger', {
    type: 'button', title: 'Delete', 'aria-label': 'Delete',
  });
  btnDel.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5M6.7 7v3.7M9.3 7v3.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  btnDel.addEventListener('click', () => { closePopover(); beginDelete(ev); });
  actions.append(btnEdit, btnDel);
  head.appendChild(actions);
  box.appendChild(head);

  // Icon rows: calendar, location, notifications, description.
  const rows = el('div');
  rows.appendChild(iconRow('cal', (cal ? cal.meta.name : 'Unknown calendar')));
  if (ev.component && ev.component.location) rows.appendChild(iconRow('loc', ev.component.location));
  const notifs = (ev.component ? ev.component.alarms : []).map((a) => triggerMinutes(a.triggerRaw)).filter((n) => n !== null);
  for (const n of notifs) rows.appendChild(iconRow('bell', notificationLabel(n)));
  if (ev.component && ev.component.description) rows.appendChild(iconRow('txt', ev.component.description));
  box.appendChild(rows);

  const pop = openPopover(box);
  positionPopover(pop, anchor);
}

function iconRow(kind, text) {
  const row = el('div', 'popover-iconrow');
  const icons = {
    cal: 'M3.5 5h9v8h-9zM5 3.5h6M3.5 7.5h9M6.5 10h1',
    loc: 'M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 1 0-9 0C3.5 9.8 8 14 8 14zm0-6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    bell: 'M8 2.5a4 4 0 0 0-4 4v2.5L2.8 12h10.4L12 9V6.5a4 4 0 0 0-4-4zM6.7 13.7a1.4 1.4 0 0 0 2.6 0',
    txt: 'M3 5h10M3 8h10M3 11h6',
  };
  row.appendChild(el('span', 'ic', { 'aria-hidden': 'true' }));
  row.firstChild.innerHTML =
    `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="${icons[kind]}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  row.appendChild(el('div', 'content', { text }));
  return row;
}

function notificationLabel(minutes) {
  if (minutes === 0) return 'At time of event';
  if (minutes < 60) return minutes + ' minutes before';
  if (minutes < 1440) return (minutes / 60) + ' hour' + (minutes >= 120 ? 's' : '') + ' before';
  return (minutes / 1440) + ' day' + (minutes >= 2880 ? 's' : '') + ' before';
}

/* ---------------- "+N more" / day popover ---------------- */

function openMorePopover(day, anchor) {
  closeAllOverlays();
  const events = viewEventsForRange(day, day).filter((ev) => ev.dispFirst <= day && day <= ev.dispLast);
  const box = el('div');
  box.appendChild(el('h1', 'eventpopover-title', {
    text: events.length + ' event' + (events.length === 1 ? '' : 's') + ' · ' +
      fmtDateMed.format(new Date(day + 'T00:00:00')),
  }));
  const list = el('div');
  if (events.length === 0) {
    list.appendChild(el('p', 'hint', { text: 'No events this day.' }));
  } else {
    for (const ev of events) {
      const row = el('div', 'popover-iconrow');
      const [main, alt] = genAccentShades(calendarColor(ev.calUuid));
      const dot = el('span', 'calendar-dayeventcell-circle');
      dot.style.background = main;
      const chip = el('button', 'calendar-dayeventcell-inner' +
        (ev.isAllDay || ev.isAllPartDay ? '' : ' isNotAllDay'));
      chip.style.setProperty('--color-main', main);
      chip.style.setProperty('--color-alt', alt);
      chip.style.position = 'relative';
      chip.style.top = '0';
      chip.style.left = '0';
      chip.style.width = '100%';
      chip.style.height = DAY_EVENT_HEIGHT + 'px';
      const line = el('div', 'flex-line');
      if (!ev.isAllDay && !ev.isAllPartDay) {
        line.appendChild(dot);
        const t = showTime(ev.start);
        if (t) line.appendChild(el('span', 'calendar-dayeventcell-time', { text: t }));
      }
      line.appendChild(el('span', 'calendar-dayeventcell-title chip-text', { text: ev.title || '' }));
      chip.appendChild(line);
      chip.addEventListener('click', () => { closePopover(); openEventPopover(ev, chip.getBoundingClientRect()); });
      row.appendChild(chip);
      list.appendChild(row);
    }
  }
  box.appendChild(list);
  const pop = openPopover(box);
  positionPopover(pop, anchor);
}

/* ---------------- modal helpers ---------------- */

function openModalSurface(modal, backdrop, close) {
  modal.hidden = false;
  backdrop.hidden = false;
  pushOverlay(modal, close);
}
function closeModalSurface(modal, backdrop) {
  modal.hidden = true;
  backdrop.hidden = true;
  modal.replaceChildren();
  popOverlay(modal);
}

/* ---------------- event editor (Proton EventForm port, modal) ---------------- */

const editor = {
  mode: null,      // 'create' | 'edit'
  scope: null,     // 'master' | 'exception' (recurring edits)
  target: null,    // view event being edited
  custom: null,    // custom rrule string (CUSTOM freq)
};

const FREQ_PRESETS = [
  { key: '', label: 'Does not repeat' },
  { key: 'DAILY', label: 'Every day' },
  { key: 'WEEKLY', label: 'Every week on' },     // + weekday name, computed
  { key: 'MONTHLY', label: 'Every month on' },   // + day number
  { key: 'YEARLY', label: 'Every year on' },     // + date
  { key: 'WEEKDAYS', label: 'Every weekday (Mon–Fri)' },
  { key: 'CUSTOM', label: 'Custom…' },
];

/** Proton uses the next half-hour from now for new events (getInitialModel). */
function defaultStart() {
  const d = new Date();
  const m = d.getMinutes();
  d.setMinutes(m < 30 ? 30 : 0, 0, 0);
  if (m >= 30) d.setHours(d.getHours() + 1);
  return d;
}

function beginCreate(dateStr) {
  closeAllOverlays();
  const start = dateStr ? null : defaultStart();
  const day = dateStr || core.localToday();
  editor.mode = 'create';
  editor.scope = null;
  editor.target = null;
  editor.custom = null;
  openEditor({
    title: '',
    allDay: !!dateStr, // month-grid click/drag creates all-day events (Proton month view)
    start: { date: day, time: start ? hhmm(start) : '00:00' },
    end: start
      ? { date: day, time: hhmm(new Date(start.getTime() + 30 * 60000)) } // DEFAULT_EVENT_DURATION
      : { date: day, time: '01:00' },
    freq: '',
    calUuid: defaultCalendarUuid(),
    location: '',
    notifs: [],
    description: '',
  });
}

function hhmm(d) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function defaultCalendarUuid() {
  const visible = [...calVisible];
  if (visible.length > 0) return visible[0];
  return state.cals.keys().next().value || null;
}

/** Edit entry point: recurring events ask scope first (Proton pattern). */
function beginEdit(ev) {
  closeAllOverlays();
  if (ev.isRecurring || ev.isException) {
    openRecurringChoice('Edit recurring event', (scope) => {
      editor.mode = 'edit';
      editor.scope = scope;
      editor.target = ev;
      editor.custom = null;
      openEditorFormFor(ev, scope);
    });
  } else {
    editor.mode = 'edit';
    editor.scope = 'master';
    editor.target = ev;
    editor.custom = null;
    openEditorFormFor(ev, 'master');
  }
}

/** Delete entry point: recurring events ask scope first. */
async function beginDelete(ev) {
  closeAllOverlays();
  const run = async (scope) => {
    if (state.busy) return;
    try {
      setBusy(true, 'Deleting…');
      await deleteEvent(ev, scope);
    } catch (e) {
      toast('Delete failed: ' + (e && e.message ? e.message : String(e)), 'err', 7000);
    } finally {
      setBusy(false);
    }
  };
  if (ev.isRecurring || ev.isException) {
    openRecurringChoice('Delete recurring event', run);
  } else {
    await run('master');
  }
}

function openEditorFormFor(ev, scope) {
  const comp = scope === 'exception' ? exceptionFor(ev) || ev.component : ev.parsed.master;
  const isAllDay = comp.dtstart.time === null;
  const end = core.effectiveEnd(comp);
  const freq = freqKeyFromComponent(comp, ev.parsed.master);
  editor.custom = freq === 'CUSTOM' ? (ev.parsed.master.rrule || '') : null;
  openEditor({
    title: comp.summary || '',
    allDay: isAllDay,
    start: {
      date: comp.dtstart.date,
      time: comp.dtstart.time === null ? '00:00' : comp.dtstart.time.slice(0, 5),
    },
    end: {
      // All-day editor shows the INCLUSIVE last day (DTEND − 1; Proton
      // hasModifiedAllDayEndDate does the same).
      date: isAllDay ? shiftDay(end.date, -1) : end.date,
      time: end.time === null ? '00:00' : end.time.slice(0, 5),
    },
    freq,
    calUuid: ev.calUuid,
    location: comp.location || '',
    notifs: comp.alarms.map((a) => triggerMinutes(a.triggerRaw)).filter((n) => n !== null),
    description: comp.description || '',
  });
}

function exceptionFor(ev) {
  if (!ev.recId) return null;
  return ev.parsed.exceptions.find(
    (x) => x.recurrenceId.date === ev.recId.date &&
      (x.recurrenceId.time || '') === (ev.recId.time || '')
  ) || null;
}

function openEditor(form) {
  const modal = $('#editor-modal');
  const backdrop = $('#editor-backdrop');
  const close = () => closeModalSurface(modal, backdrop);
  const box = el('div', 'eventform');
  const headRow = el('div', 'modal-head');
  headRow.appendChild(el('h1', { text: editor.mode === 'create' ? 'Add event' : 'Edit event' }));
  const closeX = el('button', 'button button-ghost icon-only', { type: 'button', 'aria-label': 'Close', title: 'Close' });
  closeX.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round"/></svg>';
  closeX.addEventListener('click', close);
  headRow.appendChild(closeX);
  box.appendChild(headRow);

  const f = { ...form };
  const val = () => ({
    title: f.title,
    allDay: f.allDay,
    start: { ...f.start },
    end: { ...f.end },
    freq: f.freq,
    custom: editor.custom,
    calUuid: f.calUuid,
    location: f.location,
    notifs: [...f.notifs],
    description: f.description,
  });

  /* ---- title ---- */
  const rowTitle = el('div', 'form-row');
  const titleInput = el('input', null, { type: 'text', value: f.title, placeholder: 'Add title', 'aria-label': 'Title' });
  const onTitle = () => { f.title = titleInput.value; };
  titleInput.addEventListener('input', onTitle);
  titleInput.addEventListener('change', onTitle);
  rowTitle.appendChild(el('span', 'ic'));
  rowTitle.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 2v3M8 11v3M2 8h3M11 8h3" stroke-linecap="round"/></svg>';
  rowTitle.appendChild(titleInput);
  box.appendChild(rowTitle);

  /* ---- start / end ---- */
  const mkDT = (label, which) => {
    const body = el('div', 'form-row-body');
    body.appendChild(el('label', { text: label }));
    const fields = el('div', 'fields');
    const dateI = el('input', null, { type: 'date', value: f[which].date, 'aria-label': label + ' date' });
    const timeI = el('input', null, { type: 'time', value: f[which].time, 'aria-label': label + ' time' });
    timeI.classList.add('narrow');
    const apply = () => {
      f[which] = { date: dateI.value || f[which].date, time: f.allDay ? null : (timeI.value || f[which].time) };
      // Frequency preset labels are derived from the START date (weekday /
      // month-day / date) — refresh them like Proton does on date change.
      if (which === 'start') refreshFreqLabels();
    };
    dateI.addEventListener('change', apply);
    timeI.addEventListener('change', apply);
    fields.append(dateI, timeI);
    body.appendChild(fields);
    return { body, dateI, timeI, apply };
  };
  const rowStart = el('div', 'form-row');
  rowStart.appendChild(el('span', 'ic'));
  rowStart.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M5 2v2M11 2v2M2.5 7h11" stroke-linecap="round"/></svg>';
  const dtStart = mkDT('Starts', 'start');
  rowStart.appendChild(dtStart.body);
  box.appendChild(rowStart);

  const rowEnd = el('div', 'form-row');
  rowEnd.appendChild(el('span', 'ic'));
  rowEnd.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 2" stroke-linecap="round"/></svg>';
  const dtEnd = mkDT('Ends', 'end');
  rowEnd.appendChild(dtEnd.body);
  box.appendChild(rowEnd);

  /* ---- all-day + frequency ---- */
  const rowFR = el('div', 'form-row');
  rowFR.appendChild(el('span', 'ic'));
  rowFR.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 4.5h10M3 8h10M3 11.5h10" stroke-linecap="round"/><path d="M3 3v10" stroke-linecap="round"/></svg>';
  const frBody = el('div', 'form-row-body');
  const fr = el('div', 'fullday-recurrency');
  const allDayChk = el('input', null, { type: 'checkbox' });
  allDayChk.checked = f.allDay;
  const allDayLbl = el('label');
  allDayLbl.append(allDayChk, document.createTextNode('All day'));
  const setAllDay = () => {
    f.allDay = allDayChk.checked;
    dtStart.timeI.hidden = f.allDay;
    dtEnd.timeI.hidden = f.allDay;
    dtStart.apply(); dtEnd.apply();
    refreshFreqLabels();
  };
  allDayChk.addEventListener('change', setAllDay);
  const freqSel = el('select', null, { 'aria-label': 'Frequency' });
  const refreshFreqLabels = () => {
    freqSel.replaceChildren();
    for (const p of FREQ_PRESETS) {
      let label = p.label;
      const d = new Date(f.start.date + 'T00:00:00');
      if (p.key === 'WEEKLY') label += ' ' + WEEKDAY_LONG[(d.getDay() + 6) % 7];
      if (p.key === 'MONTHLY') label += ' the ' + Number(f.start.date.slice(8));
      if (p.key === 'YEARLY') label += ' ' + fmtDayMonth.format(d);
      if (p.key === 'CUSTOM' && editor.custom) label = 'Custom… (' + editor.custom + ')';
      freqSel.appendChild(el('option', null, { value: p.key, text: label }));
    }
    freqSel.value = f.freq;
  };
  freqSel.addEventListener('change', () => {
    const prev = f.freq;
    f.freq = freqSel.value;
    if (f.freq === 'CUSTOM') openFreqModal((rrule) => {
      if (rrule) editor.custom = rrule;
      else f.freq = prev; // cancelled: revert the selection
      refreshFreqLabels();
    }, editor.custom, f);
  });
  fr.append(allDayLbl, freqSel);
  frBody.appendChild(fr);
  rowFR.appendChild(frBody);
  box.appendChild(rowFR);
  setAllDay();

  /* ---- calendar picker ---- */
  const rowCal = el('div', 'form-row');
  rowCal.appendChild(el('span', 'ic'));
  rowCal.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M5 2v2M11 2v2" stroke-linecap="round"/></svg>';
  const calBody = el('div', 'form-row-body');
  calBody.appendChild(el('label', { text: 'Calendar' }));
  const calRow = el('div', 'cal-select-row');
  const calDot = el('span', 'cal-dot');
  const calSel = el('select', null, { 'aria-label': 'Calendar' });
  for (const [uuid, { meta }] of state.cals) {
    calSel.appendChild(el('option', null, { value: uuid, text: meta.name }));
  }
  if (f.calUuid && state.cals.has(f.calUuid)) calSel.value = f.calUuid;
  const setDot = () => { calDot.style.background = calendarColor(calSel.value); f.calUuid = calSel.value; };
  calSel.addEventListener('change', setDot);
  setDot();
  calRow.append(calDot, calSel);
  calBody.appendChild(calRow);
  rowCal.appendChild(calBody);
  box.appendChild(rowCal);

  /* ---- location ---- */
  const rowLoc = el('div', 'form-row');
  rowLoc.appendChild(el('span', 'ic'));
  rowLoc.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 1 0-9 0C3.5 9.8 8 14 8 14zm0-6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" stroke-linejoin="round"/></svg>';
  const locBody = el('div', 'form-row-body');
  const locI = el('input', null, { type: 'text', value: f.location, placeholder: 'Add location', 'aria-label': 'Location' });
  const onLoc = () => { f.location = locI.value; };
  locI.addEventListener('input', onLoc);
  locI.addEventListener('change', onLoc);
  locBody.appendChild(locI);
  rowLoc.appendChild(locBody);
  box.appendChild(rowLoc);

  /* ---- notifications ---- */
  const rowNotif = el('div', 'form-row');
  rowNotif.appendChild(el('span', 'ic'));
  rowNotif.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 2.5a4 4 0 0 0-4 4v2.5L2.8 12h10.4L12 9V6.5a4 4 0 0 0-4-4zM6.7 13.7a1.4 1.4 0 0 0 2.6 0" stroke-linejoin="round"/></svg>';
  const notifBody = el('div', 'form-row-body');
  notifBody.appendChild(el('label', { text: 'Notifications' }));
  const notifRows = el('div');
  const NOTIF_OPTIONS = [
    [0, 'At time of event'], [5, '5 minutes before'], [10, '10 minutes before'],
    [15, '15 minutes before'], [30, '30 minutes before'], [60, '1 hour before'],
    [120, '2 hours before'], [1440, '1 day before'],
  ];
  const renderNotifRows = () => {
    notifRows.replaceChildren();
    f.notifs.forEach((n, i) => {
      const row = el('div', 'notif-row');
      const sel = el('select');
      for (const [v, label] of NOTIF_OPTIONS) sel.appendChild(el('option', null, { value: v, text: label }));
      sel.value = String(n);
      sel.addEventListener('change', () => { f.notifs[i] = Number(sel.value); });
      const rm = el('button', 'rm', { type: 'button', 'aria-label': 'Remove notification', text: '×' });
      rm.addEventListener('click', () => { f.notifs.splice(i, 1); renderNotifRows(); });
      row.append(sel, rm);
      notifRows.appendChild(row);
    });
  };
  renderNotifRows();
  const addBtn = el('button', 'button button-ghost notif-add', { type: 'button', text: '+ Add notification' });
  addBtn.addEventListener('click', () => { f.notifs.push(10); renderNotifRows(); });
  notifBody.append(notifRows, addBtn);
  rowNotif.appendChild(notifBody);
  box.appendChild(rowNotif);

  /* ---- description ---- */
  const rowDesc = el('div', 'form-row');
  rowDesc.appendChild(el('span', 'ic'));
  rowDesc.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 5h10M3 8h10M3 11h6" stroke-linecap="round"/></svg>';
  const descBody = el('div', 'form-row-body');
  const descT = el('textarea', null, { placeholder: 'Add description', 'aria-label': 'Description' });
  descT.value = f.description;
  const onDesc = () => { f.description = descT.value; };
  descT.addEventListener('input', onDesc);
  descT.addEventListener('change', onDesc);
  descBody.appendChild(descT);
  rowDesc.appendChild(descBody);
  box.appendChild(rowDesc);

  /* ---- footer ---- */
  const footer = el('div', 'modal-footer');
  if (editor.mode === 'edit') {
    const del = el('button', 'button button-ghost button-danger left', { type: 'button', text: 'Delete' });
    del.addEventListener('click', async () => {
      if (state.busy) return;
      const target = editor.target; // capture BEFORE close (close resets state)
      const scope = editor.scope === 'exception' ? 'exception' : 'all';
      close();
      try {
        setBusy(true, 'Deleting…');
        await deleteEvent(target, scope);
      } catch (e) {
        toast('Delete failed: ' + (e && e.message ? e.message : String(e)), 'err', 7000);
      } finally {
        setBusy(false);
      }
    });
    footer.appendChild(del);
  }
  const cancel = el('button', 'button button-ghost', { type: 'button', text: 'Cancel' });
  cancel.addEventListener('click', close);
  const save = el('button', 'button button-primary', { type: 'button', text: 'Save' });
  save.addEventListener('click', async () => {
    try {
      setBusy(true, 'Saving…');
      await saveEvent(val());
      close();
    } catch (e) {
      toast('Save failed: ' + (e && e.message ? e.message : String(e)), 'err', 7000);
    } finally {
      setBusy(false);
    }
  });
  footer.append(cancel, save);
  box.appendChild(footer);

  modal.replaceChildren(box);
  openModalSurface(modal, backdrop, close);
  titleInput.focus();
}

/* ---- save / delete: v4.2 evt row mutations ---- */

function rruleFor(freq, form, comp) {
  const d = form.start.date;
  const dow = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][(new Date(d + 'T00:00:00').getDay() + 6) % 7];
  switch (freq) {
    case '': return null;
    case 'DAILY': return 'FREQ=DAILY';
    case 'WEEKLY': return 'FREQ=WEEKLY;BYDAY=' + dow;
    case 'MONTHLY': return 'FREQ=MONTHLY';
    case 'YEARLY': return 'FREQ=YEARLY';
    case 'WEEKDAYS': return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'CUSTOM': return editor.custom || null;
    default: return null;
  }
}

function freqKeyFromComponent(comp, master) {
  const r = master ? master.rrule : null;
  if (!r) return '';
  const dow = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][(new Date(master.dtstart.date + 'T00:00:00').getDay() + 6) % 7];
  if (r === 'FREQ=DAILY') return 'DAILY';
  if (r === 'FREQ=WEEKLY;BYDAY=' + dow) return 'WEEKLY';
  if (r === 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR') return 'WEEKDAYS';
  if (r === 'FREQ=MONTHLY' || r === 'FREQ=MONTHLY;BYMONTHDAY=' + Number(master.dtstart.date.slice(8))) return 'MONTHLY';
  if (r === 'FREQ=YEARLY') return 'YEARLY';
  return 'CUSTOM';
}

async function saveEvent(form) {
  // Normalize: end after start (swap when reversed). All-day ends are
  // DISPLAY-inclusive here; the RFC-exclusive DTEND is computed below.
  const cmp = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.time || '') < (b.time || '') ? -1 : 1);
  if (cmp(form.end, form.start) < 0) {
    const t = form.start; form.start = form.end; form.end = t;
  }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const mkStart = () =>
    form.allDay
      ? { date: form.start.date, time: null, tz: null }
      : { date: form.start.date, time: form.start.time + ':00', tz };
  const mkEnd = () =>
    form.allDay
      ? // RFC 5545: DTEND DATE value is exclusive → display end + 1 day.
        { date: shiftDay(form.end.date, 1), time: null, tz: null }
      : { date: form.end.date, time: form.end.time + ':00', tz };

  const alarms = form.notifs.map((n) => ({
    action: 'DISPLAY',
    triggerRaw: formatDuration(-n * 60),
    triggerParams: [],
    extra: [],
  }));

  const now = new Date();
  const dtstamp = { date: now.toISOString().slice(0, 10), time: now.toISOString().slice(11, 19), tz: 'UTC' };

  if (editor.mode === 'create') {
    if (!form.calUuid || !state.cals.has(form.calUuid)) throw new Error('no_calendar');
    const uid = crypto.randomUUID();
    const cal = buildVCalendarOf({
      uid,
      dtstamp,
      dtstart: mkStart(),
      dtend: mkEnd(),
      rrule: rruleFor(form.freq, form),
      summary: form.title,
      description: form.description || null,
      location: form.location || null,
      status: null,
      transp: form.allDay ? 'TRANSPARENT' : null,
      sequence: 0,
      alarms,
    });
    const id = core.evtId(form.calUuid, uid);
    // v4.3 §5.2: ONE request (PUT ver 1) — no pre-GET, no post-save sync.
    const res = await putRowRMW(id, () => serializeVCalendar(cal), {
      allowCreate: true,
      local: { ver: 0, payload: null },
    });
    if (res.ver !== 1) throw new Error('unexpected_ver: ' + id);
    applyRowLocally(id, res.ver, res.text);
    renderAll();
    toast('Event saved.', 'ok', 2000);
    return;
  }

  // Edit: RMW the row, modifying master or the exception component.
  const target = editor.target;
  const rowId = target.rowId;
  const parsed = target.parsed;
  const isExceptionEdit = editor.scope === 'exception';
  // Calendar MOVE (PROTOCOL-v4.2.md): the calendar uuid is embedded in the
  // row id, so moving = DELETE the old row + PUT evt:{newcal}:{uid} with the
  // same UID and ver 1 (the documented move procedure).
  if (form.calUuid && form.calUuid !== target.calUuid && state.cals.has(form.calUuid)) {
    let current;
    try {
      current = parseEvtPayload((await fetchRow(rowId)).payload);
    } catch { current = null; }
    if (!current) throw new Error('row_corrupt: refusing to move a corrupt row');
    const events = current.calendar.events;
    const idx = isExceptionEdit
      ? events.findIndex((e) => e.recurrenceId && target.recId &&
          e.recurrenceId.date === target.recId.date && (e.recurrenceId.time || '') === (target.recId.time || ''))
      : events.findIndex((e) => e.recurrenceId === null);
    const base = idx >= 0 ? events[idx] : current.master;
    const upd = {
      ...base,
      dtstamp,
      dtstart: mkStart(),
      dtend: mkEnd(),
      rrule: isExceptionEdit ? base.rrule : rruleFor(form.freq, form),
      summary: form.title,
      description: form.description || null,
      location: form.location || null,
      transp: form.allDay ? 'TRANSPARENT' : null,
      sequence: (base.sequence === null || base.sequence === undefined ? 0 : base.sequence) + 1,
      alarms,
    };
    if (idx >= 0) events[idx] = upd;
    else events.push(upd);
    const newId = core.evtId(form.calUuid, current.uid);
    await state.api.deleteRow(rowId);
    state.evt.delete(rowId);
    state.corrupt.delete(rowId);
    const res = await putRowRMW(newId, () => serializeVCalendar(current.calendar), { allowCreate: true });
    applyRowLocally(newId, res.ver, res.text);
    renderAll();
    toast('Event moved and saved.', 'ok', 2000);
    return;
  }
  const recId = isExceptionEdit
    ? (target.recId ? { date: target.recId.date, time: target.recId.time, tz: target.component.dtstart.tz } : null)
    : null;

  // v4.3 §5.2 fast path: local ver+payload from state; rebase re-fetches.
  const localRow = state.evt.get(rowId) || null;
  const res = await putRowRMW(rowId, (payload, ver) => {
    let p;
    try { p = core.parseEvtPayload(payload); } catch { p = null; }
    if (!p) throw new Error('row_corrupt: refusing to rewrite a corrupt row');
    const events = p.calendar.events;
    const idx = isExceptionEdit
      ? events.findIndex((e) => e.recurrenceId &&
          e.recurrenceId.date === recId.date && (e.recurrenceId.time || '') === (recId.time || ''))
      : events.findIndex((e) => e.recurrenceId === null);
    const old = idx >= 0 ? events[idx] : null;
    const base = old || {
      uid: p.uid,
      dtstamp,
      dtstart: mkStart(),
      dtend: mkEnd(),
      duration: null,
      recurrenceId: recId,
      rrule: null,
      exdates: [],
      rdates: [],
      summary: '',
      description: null,
      location: null,
      status: null,
      transp: null,
      sequence: null,
      alarms: [],
      extra: [],
    };
    const upd = {
      ...base,
      dtstamp,
      dtstart: mkStart(),
      dtend: mkEnd(),
      rrule: isExceptionEdit ? base.rrule : rruleFor(form.freq, form),
      summary: form.title,
      description: form.description || null,
      location: form.location || null,
      transp: form.allDay ? 'TRANSPARENT' : null,
      sequence: (base.sequence === null || base.sequence === undefined ? 0 : base.sequence) + 1,
      alarms,
    };
    if (idx >= 0) events[idx] = upd;
    else events.push(upd);
    return serializeVCalendar(p.calendar);
  }, { allowCreate: false, local: localRow ? { ver: localRow.ver, payload: serializeEvtOf(localRow) } : null });

  applyRowLocally(rowId, res.ver, res.text);
  renderAll();
  toast('Event saved.', 'ok', 2000);
}

/** Re-serialize a locally-held parsed row (for the RMW fast-path payload). */
function serializeEvtOf(rec) {
  return core.serializeEvtPayload(rec.parsed);
}

/** Build a minimal VCALENDAR model around one component spec. */
function buildVCalendarOf(spec) {
  const ev = {
    uid: spec.uid,
    dtstamp: spec.dtstamp,
    dtstart: spec.dtstart,
    dtend: spec.dtend,
    duration: null,
    recurrenceId: null,
    rrule: spec.rrule,
    exdates: [],
    rdates: [],
    summary: spec.summary,
    description: spec.description,
    location: spec.location,
    status: spec.status,
    transp: spec.transp,
    sequence: spec.sequence,
    alarms: spec.alarms,
    extra: [],
  };
  return { prodId: null, events: [ev], extra: [] };
}

async function deleteEvent(ev, scope) {
  // NOTE: no create-mode guard — the editor's Delete button only renders in
  // edit mode, and popover/day-list callers always pass a saved event.
  const rowId = ev.rowId;
  if (!(ev.isRecurring || ev.isException) || scope === 'all') {
    await state.api.deleteRow(rowId);
    state.evt.delete(rowId);
    state.corrupt.delete(rowId);
    renderAll();
    toast('Event deleted.', 'ok', 2000);
    return;
  }
  // scope === 'this': EXDATE the occurrence on the master (+ drop any exception).
  const recId = ev.recId;
  const localRow = state.evt.get(rowId) || null;
  const res = await putRowRMW(rowId, (payload) => {
    let p;
    try { p = core.parseEvtPayload(payload); } catch { p = null; }
    if (!p) throw new Error('row_corrupt: refusing to rewrite a corrupt row');
    p.master.exdates.push({
      date: recId.date,
      time: recId.time === null ? null : recId.time,
      tz: p.master.dtstart.tz,
    });
    p.calendar.events = p.calendar.events.filter(
      (e) => !(e.recurrenceId && e.recurrenceId.date === recId.date && (e.recurrenceId.time || '') === (recId.time || ''))
    );
    return serializeVCalendar(p.calendar);
  }, { allowCreate: false, local: localRow ? { ver: localRow.ver, payload: serializeEvtOf(localRow) } : null });
  applyRowLocally(rowId, res.ver, res.text);
  renderAll();
  toast('Event deleted.', 'ok', 2000);
}

/* ---- drag & drop save ---- */

/**
 * Shift an event by whole days AND minutes (wall-clock arithmetic; a time
 * shift may carry into the next/previous day). scope 'exception' turns a
 * plain occurrence into its exception component (same semantics as before).
 */
async function applyDayShift(ev, days, scope, minutes = 0) {
  const shiftDt = (dt) => {
    if (!dt) return dt;
    const shiftedDate = shiftDay(dt.date, days);
    if (dt.time === null || minutes === 0) {
      return { date: shiftedDate, time: dt.time, tz: dt.tz };
    }
    const secs = +dt.time.slice(0, 2) * 3600 + +dt.time.slice(3, 5) * 60 + +dt.time.slice(6, 8) + minutes * 60;
    const dayCarry = Math.floor(secs / 86400);
    const rem = ((secs % 86400) + 86400) % 86400;
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return {
      date: shiftDay(shiftedDate, dayCarry),
      time: `${p(Math.floor(rem / 3600))}:${p(Math.floor((rem % 3600) / 60))}:${p(rem % 60)}`,
      tz: dt.tz,
    };
  };
  const target = ev;
  const localRow = state.evt.get(target.rowId) || null;
  const res = await putRowRMW(target.rowId, (payload) => {
    let p;
    try { p = core.parseEvtPayload(payload); } catch { p = null; }
    if (!p) throw new Error('row_corrupt: refusing to rewrite a corrupt row');
    const events = p.calendar.events;
    const isException = scope === 'exception';
    const idx = isException
      ? events.findIndex((e) => e.recurrenceId && e.recurrenceId.date === target.recId.date &&
          (e.recurrenceId.time || '') === (target.recId.time || ''))
      : events.findIndex((e) => e.recurrenceId === null);
    // Dragging a plain occurrence as "This event" CREATES the exception
    // component (same semantics as the editor's exception save path).
    const old = idx >= 0
      ? events[idx]
      : {
          uid: p.uid,
          dtstamp: null,
          dtstart: target.component.dtstart,
          dtend: target.component.dtend,
          duration: null,
          recurrenceId: target.recId
            ? { date: target.recId.date, time: target.recId.time, tz: target.component.dtstart.tz }
            : null,
          rrule: null,
          exdates: [],
          rdates: [],
          summary: target.component.summary || '',
          description: target.component.description || null,
          location: target.component.location || null,
          status: target.component.status || null,
          transp: target.component.transp || null,
          sequence: null,
          alarms: target.component.alarms || [],
          extra: [],
        };
    const upd = {
      ...old,
      dtstamp: { date: new Date().toISOString().slice(0, 10), time: new Date().toISOString().slice(11, 19), tz: 'UTC' },
      dtstart: shiftDt(old.dtstart),
      dtend: old.dtend ? shiftDt(old.dtend) : null,
      duration: old.dtend ? null : old.duration, // DURATION stays (relative)
      sequence: (old.sequence === null || old.sequence === undefined ? 0 : old.sequence) + 1,
    };
    if (isException && target.recId) {
      upd.recurrenceId = { date: target.recId.date, time: target.recId.time, tz: old.dtstart.tz };
    }
    if (idx >= 0) events[idx] = upd;
    else events.push(upd);
    return serializeVCalendar(p.calendar);
  }, { allowCreate: false, local: localRow ? { ver: localRow.ver, payload: serializeEvtOf(localRow) } : null });
  applyRowLocally(target.rowId, res.ver, res.text);
  renderAll();
}

/* ---------------- recurring choice modal ---------------- */

function openRecurringChoice(title, choose) {
  const modal = $('#recur-modal');
  const backdrop = $('#recur-backdrop');
  const close = () => closeModalSurface(modal, backdrop);
  const box = el('div');
  box.appendChild(el('h1', { text: title }));
  const btns = el('div', 'recur-choices');
  const bAll = el('button', 'button button-outline', { type: 'button', text: 'All events' });
  bAll.addEventListener('click', () => { close(); choose('all'); });
  const bOne = el('button', 'button button-outline', { type: 'button', text: 'This event' });
  bOne.addEventListener('click', () => { close(); choose('exception'); });
  const bCancel = el('button', 'button button-ghost', { type: 'button', text: 'Cancel' });
  bCancel.addEventListener('click', close);
  btns.append(bAll, bOne, bCancel);
  box.appendChild(btns);
  modal.replaceChildren(box);
  openModalSurface(modal, backdrop, close);
  bAll.focus();
}

/* ---------------- custom frequency modal ---------------- */

function openFreqModal(done, initial, form) {
  const modal = $('#freq-modal');
  const backdrop = $('#freq-backdrop');
  const close = () => closeModalSurface(modal, backdrop);

  // Parse the current custom rrule into editable state.
  let freq = 'WEEKLY', interval = 1, byday = new Set(), endType = 'never', count = 10, until = form.start.date;
  if (initial) {
    const parts = initial.split(';').map((s) => s.split('='));
    for (const [k, v] of parts) {
      if (k === 'FREQ') freq = v;
      if (k === 'INTERVAL') interval = Math.max(1, Number(v) || 1);
      if (k === 'BYDAY') byday = new Set(v.split(','));
      if (k === 'COUNT') { endType = 'count'; count = Math.max(1, Number(v) || 1); }
      if (k === 'UNTIL') { endType = 'until'; until = v.slice(0, 4) + '-' + v.slice(4, 6) + '-' + v.slice(6, 8); }
    }
  } else {
    byday.add(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][(new Date(form.start.date + 'T00:00:00').getDay() + 6) % 7]);
  }

  const box = el('div', 'eventform');
  box.appendChild(el('h1', { text: 'Custom recurrence' }));

  const rowFreq = el('div', 'form-row');
  rowFreq.appendChild(el('span', 'ic'));
  rowFreq.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 4.5h10M3 8h10M3 11.5h10" stroke-linecap="round"/></svg>';
  const fb = el('div', 'form-row-body');
  fb.appendChild(el('label', { text: 'Repeat' }));
  const fields = el('div', 'fields');
  const every = el('input', null, { type: 'number', min: '1', max: '99', value: String(interval), 'aria-label': 'Interval' });
  every.classList.add('narrow');
  const freqSel = el('select', null, { 'aria-label': 'Frequency unit' });
  freqSel.append(
    el('option', null, { value: 'DAILY', text: 'day(s)' }),
    el('option', null, { value: 'WEEKLY', text: 'week(s)' }),
    el('option', null, { value: 'MONTHLY', text: 'month(s)' }),
    el('option', null, { value: 'YEARLY', text: 'year(s)' }),
  );
  freqSel.value = freq;
  fields.append(every, freqSel);
  fb.appendChild(fields);
  rowFreq.appendChild(fb);
  box.appendChild(rowFreq);

  // BYDAY checkboxes (weekly only).
  const rowDays = el('div', 'form-row');
  rowDays.appendChild(el('span', 'ic'));
  const db = el('div', 'form-row-body');
  db.appendChild(el('label', { text: 'Repeat on' }));
  const dayBoxes = [];
  ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].forEach((dcode, i) => {
    const chk = el('input', null, { type: 'checkbox' });
    chk.checked = byday.has(dcode);
    dayBoxes.push([dcode, chk]);
    const lab = el('label', { style: 'display:inline-flex;align-items:center;gap:4px;margin-right:10px;' });
    lab.append(chk, document.createTextNode(WEEKDAY_LONG[i].slice(0, 2)));
    db.appendChild(lab);
  });
  rowDays.appendChild(db);
  box.appendChild(rowDays);
  const syncDays = () => { rowDays.hidden = freqSel.value !== 'WEEKLY'; };
  freqSel.addEventListener('change', syncDays);
  syncDays();

  const rowEnd = el('div', 'form-row');
  rowEnd.appendChild(el('span', 'ic'));
  rowEnd.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 2" stroke-linecap="round"/></svg>';
  const eb = el('div', 'form-row-body');
  eb.appendChild(el('label', { text: 'Ends' }));
  const endFields = el('div', 'fields');
  const endSel = el('select');
  endSel.append(
    el('option', null, { value: 'never', text: 'Never' }),
    el('option', null, { value: 'count', text: 'After' }),
    el('option', null, { value: 'until', text: 'On date' }),
  );
  endSel.value = endType;
  const countI = el('input', null, { type: 'number', min: '1', max: '999', value: String(count), 'aria-label': 'Occurrences' });
  countI.classList.add('narrow');
  const countLbl = el('span', null, { text: ' times' });
  const untilI = el('input', null, { type: 'date', value: until, 'aria-label': 'Until date' });
  const syncEnd = () => {
    countI.hidden = endSel.value !== 'count';
    countLbl.hidden = endSel.value !== 'count';
    untilI.hidden = endSel.value !== 'until';
  };
  endSel.addEventListener('change', syncEnd);
  syncEnd();
  endFields.append(endSel, countI, countLbl, untilI);
  eb.appendChild(endFields);
  rowEnd.appendChild(eb);
  box.appendChild(rowEnd);

  const footer = el('div', 'modal-footer');
  const cancel = el('button', 'button button-ghost', { type: 'button', text: 'Cancel' });
  cancel.addEventListener('click', close);
  const ok = el('button', 'button button-primary', { type: 'button', text: 'Apply' });
  ok.addEventListener('click', () => {
    const f = freqSel.value;
    const iv = Math.max(1, Math.min(99, Number(every.value) || 1));
    let r = 'FREQ=' + f + ';INTERVAL=' + iv;
    if (f === 'WEEKLY') {
      const days = dayBoxes.filter(([d, c]) => c.checked).map(([d]) => d);
      if (days.length) r += ';BYDAY=' + days.join(',');
    }
    if (endSel.value === 'count') r += ';COUNT=' + Math.max(1, Number(countI.value) || 1);
    if (endSel.value === 'until' && untilI.value) {
      // RFC 5545: UNTIL value type must match DTSTART (DATE / date-time with Z).
      r += form.allDay
        ? ';UNTIL=' + untilI.value.replaceAll('-', '')
        : ';UNTIL=' + untilI.value.replaceAll('-', '') + 'T' +
          (form.start.time || '00:00').replaceAll(':', '') + '00Z';
    }
    close();
    done(r);
  });
  footer.append(cancel, ok);
  box.appendChild(footer);

  modal.replaceChildren(box);
  openModalSurface(modal, backdrop, close);
}

/* ---------------- calendar modal (create / edit) ---------------- */

function openCalendarModal(uuid) {
  const modal = $('#cal-modal');
  const backdrop = $('#cal-backdrop');
  const close = () => closeModalSurface(modal, backdrop);
  const existing = uuid ? state.cals.get(uuid) : null;

  const box = el('div', 'eventform');
  box.appendChild(el('h1', { text: existing ? 'Edit calendar' : 'Add calendar' }));

  const nameRow = el('div', 'form-row');
  const nameI = el('input', null, {
    type: 'text', value: existing ? existing.meta.name : '', placeholder: 'Calendar name', 'aria-label': 'Name',
  });
  nameRow.appendChild(nameI);
  box.appendChild(nameRow);
  const colorRow = el('div', 'form-row');
  const cb = el('div', 'form-row-body');
  cb.appendChild(el('label', { text: 'Color' }));
  const grid = el('div', 'palette-grid');
  let color = existing ? existing.meta.color : core.PALETTE[0];
  const swatches = [];
  for (const c of core.PALETTE) {
    const sw = el('button', 'palette-swatch' + (c === color ? ' selected' : ''), {
      type: 'button', 'aria-label': c, title: c,
    });
    sw.style.background = c;
    sw.addEventListener('click', () => {
      color = c;
      swatches.forEach(([cc, s]) => s.classList.toggle('selected', cc === c));
    });
    swatches.push([c, sw]);
    grid.appendChild(sw);
  }
  cb.appendChild(grid);
  colorRow.appendChild(cb);
  box.appendChild(colorRow);

  const footer = el('div', 'modal-footer');
  const cancel = el('button', 'button button-ghost', { type: 'button', text: 'Cancel' });
  cancel.addEventListener('click', close);
  const save = el('button', 'button button-primary', { type: 'button', text: 'Save' });
  save.addEventListener('click', async () => {
    const name = nameI.value.trim();
    if (!name || name.length > 100) {
      toast('Name is required (≤100 chars).', 'err');
      return;
    }
    try {
      setBusy(true, 'Saving calendar…');
      if (existing) {
        const meta = core.newCalendarMeta(name, color);
        const res = await putRowRMW(core.cmetaId(uuid), () => JSON.stringify(meta), {
          allowCreate: false,
          local: { ver: existing.ver, payload: JSON.stringify(existing.meta) },
        });
        applyRowLocally(core.cmetaId(uuid), res.ver, res.text);
      } else {
        const newUuid = crypto.randomUUID();
        const meta = core.newCalendarMeta(name, color);
        const res = await putRowRMW(core.cmetaId(newUuid), () => JSON.stringify(meta), {
          allowCreate: true,
          local: { ver: 0, payload: null },
        });
        applyRowLocally(core.cmetaId(newUuid), res.ver, res.text);
        // v4.3 fix: update the PERSISTED visibility map (calVis), not just the
        // derived Set — syncCalVisible() rebuilds the Set from calVis, so a
        // calendar added only to the Set would be invisible until the next
        // sync (v4.2 masked this via the post-save syncAll).
        calVis.set(newUuid, true);
        calVisible.add(newUuid);
        saveCalVis();
      }
      close();
      syncCalVisible();
      renderAll();
      toast('Calendar saved.', 'ok', 2000);
    } catch (e) {
      toast('Save failed: ' + (e && e.message ? e.message : String(e)), 'err', 7000);
    } finally {
      setBusy(false);
    }
  });
  footer.append(cancel, save);
  box.appendChild(footer);

  modal.replaceChildren(box);
  openModalSurface(modal, backdrop, close);
  nameI.focus();
}

function confirmDeleteCalendar(uuid) {
  const modal = $('#recur-modal');
  const backdrop = $('#recur-backdrop');
  const close = () => closeModalSurface(modal, backdrop);
  const c = state.cals.get(uuid);
  const n = [...state.evt.keys()].filter((id) => (core.parseEvtId(id) || {}).cal === uuid).length;
  const box = el('div');
  box.appendChild(el('h1', { text: 'Delete calendar' }));
  box.appendChild(el('p', 'hint', {
    text: `Delete “${c ? c.meta.name : ''}”${n ? ' and its ' + n + ' event(s)' : ''}? This cannot be undone.`,
  }));
  const btns = el('div', 'recur-choices');
  const cancel = el('button', 'button button-ghost', { type: 'button', text: 'Cancel' });
  cancel.addEventListener('click', close);
  const del = el('button', 'button button-primary', { type: 'button', text: 'Delete', style: 'background:var(--signal-danger);' });
  del.addEventListener('click', async () => {
    close();
    try {
      setBusy(true, 'Deleting calendar…');
      for (const id of [...state.evt.keys()]) {
        if ((core.parseEvtId(id) || {}).cal === uuid) {
          await state.api.deleteRow(id);
          state.evt.delete(id);
        }
      }
      await state.api.deleteRow(core.cmetaId(uuid));
      state.cals.delete(uuid);
      state.corrupt.delete(core.cmetaId(uuid));
      calVisible.delete(uuid);
      saveCalVis();
      syncCalVisible();
      renderAll();
      toast('Calendar deleted.', 'ok', 2000);
    } catch (e) {
      toast('Delete failed: ' + (e && e.message ? e.message : String(e)), 'err', 7000);
    } finally {
      setBusy(false);
    }
  });
  btns.append(cancel, del);
  box.appendChild(btns);
  modal.replaceChildren(box);
  openModalSurface(modal, backdrop, close);
  del.focus();
}

/* ---------------- frequency display string (compact port of
 * getFrequencyString.ts — English only, same semantic cases) ---------------- */

function frequencyString(ev) {
  const master = ev.parsed ? ev.parsed.master : null;
  const r = master ? master.rrule : null;
  if (!r) return null;
  const start = new Date(master.dtstart.date + 'T00:00:00');
  const dow = WEEKDAY_LONG[(start.getDay() + 6) % 7];
  const parts = Object.fromEntries(r.split(';').map((s) => s.split('=')));
  const f = parts.FREQ;
  const iv = Number(parts.INTERVAL || 1);
  let base;
  if (f === 'DAILY') base = iv === 1 ? 'Every day' : `Every ${iv} days`;
  else if (f === 'WEEKLY') {
    const days = (parts.BYDAY || '').split(',').filter(Boolean)
      .map((d) => WEEKDAY_LONG[['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].indexOf(d)]).filter(Boolean);
    base = iv === 1 ? 'Every week' : `Every ${iv} weeks`;
    if (days.length === 1) base += ' on ' + days[0];
    else if (days.length > 1) base += ' on ' + days.join(', ');
  } else if (f === 'MONTHLY') base = iv === 1 ? 'Every month' : `Every ${iv} months`;
  else if (f === 'YEARLY') base = iv === 1 ? 'Every year' : `Every ${iv} years`;
  else return r;
  if (ev.isException) base += ' (this occurrence edited)';
  if (parts.COUNT) base += `, ${parts.COUNT} times`;
  if (parts.UNTIL) {
    const u = parts.UNTIL;
    const d = u.length === 8 ? u : u.slice(0, 8);
    base += ', until ' + fmtDateMed.format(new Date(
      +d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)
    ));
  }
  return base;
}

/* ---------------- DnD: dayGridMouseHandler port (VERBATIM logic) ----------------
 * interactions/dayGridMouseHandler.ts + mouseHelpers (GPL-3.0). */

const dragState = { moved: false };

/** mouseHelpers/mathHelpers.ts getTargetIndex (verbatim). */
function getRelativePosition(pagePosition, elementPosition, elementSize) {
  return Math.min(Math.max(0, pagePosition - elementPosition), elementSize) / elementSize;
}
function getTargetIndex(pagePosition, elementPosition, elementSize, total) {
  return Math.min(Math.floor(getRelativePosition(pagePosition, elementPosition, elementSize) * total), total - 1);
}

/** mouseHelpers/domHelpers.ts findUpwards (verbatim). */
function findUpwards(target, outOfBoundsElement, cb) {
  let current = target;
  do {
    if (!current) return null;
    if (cb(current)) return current;
    if (current === outOfBoundsElement) return null;
    current = current.parentElement;
  } while (true);
}

/** mouseHelpers/domHelpers.ts findContainingParent (verbatim). */
function findContainingParent(container, target) {
  for (let i = 0; i < container.childNodes.length; ++i) {
    if (container.childNodes[i].contains(target)) return i;
  }
  return -1;
}

/** mouseHelpers/domHelpers.ts blockClick (verbatim). */
function blockClick() {
  let cancel;
  const block = (e) => {
    e.stopPropagation();
    e.preventDefault();
    cancel();
  };
  let done = false;
  const handleMouseUp = () => {
    if (done) return;
    done = true;
    setTimeout(() => cancel(), 1);
  };
  document.addEventListener('mouseup', handleMouseUp, true);
  document.addEventListener('click', block, true);
  cancel = () => {
    document.removeEventListener('mouseup', handleMouseUp, true);
    document.removeEventListener('click', block, true);
  };
  return cancel;
}

/** Proton layout data for the mouse handler (recomputed per mousedown).
 * v4.3: serves BOTH the month grid (multi-row) and the TimeGrid all-day
 * row (single-row) — Proton wires the same handler into both surfaces. */
function currentGridModel(dayGridEl) {
  let rows;
  let numberOfRows;
  if (dayGridEl.classList.contains('calendar-time-fullday')) {
    rows = [timeGridModel.days];
    numberOfRows = 3; // Proton TimeGrid all-day numberOfRows
  } else {
    rows = monthRows(state.viewYM).rows;
    numberOfRows = Math.max(state.gridRows, 0);
  }
  const events = viewEventsForRange(rows[0][0], rows[rows.length - 1][rows[rows.length - 1].length - 1]);
  const perRow = rows.map((days) => {
    const last = days[days.length - 1];
    const rowEvents = events.filter((ev) => !(ev.dispFirst > last || ev.dispLast < days[0]));
    const eventsInRow = splitDayEventsInInterval(rowEvents, days[0], last);
    const laid = dayGridRowLayout(eventsInRow, numberOfRows);
    return { days, rowEvents, eventsInRow, eventsInRowStyles: laid.styles, eventsInRowSummary: laid.summary };
  });
  return { rows, events, perRow };
}

/** dayGridMouseHandler.ts handleDayGridMouseDown (ported). */
function handleDayGridMouseDown(e) {
  if (e.button !== 0) return;
  if (!(e.target instanceof HTMLElement)) return;
  const dayGridEl = e.target.closest('[data-dnd="daygrid"]');
  if (!dayGridEl) return;
  if (!dayGridEl.contains(e.target)) return;

  const model = currentGridModel(dayGridEl);
  const rowElement = findUpwards(e.target, dayGridEl, (el) => typeof el.dataset.row !== 'undefined');
  if (!rowElement) return;

  const targetRow = parseInt(rowElement.dataset.row || '', 10);
  if (Number.isNaN(targetRow)) return;
  const days = model.rows[targetRow];
  if (!days) return;

  const rect = dayGridEl.getBoundingClientRect();
  const targetDay = getTargetIndex(e.pageX, rect.left, rect.width, days.length);
  const targetDate = days[targetDay];

  dragState.moved = false;

  // Clicking the week container (or a marked element) starts event creation.
  if ((targetRow >= 0 && e.target === rowElement) || e.target.dataset.ignoreCreate) {
    return createDragCreateEvent({ e, targetRow, targetDate, rows: model.rows, model, dayGridEl });
  }

  const targetIndex = findContainingParent(rowElement, e.target);
  const { eventsInRowStyles, eventsInRow, eventsInRowSummary, rowEvents } = model.perRow[targetRow] || {};
  if (!Array.isArray(eventsInRowStyles) || targetIndex >= eventsInRowStyles.length) return;
  const eventStyle = eventsInRowStyles[targetIndex];
  if (!eventStyle) return;

  if (eventStyle.type === 'more') {
    return createUpMoreEvent(() => openMorePopover(days[eventStyle.idx], rowElement.getBoundingClientRect()));
  }

  // eventsInRow[...].idx indexes the row's FILTERED event list (rowEvents).
  const eventIdx = eventsInRow[eventStyle.idx].idx;
  const ev = rowEvents[eventIdx];
  return createDragMoveEvent({ e, ev, targetRow, targetDay, daysPerRow: days.length, model, dayGridEl });
}

/** dayGridMouseHandler.ts createDragCreateEvent (ported). */
function createDragCreateEvent({ e, targetRow, targetDate: startTargetDate, rows, model, dayGridEl }) {
  let endTargetDate = null;
  let oldMouseX = -1;
  const CREATE_STATE_ACTIVE = -2;
  let result = null;
  let currentTargetRow = targetRow;
  let ghost = null;

  e.preventDefault();
  e.stopPropagation();

  const handleMouseMove = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (oldMouseX === -1) oldMouseX = ev.pageX;
    if (oldMouseX !== CREATE_STATE_ACTIVE && Math.abs(oldMouseX - ev.pageX) < CREATE_SENSITIVITY) return;
    oldMouseX = CREATE_STATE_ACTIVE;
    dragState.moved = true;

    const rect = dayGridEl.getBoundingClientRect();
    currentTargetRow = getTargetIndex(ev.pageY, rect.top, rect.height, model.perRow.length);
    const days = rows[currentTargetRow];
    if (!days) return;
    const targetDay = getTargetIndex(ev.pageX, rect.left, rect.width, days.length);
    const newEndTargetDate = days[targetDay];
    if (newEndTargetDate === endTargetDate) return;
    endTargetDate = newEndTargetDate;
    const isAfter = endTargetDate >= startTargetDate;
    result = isAfter
      ? { start: startTargetDate, end: endTargetDate }
      : { start: endTargetDate, end: startTargetDate };
    ghost = drawGhost(ghost, dayGridEl, model, currentTargetRow, result.start, result.end);
  };

  const handleMouseUp = () => {
    document.removeEventListener('mouseup', handleMouseUp, true);
    document.removeEventListener('mousemove', handleMouseMove, true);
    removeGhost(ghost);
    // NOTE: NO setHighlight here — the create-drag never sets a row
    // highlight (that belongs to createDragMoveEvent). The stray call in
    // v4.2 threw `setHighlight is not defined` on EVERY month-grid
    // click/drag-create, silently killing event creation (wave-6 fix).
    if (result) {
      beginCreateRange(result.start, result.end);
    } else {
      beginCreate(startTargetDate);
    }
  };

  document.addEventListener('mouseup', handleMouseUp, true);
  document.addEventListener('mousemove', handleMouseMove, true);
  blockClick();
}

/** Multi-day all-day create (Proton CREATE_MOVE_UP). */
function beginCreateRange(startDay, endDay) {
  closeAllOverlays();
  const uuid = defaultCalendarUuid();
  if (!uuid) { toast('Create a calendar first.', 'warn'); return; }
  editor.mode = 'create';
  editor.scope = null;
  editor.target = null;
  editor.custom = null;
  openEditor({
    title: '',
    allDay: true,
    start: { date: startDay, time: '00:00' },
    end: { date: endDay, time: '00:00' }, // display-inclusive; save converts to DTEND
    freq: '',
    calUuid: uuid,
    location: '',
    notifs: [],
    description: '',
  });
}

/** dayGridMouseHandler.ts createDragMoveEvent (ported). */
function createDragMoveEvent({ e, ev, targetRow, targetDay, daysPerRow, model, dayGridEl }) {
  let oldIdx = targetRow * daysPerRow + targetDay;
  const initialIdx = oldIdx;
  let result = null;
  let currentTargetRow = targetRow;
  let ghost = null;

  e.preventDefault();
  e.stopPropagation();

  // NOTE: the mouse event parameter is `me` — the outer `ev` is the VIEW
  // EVENT being dragged (Proton keeps them distinct too; shadowing here
  // previously threw inside this handler and silently killed every drag).
  let hl = null; // drop-target row highlight
  const dndRowEls = () =>
    dayGridEl.classList.contains('daygrid-rowevents')
      ? [dayGridEl] // TimeGrid all-day row: the container IS the row element
      : [...dayGridEl.querySelectorAll('.daygrid-rowevents')];
  const setHighlight = (rowIdx) => {
    if (hl) hl.classList.remove('is-drop-target');
    const rows = dndRowEls();
    hl = rowIdx >= 0 && rows[rowIdx] ? rows[rowIdx] : null;
    if (hl) hl.classList.add('is-drop-target');
  };

  const handleMouseMove = (me) => {
    me.preventDefault();
    me.stopPropagation();
    const rect = dayGridEl.getBoundingClientRect();
    currentTargetRow = getTargetIndex(me.pageY, rect.top, rect.height, model.perRow.length);
    const currentTargetDay = getTargetIndex(me.pageX, rect.left, rect.width, daysPerRow);
    setHighlight(currentTargetRow);
    const currentIdx = currentTargetRow * daysPerRow + currentTargetDay;
    if (currentIdx === oldIdx) return;
    oldIdx = currentIdx;
    dragState.moved = true;

    const differenceInDays = currentIdx - initialIdx;
    result = {
      days: differenceInDays,
      start: shiftDay(ev.start.date, differenceInDays),
      end: shiftDay(ev.spanLast, differenceInDays),
      row: currentTargetRow,
    };
    ghost = drawGhost(ghost, dayGridEl, model, currentTargetRow, result.start, result.end, ev);
  };

  const handleMouseUp = () => {
    document.removeEventListener('mouseup', handleMouseUp, true);
    document.removeEventListener('mousemove', handleMouseMove, true);
    removeGhost(ghost);
    setHighlight(-1);
    // Restore the source chip opacity.
    dayGridEl.querySelectorAll('.isDragging').forEach((n) => n.classList.remove('isDragging'));

    if (result) {
      finishDragMove(ev, result.days);
    } else {
      // Plain mouseup handled by the chip's own listener (popover).
    }
  };

  document.addEventListener('mouseup', handleMouseUp, true);
  document.addEventListener('mousemove', handleMouseMove, true);
  blockClick();
  // Mark the dragged chip (Proton isDragging).
  const chip = e.target.closest('.calendar-dayeventcell');
  if (chip) chip.querySelector('.calendar-dayeventcell-inner')?.classList.add('isDragging');
}

async function finishDragMove(ev, days) {
  if (!days) return;
  const apply = async (scope) => {
    try {
      setBusy(true, 'Moving event…');
      await applyDayShift(ev, days, scope);
      toast('Event moved.', 'ok', 2000);
    } catch (e) {
      toast('Move failed: ' + (e && e.message ? e.message : String(e)), 'err', 7000);
    } finally {
      setBusy(false);
    }
  };
  if (ev.isRecurring || ev.isException) {
    openRecurringChoice('Move recurring event', apply);
  } else {
    await apply('master');
  }
}

/** Ghost chip while dragging (Proton renders the moved event live). */
function drawGhost(ghost, dayGridEl, model, targetRow, startDay, endDay, ev) {
  removeGhost(ghost);
  const rowsEls = dayGridEl.classList.contains('daygrid-rowevents')
    ? [dayGridEl] // TimeGrid all-day row: the container IS the row element
    : dayGridEl.querySelectorAll('.daygrid-rowevents');
  const target = rowsEls[targetRow];
  if (!target) return null;
  const days = model.rows[targetRow];
  // `diffDays` here is the MODULE function (the drag delta is not needed:
  // the ghost always spans the shifted start..end days). Row width uses the
  // row's OWN day count (7 in month/week, 1..14 in custom views).
  const n = days.length;
  const first = Math.max(0, diffDays(startDay, days[0]));
  const last = Math.min(n - 1, diffDays(endDay, days[0]));
  if (first > last) return null;
  const g = el('div', 'chip-ghost', { text: ev ? (ev.title || '') : '' });
  g.style.top = '0px';
  g.style.left = (first / n) * 100 + '%';
  g.style.width = ((last - first + 1) / n) * 100 + '%';
  g.style.height = DAY_EVENT_HEIGHT + 'px';
  target.appendChild(g);
  return g;
}
function removeGhost(ghost) {
  if (ghost && ghost.parentNode) ghost.remove();
}

/** dayGridMouseHandler.ts createUpMoreEvent (ported). */
function createUpMoreEvent(cb) {
  const handleMouseUp = (e) => {
    document.removeEventListener('mouseup', handleMouseUp, true);
    e.preventDefault();
    e.stopPropagation();
    cb();
  };
  document.addEventListener('mouseup', handleMouseUp, true);
  blockClick();
}

/* ---------------- UI wiring ---------------- */

function refreshLoginUi() {
  const has = !!localStorage.getItem(LS_TOKEN);
  $('#setup-row').hidden = has;
  $('#lock-note').hidden = has;
  $('#server').value = serverUrl();
}

function bind() {
  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    unlock();
  });
  $('#btn-lock').addEventListener('click', lock);
  $('#btn-forget').addEventListener('click', forgetBrowser);
  $('#btn-sync').addEventListener('click', () => {
    if (state.busy || !state.api) return;
    syncAll().catch((e) => toast('Sync failed: ' + (e && e.message ? e.message : String(e)), 'err'));
  });
  $('#btn-prev').addEventListener('click', () => navView(-1));
  $('#btn-next').addEventListener('click', () => navView(1));
  $('#minical-prev').addEventListener('click', () => navView(-1));
  $('#minical-next').addEventListener('click', () => navView(1));
  $('#btn-today').addEventListener('click', () => {
    state.today = core.localToday();
    state.viewYM = state.today.slice(0, 7);
    state.selectedDate = state.today;
    renderAll();
  });
  $('#btn-new-event').addEventListener('click', () => {
    if (!state.api || state.busy) return;
    if (state.cals.size === 0) { openCalendarModal(null); return; }
    beginCreate(null);
  });
  $('#btn-add-calendar').addEventListener('click', () => openCalendarModal(null));
  $('#btn-theme').addEventListener('click', toggleTheme);

  $('#popover-backdrop').addEventListener('click', closePopover);
  $('#editor-backdrop').addEventListener('click', () => {
    const modal = $('#editor-modal');
    if (!modal.hidden) closeModalSurface(modal, $('#editor-backdrop'));
  });
  $('#recur-backdrop').addEventListener('click', () => {
    const modal = $('#recur-modal');
    if (!modal.hidden) closeModalSurface(modal, $('#recur-backdrop'));
  });
  $('#cal-backdrop').addEventListener('click', () => {
    const modal = $('#cal-modal');
    if (!modal.hidden) closeModalSurface(modal, $('#cal-backdrop'));
  });
  $('#freq-backdrop').addEventListener('click', () => {
    const modal = $('#freq-modal');
    if (!modal.hidden) closeModalSurface(modal, $('#freq-backdrop'));
  });

  // Proton: capture-phase document mousedown drives grid DnD. v4.3 routes
  // time-grid events (day/week/custom) to the TimeGrid handler FIRST; the
  // month grid and the all-day row use the day-grid handler.
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target instanceof HTMLElement && e.target.closest('.timegrid-columns')) {
      handleTimeGridMouseDown(e);
      return;
    }
    handleDayGridMouseDown(e);
  }, true);

  // Keyboard: Escape closes the topmost overlay; n/t/arrows navigate;
  // d/w/m/y/c switch views (Proton keyboard shortcuts).
  document.addEventListener('keydown', (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === 'Escape') {
      if (closeTopOverlay()) e.preventDefault();
      return;
    }
    if (inField || state.busy || !state.api || $('#app').hidden) return;
    if (e.key === 'n') { e.preventDefault(); $('#btn-new-event').click(); }
    else if (e.key === 't') { e.preventDefault(); $('#btn-today').click(); }
    else if (e.key === 'd') { e.preventDefault(); setView('day'); }
    else if (e.key === 'w') { e.preventDefault(); setView('week'); }
    else if (e.key === 'm') { e.preventDefault(); setView('month'); }
    else if (e.key === 'y') { e.preventDefault(); setView('year'); }
    else if (e.key === 'v') { e.preventDefault(); setView('custom'); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); navView(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); navView(1); }
  });

  window.addEventListener('resize', () => {
    if (!$('#app').hidden) {
      // Only the grids need re-layout; keep the user's scroll position.
      const scroll = document.querySelector('.calendar-time-grid');
      const top = scroll ? scroll.scrollTop : null;
      renderAll();
      if (scroll && top !== null) scroll.scrollTop = top;
    }
  });

  $('#btn-paste-setup').addEventListener('click', () => {
    const v = $('#setup-input').value.trim();
    if (/^[0-9a-f]{64}$/.test(v)) {
      localStorage.setItem(LS_TOKEN, v);
      refreshLoginUi();
      toast('Provisioning code stored.', 'ok');
    } else {
      toast('Invalid provisioning code (64 lowercase hex chars).', 'err');
    }
  });
  $('#setup-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#btn-paste-setup').click();
    }
  });

  // v4.3 §5.3 autosync: 60 s poll while visible + one sync on refocus.
  setInterval(() => {
    if (document.hidden) return;
    autosync();
  }, AUTOSYNC_MS);
  window.addEventListener('focus', autosync);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) autosync();
  });

  // Keep the now-line and the "today" marker current (day rollover, minute
  // hand) without a full re-render.
  setInterval(() => {
    const today = core.localToday();
    if (state.api && today !== state.today) {
      state.today = today;
      renderAll();
      return;
    }
    const line = document.querySelector('.calendar-grid-nowHourLine');
    if (line) line.style.top = ((nowMinutes() / TOTAL_MINUTES) * 100).toFixed(4) + '%';
  }, 60000);
}

/* ---------------- theme (Proton light/dark tokens) ---------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('#btn-theme');
  if (btn) {
    btn.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    btn.setAttribute('aria-label', btn.title);
  }
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(LS_THEME, next); } catch { /* ignore */ }
  applyTheme(next);
}

function boot() {
  ingestParams();
  refreshLoginUi();
  state.today = core.localToday();
  state.viewYM = state.today.slice(0, 7);
  state.selectedDate = state.today;
  try {
    const v = localStorage.getItem(LS_VIEW);
    if (VIEWS.includes(v)) state.view = v;
  } catch { /* ignore */ }
  bind();
  // applyTheme is also set by the inline head script (FOUC guard); re-apply
  // in case the DOM finished parsing after it.
  applyTheme((() => {
    try { return localStorage.getItem(LS_THEME) || null; } catch { return null; }
  })() || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
}

boot();
