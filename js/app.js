/**
 * app.js — web client orchestration for the Calendar PoC (protocol v4.1 §13).
 *
 * Flow: provisioning (setup link, WORKLOG D4) -> unlock (§3 derivation) ->
 * window rotation (create/DELETE the 23 live buckets) -> render/edit via RMW
 * with rebase (§9). The clock does not exist in this PoC; its §13 reader
 * behaviour is represented by the read-only "Clock preview" panel.
 */
import { deriveKeys, importRowKey, encryptRow, decryptRow } from './crypto.js';
import { Api, ApiError } from './api.js';
import * as core from './calendar-core.js';

const DEFAULT_SERVER_URL = 'https://calendar-poc.sh-clock.workers.dev';
const LS_TOKEN = 'clock_poc_auth_ui';
const LS_SERVER = 'clock_poc_server';
const REBASE_MAX = 8;

const state = {
  api: null,
  rowKey: null,
  eventsByDay: new Map(), // dateStr -> events[] (null = corrupt bucket, flagged in UI)
  today: null,
  viewYM: null, // 'YYYY-MM'
  busy: false,
};

/* ---------------- tiny DOM helpers ---------------- */

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toast(msg, kind = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function setBusy(busy, msg) {
  state.busy = busy;
  const bar = $('#syncbar');
  bar.hidden = !busy;
  if (busy) $('#syncmsg').textContent = msg || 'Working…';
}

/* ---------------- provisioning & boot (WORKLOG D4) ---------------- */

function serverUrl() {
  return localStorage.getItem(LS_SERVER) || DEFAULT_SERVER_URL;
}

function ingestParams() {
  // The setup code may arrive as a URL query OR as a #fragment — the fragment
  // form is never transmitted to the static host (keeps the token out of
  // CDN/access logs; WORKLOG D6 note).
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
    const cfg = await probe.getConfig(); // silent 404 => bad token / not bootstrapped
    const { aes1, kData, authUiHex } = await deriveKeys(password, cfg.salt, cfg.iters, cfg.wrapped);
    if (authUiHex !== token) {
      // The stored token authenticates but does not match HKDF(AES1): surface
      // it loudly and continue with the DERIVED token (§3: AUTH_UI is derived).
      toast('Warning: stored provisioning code does not match the derived AUTH_UI. Using derived token.', 'warn', 8000);
    }
    state.api = new Api(url, authUiHex);
    state.rowKey = await importRowKey(kData);
    // §3 ledger: the client caches K_data + AUTH_UI only — AES1 itself is
    // dropped after derivation (never retained in app state).
    const ver = await state.api.getVersion();
    $('#proto-badge').textContent = 'protocol ' + ver.proto;
    state.viewYM = core.localToday().slice(0, 7);
    await syncWindow();
    $('#password').value = ''; // do not keep the password in the DOM after unlock
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
  state.api = null;
  state.rowKey = null;
  state.eventsByDay.clear();
  state.today = null;
  editingDay = null;
  $('#password').value = '';
  closeModal();
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#btn-sync').hidden = true;
  $('#btn-lock').hidden = true;
  $('#btn-forget').hidden = true;
}

function forgetBrowser() {
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_SERVER);
  lock();
  refreshLoginUi();
  toast('Provisioning code forgotten on this browser.', 'ok');
}

/* ---------------- sliding-window rotation (§13) ---------------- */

async function syncWindow() {
  const today = core.localToday();
  state.today = today;
  const target = core.windowDays(today);
  const targetSet = new Set(target);

  setBusy(true, 'Syncing the 23-bucket window…');
  const errors = [];
  try {
    const manifest = await state.api.getManifest();
    const calRows = manifest.rows.filter((r) => core.parseBucketId(r.id));
    const have = new Set(calRows.map((r) => core.parseBucketId(r.id)));

    // DELETE buckets that slid out of the window (§13 rotation).
    for (const r of calRows) {
      const day = core.parseBucketId(r.id);
      if (!targetSet.has(day)) {
        try {
          await state.api.deleteRow(r.id);
        } catch {
          errors.push('delete ' + r.id);
        }
      }
    }

    // CREATE buckets that slide in (§13 rotation) — empty unless they exist.
    for (const day of target) {
      if (!have.has(day)) {
        try {
          const id = core.bucketId(day);
          const enc = await encryptRow(state.rowKey, id, 1, { events: [] });
          // A concurrent writer may have created it first; the server then
          // returns the stored envelope — harmless (no data loss possible).
          await state.api.putRow(id, { ver: 1, ...enc });
        } catch {
          errors.push('create ' + day);
        }
      }
    }

    // Load + decrypt every live bucket into LOCAL maps and swap on success —
    // a mid-sync failure must never leave a wiped cache behind (rows are truth).
    const oldEvents = state.eventsByDay;
    const newEvents = new Map();
    for (const day of target) {
      const id = core.bucketId(day);
      try {
        const env = await state.api.getRow(id);
        if (!env) continue; // raced delete; retried next sync
        try {
          const payload = await decryptRow(state.rowKey, id, env.ver, env.nonce, env.ct);
          const bucket = core.normalizeBucket(payload);
          // null = corrupt/tampered bucket: flagged in the UI, NEVER rewritten.
          newEvents.set(day, bucket ? bucket.events : null);
        } catch {
          newEvents.set(day, null); // AEAD failure: flagged, never rewritten
        }
      } catch {
        errors.push('load ' + day);
        if (oldEvents.has(day)) newEvents.set(day, oldEvents.get(day)); // keep the last decrypted view
      }
    }
    state.eventsByDay = newEvents;
    renderAll();
    if (errors.length > 0) {
      toast(`Sync incomplete: ${errors.length} operation(s) failed — retry with Sync.`, 'warn', 7000);
    }
  } finally {
    setBusy(false);
  }
}

/* ---------------- RMW write path (§9 + WORKLOG D14) ---------------- */

/**
 * Read-modify-write a day bucket with automatic rebase: on a lost RMW race the
 * server returns the CURRENT stored envelope (200); acceptance is detected by
 * envelope identity (nonce echo), the change is re-applied onto the fresh
 * state and resubmitted with ver = stored.ver + 1.
 */
async function writeBucket(day, mutate) {
  const id = core.bucketId(day);
  for (let attempt = 0; attempt < REBASE_MAX; attempt++) {
    const env = await state.api.getRow(id);
    const ver = env ? env.ver : 0;
    let events;
    if (env) {
      const payload = await decryptRow(state.rowKey, id, env.ver, env.nonce, env.ct);
      const bucket = core.normalizeBucket(payload);
      if (!bucket) throw new Error('bucket_corrupt: refusing to rewrite a corrupt bucket');
      events = bucket.events;
    } else {
      events = [];
    }

    const change = mutate(events); // pure: re-applied on each rebase attempt
    const capped = core.capEvents(change.events, core.WRITER_PREFIX, core.CAP_PER_BUCKET);

    const newVer = ver + 1;
    const enc = await encryptRow(state.rowKey, id, newVer, { events: capped.events });
    const submitted = { ver: newVer, nonce: enc.nonce, ct: enc.ct };
    const stored = await state.api.putRow(id, submitted);

    if (stored.ver === submitted.ver && stored.nonce === submitted.nonce && stored.ct === submitted.ct) {
      state.eventsByDay.set(day, capped.events);
      renderAll();
      return { ok: true, dropped: capped.dropped.length }; // cap drops surfaced ONCE, by the caller
    }
    // else: server returned the current envelope — loop re-reads and re-applies.
  }
  throw new Error('rebase_exhausted: bucket kept changing across ' + REBASE_MAX + ' attempts');
}

/* ---------------- rendering ---------------- */

function renderAll() {
  renderMonth();
  renderClockPreview();
}

function monthDays(ym) {
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= n; d++) out.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  return { days: out, firstDow: (first.getUTCDay() + 6) % 7 }; // Monday = 0
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function inWindow(dateStr) {
  return core.windowDays(state.today).includes(dateStr);
}

function renderMonth() {
  const grid = $('#grid');
  grid.innerHTML = '';
  const { days, firstDow } = monthDays(state.viewYM);
  $('#month-label').textContent =
    MONTHS[Number(state.viewYM.slice(5)) - 1] + ' ' + state.viewYM.slice(0, 4);

  const head = document.createElement('div');
  head.className = 'grid-head';
  for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
    const c = document.createElement('div');
    c.textContent = d;
    head.appendChild(c);
  }
  grid.appendChild(head);

  const row = document.createElement('div');
  row.className = 'grid-body';
  for (let i = 0; i < firstDow; i++) row.appendChild(document.createElement('div'));

  for (const day of days) {
    const cell = document.createElement('div');
    cell.className = 'day' + (day === state.today ? ' today' : '') + (inWindow(day) ? '' : ' muted');
    const events = state.eventsByDay.get(day);
    const corrupt = events === null;
    const shown = corrupt ? [] : core.sortEvents(events || []);
    const num = document.createElement('div');
    num.className = 'daynum';
    num.textContent = Number(day.slice(8));
    cell.appendChild(num);
    if (corrupt) {
      const b = document.createElement('div');
      b.className = 'chip err';
      b.textContent = 'decrypt error';
      cell.appendChild(b);
    } else {
      for (const ev of shown.slice(0, 3)) {
        const b = document.createElement('div');
        b.className = 'chip p' + Math.min(ev.priority, 3) + (core.eventPrefix(ev) === 'w' ? '' : ' ext');
        b.textContent = `${String(ev.hh).padStart(2, '0')}:${String(ev.mm).padStart(2, '0')} ${ev.title}`;
        cell.appendChild(b);
      }
      if (shown.length > 3) {
        const b = document.createElement('div');
        b.className = 'chip more';
        b.textContent = '+' + (shown.length - 3) + ' more';
        cell.appendChild(b);
      }
    }
    cell.addEventListener('click', () => openDay(day));
    row.appendChild(cell);
  }
  grid.appendChild(row);
}

function renderClockPreview() {
  const panel = $('#clock-list');
  panel.innerHTML = '';
  for (const day of core.clockPreviewDays(state.today)) {
    const events = state.eventsByDay.get(day);
    const item = document.createElement('div');
    item.className = 'clock-item' + (day === state.today ? ' today' : '');
    const label = document.createElement('div');
    label.className = 'clock-date';
    label.textContent = day === state.today ? day + ' (today)' : day;
    item.appendChild(label);
    if (events === null) {
      const e = document.createElement('div');
      e.className = 'clock-ev err';
      e.textContent = 'decrypt error';
      item.appendChild(e);
    } else {
      const list = core.sortEvents(events || []);
      if (list.length === 0) {
        const e = document.createElement('div');
        e.className = 'clock-ev none';
        e.textContent = '—';
        item.appendChild(e);
      } else {
        for (const ev of list) {
          const e = document.createElement('div');
          e.className = 'clock-ev';
          e.textContent = `${String(ev.hh).padStart(2, '0')}:${String(ev.mm).padStart(2, '0')} — ${ev.title} [p${ev.priority}]`;
          item.appendChild(e);
        }
      }
    }
    panel.appendChild(item);
  }
}

/* ---------------- day editor ---------------- */

let editingDay = null;

function openModal() {
  $('#modal').hidden = false;
  $('#modal-backdrop').hidden = false;
}

function closeModal() {
  $('#modal').hidden = true;
  $('#modal-backdrop').hidden = true;
}

function openDay(day) {
  editingDay = day;
  const events = state.eventsByDay.get(day);
  const list = $('#day-events');
  list.innerHTML = '';
  $('#day-title').textContent = day + (day === state.today ? ' — today' : '');

  if (!inWindow(day)) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = 'This day is outside the 23-bucket sync window [today-1 .. today+21].';
    list.appendChild(note);
    $('#day-form').hidden = true;
    openModal();
    return;
  }
  $('#day-form').hidden = false;

  if (events === null) {
    const note = document.createElement('p');
    note.className = 'note err';
    note.textContent = 'Bucket failed to decrypt (corrupt or tampered). Editing is disabled.';
    list.appendChild(note);
    $('#day-form').hidden = true;
    openModal();
    return;
  }

  for (const ev of core.sortEvents(events || [])) {
    const own = core.eventPrefix(ev) === core.WRITER_PREFIX;
    const row = document.createElement('div');
    row.className = 'ev-row';
    const main = document.createElement('div');
    main.className = 'ev-main';
    main.textContent = `${String(ev.hh).padStart(2, '0')}:${String(ev.mm).padStart(2, '0')} — ${ev.title} [p${ev.priority}]`;
    row.appendChild(main);
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = core.writerLabel(core.eventPrefix(ev));
    row.appendChild(badge);
    if (own) {
      const btnE = document.createElement('button');
      btnE.textContent = 'Edit';
      btnE.addEventListener('click', () => fillForm(ev));
      const btnD = document.createElement('button');
      btnD.className = 'danger';
      btnD.textContent = 'Delete';
      btnD.addEventListener('click', () => deleteOwnEvent(day, ev.id));
      row.appendChild(btnE);
      row.appendChild(btnD);
    } else {
      const ro = document.createElement('span');
      ro.className = 'ro';
      ro.textContent = 'read-only';
      row.appendChild(ro);
    }
    list.appendChild(row);
  }
  clearForm();
  openModal();
}

function fillForm(ev) {
  $('#ev-time').value = `${String(ev.hh).padStart(2, '0')}:${String(ev.mm).padStart(2, '0')}`;
  $('#ev-title').value = ev.title;
  $('#ev-pri').value = String(ev.priority);
  $('#ev-id').value = ev.id; // editing keeps the id (ownership is immutable, §13)
}

function clearForm() {
  $('#ev-time').value = '09:00';
  $('#ev-title').value = '';
  $('#ev-pri').value = '1';
  $('#ev-id').value = '';
}

async function saveForm() {
  if (state.busy || !editingDay) return;
  const day = editingDay;
  const time = $('#ev-time').value;
  const title = $('#ev-title').value.trim();
  const priority = Number($('#ev-pri').value);
  const existingId = $('#ev-id').value;
  if (!/^\d{2}:\d{2}$/.test(time) || !title || title.length > 500) {
    toast('Time and title are required (title <= 500 chars).', 'err');
    return;
  }
  const [hh, mm] = time.split(':').map(Number);
  const fields = { date: day, hh, mm, title, priority };
  try {
    setBusy(true, 'Writing bucket (RMW)…');
    const ev = existingId
      ? core.validateEvent({ id: existingId, ...fields })
      : core.makeEvent(fields);
    if (!ev) throw new Error('invalid_event');
    const res = await writeBucket(day, (events) => ({
      events: core.applyEvent(events, ev, core.WRITER_PREFIX),
    }));
    if (res.dropped > 0) {
      toast(`Bucket cap (16/day): dropped ${res.dropped} of YOUR lowest-priority events.`, 'warn', 7000);
    }
    toast('Saved.', 'ok', 2000);
    openDay(day);
  } catch (e) {
    toast('Save failed: ' + (e && e.message ? e.message : String(e)), 'err', 7000);
  } finally {
    setBusy(false);
  }
}

async function deleteOwnEvent(day, id) {
  if (state.busy) return;
  try {
    setBusy(true, 'Deleting event (RMW)…');
    await writeBucket(day, (events) => ({
      events: core.removeEvent(events, id, core.WRITER_PREFIX).events,
    }));
    toast('Deleted.', 'ok', 2000);
    openDay(day);
  } catch (e) {
    toast('Delete failed: ' + (e && e.message ? e.message : String(e)), 'err', 7000);
  } finally {
    setBusy(false);
  }
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
    syncWindow().catch((e) => toast('Sync failed: ' + (e && e.message ? e.message : String(e)), 'err'));
  });
  $('#btn-prev').addEventListener('click', () => navMonth(-1));
  $('#btn-next').addEventListener('click', () => navMonth(1));
  $('#btn-today').addEventListener('click', () => {
    state.viewYM = core.localToday().slice(0, 7);
    renderAll();
  });
  $('#btn-close-modal').addEventListener('click', closeModal);
  $('#modal-backdrop').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
  $('#day-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveForm();
  });
  $('#btn-clear-form').addEventListener('click', clearForm);
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
}

function navMonth(delta) {
  const [y, m] = state.viewYM.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  state.viewYM = d.toISOString().slice(0, 7);
  renderAll();
}

function boot() {
  ingestParams();
  refreshLoginUi();
  state.viewYM = core.localToday().slice(0, 7);
  bind();
}

boot();
