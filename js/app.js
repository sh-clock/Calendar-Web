/**
 * app.js — web client orchestration for PROTOCOL v4.3 wire / v4.5 client
 * payload extension (calendar domain).
 *
 * UI LAYER: FullCalendar v7.1.3 (MIT, (c) Adam Shaw) — the official
 * `all/global.js` bundle + `skeleton.css` + the official stock THEMES
 * (monarch / forma / breezy / pulse / classic plugin + theme.css + palette
 * css) vendored VERBATIM from npm `fullcalendar@7.1.3` at
 * js/vendor/fullcalendar/v7/ (see LICENSE.md). The Shadcn and MUI themes
 * port the official fullcalendar-workspace theming sources (see
 * docs/PROVENANCE.md): FC views use the monarch flavor (the playground
 * default) while the app chrome adopts shadcn / Material Design tokens.
 * All view rendering, drag & drop, resizing, event layout, "+N more"
 * popovers, the toolbar and the now-indicator are FullCalendar's OWN
 * implementations, driven through its documented options. No FullCalendar
 * internals are patched or tweaked.
 *
 * TASKS (v4.5): evt rows may hold VTODO components (Fossify Calendar
 * semantics): STATUS:COMPLETED marks a task done; one occurrence of a
 * repeating task completes via a RECURRENCE-ID exception with
 * STATUS:COMPLETED. CalDAV-native (RFC 5545 §3.6.2 / RFC 4791 §4.1) so the
 * davx5 fork maps task rows with its existing VTODO code.
 *
 * LOCAL-FIRST (v4.5): the decrypted model is cached in localStorage
 * (clock_poc_cache_v45) — unlock paints from the cache BEFORE syncing; the
 * cloud sync (manifest diff + §9b batch) reconciles in the background.
 * lock() purges the cache (E5-5 parity: no plaintext survives Lock).
 *
 * BACKBONE (protocol v4.3 — protocol.md, REPOSITORY ROOT, normative):
 *  - `cmeta:{uuid}` rows → calendars (name, color).
 *  - `evt:{cal}:{uid}` rows → source of truth, RFC 5545 payloads
 *    (VEVENT rows, or VTODO task rows since v4.5).
 *  - Sync = read-only manifest diff + POST /rows:batch (§9b) — 1–2 requests,
 *    failure-tolerant, ALWAYS renders. Mutations RMW the row directly,
 *    update local state and re-render — NO post-mutation sync chain (§5).
 *  - Autosync: 60 s poll + focus/visibility (never blocks the UI).
 *
 * Provenance of retained ports (see docs/PROVENANCE.md): calendar colors
 * (Proton ACCENT_COLORS + gen-accent-shades formula), editor/recurrence
 * semantics, DEFAULT_CALENDAR, DEFAULT_EVENT_DURATION. The previous
 * Proton-ported view/DnD layer was REPLACED by FullCalendar (this file's
 * history in git preserves the GPL-3.0 port for reference).
 */

import { deriveKeys, importRowKey, encryptRow, decryptRow } from './crypto.js';
import { Api, ApiError } from './api.js';
import * as core from './calendar-core.js';
import { serializeVCalendar, triggerMinutes, formatDuration } from './ical.js';

const DEFAULT_SERVER_URL = 'https://calendar-poc.sh-clock.workers.dev';
const LS_TOKEN = 'clock_poc_auth_ui';
const LS_SERVER = 'clock_poc_server';
const LS_CALVIS = 'clock_poc_calvis_v42';
const LS_VIEW = 'clock_poc_view_fc6'; // FC view ids (supersedes clock_poc_view_v43)
const LS_SETTINGS = 'clock_poc_settings_v45'; // v45: fcTheme/fcPalette replace accent
const LS_SETTINGS_V44 = 'clock_poc_settings_v44'; // legacy (migrated once, then removed)
const LS_CACHE = 'clock_poc_cache_v45'; // local-first decrypted model cache
const LS_CFG = 'clock_poc_cfg_v45';   // cached public config row (offline unlock)
const LS_THEME = 'clock_poc_theme'; // legacy pre-settings key (migrated)
const REBASE_MAX = 8;
const AUTOSYNC_MS = 60000;     // v4.3 §5.3: 60 s poll while visible
const MIN_DURATION = 15;       // Proton splitTimeGridEventsPerDay MIN_DURATION
const DEFAULT_EVENT_DURATION = 30; // Proton DEFAULT_EVENT_DURATION (minutes)
const CACHE_WRITE_DELAY = 250; // local-first: debounce plaintext cache writes

/** FullCalendar view ids offered in the toolbar (order = toolbar order). */
const VIEWS = ['timeGridDay', 'timeGridWeek', 'dayGridMonth', 'multiMonthYear', 'listYear', 'custom'];

/**
 * The 7 selectable calendar themes (FullCalendar's official set — see
 * themes.fullcalendar.io). Each stock theme vendors its own plugin + CSS +
 * palettes from npm fullcalendar@7.1.3. shadcn and mui are the official
 * UI-language themes from fullcalendar-workspace: the FC views use the
 * monarch flavor (the playground's default combination) while the app
 * chrome adopts shadcn / Material Design tokens (adaptation documented in
 * docs/DEVIATIONS.md — the React toolbars themselves cannot run here).
 * `flavor` = which stock FC theme plugin/CSS drives the calendar views.
 */
const FC_THEMES = {
  monarch: { label: 'Monarch', flavor: 'monarch', palettes: ['blue', 'green', 'purple', 'red', 'yellow'] },
  forma: { label: 'Forma', flavor: 'forma', palettes: ['blue', 'green', 'purple', 'red'] },
  breezy: { label: 'Breezy', flavor: 'breezy', palettes: ['amber', 'emerald', 'indigo', 'rose'] },
  pulse: { label: 'Pulse', flavor: 'pulse', palettes: ['blue', 'green', 'purple', 'red'] },
  classic: { label: 'Classic', flavor: 'classic', palettes: [] },
  shadcn: { label: 'Shadcn', flavor: 'monarch', palettes: ['neutral', 'blue', 'green', 'purple', 'red', 'yellow', 'amber', 'orange', 'rose', 'pink', 'violet', 'indigo', 'cyan', 'teal', 'sky', 'emerald', 'lime', 'fuchsia'] },
  mui: { label: 'MUI', flavor: 'monarch', palettes: ['blue', 'purple'] },
};
const FC_THEME_IDS = Object.keys(FC_THEMES);
const FC_VENDOR = 'js/vendor/fullcalendar/v7';

/** Default palette per theme (classic has none). */
function defaultPaletteOf(themeId) {
  const t = FC_THEMES[themeId];
  return t && t.palettes.length > 0 ? t.palettes[0] : '';
}

/** Which stock flavor's plugin + CSS drives the FC views for a theme id. */
function flavorOf(themeId) {
  return (FC_THEMES[themeId] || FC_THEMES.monarch).flavor;
}

/** Map legacy v4.3 view names to FullCalendar view ids (one-time migration). */
function migrateView(v) {
  const map = { day: 'timeGridDay', week: 'timeGridWeek', month: 'dayGridMonth', year: 'multiMonthYear', custom: 'custom' };
  return map[v] || v;
}

const state = {
  api: null,
  rowKey: null,
  cals: new Map(),      // uuid -> { ver, meta }   (cmeta rows)
  evt: new Map(),       // rowId -> { ver, parsed } (evt rows)
  corrupt: new Map(),   // rowId -> { reason, ver } (undecryptable/unparseable rows)
  today: null,
  view: 'dayGridMonth', // FullCalendar view id
  busy: false,
  batchOk: true,        // false when the server predates v4.3 (§5.1c fallback)
  syncing: false,       // one background sync at a time (§5.3)
  manifestEtag: null,   // §9 conditional read: last manifest etag (null = full fetch)
  dirty: new Map(),       // row id → mutation generation (A3 race protection)
  deletedLocally: new Map(), // row id → generation (A3: no resurrect)
  mutGen: 0,            // bumped on every completed mutation
  lastCorruptCount: 0,  // A5: suppress repeated corrupt toasts
};

/* ---------------- tiny DOM helpers ---------------- */

const $ = (sel) => document.querySelector(sel);

/** Wave-7 A11: localStorage can throw (quota / privacy mode) — never let a
 * storage failure brick unlock or fake a sync error. */
function safeSetItem(k, v) {
  try { localStorage.setItem(k, v); } catch { /* ignore */ }
}

/** Create an element with class/props/children (no innerHTML for data).
 * Wave-7 S1 fix: a plain-object SECOND argument is treated as props —
 * call sites written as el('h1', { text: … }) previously put the props in
 * the cls slot, producing class "[object Object]" and blank headings/labels. */
function el(tag, cls, props = {}) {
  if (cls && typeof cls === 'object' && !Array.isArray(cls)) {
    props = cls;
    cls = null;
  }
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

/* Wave-7 A12: busy is a DEPTH counter — overlapping mutations each increment;
 * the overlay hides only when the LAST one finishes. */
let busyDepth = 0;
function setBusy(busy, msg) {
  busyDepth = Math.max(0, busyDepth + (busy ? 1 : -1));
  state.busy = busyDepth > 0;
  const bar = $('#syncbar');
  bar.hidden = busyDepth === 0;
  if (busyDepth > 0) $('#syncmsg').textContent = msg || 'Working…';
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
/* F-A5-7 (audit wave): the app-side time formatting honours the settings'
 * hour12 preference (FullCalendar's own formats already do). Lazily rebuilt
 * when the setting changes (see applySettings). */
let fmtTimeCache = { key: null, fmt: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }) };
function fmtTime(d) {
  const key = settings.hour12 === null ? 'd' : settings.hour12 ? '12' : '24';
  if (fmtTimeCache.key !== key) {
    fmtTimeCache = {
      key,
      fmt: new Intl.DateTimeFormat(locale, {
        hour: 'numeric', minute: '2-digit',
        ...(settings.hour12 === null ? {} : { hour12: settings.hour12 }),
      }),
    };
  }
  return fmtTimeCache.fmt.format(d);
}
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
const showTime = (dt) => (dt.time === null ? '' : fmtTime(wallToDate(dt)));

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
    return `${fmtDateMed.format(s)} · ${fmtTime(s)} – ${fmtTime(e)}`;
  }
  return `${fmtDateMed.format(s)}, ${fmtTime(s)} – ${fmtDayMonth.format(e)}, ${fmtTime(e)}`;
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

const MONTHS = (() => {
  const out = [];
  for (let m = 0; m < 12; m++) out.push(new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(2026, m, 15)));
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
  safeSetItem(LS_CALVIS, JSON.stringify(o)); // A11: never throws
}
let calVis = loadCalVis() || new Map();
const calVisible = new Set();
function syncCalVisible() {
  calVisible.clear();
  for (const [uuid, on] of calVis) if (on && state.cals.has(uuid)) calVisible.add(uuid);
}

/* ---------------- settings (theme & customisation) ----------------
 * The theme settings live UNDER the settings menu (user directive): the
 * topbar gear opens one modal holding every customisation. Every change
 * applies LIVE (DOM tokens + managed CSS links immediately; FullCalendar
 * options via resetOptions; a THEME FLAVOR switch rebuilds the Calendar —
 * theme plugins register their render hooks at construction) and persists
 * to localStorage. */

const SETTINGS_KEYS = ['theme', 'fcTheme', 'fcPalette', 'firstDay', 'hour12', 'slotDuration', 'weekNumbers', 'density', 'customDays', 'view', 'autoLock'];

const SETTINGS_DEFAULTS = {
  theme: 'system',            // color scheme: 'light' | 'dark' | 'system'
  fcTheme: 'monarch',         // FullCalendar theme (FC_THEMES keys)
  fcPalette: 'blue',          // per-theme palette (official palette sets)
  firstDay: 1,                // 0=Sun, 1=Mon (current app default), 6=Sat
  hour12: null,               // null = locale default | true | false
  slotDuration: '00:30:00',   // timeGrid slot (Proton interval analogue)
  weekNumbers: false,
  density: 'comfortable',     // 'comfortable' | 'compact'
  customDays: 5,              // custom view days (2..14)
  view: 'dayGridMonth',       // default view on unlock
  autoLock: true,             // sec-S5-F4: idle auto-lock (15 min) on by default
};

let settings = { ...SETTINGS_DEFAULTS };

function loadSettings() {
  // F-A1-7/F-A5-6 (audit wave): every read is guarded — a throwing
  // localStorage (quota/privacy) must never abort boot.
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  try {
    const o = JSON.parse(ls.get(LS_SETTINGS) || 'null');
    if (o && typeof o === 'object') {
      for (const k of SETTINGS_KEYS) if (o[k] !== undefined) settings[k] = o[k];
    }
  } catch { /* ignore */ }
  // v44 → v45 migration: fcTheme/fcPalette replace the Proton accent (the
  // official theme palettes are the accent system now). Read ONCE, then
  // remove the legacy key so this migration is one-shot.
  if (!ls.get(LS_SETTINGS)) {
    try {
      const v44 = JSON.parse(ls.get(LS_SETTINGS_V44) || 'null');
      if (v44 && typeof v44 === 'object') {
        for (const k of ['theme', 'firstDay', 'hour12', 'slotDuration', 'weekNumbers', 'density', 'customDays', 'view']) {
          if (v44[k] !== undefined) settings[k] = v44[k];
        }
      }
    } catch { /* ignore */ }
    ls.del(LS_SETTINGS_V44);
  }
  // Legacy migration: v4.3 stored the theme under its own key — used ONLY
  // when no settings exist yet, then removed (F-A5-9).
  if (!ls.get(LS_SETTINGS) && !ls.get(LS_SETTINGS_V44)) {
    const t = ls.get(LS_THEME);
    if (t === 'light' || t === 'dark') settings.theme = t;
  }
  ls.del(LS_THEME);
  // Legacy migration: v4.3 view name → FullCalendar view id — only when
  // no settings exist and the FC view key does not, then removed.
  const oldView = ls.get('clock_poc_view_v43');
  if (oldView && !ls.get(LS_VIEW) && !(JSON.parse(ls.get(LS_SETTINGS) || 'null') || {}).view) {
    const m = migrateView(oldView);
    if (VIEWS.includes(m)) settings.view = m;
  }
  ls.del('clock_poc_view_v43');
  settings.customDays = Math.max(2, Math.min(14, Number(settings.customDays) || 5));
  if (!VIEWS.includes(settings.view)) settings.view = 'dayGridMonth';
  if (!['light', 'dark', 'system'].includes(settings.theme)) settings.theme = 'system';
  if (!FC_THEME_IDS.includes(settings.fcTheme)) settings.fcTheme = SETTINGS_DEFAULTS.fcTheme;
  const pal = FC_THEMES[settings.fcTheme].palettes;
  if (!pal.includes(settings.fcPalette)) settings.fcPalette = defaultPaletteOf(settings.fcTheme);
  if (!['00:15:00', '00:30:00', '01:00:00'].includes(settings.slotDuration)) settings.slotDuration = '00:30:00';
  if (!['comfortable', 'compact'].includes(settings.density)) settings.density = 'comfortable';
  if (![0, 1, 6].includes(settings.firstDay)) settings.firstDay = 1;
  if (typeof settings.autoLock !== 'boolean') settings.autoLock = true; // sec-S5-F4
}

function saveSettings() {
  safeSetItem(LS_SETTINGS, JSON.stringify(settings));
}

/** Resolve 'system' to a concrete theme using the OS preference. */
function resolvedTheme() {
  if (settings.theme === 'system') {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return settings.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme() {
  // data-theme drives OUR chrome tokens ([data-theme=dark] blocks);
  // data-color-scheme drives the OFFICIAL FullCalendar theme CSS + the
  // vendored shadcn / MUI palette dark blocks (both keyed on it).
  const t = resolvedTheme();
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.colorScheme = t;
}

/* ---------------- FullCalendar theme assets (official v7 themes) ----------------
 * skeleton.css is a static <link> in index.html. The active theme's
 * plugin (global.js) + theme.css + ONE palette css are managed here:
 * managed <link> elements swapped per settings. The theme plugin global
 * scripts auto-register into FullCalendar.globalPlugins on load — we
 * CAPTURE the pushed plugin and remove it from the global registry (it
 * would otherwise stay active forever and stack with other themes), then
 * pass it EXPLICITLY via plugins:[...] — the official ESM usage pattern
 * (README: `import classicThemePlugin from 'fullcalendar/themes/classic'`).
 * Switching the theme flavor therefore requires destroy()+re-create of
 * the Calendar (plugin hooks build at construction; resetOptions alone
 * would keep the old theme's classNames). */

const fcThemePlugins = new Map(); // flavor -> plugin object (loaded once)
let activeFcTheme = null;         // plugin currently driving fcCal
let fcThemeLoadBusy = null;       // in-flight plugin load (dedup concurrent)

function injectScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('load_failed: ' + src));
    document.head.appendChild(s);
  });
}

/** Load (once) a stock flavor's theme plugin and return the plugin object. */
function fcThemePlugin(flavor) {
  if (fcThemePlugins.has(flavor)) return Promise.resolve(fcThemePlugins.get(flavor));
  if (fcThemeLoadBusy) return fcThemeLoadBusy.then(() => fcThemePlugin(flavor));
  fcThemeLoadBusy = (async () => {
    const before = window.FullCalendar.globalPlugins.length;
    await injectScriptOnce(FC_VENDOR + '/themes/' + flavor + '/global.js');
    // The theme global.js pushed exactly one plugin into the registry:
    // capture it and trim the registry back (the plugin is used EXPLICITLY
    // via plugins:[...] — leaving it registered would stack every loaded
    // theme onto every Calendar instance).
    const added = window.FullCalendar.globalPlugins.splice(before);
    if (added.length !== 1) {
      throw new Error('theme_plugin_load: expected 1 plugin, got ' + added.length);
    }
    fcThemePlugins.set(flavor, added[0]);
    return added[0];
  })();
  const done = fcThemeLoadBusy;
  fcThemeLoadBusy.then(() => { if (fcThemeLoadBusy === done) fcThemeLoadBusy = null; }, () => { if (fcThemeLoadBusy === done) fcThemeLoadBusy = null; });
  return done;
}

/** Ensure a <link id> exists with the given href (swap href on change).
 * href === null disables (removes) the link. */
function ensureCssLink(id, href) {
  let link = document.getElementById(id);
  if (href === null) {
    if (link) link.remove();
    return;
  }
  if (!link) {
    link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

/** Apply theme ASSETS for the current settings: <html> attributes + CSS
 * links. Synchronous (no plugin load). */
function applyFcThemeAssets() {
  const themeId = settings.fcTheme;
  const t = FC_THEMES[themeId];
  const flavor = t.flavor;
  const root = document.documentElement;
  root.dataset.fctheme = themeId;

  // Calendar view CSS: the stock flavor's theme.css + its palette css.
  ensureCssLink('fc-theme-css', FC_VENDOR + '/themes/' + flavor + '/theme.css');
  if (flavor === 'classic') {
    ensureCssLink('fc-palette-css', FC_VENDOR + '/themes/classic/palette.css');
  } else {
    // shadcn / mui keep the monarch flavor on the OFFICIAL default palette
    // (blue) — the playground's default combination; their own palette
    // setting styles the app chrome instead.
    const pal = (themeId === 'shadcn' || themeId === 'mui') ? 'blue' : settings.fcPalette;
    ensureCssLink('fc-palette-css', FC_VENDOR + '/themes/' + flavor + '/palettes/' + pal + '.css');
  }

  // Chrome palette CSS for the UI-language themes + activation attributes.
  if (themeId === 'shadcn') {
    ensureCssLink('fc-chrome-palettes', FC_VENDOR + '/chrome/shadcn-palettes.css');
    root.dataset.palette = settings.fcPalette;
  } else {
    ensureCssLink('fc-chrome-palettes', null);
    delete root.dataset.palette;
  }
  if (themeId === 'mui') {
    ensureCssLink('fc-chrome-palettes', FC_VENDOR + '/chrome/mui-palettes.css');
    root.dataset.muiPalette = settings.fcPalette;
  } else {
    delete root.dataset.muiPalette;
  }
}

/** Apply the FULL theme state: assets + (on flavor change) Calendar rebuild.
 * Async — callers fire-and-forget; failures toast loudly. */
async function applyFcTheme({ rebuild = true } = {}) {
  applyFcThemeAssets();
  const flavor = flavorOf(settings.fcTheme);
  let plugin;
  try {
    plugin = await fcThemePlugin(flavor);
  } catch (e) {
    toast('Theme failed to load: ' + (e && e.message ? e.message : String(e)), 'err', 7000);
    return;
  }
  if (plugin === activeFcTheme) return;
  activeFcTheme = plugin;
  if (rebuild && fcCal) {
    fcCal.destroy();
    fcCal = null;
    await ensureCalendar();
    renderAll();
  }
}

/** Apply the FULL settings state: DOM tokens + FullCalendar options.
 * resetOptions re-processes view specs, so slotDuration/firstDay/formats/
 * weekNumbers/duration all apply live. (A theme FLAVOR switch is handled by
 * applyFcTheme's rebuild, not resetOptions.) */
function applySettings({ fc = true } = {}) {
  applyTheme();
  document.documentElement.dataset.density = settings.density;
  applyFcThemeAssets();
  fmtTimeCache = { key: null, fmt: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }) }; // rebuilt per hour12 (F-A5-7)
  if (fc && fcCal) fcCal.resetOptions(buildFcOptions());
}

/* ---------------- local-first cache (v4.5) ----------------
 * The decrypted model (calendars + evt row payloads) is cached in
 * localStorage under clock_poc_cache_v45 so an unlock paints IMMEDIATELY
 * from local data; the cloud sync reconciles afterwards (manifest diff +
 * §9b batch — the cloud is the secondary, authoritative store).
 * Writes are debounced (CACHE_WRITE_DELAY) and best-effort (quota never
 * breaks the app); lock()/forgetBrowser PURGE the cache so no plaintext
 * survives Lock (E5-5 parity — the same guarantee the in-memory model has).
 * Offline note: reads are local-first; MUTATIONS still require the network
 * (an offline write queue is out of scope — see docs/DEVIATIONS.md). */

function hydrateLocalCache() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_CACHE) || 'null');
    if (!o || typeof o !== 'object' || o.v !== 1) return false;
    // sec-S7-F3: the model cache is pinned to the universe it was decrypted
    // under (cfg fingerprint = salt|wrapped, set at unlock). A cache from
    // DIFFERENT key material (post-rotation, post-force-wipe) must never
    // paint — that was the stale-universe ghost-render path.
    if (!state.cfgFp || o.fp !== state.cfgFp) return false;
    if (Array.isArray(o.cals)) {
      for (const c of o.cals) {
        const meta = core.validateCalendarMeta(c && c.meta);
        if (c && typeof c.uuid === 'string' && meta && Number.isInteger(c.ver)) {
          state.cals.set(c.uuid, { ver: c.ver, meta });
        }
      }
    }
    if (Array.isArray(o.evt)) {
      for (const r of o.evt) {
        if (!r || typeof r.id !== 'string' || !Number.isInteger(r.ver) || typeof r.text !== 'string') continue;
        if (!core.parseEvtId(r.id)) continue; // cache hygiene: only evt rows
        const parsed = core.parseEvtPayload(r.text);
        if (!parsed) continue; // stale/foreign payload shape — drop quietly
        state.evt.set(r.id, { ver: r.ver, parsed });
      }
    }
    return state.cals.size > 0 || state.evt.size > 0;
  } catch {
    return false; // corrupt cache — ignored, rebuilt from the next sync
  }
}

let cacheWriteTimer = null;
function scheduleCacheWrite() {
  if (cacheWriteTimer) return;
  cacheWriteTimer = setTimeout(() => {
    cacheWriteTimer = null;
    writeLocalCache();
  }, CACHE_WRITE_DELAY);
}
function writeLocalCache() {
  try {
    // sec-S7-F3: stamp the cfg fingerprint so hydrateLocalCache can refuse
    // a cache decrypted under different key material.
    const o = { v: 1, fp: state.cfgFp || null, cals: [], evt: [] };
    for (const [uuid, c] of state.cals) o.cals.push({ uuid, ver: c.ver, meta: c.meta });
    for (const [id, r] of state.evt) o.evt.push({ id, ver: r.ver, text: core.serializeEvtPayload(r.parsed) });
    localStorage.setItem(LS_CACHE, JSON.stringify(o));
  } catch {
    /* quota / privacy mode — the cache is best-effort by design */
  }
}
function purgeLocalCache() {
  if (cacheWriteTimer) {
    clearTimeout(cacheWriteTimer);
    cacheWriteTimer = null;
  }
  try { localStorage.removeItem(LS_CACHE); } catch { /* ignore */ }
}

/* ---------------- provisioning & boot ---------------- */

function serverUrl() {
  return localStorage.getItem(LS_SERVER) || DEFAULT_SERVER_URL;
}

/** sec-S5-F1: a `server` URL parameter is only honoured for loopback hosts
 *  (pointing a browser at a local dev stack). A crafted link carrying
 *  `?server=https://evil.example/` used to silently repoint every unlock
 *  request — bearer included — at the attacker's server; the URL bar was
 *  cleaned afterwards, so nothing looked wrong. Remote hosts from a URL are
 *  now IGNORED with a loud toast; the login form field (a visible, manual
 *  user action) remains the only way to set a remote server. */
function isLoopbackServer(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' ||
      u.hostname === '[::1]' || u.hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

function ingestParams() {
  const params = new URLSearchParams(location.search);
  const hash = new URLSearchParams(
    location.hash.startsWith('#') ? location.hash.slice(1) : location.hash
  );
  // sec-S5-F2: `setup` is accepted from the URL FRAGMENT only — fragments are
  // never sent to any server, while a `?setup=` query string lands verbatim in
  // static-host/CDN/proxy access logs (GitHub Pages → Fastly → corporate
  // middleboxes all log full request URLs).
  const setup = hash.get('setup');
  if (setup && /^[0-9a-f]{64}$/.test(setup)) {
    safeSetItem(LS_TOKEN, setup);
    toast('Provisioning code stored in this browser.', 'ok');
  } else if (setup) {
    toast('Ignored invalid provisioning code (must be 64 lowercase hex chars).', 'err');
  }
  if (params.get('setup')) {
    toast('Ignored a provisioning code passed in the query string (use a #fragment link — query strings are logged by servers).', 'warn', 9000);
  }
  const srv = hash.get('server') || params.get('server');
  if (srv) {
    if (/^https?:\/\//.test(srv) && isLoopbackServer(srv)) {
      safeSetItem(LS_SERVER, srv.replace(/\/+$/, ''));
      toast('Server set from link: ' + srv.replace(/\/+$/, '') + ' (local development).', 'ok', 7000);
    } else if (/^https?:\/\//.test(srv)) {
      toast('Ignored a server address from the link (' + srv.slice(0, 60) + ') — only local development servers may be set via URL.', 'err', 9000);
    }
  }
  if (setup || srv || params.get('setup')) history.replaceState(null, '', location.pathname);
}

/* ---------------- unlock (§3) ---------------- */

async function unlock() {
  if (state.busy) return;
  const token = localStorage.getItem(LS_TOKEN);
  const password = $('#password').value;
  const url = $('#server').value.trim().replace(/\/+$/, '');
  safeSetItem(LS_SERVER, url); // A11: a storage quota error must not brick login
  $('#login-msg').textContent = '';
  if (!token) {
    $('#login-msg').textContent = 'No provisioning code in this browser — paste one below first.';
    return;
  }
  setBusy(true, 'Deriving keys (PBKDF2)…');
  try {
    const probe = new Api(url, token);
    let cfg;
    let offline = false;
    try {
      cfg = await probe.getConfig();
      // sec-S7-F3: the LOCAL-FIRST config cache must never go STALE-unnoticed.
      // If the server's key material changed since we last cached it (Type-A
      // rewrap, or a force re-bootstrap to a new universe), the cached cfg —
      // and the decrypted model cache built under it — describe a dead
      // universe; a revoked password could still "unlock" offline against
      // the old wrapped blob. Purge both BEFORE derivation so changed
      // material can never hydrate stale plaintext.
      let cachedCfg = null;
      try { cachedCfg = JSON.parse(localStorage.getItem(LS_CFG) || 'null'); } catch { /* ignore */ }
      if (cachedCfg && typeof cachedCfg === 'object' &&
          (cachedCfg.salt !== cfg.salt || cachedCfg.wrapped !== cfg.wrapped)) {
        purgeLocalCache();
        toast('Server key material changed — local cache cleared.', 'warn', 7000);
      }
      // LOCAL-FIRST: cache the (public, §8) config row so a LATER unlock
      // can derive keys and open the cached calendar even while the server
      // is unreachable. The fingerprint (salt+wrapped) pins the model cache
      // to THIS universe — see hydrateLocalCache.
      safeSetItem(LS_CFG, JSON.stringify(cfg));
    } catch (e) {
      // Offline fallback: use the cached config when one exists — the
      // local cache then renders without any network round-trip. NOTE
      // (sec-S7-F3, documented trade-off): if the password was rotated
      // server-side, a stale cached cfg still unwraps the OLD AES1 offline
      // — bounded by "this browser profile already held that plaintext";
      // the next ONLINE unlock replaces the cached cfg (above) and purges
      // the stale model.
      let cached = null;
      try { cached = JSON.parse(localStorage.getItem(LS_CFG) || 'null'); } catch { /* ignore */ }
      const okCfg = cached && typeof cached === 'object' &&
        typeof cached.salt === 'string' && Number.isInteger(cached.iters) && typeof cached.wrapped === 'string';
      if (!okCfg || !(e instanceof ApiError) || e.kind !== 'network') throw e;
      cfg = cached;
      offline = true;
    }
    // sec-S7-F3: the cache fingerprint = the cfg's key material (salt+wrapped
    // uniquely identify the KEK inputs). hydrateLocalCache refuses to paint
    // a model cached under DIFFERENT material (e.g. after a rotation).
    state.cfgFp = String(cfg.salt) + '|' + String(cfg.wrapped);
    const { aes1, kData, authUiHex } = await deriveKeys(password, cfg.salt, cfg.iters, cfg.wrapped);
    if (authUiHex !== token) {
      toast('Warning: stored provisioning code does not match the derived AUTH_UI. Using derived token.', 'warn', 8000);
    }
    state.api = new Api(url, authUiHex);
    state.rowKey = await importRowKey(kData);
    state.today = core.localToday();
    if (offline) {
      toast('Server unreachable — showing your locally cached calendar (read-only until sync succeeds). If your password was recently changed, this view may be stale.', 'warn', 9000);
      state.batchOk = false; // every read would fail anyway; per-row fallback is quiet
    }
    // v4.5 LOCAL-FIRST: hydrate the decrypted model from the local cache
    // and paint BEFORE any network round-trip; the sync below then
    // reconciles with the cloud. A cache-less first unlock keeps the old
    // "busy until synced" UX so an empty calendar never flashes.
    const hadLocal = hydrateLocalCache();
    // v4.3 §5.4 — SOFT version gate: a mismatch degrades features (per-row
    // GETs instead of §9b batch) but NEVER locks the user out of their data.
    // E2-2: the gate runs CONCURRENTLY with the first sync — the batch path is
    // optimistic, and a v4.2 server degrades mid-sync (fetchRowsIntoState
    // catches the batch silent-drop and falls back to per-row GETs), so the
    // first paint does not wait for the extra round-trip.
    state.batchOk = true;
    const versionGate = (async () => {
      try {
        const ver = await state.api.getVersion();
        $('#proto-badge').textContent = 'protocol ' + ver.proto;
        // sec-S8-F3: semver-tolerant gate — the exact-string '4.3' match
        // degraded EVERY future server (a 4.3.1 worker would silently lose
        // §9b batch). Batch needs >= 4.3: accept any 4.x with x >= 3 and any
        // higher major. The gate is a capability hint, not an auth boundary —
        // a wrong guess degrades to per-row reads, it never blocks.
        const vm = /^(\d+)\.(\d+)/.exec(String(ver.proto || ''));
        const batchOkProto = vm && (Number(vm[1]) > 4 || (Number(vm[1]) === 4 && Number(vm[2]) >= 3));
        if (!batchOkProto) {
          state.batchOk = false;
          toast('Server reports protocol ' + ver.proto + ' (this client targets 4.3). ' +
            'Sync falls back to per-row reads. Deploy the updated worker for batch sync.', 'warn', 9000);
        }
      } catch {
        $('#proto-badge').textContent = 'protocol ?';
        toast('Could not read /version — continuing with per-row reads.', 'warn', 7000);
        state.batchOk = false;
      }
    })();
    $('#password').value = '';
    await showApp();
    armAutoLock(); // sec-S5-F4: the idle clock starts once the app is up
    if (hadLocal) {
      // Cached data is on screen — reconcile silently (failure-tolerant,
      // toasts handled inside syncAll; autosync keeps retrying every 60 s).
      setBusy(false);
      syncAll(true).catch(() => {});
    } else {
      setBusy(true, 'Syncing…');
      try {
        await syncAll(true);
      } finally {
        setBusy(false);
      }
    }
    await versionGate;
  } catch (e) {
    const srvErr =
      e instanceof ApiError && e.body && e.body.error ? ` (server said "${e.body.error}")` : '';
    const msg =
      e instanceof ApiError && e.kind === 'silent'
        ? 'Authentication failed (silent 404): the provisioning code is not valid on this server.'
        : e instanceof ApiError && e.kind === 'forbidden'
          ? 'The server rejected this token class (403): the stored code is a read-only token — re-provision with the AUTH_UI code.'
          : e && e.message === 'unlock_failed'
            ? 'Unlock failed: wrong password (or the server config does not match this deployment).'
            : e && e.message === 'bad_token'
              ? 'The stored provisioning code is malformed — paste a valid 64-hex code below.'
              : 'Login failed: ' + (e && e.message ? e.message : String(e)) + srvErr;
    $('#login-msg').textContent = msg;
  } finally {
    setBusy(false);
  }
}

async function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#btn-sync').hidden = false;
  $('#btn-lock').hidden = false;
  $('#btn-forget').hidden = false;
  $('#btn-settings').hidden = false;
  await ensureCalendar(); // construct + render the FullCalendar instance once
  renderAll();
}

function lock() {
  if (state.busy) return;
  closeAllOverlays();
  disarmAutoLock();
  state.api = null;
  state.rowKey = null;
  state.cfgFp = null;
  state.cals.clear();
  state.evt.clear();
  state.corrupt.clear();
  state.today = null;
  // v4.5 LOCAL-FIRST: purge the plaintext cache — no titles/descriptions
  // may survive Lock on disk either (E5-5 parity).
  purgeLocalCache();
  // §9 conditional read: drop the manifest etag on lock — a fresh unlock
  // MUST do a full manifest fetch (a 304 against a cleared state would
  // render an empty calendar).
  state.manifestEtag = null;
  // E5-5: purge plaintext event data so titles/descriptions do not survive
  // Lock in the JS heap: the FullCalendar event store and any half-open
  // editor target.
  if (fcCal) { try { fcCal.removeAllEvents(); } catch { /* not rendered yet */ } }
  editor.mode = null;
  editor.scope = null;
  editor.target = null;
  editor.custom = null;
  $('#password').value = '';
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#btn-sync').hidden = true;
  $('#btn-lock').hidden = true;
  $('#btn-forget').hidden = true;
  $('#btn-settings').hidden = true;
}

function forgetBrowser() {
  if (state.busy) return;
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_SERVER);
  localStorage.removeItem(LS_CALVIS);
  try { localStorage.removeItem(LS_CFG); } catch { /* ignore */ }
  calVis = new Map();
  calVisible.clear();
  lock();
  refreshLoginUi();
  toast('Provisioning code forgotten on this browser.', 'ok');
}

/* ---------------- idle auto-lock (sec-S5-F4) ----------------
 * Nothing ever triggered lock() automatically: an unlocked tab left on
 * screen (or closed without pressing Lock) kept the full plaintext model
 * in localStorage indefinitely. After 15 minutes without user activity
 * the app now locks + purges — the exact lock() the topbar button runs.
 * Armed on unlock, disarmed by lock(); disabled via the settings toggle.
 * A loopback-only test hook lets the e2e suite force expiry without
 * waiting a quarter hour. */
const AUTO_LOCK_MS = 15 * 60 * 1000;
let autoLockTimer = null;
let lastActivity = Date.now();

function armAutoLock() {
  if (autoLockTimer) clearTimeout(autoLockTimer);
  if (!settings.autoLock) return;
  autoLockTimer = setTimeout(() => {
    autoLockTimer = null;
    if (state.api && !state.busy) {
      lock();
      toast('Auto-locked after 15 minutes of inactivity.', 'ok', 6000);
    }
  }, AUTO_LOCK_MS);
}

function disarmAutoLock() {
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = null;
}

function noteUserActivity() {
  const now = Date.now();
  if (now - lastActivity < 1000) return; // 1 Hz throttle is plenty
  lastActivity = now;
  if (settings.autoLock && state.api) armAutoLock();
}

/** Loopback check for dev/test-only affordances (e2e stacks, __autolockForce). */
function isLoopbackHost() {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1' ||
    location.hostname === '[::1]' || location.hostname.endsWith('.localhost');
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

/** Ingest one decrypted envelope into state (failure-tolerant, per-row).
 * Wave-7 A3: vers are monotonic server-side — a batch response OLDER than a
 * just-completed local RMW (stale manifest snapshot racing a mutation) must
 * NOT roll the local state back. Rows the user mutated are also protected by
 * the dirty set at the syncAll cleanup below. */
async function ingestRow(id, ver, nonce, ct) {
  const localEvt = state.evt.get(id);
  if (localEvt && Number.isInteger(ver) && localEvt.ver >= ver && !state.corrupt.has(id)) {
    return; // stale envelope — keep the fresher local state
  }
  const cu = core.parseCmetaId(id);
  if (cu) {
    const localCal = state.cals.get(cu);
    if (localCal && Number.isInteger(ver) && localCal.ver >= ver && !state.corrupt.has(id)) {
      return;
    }
  }
  let payload;
  try {
    payload = await decryptRow(state.rowKey, id, ver, nonce, ct);
  } catch {
    state.corrupt.set(id, { reason: 'decrypt_failed', ver });
    state.evt.delete(id);
    if (cu) state.cals.delete(cu);
    return;
  }
  if (core.parseEvtId(id)) {
    const parsed = core.parseEvtPayload(payload);
    if (!parsed) {
      state.corrupt.set(id, { reason: 'bad_payload', ver });
      state.evt.delete(id);
    } else {
      state.evt.set(id, { ver, parsed });
      state.corrupt.delete(id);
    }
  } else {
    let meta = null;
    try { meta = JSON.parse(payload); } catch { /* corrupt */ }
    const v = core.validateCalendarMeta(meta);
    if (!cu || !v) {
      state.corrupt.set(id, { reason: 'bad_payload', ver });
      if (cu) state.cals.delete(cu);
    } else {
      state.cals.set(cu, { ver, meta: v });
      state.corrupt.delete(id);
    }
  }
}

/**
 * Fetch the given row ids into state: one POST /rows:batch (§9b) when the
 * server supports it, else per-row GETs (v4.2 fallback, §5.1c). Individual
 * failures NEVER abort the batch — the row is flagged corrupt instead.
 * `syncGen` is the mutation generation captured when the sync's manifest
 * request was ISSUED: rows mutated after that (dirty gen > syncGen) may be
 * absent from the snapshot legitimately and must be kept locally (A3).
 */
async function fetchRowsIntoState(ids, syncGen) {
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
    // Wave-7 A8: per-row fallback — ONE failed GET (network/500) must not
    // abort the whole set; the failed row is simply retried next sync.
    envelopes = await Promise.all(ids.map(async (id) => {
      try {
        const env = await state.api.getRow(id); // null when missing
        return env || { id, missing: true };
      } catch {
        return { id, skip: true };
      }
    }));
  }
  for (const env of envelopes) {
    if (!env || !env.id || env.skip) continue;
    if (env.missing) {
      // A3: keep a row ONLY if it was mutated after the manifest request was
      // issued (dirty gen > syncGen) — its absence from the snapshot is then
      // expected, not a server-side delete.
      const dirtyGen = state.dirty.get(env.id);
      if (!(dirtyGen !== undefined && dirtyGen > syncGen)) {
        state.evt.delete(env.id);
        state.corrupt.delete(env.id);
        const cu = core.parseCmetaId(env.id);
        if (cu) state.cals.delete(cu);
      }
      state.deletedLocally.delete(env.id); // confirmed gone server-side
      continue;
    }
    // A3: a row deleted locally this session must not be resurrected by a
    // stale batch response (the server confirms the delete next sync).
    if (state.deletedLocally.has(env.id)) continue;
    await ingestRow(env.id, env.ver, env.nonce, env.ct);
  }
}

/**
 * Cheap fingerprint of the sync-relevant state (E3-1/E2-5): which rows exist,
 * at which vers, and which are flagged corrupt. Two equal shapes ⇒ a sync
 * changed nothing ⇒ no renderAll needed. O(rows) string build, ~1 ms at 300 rows.
 */
function syncStateShape() {
  const parts = [];
  for (const [id, r] of state.evt) parts.push(id + '>' + r.ver);
  for (const [u, c] of state.cals) parts.push('c:' + u + '>' + c.ver);
  for (const id of state.corrupt.keys()) parts.push('x:' + id);
  return parts.join('|');
}

/**
 * v4.3 §5.1 sync — READ-ONLY, failure-tolerant, renders when something changed.
 * 1 request when nothing changed; 2 when anything did. Never writes rows;
 * never lets one bad row (corrupt/unparseable) abort the others.
 * Wave-7 A3/A6/A7: races with mutations are defused via the monotonic-ver
 * skip in ingestRow + the dirty set below; the bootstrap only fires when the
 * MANIFEST (not local state) has no evt/cmeta rows; a lock() during an
 * in-flight sync aborts it silently instead of throwing on null state.
 */
async function syncAll(forceRender = false) {
  if (!state.api || state.syncing) return;
  state.syncing = true;
  const api = state.api; // captured: detect lock() during this sync (A7)
  const syncGen = state.mutGen; // A3: mutations AFTER this are newer than the snapshot
  const errors = [];
  // E3-1/E2-5: change signal — a sync that changes NOTHING (idle autosync)
  // must not pay a full renderAll. Snapshot the sync-relevant state shape.
  const before = syncStateShape();
  try {
    const manifest = await api.getManifest(state.manifestEtag);
    if (state.api !== api) return; // locked while awaiting — abort silently
    if (!manifest.notModified) {
      state.manifestEtag = manifest.etag || null;
      const rows = manifest.rows || [];
      const seen = new Set();
      const toFetch = [];
      let evtOrCmetaOnServer = 0;

      for (const r of rows) {
        const id = r.id;
        // `cal:` day buckets are DEPRECATED in v4.3 (protocol.md §13c):
        // never read, never written, ignored entirely.
        if (core.parseEvtId(id)) {
          seen.add(id);
          evtOrCmetaOnServer++;
          const local = state.evt.get(id);
          // E2-3: a corrupt row is retried only when its ver CHANGED (a fixed
          // server row) — not on every idle poll forever.
          const bad = state.corrupt.get(id);
          if (bad ? bad.ver !== r.ver : (!local || local.ver !== r.ver)) toFetch.push(id);
        } else if (core.parseCmetaId(id)) {
          seen.add(id);
          evtOrCmetaOnServer++;
          const uuid = core.parseCmetaId(id);
          const local = state.cals.get(uuid);
          const bad = state.corrupt.get(id);
          if (bad ? bad.ver !== r.ver : (!local || local.ver !== r.ver)) toFetch.push(id);
        }
      }

      if (toFetch.length > 0) {
        // ≤256 ids per call (protocol.md §9b); chunk larger sets.
        for (let i = 0; i < toFetch.length; i += 256) {
          await fetchRowsIntoState(toFetch.slice(i, i + 256), syncGen);
          if (state.api !== api) return; // locked mid-sync — abort silently
        }
      }

      // Locally-known rows absent from the manifest were deleted elsewhere.
      // A3: rows mutated AFTER the manifest request was issued (dirty gen >
      // syncGen) may legitimately be absent — keep ONLY those. (A session-long
      // protection was a bug: it masked genuine deletions for the whole
      // session — wave-7 A9 regression caught it.)
      for (const id of [...state.evt.keys()]) {
        const dg = state.dirty.get(id);
        if (!seen.has(id) && !(dg !== undefined && dg > syncGen)) state.evt.delete(id);
      }
      for (const [uuid] of state.cals) {
        const cid = core.cmetaId(uuid);
        const dg = state.dirty.get(cid);
        if (!seen.has(cid) && !(dg !== undefined && dg > syncGen)) state.cals.delete(uuid);
      }
      for (const id of [...state.corrupt.keys()]) if (!seen.has(id)) state.corrupt.delete(id);
      // Dirty rows the manifest now confirms are no longer dirty.
      for (const [id] of [...state.dirty.entries()]) if (seen.has(id)) state.dirty.delete(id);
      // Locally-deleted rows the manifest no longer lists are confirmed.
      for (const id of [...state.deletedLocally.keys()]) if (!seen.has(id)) state.deletedLocally.delete(id);

      /* ---- calendar visibility: unchecking persists; new calendars visible ---- */
      const stored = loadCalVis();
      for (const uuid of state.cals.keys()) {
        if (!stored || !stored.has(uuid)) calVis.set(uuid, true);
      }
      for (const uuid of [...calVis.keys()]) {
        if (!state.cals.has(uuid)) calVis.delete(uuid);
      }
      syncCalVisible();

      /* ---- default calendar bootstrap (Proton DEFAULT_CALENDAR).
       * A6: gated on the MANIFEST, not local state — an all-corrupt store or a
       * v4.2 leftover with only `cal:` bucket rows must NOT trigger a write. */
      if (evtOrCmetaOnServer === 0) {
        const uuid = crypto.randomUUID();
        const meta = core.newCalendarMeta('My calendar', core.PALETTE[0]);
        const res = await putRowRMW(core.cmetaId(uuid), () => JSON.stringify(meta), {
          allowCreate: true, local: { ver: 0, payload: null },
        });
        if (state.api !== api) return; // locked — abort silently
        applyRowLocally(core.cmetaId(uuid), res.ver, res.text); // marks dirty
        calVis.set(uuid, true);
        saveCalVis();
        syncCalVisible();
      }
    } // §9 304: NOTHING changed server-side — rows cannot have appeared,
      // changed or vanished, so the whole manifest body is a no-op.
  } catch (e) {
    if (state.api === api) errors.push(e); // a locked session swallows it
  } finally {
    state.syncing = false;
  }

  if (state.api !== api) return; // locked — do not render/toast on dead state

  // §5.1d: render after a sync when something actually CHANGED (or when the
  // caller needs a guaranteed render, e.g. first unlock). A13: a render bug
  // must not reject the sync (unlock shows "Login failed").
  const changed = syncStateShape() !== before || errors.length > 0;
  try {
    if (changed || forceRender) renderAll();
  } catch (e) {
    console.error('render error after sync: ' + (e && e.message ? e.message : String(e)));
  }
  // A5: only toast when the unreadable-row count CHANGED (no 60 s spam).
  if (state.corrupt.size > 0 && state.corrupt.size !== state.lastCorruptCount) {
    toast(`${state.corrupt.size} row(s) could not be decrypted — flagged, never rewritten.`, 'warn', 8000);
  }
  state.lastCorruptCount = state.corrupt.size;
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
 * just wrote (no re-fetch, no sync) and re-render. The row is marked dirty
 * (with the current mutation generation) so a sync whose manifest snapshot
 * predates the mutation cannot roll it back or delete it (A3).
 */
function applyRowLocally(id, ver, text) {
  state.dirty.set(id, ++state.mutGen);
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
  const startedAsCreate = !!(local && local.ver === 0);
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
    // A10: a CREATE that rebased means the row already exists (someone else
    // created it) — never overwrite a foreign row; fail loudly instead.
    if (startedAsCreate && attempt === 0) {
      throw new Error('exists: ' + id);
    }
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

/** Hours between two wall {date,time} (naive; display-classification only). */
function wallHours(a, b) {
  const t = (x) => (x.time === null ? 0 : Date.UTC(1970, 0, 1, +x.time.slice(0, 2), +x.time.slice(3, 5), +x.time.slice(6, 8)));
  return (t(b) - t(a)) / 3600000 + diffDays(b.date, a.date) * 24;
}

/**
 * All view events overlapping [firstDay, lastDay] (inclusive), from visible
 * calendars only. Mirrors Proton's CalendarViewEvent essentials. Feeds the
 * FullCalendar event source, the event popover and the clock preview.
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
        isTask: occ.isTask,
        isCompleted: occ.isCompleted,
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
  // Deterministic order: start, then all-day first, then title.
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

/* ==================================================================
 * FullCalendar bridge (view layer — everything in this section drives
 * FullCalendar v7.1.3 through its DOCUMENTED options only; its DnD,
 * resizing, layout and popovers are used exactly as shipped).
 * ================================================================== */

let fcCal = null; // the FullCalendar.Calendar instance (created on unlock)

/** Plugin objects from the official global bundle (verified by smoke test)
 * + the ACTIVE stock theme plugin (official themes are plugins — see
 * applyFcTheme; activeFcTheme is set before any Calendar is constructed). */
function fcPlugins() {
  return [
    window.FullCalendar.DayGrid.default,
    window.FullCalendar.TimeGrid.default,
    window.FullCalendar.Interaction.default,
    window.FullCalendar.MultiMonth.default,
    window.FullCalendar.List.default,
    activeFcTheme,
  ].filter(Boolean);
}

/** Local (browser) wall components of a Date — for create/convert paths. */
function localWallOf(date) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate()),
    time: p(date.getHours()) + ':' + p(date.getMinutes()) + ':' + p(date.getSeconds()),
  };
}

/** One view event → a FullCalendar EventInput.
 *  - all-day occurrences: date strings (end EXCLUSIVE — RFC DTEND semantics).
 *  - timed occurrences: real instants (wall+TZID → UTC Date) so FullCalendar
 *    renders in the browser's timezone (RFC 5545 semantics; DST-correct).
 *  - id: uniqueId (rowId#recId) — stable across refetches; the app-side view
 *    event rides along in extendedProps.ev (popover / mutations). */
function fcEventInput(ev) {
  const tz = ev.component.dtstart.tz || 'UTC';
  let start;
  let end;
  let allDay;
  if (ev.isAllDay) {
    allDay = true;
    start = ev.start.date;
    end = core.addDays(ev.spanLast, 1); // display-inclusive → exclusive
  } else {
    allDay = false;
    start = core.wallToInstantUTC({ date: ev.start.date, time: ev.start.time || '00:00:00' }, tz);
    const endTime = ev.end.time === null ? '00:00:00' : ev.end.time;
    end = core.wallToInstantUTC({ date: ev.end.date, time: endTime }, tz);
    if (end.getTime() <= start.getTime()) end = new Date(start.getTime()); // zero-length
  }
  const [colorMain] = genAccentShades(calendarColor(ev.calUuid));
  return {
    id: ev.uniqueId,
    title: ev.title || '',
    start,
    end,
    allDay,
    // v7 EventInput colors: `color` + `contrastColor` replace v6's
    // backgroundColor/borderColor/textColor (the theme derives borders from
    // the color itself). Per-calendar colors still drive the chip.
    color: colorMain,
    contrastColor: '#FFFFFF',
    // v7 themes style events via hashed utility classes; the canonical
    // semantic name is carried on OUR event data (documented EventInput
    // `class` field — pure data, string-only in v7) so the app's CSS and the
    // e2e suite have a stable handle (the official test theme does exactly
    // this via eventClass).
    class: 'fc-event',
    // Tasks are anchored at DTSTART (no DTEND): duration-resizing a task
    // would write a nonstandard DTEND on a VTODO — resizing is events-only
    // (FullCalendar's per-event flag; moves stay enabled).
    ...(ev.isTask ? { durationEditable: false } : {}),
    extendedProps: { ev },
  };
}

/** FullCalendar event source: expand the decrypted model over the requested
 * range (synchronous, ZERO network — the sync engine owns the wire). */
function fcEventsSource(fetchInfo, successCallback, failureCallback) {
  try {
    const a = localWallOf(fetchInfo.start);
    const b = localWallOf(fetchInfo.end);
    const events = viewEventsForRange(a.date, core.addDays(b.date, -1)).map(fcEventInput);
    successCallback(events);
  } catch (e) {
    failureCallback(e);
  }
}

/** The single source of FullCalendar options (settings + state derived). */
function buildFcOptions() {
  const hour12 = settings.hour12 === null ? undefined : !!settings.hour12;
  const timeFmt = { hour: 'numeric', minute: '2-digit', meridiem: 'narrow', ...(hour12 === undefined ? {} : { hour12 }) };
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return {
    plugins: fcPlugins(),
    initialView: state.view,
    headerToolbar: {
      start: 'prev,next today',
      center: 'title',
      end: 'timeGridDay,timeGridWeek,dayGridMonth,multiMonthYear,listYear,custom',
    },
    height: '100%',
    expandRows: true,

    /* ---- event data ---- */
    events: fcEventsSource,
    editable: true,          // FullCalendar's own drag & drop + resizing
    selectable: true,        // FullCalendar's own drag-to-create
    selectMirror: true,
    unselectAuto: true,
    eventStartEditable: true,
    eventDurationEditable: true,
    dayMaxEvents: true,      // native "+N more"
    nowIndicator: true,      // native now-line
    navLinks: true,          // native day-number navigation
    navLinkDayClick: 'timeGridDay',
    navLinkWeekClick: 'timeGridWeek',

    /* ---- callbacks (the ONLY glue to the backbone) ---- */
    viewDidMount: onViewDidMount,
    datesSet: onDatesSet,
    eventClick: handleEventClick,
    eventDidMount: onEventDidMount,
    eventDrop: handleEventDrop,
    eventResize: handleEventResize,
    select: handleSelect,
    dateClick: handleDateClick,

    /* ---- appearance / customisation (settings menu) ---- */
    firstDay: settings.firstDay,
    weekNumbers: !!settings.weekNumbers,
    slotDuration: settings.slotDuration,
    // v7 renames: slotLabelInterval → slotHeaderInterval (hourly labels
    // under 15-minute slots, the previous explicit setting).
    slotHeaderInterval: settings.slotDuration === '00:15:00' ? '01:00:00' : undefined,
    scrollTime: p(now.getHours()) + ':' + p(now.getMinutes()) + ':00',
    eventTimeFormat: timeFmt,
    // v7 rename: slotLabelFormat → slotHeaderFormat.
    slotHeaderFormat: timeFmt,
    titleFormat: { year: 'numeric', month: 'long' },
    views: {
      custom: { type: 'timeGrid', duration: { days: settings.customDays } },
    },
    // v7: per-view toolbar button labels move from views{}.buttonText to the
    // `buttons` map (the option the toolbar reads — see buildContentButtons).
    buttons: {
      custom: { text: 'Custom' },
      timeGridDay: { text: 'Day' },
      timeGridWeek: { text: 'Week' },
      dayGridMonth: { text: 'Month' },
      multiMonthYear: { text: 'Year' },
      listYear: { text: 'Agenda' },
    },
    // v7 rename of v6's eventClassNames — NOTE: v7 accepts a STRING (or
    // falsy) ONLY (refineClassName), never an array. Tasks get their own
    // classes; completed tasks render dimmed+struck (Fossify's
    // dimCompletedTasks look); cancelled events keep the strikethrough.
    eventClass: (arg) => {
      const ev = arg.event.extendedProps.ev;
      if (!ev) return '';
      const cls = [];
      if (ev.isCancelled) cls.push('fc-event-cancelled');
      if (ev.isTask) {
        cls.push('fc-task');
        if (ev.isCompleted) cls.push('fc-task-completed');
      }
      return cls.join(' ');
    },
    moreLinkClick: 'popover', // native "+N more" popover
  };
}

/** FullCalendar viewDidMount: keep state.view/settings/LS_VIEW in sync with
 * toolbar view switches (documented callback — fires on every view mount). */
function onViewDidMount(info) {
  const v = info.view.type;
  if (v !== state.view) {
    state.view = v;
    settings.view = v;
    saveSettings();
    try { localStorage.setItem(LS_VIEW, v); } catch { /* ignore */ }
  }
  renderMiniCalendar();
}

/** FullCalendar datesSet: fires on EVERY navigation (prev/next/today/
 * gotoDate/view switch) — refreshes the mini calendar (which shows
 * fc.getDate()'s month); viewDidMount alone misses same-view navigation. */
function onDatesSet() {
  // F-A1-8 (audit wave): navigating with the Today button (or any date
  // change) also refreshes the day-rollover state instead of waiting for
  // the 60 s interval.
  const today = core.localToday();
  if (state.api && today !== state.today) {
    state.today = today;
    renderAll();
    return;
  }
  renderMiniCalendar();
}

/** Construct + render the calendar (on first unlock, or after a theme
 * FLAVOR switch destroyed it). Async: the theme plugin global.js is loaded
 * on first use — every later switch is a synchronous cache hit. */
async function ensureCalendar() {
  if (fcCal) return;
  if (!activeFcTheme) {
    activeFcTheme = await fcThemePlugin(flavorOf(settings.fcTheme));
  }
  fcCal = new window.FullCalendar.Calendar($('#calendar'), buildFcOptions());
  fcCal.render();
}

/* ---------------- FullCalendar → backbone handlers ---------------- */

/** Click on an event chip → task checkbox toggles completion (Fossify
 * semantics); anything else opens the read-only popover. */
function handleEventClick(info) {
  info.jsEvent.preventDefault();
  const ev = info.event.extendedProps.ev;
  if (!ev) return;
  if (ev.isTask && info.jsEvent.target && info.jsEvent.target.closest && info.jsEvent.target.closest('.fc-task-check')) {
    toggleTaskCompletion(ev);
    return;
  }
  openEventPopover(ev, info.el.getBoundingClientRect());
}

/** eventDidMount: prepend the task CHECKBOX (Fossify renders a task icon
 * beside every task; ours is interactive). Official FullCalendar render
 * hook — FullCalendar's own time/title content is untouched. Idempotent
 * (a re-mount of the same element never duplicates the box). */
function onEventDidMount(arg) {
  const ev = arg.event.extendedProps.ev;
  if (!ev) return;
  // Keyboard accessibility: v7 themes do not set tabindex on event chips —
  // add it so chips are focusable and Enter opens the popover (v6 parity).
  if (!arg.isMirror && arg.el.getAttribute('tabindex') === null) {
    arg.el.setAttribute('tabindex', '0');
  }
  if (!ev.isTask || arg.isMirror) return;
  const root = arg.el;
  if (root.querySelector(':scope > .fc-task-check, :scope .fc-event-main > .fc-task-check')) return;
  const box = el('span', 'fc-task-check' + (ev.isCompleted ? ' is-completed' : ''), {
    role: 'checkbox',
    'aria-checked': ev.isCompleted ? 'true' : 'false',
    'aria-label': ev.isCompleted ? 'Mark task incomplete' : 'Mark task complete',
    tabindex: '0',
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      toggleTaskCompletion(ev);
    }
  });
  const host = root.querySelector('.fc-event-main') || root;
  host.prepend(box);
}

/** Duration → {days, minutes} (FullCalendar Duration objects carry
 * days/milliseconds; minutes may carry across-midnight drags). */
function fcDurationToParts(d) {
  if (!d) return { days: 0, minutes: 0 };
  return { days: d.days || 0, minutes: Math.round((d.milliseconds || 0) / 60000) };
}

/**
 * Drop (move). FullCalendar's own DnD computes the delta; the backbone's
 * applyDayShift performs the RMW (wall-clock day+minute shift, recurring
 * scope choice, A1 exception semantics). info.revert() puts the chip back
 * on failure/cancel — FullCalendar's documented revert mechanism, unmodified.
 */
function handleEventDrop(info) {
  const ev = info.event.extendedProps.ev;
  if (!ev) { info.revert(); return; }
  const { days, minutes } = fcDurationToParts(info.delta);
  const toAllDay = !!info.event.allDay;
  const wasAllDay = ev.isAllDay;
  const dropDay = info.event.allDay ? localWallOf(info.event.start).date : null;

  // Cross-slot conversion (timed ↔ all-day): a separate mutation shape.
  if (toAllDay !== wasAllDay) {
    applyWithScope(ev, {
      title: 'Convert event',
      verb: 'converted',
      run: (scope) => applyAllDayConversion(ev, scope, {
        toAllDay,
        day: toAllDay ? dropDay : localWallOf(info.event.start).date,
        time: toAllDay ? null : localWallOf(info.event.start).time,
      }),
      revert: info.revert,
    });
    return;
  }

  applyWithScope(ev, {
    title: 'Move recurring event',
    verb: 'moved',
    run: (scope) => applyDayShift(ev, days, scope, minutes),
    revert: info.revert,
  });
}

/**
 * Resize (duration change): new-backbone mutation applyDurationChange —
 * shifts ONLY the end (dtend) by the resized delta, same putRowRMW pattern
 * as every other mutation. startDelta is 0 for one-edge resizes.
 */
function handleEventResize(info) {
  const ev = info.event.extendedProps.ev;
  if (!ev) { info.revert(); return; }
  const { days, minutes } = fcDurationToParts(info.endDelta);
  applyWithScope(ev, {
    title: 'Resize recurring event',
    verb: 'resized',
    run: (scope) => applyDurationChange(ev, days, minutes, scope),
    revert: info.revert,
  });
}

/** Shared mutation wrapper: recurring scope choice → busy → run → revert on
 * failure; toasts mirror the backbone's move/resize UX. */
function applyWithScope(ev, { title, verb = 'updated', run, revert }) {
  const apply = async (scope) => {
    try {
      setBusy(true, 'Saving…');
      await run(scope);
      toast('Event ' + verb + '.', 'ok', 2000);
    } catch (e) {
      toast('Update failed: ' + (e && e.message ? e.message : String(e)), 'err', 7000);
      if (revert) revert();
    } finally {
      setBusy(false);
    }
  };
  if (ev.isRecurring || ev.isException) {
    openRecurringChoice(title, (choice) => {
      apply(choice === 'exception' ? 'exception' : 'master');
    }, () => { if (revert) revert(); });
  } else {
    apply('master');
  }
}

/**
 * Drag-to-create (FullCalendar select). all-day selections open the editor
 * with an inclusive day range; timed selections with wall start/end minutes
 * (beginCreateTimeGrid normalises minute carry across midnight).
 */
function handleSelect(info) {
  fcCal.unselect();
  closeAllOverlays();
  if (info.allDay) {
    // FullCalendar all-day select end is EXCLUSIVE; the editor takes the
    // display-INCLUSIVE last day (beginCreateRange semantics).
    const last = core.addDays(localWallOf(info.end).date, -1);
    beginCreateRange(localWallOf(info.start).date, last);
    return;
  }
  const startW = localWallOf(info.start);
  const endW = localWallOf(info.end);
  const mins = (w) => +w.time.slice(0, 2) * 60 + +w.time.slice(3, 5);
  // Total minutes from the SELECTED day (multi-day timed selects carry).
  const totalM = diffDays(endW.date, startW.date) * 1440 + (mins(endW) - mins(startW));
  beginCreateTimeGrid(startW.date, mins(startW), Math.max(mins(startW) + MIN_DURATION, mins(startW) + totalM));
}

/** Plain click on an empty day/timeslot → create (Proton default duration). */
function handleDateClick(info) {
  closeAllOverlays();
  // F-A2-1 (audit wave): branch on FullCalendar's OWN all-day signal — the
  // previous view-type prefix test ('multimonth') never matched the real
  // 'multiMonthYear' view type (camelCase), so year-view day clicks created
  // timed 00:00 events; info.allDay is true on every all-day surface
  // (dayGrid month, multiMonth year, the week/day all-day strip).
  if (info.allDay) {
    beginCreate(localWallOf(info.date).date); // all-day (month-grid semantics)
    return;
  }
  const w = localWallOf(info.date);
  const m = +w.time.slice(0, 2) * 60 + +w.time.slice(3, 5);
  beginCreateTimeGrid(w.date, m, m + DEFAULT_EVENT_DURATION);
}

/* ---------------- rendering (view refresh) ---------------- */

/** Render everything from the CURRENT decrypted state. The grid itself is
 * FullCalendar's — refetchEvents re-runs the (synchronous) event source.
 * v4.5 LOCAL-FIRST: every completed render schedules a debounced cache
 * write (sync ingestion, mutations and deletes ALL funnel through here). */
function renderAll() {
  state.today = state.today || core.localToday();
  if (fcCal) fcCal.refetchEvents();
  renderCalendarList();
  renderMiniCalendar();
  renderClockPreview();
  scheduleCacheWrite();
}

/** Switch the FullCalendar view (toolbar buttons call this via view-did-mount
 * state tracking; keyboard shortcuts call it directly). */
function setView(v) {
  if (!VIEWS.includes(v)) return;
  state.view = v;
  try { localStorage.setItem(LS_VIEW, v); } catch { /* ignore */ }
  settings.view = v;
  saveSettings();
  if (fcCal && fcCal.view.type !== v) fcCal.changeView(v);
  renderMiniCalendar();
}

/* ---------------- mini calendar (sidebar; drives fc.gotoDate) ---------------- */

/** Weeks covering the month (leading column = settings.firstDay), each
 * row = 7 day strings. Used by the mini calendar (the main grid is
 * FullCalendar's, which applies firstDay natively). */
function monthRows(ym, firstDay = 1) {
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = [];
  for (let d = 1; d <= n; d++) days.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  const lead = (first.getUTCDay() - firstDay + 7) % 7; // firstDay column = 0
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

/** The month the MAIN calendar is showing (FullCalendar's current date). */
function currentYM() {
  const d = fcCal ? fcCal.getDate() : new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function renderMiniCalendar() {
  const grid = $('#minical-grid');
  if (!grid) return;
  grid.replaceChildren();
  const ym = currentYM();
  $('#minical-label').textContent = MONTHS[Number(ym.slice(5)) - 1] + ' ' + ym.slice(0, 4);

  const { rows, monthDays } = monthRows(ym, settings.firstDay);
  const today = state.today || core.localToday();
  const dowNames = [];
  // WEEKDAY_LONG is Monday-first (index 0 = Monday); the column at position
  // i shows weekday (i + firstDay + 6) % 7 (firstDay: 0=Sun, 1=Mon, 6=Sat).
  for (let i = 0; i < 7; i++) dowNames.push(WEEKDAY_LONG[(i + settings.firstDay + 6) % 7].slice(0, 2));
  for (const wd of dowNames) grid.appendChild(el('div', 'wd', { text: wd }));

  const selected = fcCal ? localWallOf(fcCal.getDate()).date : today;
  for (const week of rows) {
    for (const day of week) {
      const cls = [
        'minicalendar-day',
        monthDays.has(day) ? '' : 'out',
        day === today ? 'today' : '',
        day === selected ? 'selected' : '',
      ].filter(Boolean).join(' ');
      const b = el('button', cls, {
        type: 'button', text: String(Number(day.slice(8))),
        'aria-label': fmtDateMed.format(new Date(day + 'T00:00:00')),
      });
      b.addEventListener('click', () => {
        if (fcCal) fcCal.gotoDate(day);
        renderMiniCalendar();
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
  if (!ul) return;
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
  if (!panel) return;
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

/* ---------------- event popover (read-only) ---------------- */

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
  if (ev.isTask) {
    headMain.appendChild(el('span', 'badge proto' + (ev.isCompleted ? ' task-done' : ''), {
      text: ev.isCompleted ? 'task — completed' : 'task',
    }));
  }
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
  // Task completion toggle (Fossify's mark-complete action): a checkbox
  // button beside edit/delete.
  if (ev.isTask) {
    const btnDone = el('button', 'button button-ghost icon-only' + (ev.isCompleted ? ' task-toggle-done' : ''), {
      type: 'button',
      title: ev.isCompleted ? 'Mark task incomplete' : 'Mark task complete',
      'aria-label': ev.isCompleted ? 'Mark task incomplete' : 'Mark task complete',
      'aria-pressed': ev.isCompleted ? 'true' : 'false',
    });
    btnDone.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6.2"/><path d="M5.2 8.3l1.9 1.9 3.7-4.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btnDone.addEventListener('click', () => { closePopover(); toggleTaskCompletion(ev); });
    actions.appendChild(btnDone);
  }
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

/* ---------------- event editor (modal) ---------------- */

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

/** Open the editor for a timed event created on the time grid.
 * Wave-7 B1 (BLOCKER): minutes ≥ 1440 must CARRY into the next day (Proton
 * getNewTime semantics) — writing a '24:00' wall time produced DTEND
 * T240000, which the strict parser rejects → a corrupt row with a false
 * success toast. */
function beginCreateTimeGrid(day, startMinutes, endMinutes) {
  closeAllOverlays();
  const uuid = defaultCalendarUuid();
  if (!uuid) { toast('Create a calendar first.', 'warn'); return; }
  const p2 = (n) => String(Math.floor(n)).padStart(2, '0');
  const norm = (mins) => {
    let d = day;
    let m = Math.round(mins);
    while (m >= 1440) { d = shiftDay(d, 1); m -= 1440; } // carry (Proton roll)
    while (m < 0) { d = shiftDay(d, -1); m += 1440; }
    return { date: d, time: p2(m / 60) + ':' + p2(m % 60) };
  };
  const start = norm(startMinutes);
  const end = norm(endMinutes);
  editor.mode = 'create';
  editor.scope = null;
  editor.target = null;
  editor.custom = null;
  openEditor({
    title: '',
    allDay: false,
    start,
    end,
    freq: '',
    calUuid: uuid,
    location: '',
    notifs: [],
    description: '',
  });
}

/** Multi-day all-day create (month-grid drag). */
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

/** New TASK (Fossify Calendar's "New task" — MainActivity split). A task is
 * a VTODO row: start anchor + optional recurrence + completion checkbox.
 * The editor hides the Ends row (Fossify's TaskActivity has no end field). */
function beginCreateTask() {
  closeAllOverlays();
  const uuid = defaultCalendarUuid();
  if (!uuid) { toast('Create a calendar first.', 'warn'); return; }
  const start = defaultStart();
  const day = core.localToday();
  editor.mode = 'create';
  editor.scope = null;
  editor.target = null;
  editor.custom = null;
  openEditor({
    isTask: true,
    completed: false,
    title: '',
    allDay: false,
    start: { date: day, time: hhmm(start) },
    end: { date: day, time: hhmm(new Date(start.getTime() + 30 * 60000)) }, // unused by tasks
    freq: '',
    calUuid: uuid,
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
    openRecurringChoice(ev.isTask ? 'Edit recurring task' : 'Edit recurring event', (scope) => {
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
    isTask: !!ev.isTask,
    completed: !!ev.isTask && comp.status === 'COMPLETED',
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
  const isTask = !!form.isTask;
  const headRow = el('div', 'modal-head');
  const headTitle = isTask
    ? (editor.mode === 'create' ? 'Add task' : 'Edit task')
    : (editor.mode === 'create' ? 'Add event' : 'Edit event');
  headRow.appendChild(el('h1', { text: headTitle }));
  const closeX = el('button', 'button button-ghost icon-only', { type: 'button', 'aria-label': 'Close', title: 'Close' });
  closeX.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round"/></svg>';
  closeX.addEventListener('click', close);
  headRow.appendChild(closeX);
  box.appendChild(headRow);

  const f = { ...form };
  const val = () => ({
    isTask: !!f.isTask,
    completed: !!f.completed,
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
  // Tasks carry no end boundary (Fossify TaskActivity has none; VTODO ends
  // via DUE, which our editor does not manage) — the Ends row is events-only.
  if (isTask) rowEnd.hidden = true;
  box.appendChild(rowEnd);

  /* ---- task completion toggle (edit mode — Fossify toggleMarkComplete) ---- */
  if (isTask && editor.mode === 'edit') {
    const rowDone = el('div', 'form-row');
    rowDone.appendChild(el('span', 'ic'));
    rowDone.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 8.5l3 3 7-7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const doneBody = el('div', 'form-row-body');
    const doneChk = el('input', null, { type: 'checkbox', id: 'task-done-chk' });
    doneChk.checked = !!f.completed;
    doneChk.addEventListener('change', () => { f.completed = doneChk.checked; });
    const doneLbl = el('label', null, { for: 'task-done-chk' });
    doneLbl.append(doneChk, document.createTextNode('Mark complete'));
    doneBody.appendChild(doneLbl);
    rowDone.appendChild(doneBody);
    box.appendChild(rowDone);
  }

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
      // Guard: a mid-edit / cleared date input must never throw here —
      // Intl formatting an Invalid Date raises RangeError (found by the
      // A6 UI-robustness stress when Enter landed on a stale input).
      const d = new Date(f.start.date + 'T00:00:00');
      const dOk = typeof f.start.date === 'string' && f.start.date.length === 10 && !Number.isNaN(d.getTime());
      if (p.key === 'WEEKLY' && dOk) label += ' ' + WEEKDAY_LONG[(d.getDay() + 6) % 7];
      if (p.key === 'MONTHLY' && dOk) label += ' the ' + Number(f.start.date.slice(8));
      if (p.key === 'YEARLY' && dOk) label += ' ' + fmtDayMonth.format(d);
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
    const isTask = !!form.isTask;
    const cal = buildVCalendarOf({
      type: isTask ? 'VTODO' : 'VEVENT',
      uid,
      dtstamp,
      dtstart: mkStart(),
      // Tasks anchor at DTSTART only (Fossify TaskActivity shape): a VTODO
      // carries no DTEND — its span is the start day.
      dtend: isTask ? null : mkEnd(),
      rrule: rruleFor(form.freq, form),
      summary: form.title,
      description: form.description || null,
      location: form.location || null,
      status: isTask && form.completed ? 'COMPLETED' : null,
      transp: !isTask && form.allDay ? 'TRANSPARENT' : null,
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
    toast((isTask ? 'Task' : 'Event') + ' saved.', 'ok', 2000);
    return;
  }

  // Edit: RMW the row, modifying master or the exception component.
  const target = editor.target;
  const rowId = target.rowId;
  const parsed = target.parsed;
  const isExceptionEdit = editor.scope === 'exception';
  const isTask = !!form.isTask;
  // A9: guard BOTH calendars up front — a deleted target calendar must not
  // be resurrected by a plain edit, and a deleted picked calendar must not
  // silently drop the user's move.
  if (editor.mode === 'edit') {
    if (!state.cals.has(target.calUuid)) {
      throw new Error('calendar_gone: this event\u2019s calendar no longer exists — press Sync and retry');
    }
    if (form.calUuid && form.calUuid !== target.calUuid && !state.cals.has(form.calUuid)) {
      throw new Error('no_calendar: the selected calendar no longer exists — press Sync and retry');
    }
  }
  // Calendar MOVE (protocol.md: the calendar uuid is embedded in the row id,
  // so moving = PUT evt:{newcal}:{uid} FIRST, then DELETE the old row — the
  // create-before-delete order guarantees a PUT failure can never LOSE the
  // event (wave-7 A2); a failed DELETE leaves a visible duplicate instead,
  // which the next sync reconciles and the user can remove manually).
  if (form.calUuid && form.calUuid !== target.calUuid && state.cals.has(form.calUuid)) {
    let current;
    const res0 = await fetchRow(rowId);
    if (res0.missing) throw new Error('not_found: ' + rowId);
    if (res0.corrupt) throw new Error('row_corrupt: refusing to move a corrupt row');
    try {
      current = core.parseEvtPayload(res0.payload);
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
      // Tasks keep their foreign DTEND verbatim (our editor writes none).
      dtend: isTask ? (base.dtend || null) : mkEnd(),
      rrule: isExceptionEdit ? base.rrule : rruleFor(form.freq, form),
      summary: form.title,
      description: form.description || null,
      location: form.location || null,
      // Tasks: the editor's Mark-complete toggle drives STATUS:COMPLETED
      // (any foreign non-COMPLETED status survives when un-checked).
      status: isTask
        ? (form.completed ? 'COMPLETED' : (base.status === 'COMPLETED' ? null : base.status))
        : base.status,
      transp: isTask ? null : (form.allDay ? 'TRANSPARENT' : null),
      sequence: (base.sequence === null || base.sequence === undefined ? 0 : base.sequence) + 1,
      alarms,
    };
    // Wave-7 A1 (BLOCKER): an exception-scope edit MUST keep (or gain) its
    // RECURRENCE-ID — without it the row has two masters, fails the v4.2
    // one-master rule, and the event is destroyed with a success toast.
    if (isExceptionEdit && target.recId) {
      upd.recurrenceId = { date: target.recId.date, time: target.recId.time, tz: base.dtstart.tz };
    }
    if (idx >= 0) events[idx] = upd;
    else events.push(upd);
    const newId = core.evtId(form.calUuid, current.uid);
    // PUT the new row FIRST (failure here leaves the old row untouched).
    const res = await putRowRMW(newId, () => serializeVCalendar(current.calendar), {
      allowCreate: true,
      local: { ver: 0, payload: null },
    });
    applyRowLocally(newId, res.ver, res.text);
    // Then delete the old row (failure here leaves a visible duplicate —
    // recoverable, never a loss).
    try {
      await state.api.deleteRow(rowId);
      state.evt.delete(rowId);
      state.corrupt.delete(rowId);
      state.dirty.delete(rowId);
      state.deletedLocally.set(rowId, ++state.mutGen); // A3
    } catch (e) {
      toast('Moved, but the old copy could not be removed — it will re-appear; delete it manually.', 'warn', 8000);
    }
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
      type: isTask ? 'VTODO' : 'VEVENT',
      uid: p.uid,
      dtstamp,
      dtstart: mkStart(),
      dtend: isTask ? null : mkEnd(),
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
      // Tasks keep their foreign DTEND verbatim (our editor writes none).
      dtend: isTask ? (base.dtend || null) : mkEnd(),
      rrule: isExceptionEdit ? base.rrule : rruleFor(form.freq, form),
      summary: form.title,
      description: form.description || null,
      location: form.location || null,
      // Tasks: the editor's Mark-complete toggle drives STATUS:COMPLETED
      // (any foreign non-COMPLETED status survives when un-checked).
      status: isTask
        ? (form.completed ? 'COMPLETED' : (base.status === 'COMPLETED' ? null : base.status))
        : base.status,
      transp: isTask ? null : (form.allDay ? 'TRANSPARENT' : null),
      sequence: (base.sequence === null || base.sequence === undefined ? 0 : base.sequence) + 1,
      alarms,
    };
    if (idx >= 0) events[idx] = upd;
    else events.push(upd);
    return serializeVCalendar(p.calendar);
  }, { allowCreate: false, local: localRow ? { ver: localRow.ver, payload: serializeEvtOf(localRow) } : null });

  applyRowLocally(rowId, res.ver, res.text);
  renderAll();
  toast((form.isTask ? 'Task' : 'Event') + ' saved.', 'ok', 2000);
}

/** Re-serialize a locally-held parsed row (for the RMW fast-path payload). */
function serializeEvtOf(rec) {
  return core.serializeEvtPayload(rec.parsed);
}

/** Build a minimal VCALENDAR model around one component spec. */
function buildVCalendarOf(spec) {
  const ev = {
    type: spec.type || 'VEVENT', // v4.5: 'VTODO' rows are tasks
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
    state.dirty.delete(rowId);
    state.deletedLocally.set(rowId, ++state.mutGen); // A3: stale syncs must not resurrect it
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

/* ---- drag & drop / resize mutations ---- */

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

/**
 * RESIZE (FullCalendar eventResize): shift ONLY the end boundary by whole
 * days + minutes (dtstart untouched). scope 'exception' resizes the
 * exception component (creating it when the user resizes a plain occurrence
 * of a recurring series — same semantics as applyDayShift). DURATION-only
 * components are materialised to a DTEND (effectiveEnd + delta) so the new
 * boundary is explicit. Rejects non-positive results (the caller reverts).
 */
async function applyDurationChange(ev, days, minutes, scope) {
  const shiftDt = (dt, d, m) => {
    if (!dt) return dt;
    const shiftedDate = shiftDay(dt.date, d);
    if (dt.time === null || m === 0) {
      return { date: shiftedDate, time: dt.time, tz: dt.tz };
    }
    const secs = +dt.time.slice(0, 2) * 3600 + +dt.time.slice(3, 5) * 60 + +dt.time.slice(6, 8) + m * 60;
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
    // Materialise the current effective end (DURATION / DTEND / defaults).
    const curEnd = core.effectiveEnd(old);
    const newEnd = shiftDt(curEnd, days, minutes);
    // Reject a zero/negative-duration result (all-day shrunk below 1 day,
    // timed below zero): the caller reverts the chip.
    const badTimed = old.dtstart.time !== null &&
      (newEnd.date < old.dtstart.date ||
        (newEnd.date === old.dtstart.date && (newEnd.time || '00:00:00') <= (old.dtstart.time || '00:00:00')));
    const badAllDay = old.dtstart.time === null && newEnd.date <= old.dtstart.date;
    if (badTimed || badAllDay) throw new Error('invalid_duration: the event would end before it starts');
    const upd = {
      ...old,
      dtstamp: { date: new Date().toISOString().slice(0, 10), time: new Date().toISOString().slice(11, 19), tz: 'UTC' },
      dtend: newEnd,
      duration: null, // explicit DTEND now
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

/**
 * Cross-slot drop conversion (timed ↔ all-day). The span is preserved:
 * a timed event keeps its whole-day length as all-day days (rounded up,
 * minimum 1) and vice versa. scope semantics identical to applyDayShift.
 */
async function applyAllDayConversion(ev, scope, { toAllDay, day, time }) {
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
    const curEnd = core.effectiveEnd(old);
    // F-A1-4 (audit wave): converting a recurring MASTER flips the value
    // type of the series, but its RECURRENCE-ID exceptions keep their old
    // type — parseEvtPayload rejects the mismatch and the whole row turns
    // corrupt (event destroyed). Block it loudly instead (the drag reverts).
    if (p.master.rrule) {
      // ANY conversion inside a recurring series breaks the value-type match
      // between the master and its RECURRENCE-IDs (or would orphan the
      // exception) — refuse both master- and exception-scope conversions.
      throw new Error('convert_recurring: recurring events cannot be converted between timed and all-day — edit the event instead');
    }
    let newStart;
    let newEnd;
    if (toAllDay) {
      // timed → all-day: drop day at 00:00, span = whole days of the old
      // duration (rounded UP, minimum 1; DTEND stays exclusive).
      const spanDays = Math.max(1, Math.ceil(wallHours(old.dtstart, curEnd) / 24));
      newStart = { date: day, time: null, tz: null };
      newEnd = { date: shiftDay(day, spanDays), time: null, tz: null };
    } else {
      // all-day → timed: drop slot wall time; end = start + old span days.
      // F-A1-5: the wall time is BROWSER-local, so the component must carry
      // the browser's IANA zone (not the all-day master's null) or it
      // renders shifted by the UTC offset.
      const spanDays = Math.max(1, diffDays(curEnd.date, old.dtstart.date));
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      newStart = { date: day, time: (time || '09:00:00').slice(0, 8), tz };
      newEnd = { date: shiftDay(day, spanDays), time: (time || '09:00:00').slice(0, 8), tz };
    }
    const upd = {
      ...old,
      dtstamp: { date: new Date().toISOString().slice(0, 10), time: new Date().toISOString().slice(11, 19), tz: 'UTC' },
      dtstart: newStart,
      dtend: newEnd,
      duration: null,
      transp: toAllDay ? 'TRANSPARENT' : null,
      sequence: (old.sequence === null || old.sequence === undefined ? 0 : old.sequence) + 1,
      // F-A1-3/F-A1-6 (audit wave): the VALUE TYPE changes on conversion —
      // the parsed component's kept params (VALUE=DATE / TZID) would survive
      // the spread above and dtProp() prefers keptParams, emitting
      // DTSTART;VALUE=DATE:<datetime> (unparseable → corrupt row). Fresh
      // values must carry fresh params (dtProp's documented contract).
      dtstartParams: [],
      dtendParams: [],
      dtstampParams: [],
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

/* ---------------- task completion mutations (v4.5) ----------------
 * Fossify Calendar semantics on our RMW backbone: STATUS:COMPLETED on the
 * master completes a whole task; on a RECURRENCE-ID exception it completes
 * ONE occurrence of a repeating task (the RFC-native analogue of Fossify's
 * per-occurrence completed-tasks rows). Un-completing clears the STATUS
 * line (an open task carries no STATUS — Fossify's exporter does the same). */

/** Entry point from the event-block checkbox / popover / editor toggle. */
function toggleTaskCompletion(ev) {
  if (!state.api || state.busy) return;
  if (!ev.isTask) return;
  if (ev.isException) {
    // A completed occurrence un-completes ITSELF; an edited exception of a
    // repeating task also toggles just this occurrence.
    runTaskCompletionToggle(ev, 'exception');
    return;
  }
  if (ev.isRecurring) {
    openRecurringChoice(
      ev.isCompleted ? 'Mark recurring task incomplete' : 'Mark recurring task complete',
      (choice) => { runTaskCompletionToggle(ev, choice === 'exception' ? 'exception' : 'master'); },
      null
    );
    return;
  }
  runTaskCompletionToggle(ev, 'master');
}

async function runTaskCompletionToggle(ev, scope) {
  const wasCompleted = ev.isCompleted;
  try {
    setBusy(true, 'Saving…');
    await applyCompletionChange(ev, scope, !wasCompleted);
    toast('Task marked ' + (wasCompleted ? 'incomplete' : 'complete') + '.', 'ok', 2000);
  } catch (e) {
    toast('Update failed: ' + (e && e.message ? e.message : String(e)), 'err', 7000);
  } finally {
    setBusy(false);
  }
}

/** RMW: set/clear STATUS:COMPLETED on the master or on the occurrence's
 * exception component (creating it from the master when needed — the same
 * exception-creation pattern as applyDayShift). */
async function applyCompletionChange(ev, scope, completed) {
  const target = ev;
  const localRow = state.evt.get(target.rowId) || null;
  const now = { date: new Date().toISOString().slice(0, 10), time: new Date().toISOString().slice(11, 19), tz: 'UTC' };
  const res = await putRowRMW(target.rowId, (payload) => {
    let p;
    try { p = core.parseEvtPayload(payload); } catch { p = null; }
    if (!p) throw new Error('row_corrupt: refusing to rewrite a corrupt row');
    if (!p.isTask) throw new Error('not_a_task: this row is not a task');
    const events = p.calendar.events;
    const isException = scope === 'exception';
    const idx = isException
      ? events.findIndex((e) => e.recurrenceId && e.recurrenceId.date === target.recId.date &&
          (e.recurrenceId.time || '') === (target.recId.time || ''))
      : events.findIndex((e) => e.recurrenceId === null);
    if (isException && !target.recId) throw new Error('bad_scope: no occurrence id');
    let comp;
    if (idx >= 0) {
      comp = events[idx];
    } else {
      // Create the exception from the master occurrence (same shape as
      // applyDayShift's exception creation).
      comp = {
        type: 'VTODO',
        uid: p.uid,
        dtstamp: null,
        dtstart: target.component.dtstart,
        dtend: target.component.dtend,
        duration: null,
        recurrenceId: { date: target.recId.date, time: target.recId.time, tz: target.component.dtstart.tz },
        rrule: null,
        exdates: [],
        rdates: [],
        summary: target.component.summary || '',
        description: target.component.description || null,
        location: target.component.location || null,
        status: target.component.status && target.component.status !== 'COMPLETED' ? target.component.status : null,
        transp: null,
        sequence: null,
        alarms: target.component.alarms || [],
        extra: [],
      };
    }
    comp.dtstamp = now;
    comp.status = completed ? 'COMPLETED' : (comp.status === 'COMPLETED' ? null : comp.status);
    comp.sequence = (comp.sequence === null || comp.sequence === undefined ? 0 : comp.sequence) + 1;
    if (idx >= 0) events[idx] = comp;
    else events.push(comp);
    return serializeVCalendar(p.calendar);
  }, { allowCreate: false, local: localRow ? { ver: localRow.ver, payload: serializeEvtOf(localRow) } : null });
  applyRowLocally(target.rowId, res.ver, res.text);
  renderAll();
}

/* ---------------- recurring choice modal ---------------- */

function openRecurringChoice(title, choose, onCancel) {
  const modal = $('#recur-modal');
  const backdrop = $('#recur-backdrop');
  // Two close paths: choosing closes neutrally; dismissing without choosing
  // (Cancel button, Escape, backdrop click) is a CANCEL — drag/resize flows
  // pass onCancel to revert the chip (F-A1-1/F-A1-2; the same semantics are
  // now wired through the overlay stack so Escape/backdrop cannot strand a
  // dragged recurring chip at its drop target with no PUT).
  const closeChoose = () => closeModalSurface(modal, backdrop);
  const closeCancel = () => { closeModalSurface(modal, backdrop); if (onCancel) onCancel(); };
  const box = el('div');
  box.appendChild(el('h1', { text: title }));
  const btns = el('div', 'recur-choices');
  const bAll = el('button', 'button button-outline', { type: 'button', text: 'All events' });
  bAll.addEventListener('click', () => { closeChoose(); choose('all'); });
  const bOne = el('button', 'button button-outline', { type: 'button', text: 'This event' });
  bOne.addEventListener('click', () => { closeChoose(); choose('exception'); });
  const bCancel = el('button', 'button button-ghost', { type: 'button', text: 'Cancel' });
  // F-A1-1/F-A1-2 (audit wave): Cancel must NOT reach `choose` — the
  // backbone callers (beginDelete/beginEdit) treat their argument as a
  // SCOPE ('all'|'exception') and would execute destructive work for any
  // other string. Drag/resize flows pass onCancel to revert the chip.
  bCancel.addEventListener('click', closeCancel);
  btns.append(bAll, bOne, bCancel);
  box.appendChild(btns);
  modal.replaceChildren(box);
  openModalSurface(modal, backdrop, closeCancel);
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
      // A4: iterate BOTH the parsed rows AND the corrupt-flagged rows of this
      // calendar — corrupt evt rows live only in state.corrupt and were
      // silently leaked server-side before.
      const calRowIds = [...state.evt.keys()]
        .filter((id) => (core.parseEvtId(id) || {}).cal === uuid);
      const corruptRowIds = [...state.corrupt.keys()]
        .filter((id) => (core.parseEvtId(id) || {}).cal === uuid);
      const allRowIds = [...new Set([...calRowIds, ...corruptRowIds])];
      // E2-1: the event-row DELETEs run in PARALLEL (N+1 sequential round-trips
      // took 15–30 s for a 100-event calendar). The cmeta row is deleted LAST
      // and ONLY when every event delete succeeded — a partial failure then
      // leaves a smaller but fully usable calendar instead of orphaning rows
      // invisibly under a vanished calendar (other tabs would drop the
      // calendar from their sidebar while its events survive server-side).
      const results = await Promise.allSettled(allRowIds.map((id) => state.api.deleteRow(id)));
      const failed = [];
      results.forEach((r, i) => {
        const id = allRowIds[i];
        if (r.status === 'fulfilled') {
          state.evt.delete(id);
          state.corrupt.delete(id);
          state.dirty.delete(id);
          state.deletedLocally.set(id, ++state.mutGen); // A3
        } else {
          failed.push(r.reason);
        }
      });
      if (failed.length > 0) throw failed[0];
      await state.api.deleteRow(core.cmetaId(uuid));
      state.cals.delete(uuid);
      state.corrupt.delete(core.cmetaId(uuid));
      state.dirty.delete(core.cmetaId(uuid));
      state.deletedLocally.set(core.cmetaId(uuid), ++state.mutGen);
      calVisible.delete(uuid);
      calVis.delete(uuid);
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

/* ---------------- frequency display string ---------------- */

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

/* ---------------- settings modal (theme & customisation live here) ---------------- */

function openSettingsModal() {
  const modal = $('#settings-modal');
  const backdrop = $('#settings-backdrop');
  const close = () => closeModalSurface(modal, backdrop);
  const box = el('div', 'eventform settings-form');

  const head = el('div', 'modal-head');
  head.appendChild(el('h1', { text: 'Settings' }));
  const closeX = el('button', 'button button-ghost icon-only', { type: 'button', 'aria-label': 'Close', title: 'Close' });
  closeX.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round"/></svg>';
  closeX.addEventListener('click', close);
  head.appendChild(closeX);
  box.appendChild(head);

  const change = (fn) => {
    fn();
    saveSettings();
    applySettings();
    renderMiniCalendar();
  };

  /* ---- theme ---- */
  const themeRow = el('div', 'form-row');
  themeRow.appendChild(el('span', 'ic'));
  themeRow.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z" stroke-linejoin="round"/></svg>';
  const tb = el('div', 'form-row-body');
  tb.appendChild(el('label', { text: 'Theme' }));
  const themeSeg = el('div', 'settings-segment', { role: 'group', 'aria-label': 'Theme' });
  for (const t of ['light', 'dark', 'system']) {
    const b = el('button', 'settings-segment-button' + (settings.theme === t ? ' is-selected' : ''), {
      type: 'button', text: t.charAt(0).toUpperCase() + t.slice(1), 'aria-pressed': settings.theme === t ? 'true' : 'false',
    });
    b.addEventListener('click', () => {
      change(() => { settings.theme = t; });
      themeSeg.querySelectorAll('.settings-segment-button').forEach((x) => {
        const on = x.textContent.toLowerCase() === t;
        x.classList.toggle('is-selected', on);
        x.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    });
    themeSeg.appendChild(b);
  }
  tb.appendChild(themeSeg);
  themeRow.appendChild(tb);
  box.appendChild(themeRow);

  /* ---- calendar theme (the 7 official FullCalendar themes) ---- */
  const fcThemeRow = el('div', 'form-row');
  fcThemeRow.appendChild(el('span', 'ic'));
  fcThemeRow.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2" stroke-linecap="round"/></svg>';
  const fctb = el('div', 'form-row-body');
  fctb.appendChild(el('label', { text: 'Calendar theme', for: 'set-fctheme' }));
  const fcThemeSeg = el('div', 'settings-segment settings-segment-wrap', { role: 'group', 'aria-label': 'Calendar theme' });
  for (const id of FC_THEME_IDS) {
    const b = el('button', 'settings-segment-button' + (settings.fcTheme === id ? ' is-selected' : ''), {
      type: 'button', text: FC_THEMES[id].label, 'aria-pressed': settings.fcTheme === id ? 'true' : 'false',
    });
    b.addEventListener('click', () => {
      if (settings.fcTheme === id) return;
      const prevFlavor = flavorOf(settings.fcTheme);
      change(() => {
        settings.fcTheme = id;
        settings.fcPalette = defaultPaletteOf(id);
      });
      fcThemeSeg.querySelectorAll('.settings-segment-button').forEach((x) => {
        const on = x.textContent.toLowerCase() === FC_THEMES[id].label.toLowerCase();
        x.classList.toggle('is-selected', on);
        x.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      rebuildPaletteRow();
      // A flavor change swaps the theme PLUGIN — rebuild the Calendar.
      if (flavorOf(id) !== prevFlavor) applyFcTheme({ rebuild: true }).catch(() => {});
    });
    fcThemeSeg.appendChild(b);
  }
  fctb.appendChild(fcThemeSeg);
  fcThemeRow.appendChild(fctb);
  box.appendChild(fcThemeRow);

  /* ---- theme palette (per-theme official palettes; classic has none) ---- */
  const palRow = el('div', 'form-row');
  palRow.appendChild(el('span', 'ic'));
  palRow.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 2.5a5.5 5.5 0 1 1 0 11C6.2 13.5 6 11.8 7.2 11a1.6 1.6 0 0 0-1-2.9H5A2.5 2.5 0 0 1 8 2.5z" stroke-linejoin="round"/><circle cx="6" cy="6.5" r="0.4" fill="currentColor"/><circle cx="8" cy="5.2" r="0.4" fill="currentColor"/><circle cx="10" cy="6.5" r="0.4" fill="currentColor"/></svg>';
  const palBody = el('div', 'form-row-body');
  const palSel = el('select', null, { id: 'set-fcpalette', 'aria-label': 'Theme palette' });
  const rebuildPaletteRow = () => {
    const opts = FC_THEMES[settings.fcTheme].palettes;
    palSel.replaceChildren();
    for (const p of opts) {
      palSel.appendChild(el('option', null, { value: p, text: p.charAt(0).toUpperCase() + p.slice(1) }));
    }
    palSel.value = settings.fcPalette;
    palRow.hidden = opts.length === 0;
    palLabel.textContent = settings.fcTheme === 'shadcn' || settings.fcTheme === 'mui'
      ? 'Palette (app chrome)'
      : 'Palette';
  };
  const palLabel = el('label', { for: 'set-fcpalette' });
  palBody.appendChild(palLabel);
  palSel.addEventListener('change', () => change(() => { settings.fcPalette = palSel.value; }));
  palBody.appendChild(palSel);
  palRow.appendChild(palBody);
  box.appendChild(palRow);
  rebuildPaletteRow();

  /* ---- first day of week ---- */
  const fdRow = el('div', 'form-row');
  fdRow.appendChild(el('span', 'ic'));
  fdRow.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M5 2v2M11 2v2M2.5 7h11" stroke-linecap="round"/></svg>';
  const fdb = el('div', 'form-row-body');
  fdb.appendChild(el('label', { text: 'First day of week', for: 'set-firstday' }));
  const fdSel = el('select', null, { id: 'set-firstday', 'aria-label': 'First day of week' });
  for (const [v, label] of [[0, 'Sunday'], [1, 'Monday'], [6, 'Saturday']]) {
    fdSel.appendChild(el('option', null, { value: String(v), text: label }));
  }
  fdSel.value = String(settings.firstDay);
  fdSel.addEventListener('change', () => change(() => { settings.firstDay = Number(fdSel.value); }));
  fdb.appendChild(fdSel);
  fdRow.appendChild(fdb);
  box.appendChild(fdRow);

  /* ---- time format ---- */
  const tfRow = el('div', 'form-row');
  tfRow.appendChild(el('span', 'ic'));
  tfRow.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 2" stroke-linecap="round"/></svg>';
  const tfb = el('div', 'form-row-body');
  tfb.appendChild(el('label', { text: 'Time format', for: 'set-hour12' }));
  const tfSel = el('select', null, { id: 'set-hour12', 'aria-label': 'Time format' });
  tfSel.append(
    el('option', null, { value: '', text: 'Locale default' }),
    el('option', null, { value: '24', text: '24-hour' }),
    el('option', null, { value: '12', text: '12-hour (AM/PM)' }),
  );
  tfSel.value = settings.hour12 === null ? '' : (settings.hour12 ? '12' : '24');
  tfSel.addEventListener('change', () => {
    const v = tfSel.value;
    change(() => { settings.hour12 = v === '' ? null : v === '12'; });
  });
  tfb.appendChild(tfSel);
  tfRow.appendChild(tfb);
  box.appendChild(tfRow);

  /* ---- slot duration ---- */
  const sdRow = el('div', 'form-row');
  sdRow.appendChild(el('span', 'ic'));
  sdRow.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 4.5h10M3 8h10M3 11.5h5" stroke-linecap="round"/></svg>';
  const sdb = el('div', 'form-row-body');
  sdb.appendChild(el('label', { text: 'Time-grid slot', for: 'set-slot' }));
  const sdSel = el('select', null, { id: 'set-slot', 'aria-label': 'Time-grid slot' });
  for (const [v, label] of [['00:15:00', '15 minutes'], ['00:30:00', '30 minutes'], ['01:00:00', '1 hour']]) {
    sdSel.appendChild(el('option', null, { value: v, text: label }));
  }
  sdSel.value = settings.slotDuration;
  sdSel.addEventListener('change', () => change(() => { settings.slotDuration = sdSel.value; }));
  sdb.appendChild(sdSel);
  sdRow.appendChild(sdb);
  box.appendChild(sdRow);

  /* ---- custom view days ---- */
  const cdRow = el('div', 'form-row');
  cdRow.appendChild(el('span', 'ic'));
  cdRow.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="3.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="3.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>';
  const cdb = el('div', 'form-row-body');
  cdb.appendChild(el('label', { text: 'Custom view — days', for: 'set-customdays' }));
  const cdSel = el('select', null, { id: 'set-customdays', 'aria-label': 'Custom view days' });
  for (let n = 2; n <= 14; n++) cdSel.appendChild(el('option', null, { value: String(n), text: n + ' days' }));
  cdSel.value = String(settings.customDays);
  cdSel.addEventListener('change', () => change(() => { settings.customDays = Math.max(2, Math.min(14, Number(cdSel.value) || 5)); }));
  cdb.appendChild(cdSel);
  cdRow.appendChild(cdb);
  box.appendChild(cdRow);

  /* ---- week numbers + density (inline toggles) ---- */
  const togRow = el('div', 'form-row');
  togRow.appendChild(el('span', 'ic'));
  togRow.firstChild.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 8l3 3 7-7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const tgb = el('div', 'form-row-body');
  const wnChk = el('input', null, { type: 'checkbox', id: 'set-weeknumbers' });
  wnChk.checked = !!settings.weekNumbers;
  const wnLbl = el('label', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:8px;' });
  wnLbl.append(wnChk, document.createTextNode('Show week numbers'));
  wnChk.addEventListener('change', () => change(() => { settings.weekNumbers = wnChk.checked; }));
  tgb.appendChild(wnLbl);

  tgb.appendChild(el('label', { text: 'Density', for: 'set-density' }));
  const dnSel = el('select', null, { id: 'set-density', 'aria-label': 'Density' });
  dnSel.append(
    el('option', null, { value: 'comfortable', text: 'Comfortable' }),
    el('option', null, { value: 'compact', text: 'Compact' }),
  );
  dnSel.value = settings.density;
  dnSel.addEventListener('change', () => change(() => { settings.density = dnSel.value; }));
  tgb.appendChild(dnSel);

  // sec-S5-F4: idle auto-lock toggle (on by default; 15 min inactivity).
  const alChk = el('input', null, { type: 'checkbox', id: 'set-autolock' });
  alChk.checked = settings.autoLock !== false;
  const alLbl = el('label', { style: 'display:flex;align-items:center;gap:6px;margin-top:8px;' });
  alLbl.append(alChk, document.createTextNode('Auto-lock after 15 minutes idle'));
  alChk.addEventListener('change', () =>
    change(() => {
      settings.autoLock = alChk.checked;
      if (!alChk.checked) disarmAutoLock();
      else if (state.api) armAutoLock();
    }));
  tgb.appendChild(alLbl);
  togRow.appendChild(tgb);
  box.appendChild(togRow);

  const footer = el('div', 'modal-footer');
  const done = el('button', 'button button-primary', { type: 'button', text: 'Done' });
  done.addEventListener('click', close);
  const reset = el('button', 'button button-ghost left', { type: 'button', text: 'Reset to defaults' });
  reset.addEventListener('click', () => {
    settings = { ...SETTINGS_DEFAULTS };
    saveSettings();
    // F-A5-2 (audit wave): the persisted FC view key would otherwise
    // override the reset view on the next boot — write the default (the
    // changeView below re-persists it via viewDidMount anyway).
    safeSetItem(LS_VIEW, SETTINGS_DEFAULTS.view);
    state.view = settings.view;
    if (fcCal && fcCal.view.type !== settings.view) fcCal.changeView(settings.view);
    applySettings();
    close();
    toast('Settings reset to defaults.', 'ok', 2000);
  });
  footer.append(reset, done);
  box.appendChild(footer);

  modal.replaceChildren(box);
  openModalSurface(modal, backdrop, close);
}

/* ---------------- UI wiring ---------------- */

function refreshLoginUi() {
  // S2: only a WELL-FORMED stored code counts as provisioned — a malformed
  // value (garbage/typo) keeps the paste-row visible so recovery is obvious.
  const raw = localStorage.getItem(LS_TOKEN);
  const has = !!raw && /^[0-9a-f]{64}$/.test(raw);
  $('#setup-row').hidden = has;
  $('#lock-note').hidden = has;
  const srv = serverUrl();
  $('#server').value = srv;
  // sec-S5-F1 residue: a browser whose LS_SERVER was poisoned by a crafted
  // link BEFORE the loopback restriction keeps pointing at the attacker's
  // server (the restriction only blocks NEW URL-based repointing). Loudly
  // flag any non-default, non-loopback stored server before unlock.
  let note = document.getElementById('server-note');
  if (!note) {
    note = el('p', 'hint');
    note.id = 'server-note';
    $('#server').after(note);
  }
  const foreign = srv !== DEFAULT_SERVER_URL && !isLoopbackServer(srv);
  note.hidden = !foreign;
  note.textContent = foreign
    ? 'Heads-up: this browser is set to a NON-DEFAULT server (' + srv + '). Verify you trust it before unlocking — the API token is sent there.'
    : '';
}

function bind() {
  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    unlock();
  });
  $('#btn-lock').addEventListener('click', lock);
  $('#btn-forget').addEventListener('click', forgetBrowser);
  $('#btn-settings').addEventListener('click', openSettingsModal);
  $('#btn-sync').addEventListener('click', () => {
    if (state.busy || !state.api) return;
    syncAll().catch((e) => toast('Sync failed: ' + (e && e.message ? e.message : String(e)), 'err'));
  });
  $('#minical-prev').addEventListener('click', () => {
    if (!fcCal) return;
    const d = fcCal.getDate();
    fcCal.gotoDate(new Date(d.getFullYear(), d.getMonth() - 1, d.getDate()));
    renderMiniCalendar();
  });
  $('#minical-next').addEventListener('click', () => {
    if (!fcCal) return;
    const d = fcCal.getDate();
    fcCal.gotoDate(new Date(d.getFullYear(), d.getMonth() + 1, d.getDate()));
    renderMiniCalendar();
  });
  // New event / New task (Fossify MainActivity's split): the caret opens a
  // small menu; the button body stays "New event".
  $('#btn-new-event').addEventListener('click', () => {
    if (!state.api || state.busy) return;
    if (state.cals.size === 0) { openCalendarModal(null); return; }
    beginCreate(null);
  });
  const newTaskMenu = () => {
    const old = document.getElementById('new-task-menu');
    if (old) { old.remove(); return; }
    const menu = el('div', 'item-menu new-task-menu');
    menu.id = 'new-task-menu';
    const evt = el('button', { type: 'button', text: 'New event' });
    evt.addEventListener('click', () => { menu.remove(); $('#btn-new-event').click(); });
    const tsk = el('button', { type: 'button', text: 'New task' });
    tsk.addEventListener('click', () => {
      menu.remove();
      if (!state.api || state.busy) return;
      if (state.cals.size === 0) { openCalendarModal(null); return; }
      beginCreateTask();
    });
    menu.append(evt, tsk);
    const anchor = $('#btn-new-task');
    const r = anchor.getBoundingClientRect();
    menu.style.top = r.bottom + 4 + 'px';
    menu.style.left = Math.min(r.left, window.innerWidth - 170) + 'px';
    document.body.appendChild(menu);
    setTimeout(() => {
      const closer = (ev) => {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', closer, true); }
      };
      document.addEventListener('mousedown', closer, true);
    }, 0);
  };
  $('#btn-new-task').addEventListener('click', (e) => {
    e.stopPropagation();
    newTaskMenu();
  });
  $('#btn-add-calendar').addEventListener('click', () => openCalendarModal(null));

  $('#popover-backdrop').addEventListener('click', closePopover);
  $('#editor-backdrop').addEventListener('click', () => {
    const modal = $('#editor-modal');
    if (!modal.hidden) closeModalSurface(modal, $('#editor-backdrop'));
  });
  $('#recur-backdrop').addEventListener('click', () => {
    const modal = $('#recur-modal');
    if (modal.hidden) return;
    // Route through the overlay stack's registered close: for the recurring
    // choice modal that is the CANCEL path (reverts a dragged chip). Falls
    // back to a plain close if the entry is somehow missing.
    const entry = overlayStack.find((o) => o.node === modal);
    if (entry) entry.close();
    else closeModalSurface(modal, $('#recur-backdrop'));
  });
  $('#cal-backdrop').addEventListener('click', () => {
    const modal = $('#cal-modal');
    if (!modal.hidden) closeModalSurface(modal, $('#cal-backdrop'));
  });
  $('#freq-backdrop').addEventListener('click', () => {
    const modal = $('#freq-modal');
    if (!modal.hidden) closeModalSurface(modal, $('#freq-backdrop'));
  });
  $('#settings-backdrop').addEventListener('click', () => {
    const modal = $('#settings-modal');
    if (!modal.hidden) closeModalSurface(modal, $('#settings-backdrop'));
  });

  // Keyboard: Escape closes the topmost overlay; n/t/arrows navigate;
  // d/w/m/y/v switch views (Proton keyboard shortcuts). B13: no shortcuts
  // while an overlay (modal/popover) is open — except Escape.
  document.addEventListener('keydown', (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === 'Escape') {
      if (closeTopOverlay()) e.preventDefault();
      return;
    }
    if (inField || state.busy || !state.api || $('#app').hidden) return;
    if (overlayStack.length > 0) return; // B13
    if (e.key === 'n') { e.preventDefault(); $('#btn-new-event').click(); }
    else if (e.key === 't') { e.preventDefault(); if (fcCal) { fcCal.today(); renderMiniCalendar(); } }
    else if (e.key === 'd') { e.preventDefault(); setView('timeGridDay'); }
    else if (e.key === 'w') { e.preventDefault(); setView('timeGridWeek'); }
    else if (e.key === 'm') { e.preventDefault(); setView('dayGridMonth'); }
    else if (e.key === 'y') { e.preventDefault(); setView('multiMonthYear'); }
    else if (e.key === 'v') { e.preventDefault(); setView('custom'); }
    else if (e.key === 'a') { e.preventDefault(); setView('listYear'); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (fcCal) { fcCal.prev(); renderMiniCalendar(); } }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (fcCal) { fcCal.next(); renderMiniCalendar(); } }
  });

  // FullCalendar handles its own container-resize re-rendering (v6
  // ResizeObserver) — no manual window-resize handler is needed.

  $('#btn-paste-setup').addEventListener('click', () => {
    const v = $('#setup-input').value.trim();
    if (/^[0-9a-f]{64}$/.test(v)) {
      safeSetItem(LS_TOKEN, v);
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
  // A15: focus and visibilitychange fire together on tab switches — debounce
  // so a refocus never triggers two back-to-back syncs.
  let lastAutosyncAt = 0;
  const maybeAutosync = () => {
    const now = Date.now();
    if (now - lastAutosyncAt < 5000) return; // A15 debounce
    lastAutosyncAt = now;
    autosync();
  };
  setInterval(() => {
    if (document.hidden) return;
    autosync();
  }, AUTOSYNC_MS);
  window.addEventListener('focus', maybeAutosync);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) maybeAutosync();
  });

  // Day rollover: refresh the today markers + events (the now-indicator
  // updates itself between renders).
  setInterval(() => {
    const today = core.localToday();
    if (state.api && today !== state.today) {
      state.today = today;
      renderAll();
    }
  }, 60000);

  // sec-S5-F4 — idle auto-lock listeners (the machinery lives at module
  // scope; unlock arms, lock disarms, activity re-arms).
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(ev, noteUserActivity, { passive: true });
  }
  if (isLoopbackHost()) {
    window.__autolockForce = () => {
      disarmAutoLock();
      if (state.api && !state.busy) {
        lock();
        toast('Auto-locked (forced).', 'ok', 4000);
      }
    };
  }

  // 'system' theme: follow the OS preference live.
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => { if (settings.theme === 'system') applyTheme(); };
  if (mq.addEventListener) mq.addEventListener('change', onScheme);
  else if (mq.addListener) mq.addListener(onScheme); // old Safari
}

/* ---------------- boot ---------------- */

function boot() {
  loadSettings();
  ingestParams();
  refreshLoginUi();
  state.today = core.localToday();
  state.view = VIEWS.includes(settings.view) ? settings.view : 'dayGridMonth';
  try {
    const v = localStorage.getItem(LS_VIEW);
    if (v && VIEWS.includes(v)) state.view = v;
  } catch { /* ignore */ }
  bind();
  applySettings({ fc: false }); // theme assets/density before first paint
}

boot();
