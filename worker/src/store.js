/**
 * Store — Durable Object (SQLite-backed) implementing the calendar slice of
 * PROTOCOL v4.1 (Encrypted Clock Ecosystem wire specification, 2026-10-19).
 *
 * Scope (per user order, see WORKLOG.MD D1): calendar feature only. Photos
 * (§15–§18) and todos (§14) are NOT implemented; /status reports
 * photo_pending = |staged|, which is always 0 without the photo domain.
 *
 * Implemented sections: §2 constants, §4 auth + silent drop, §5 encoding and
 * error policy, §6 row envelope (server side: opaque storage + ver RMW),
 * §7 storage schema, §8 bootstrap/config/rewrap, §9 row sync (GET/PUT/DELETE),
 * §10 status, §19 backup (calendar scope), §22 versioning.
 *
 * The server is an untrusted relay (L1): it stores and returns envelopes
 * verbatim, compares only the clear `ver`, and never reads `nonce`/`ct`.
 */

const PROTO_VERSION = '4.1';                       // §22
const KDF_ITERS = 100000;                          // §2
const ROW_CT_MAX = 65536;                          // §2 — ciphertext incl. tag
const VER_U32_MAX = 4294967295;                    // §2 VER_WIDTH (u32)
const WRAPPED_LEN = 60;                            // WORKLOG D2: 12 nonce || 32 ct || 16 tag
const NONCE_LEN = 12;                              // §2 GCM_NONCE_LEN
const ID_MAX = 256;                                // WORKLOG D9
const BODY_MAX = 1048576;                          // hygiene cap on request bodies (WORKLOG D16)
const BODY_DRAIN_MAX = 32 * 1048576;               // drain ceiling for rejected oversized bodies
const BACKUP_RETENTION_DAYS = 7;                   // §2
const STAGING_MAX_AGE_S = 14 * 86400;              // §2 STAGING_MAX_AGE

const HEX64_RE = /^[0-9a-f]{64}$/;                 // §5: hex fields are lowercase
const HEX32_RE = /^[0-9a-f]{32}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/* ------------------------------------------------------------------ */
/* Encoding helpers (chunk-safe for 64KiB payloads)                     */
/* ------------------------------------------------------------------ */

function b64Encode(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
  }
  return btoa(s);
}

/** Strict base64 (standard alphabet, padded, CANONICAL — §5). Returns null on any violation. */
function b64Decode(str) {
  if (typeof str !== 'string' || str.length === 0 || str.length % 4 !== 0) return null;
  if (!B64_RE.test(str)) return null;
  const pad = str.indexOf('=');
  if (pad !== -1 && pad < str.length - 2) return null;
  let bin;
  try { bin = atob(str); } catch { return null; }
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  // Canonicality: atob silently discards non-zero trailing padding bits, so
  // e.g. "QR==" decodes identically to "QQ==". Storing such input and echoing
  // it back in canonical form would break the client's envelope-identity
  // acceptance check (WORKLOG D14). Reject non-canonical base64 instead.
  if (b64Encode(u8) !== str) return null;
  return u8;
}

/** Strict lowercase hex decode of exactly `len` bytes. Returns null on violation. */
function hexDecode(str, len) {
  if (typeof str !== 'string' || str.length !== len * 2) return null;
  const re = len === 32 ? HEX64_RE : HEX32_RE;
  if (!re.test(str)) return null;
  const u8 = new Uint8Array(len);
  for (let i = 0; i < len; i++) u8[i] = parseInt(str.slice(i * 2, i * 2 + 2), 16);
  return u8;
}

/** Normalise a SQLite BLOB cell to Uint8Array (handles ArrayBuffer/Uint8Array). */
function toU8(v) {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v);
  return null;
}

/** Constant-time compare over equal-length buffers (§4). */
function ctEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/* ------------------------------------------------------------------ */
/* Responses (§5 policy)                                                */
/* ------------------------------------------------------------------ */

/** L3 silent drop: empty 404, no body, no WWW-Authenticate, no cache headers. */
function silentDrop() {
  return new Response(null, { status: 404 });
}

/** §5 capability violation (e.g. clock writing rows): 403, empty body. */
function forbidden() {
  return new Response(null, { status: 403 });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function badRequest(msg) {
  return json({ error: msg }, 400);
}

/* ------------------------------------------------------------------ */
/* Bounded request body reading                                         */
/* ------------------------------------------------------------------ */

async function readBodyBounded(req) {
  if (!req.body) return new Uint8Array(0);
  // Read the stream to COMPLETION (draining beyond BODY_MAX): returning a 400
  // while the client is still sending would make workerd tear down the
  // connection, so the client would see a network error instead of the 400.
  // Beyond BODY_DRAIN_MAX (pathological abuse) we stop reading and let the
  // connection reset — acceptable for that class of client.
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  let overflow = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_DRAIN_MAX) return null;
    if (total <= BODY_MAX) chunks.push(value);
    else overflow = true;
  }
  if (overflow) return null;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/** Parse the request body as UTF-8 JSON (§5). err is a short 400 error string. */
async function readJson(req) {
  const body = await readBodyBounded(req);
  if (!body) return { err: 'too_large' };
  if (body.length === 0) return { err: 'bad_json' };
  try {
    return { val: JSON.parse(new TextDecoder().decode(body)) };
  } catch {
    return { err: 'bad_json' };
  }
}

/* ------------------------------------------------------------------ */
/* The Durable Object                                                   */
/* ------------------------------------------------------------------ */

export class Store {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this._schema = null;
  }

  /** §7 schema — created lazily, once per isolate (with transient-failure retry). */
  async ensureSchema() {
    if (!this._schema) {
      const init = (async () => {
        const sql = this.ctx.storage.sql;
        sql.exec(
          'CREATE TABLE IF NOT EXISTS rows (' +
            'id TEXT PRIMARY KEY, ver INTEGER NOT NULL, nonce BLOB NOT NULL, ct BLOB NOT NULL, ' +
            'updated_at INTEGER NOT NULL)'
        );
        sql.exec(
          'CREATE TABLE IF NOT EXISTS config (' +
            'k INTEGER PRIMARY KEY CHECK (k = 1), salt TEXT NOT NULL, iters INTEGER NOT NULL, ' +
            'wrapped BLOB NOT NULL, auth_ui TEXT NOT NULL, auth_clock TEXT NOT NULL, ' +
            'ver INTEGER NOT NULL, updated_at INTEGER NOT NULL)'
        );
        sql.exec(
          'CREATE TABLE IF NOT EXISTS staged (uid TEXT PRIMARY KEY, first_seen INTEGER NOT NULL)'
        );
      })();
      // Do not pin a rejected promise: a transient SQLite failure must not
      // poison the isolate for every subsequent request.
      init.catch(() => {
        this._schema = null;
      });
      this._schema = init;
    }
    return this._schema;
  }

  async fetch(req) {
    try {
      await this.ensureSchema();
      return await this.route(req);
    } catch (e) {
      // Log the exception message only (never payload/key material — §3).
      console.error('store error: ' + (e && e.message ? e.message : String(e)));
      return json({ error: 'internal' }, 500);
    }
  }

  /** Reads the config singleton (or null if not bootstrapped). */
  async getConfig() {
    const cur = this.ctx.storage.sql
      .exec('SELECT salt, iters, wrapped, auth_ui, auth_clock, ver FROM config WHERE k = 1')
      .toArray();
    if (cur.length === 0) return null;
    const r = cur[0];
    return {
      salt: r.salt,
      iters: r.iters,
      wrapped: toU8(r.wrapped),
      auth_ui: r.auth_ui,
      auth_clock: r.auth_clock,
      ver: r.ver,
    };
  }

  /**
   * §4/§5 routing + bearer gate.
   *
   * Route families (WORKLOG D15):
   *  - admin routes    (/bootstrap, /bootstrap/rewrap): only ADMIN_SECRET; anything
   *    else is "wrong-secret /bootstrap" → empty 404 (§4).
   *  - app routes      (config/version/status/rows): only AUTH_UI/AUTH_CLOCK pass
   *    the bearer gate (missing/unknown/admin tokens → empty 404). Within them,
   *    PUT/DELETE rows require the UI class → 403 empty body (§5 capability
   *    violation, "clock writing rows").
   *  - internal routes (/internal/backup): only INTERNAL_TOKEN; silent to all others.
   *
   * Unknown routes (any method) → empty 404, regardless of authorization (§4).
   */
  async route(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    let family = null;      // 'admin' | 'app' | 'internal'
    let requireUi = false;  // app route requiring the UI capability class
    let handler = null;
    let id = null;

    if (path === '/bootstrap' && method === 'PUT') {
      family = 'admin';
      handler = () => this.hBootstrap(req);
    } else if (path === '/bootstrap/rewrap' && method === 'PUT') {
      family = 'admin';
      handler = () => this.hRewrap(req);
    } else if (path === '/config' && method === 'GET') {
      family = 'app';
      handler = () => this.hConfig();
    } else if (path === '/version' && method === 'GET') {
      family = 'app';
      handler = () => this.hVersion();
    } else if (path === '/status' && method === 'GET') {
      family = 'app';
      handler = () => this.hStatus();
    } else if (path === '/rows' && method === 'GET') {
      family = 'app';
      handler = () => this.hManifest();
    } else if (
      path.startsWith('/rows/') &&
      (method === 'GET' || method === 'PUT' || method === 'DELETE')
    ) {
      let raw;
      try {
        raw = decodeURIComponent(path.slice('/rows/'.length));
      } catch {
        return silentDrop(); // malformed percent-encoding → unknown route
      }
      if (!raw) return silentDrop(); // empty id ("/rows/") → unknown route
      id = raw; // length cap enforced AFTER the bearer gate (§5: authenticated-but-malformed → 400)
      if (method === 'GET') {
        family = 'app';
        handler = () => this.hGetRow(id);
      } else if (method === 'PUT') {
        family = 'app';
        requireUi = true;
        handler = () => this.hPutRow(req, id);
      } else {
        family = 'app';
        requireUi = true;
        handler = () => this.hDeleteRow(id);
      }
    } else if (path === '/internal/backup' && method === 'POST') {
      family = 'internal';
      handler = () => this.hBackup();
    } else {
      return silentDrop(); // §4: unknown routes (naturally)
    }

    // ---- bearer gate (§4): constant-time over the hex-decoded 32 bytes ----
    const header = req.headers.get('authorization') || '';
    const m = /^Bearer ([0-9a-f]{64})$/.exec(header);
    const token = m ? hexDecode(m[1], 32) : null;
    let cls = null;
    if (token) {
      const cfg = await this.getConfig();
      const admin = this.env.ADMIN_SECRET ? hexDecode(this.env.ADMIN_SECRET, 32) : null;
      const internal = this.env.INTERNAL_TOKEN ? hexDecode(this.env.INTERNAL_TOKEN, 32) : null;
      const ui = cfg && cfg.auth_ui ? hexDecode(cfg.auth_ui, 32) : null;
      const clock = cfg && cfg.auth_clock ? hexDecode(cfg.auth_clock, 32) : null;
      if (admin && ctEqual(token, admin)) cls = 'admin';
      else if (internal && ctEqual(token, internal)) cls = 'internal';
      else if (ui && ctEqual(token, ui)) cls = 'ui';
      else if (clock && ctEqual(token, clock)) cls = 'clock';
    }

    if (family === 'admin') {
      if (cls !== 'admin') return silentDrop();
    } else if (family === 'internal') {
      if (cls !== 'internal') return silentDrop();
    } else {
      if (cls !== 'ui' && cls !== 'clock') return silentDrop();
      if (requireUi && cls !== 'ui') {
        if (method === 'PUT') await readBodyBounded(req); // drain so the 403 reaches the client cleanly
        return forbidden();
      }
    }

    // Authenticated-but-malformed (§5): the D9 id size cap maps to 400 like
    // every other field validation — never to a pre-auth silent drop.
    if (id !== null && id.length > ID_MAX) {
      if (method === 'PUT') await readBodyBounded(req); // drain: the client must receive the 400, not a connection reset
      return badRequest('bad_id');
    }

    return handler();
  }

  /* -------------------- §8: bootstrap / config -------------------- */

  /** PUT /bootstrap — create config, or destructive re-key with force:true. */
  async hBootstrap(req) {
    const { val, err } = await readJson(req);
    if (err) return badRequest(err);
    if (!val || typeof val !== 'object' || Array.isArray(val)) return badRequest('bad_body');

    const saltOk = typeof val.salt === 'string' && HEX32_RE.test(val.salt);
    const wrapped = b64Decode(val.wrapped);
    const authUiOk = typeof val.auth_ui === 'string' && HEX64_RE.test(val.auth_ui);
    const authClockOk = typeof val.auth_clock === 'string' && HEX64_RE.test(val.auth_clock);
    const force = val.force === true;

    if (!saltOk) return badRequest('bad_salt');
    if (!Number.isInteger(val.iters) || val.iters !== KDF_ITERS) return badRequest('bad_iters'); // WORKLOG D7
    if (!wrapped || wrapped.length !== WRAPPED_LEN) return badRequest('bad_wrapped');            // WORKLOG D2
    if (!authUiOk) return badRequest('bad_auth_ui');
    if (!authClockOk) return badRequest('bad_auth_clock');

    const existing = await this.getConfig();
    if (existing && !force) return json({ error: 'exists' }, 409);

    const now = Math.floor(Date.now() / 1000);
    const sql = this.ctx.storage.sql;
    if (existing) {
      // §8 force re-bootstrap: DESTRUCTIVELY wipes rows + staged (no R2 in
      // calendar scope). Order: rows/staged first, config LAST — a crash
      // mid-wipe leaves config present, so the next bootstrap correctly 409s
      // and the operator must force again. (Deleting config first would let a
      // later NON-force bootstrap silently adopt stale old-key rows.)
      sql.exec('DELETE FROM rows');
      sql.exec('DELETE FROM staged');
      sql.exec('DELETE FROM config');
    }
    sql.exec(
      'INSERT INTO config (k, salt, iters, wrapped, auth_ui, auth_clock, ver, updated_at) ' +
        'VALUES (1, ?, ?, ?, ?, ?, 1, ?)',
      val.salt, val.iters, wrapped, val.auth_ui, val.auth_clock, now
    );
    return json({ ver: 1 });
  }

  /** PUT /bootstrap/rewrap — §20 Type A rotation: atomic wrapped(+salt) replace. */
  async hRewrap(req) {
    const { val, err } = await readJson(req);
    if (err) return badRequest(err);
    if (!val || typeof val !== 'object' || Array.isArray(val)) return badRequest('bad_body');

    const wrapped = b64Decode(val.wrapped);
    if (!wrapped || wrapped.length !== WRAPPED_LEN) return badRequest('bad_wrapped');

    let salt = null;
    if (val.salt !== undefined) {
      if (typeof val.salt !== 'string' || !HEX32_RE.test(val.salt)) return badRequest('bad_salt');
      salt = val.salt;
    }

    const existing = await this.getConfig();
    if (!existing) return json({ error: 'not_found' }, 404); // WORKLOG D11

    const now = Math.floor(Date.now() / 1000);
    if (salt) {
      this.ctx.storage.sql.exec(
        'UPDATE config SET wrapped = ?, salt = ?, ver = ver + 1, updated_at = ? WHERE k = 1',
        wrapped, salt, now
      );
    } else {
      this.ctx.storage.sql.exec(
        'UPDATE config SET wrapped = ?, ver = ver + 1, updated_at = ? WHERE k = 1',
        wrapped, now
      );
    }
    return json({});
  }

  /** GET /config — CLEAR params only; the private column is never returned (§8). */
  async hConfig() {
    const cfg = await this.getConfig();
    if (!cfg) return json({ error: 'not_found' }, 404); // WORKLOG D11
    return json({
      salt: cfg.salt,
      iters: cfg.iters,
      wrapped: b64Encode(cfg.wrapped),
      ver: cfg.ver,
    });
  }

  /* -------------------- §22 / §10 -------------------- */

  async hVersion() {
    return json({ proto: PROTO_VERSION });
  }

  async hStatus() {
    const r = this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM staged').toArray()[0];
    return json({ photo_pending: r ? r.n : 0 });
  }

  /* -------------------- §9: row sync -------------------- */

  async hManifest() {
    const rows = this.ctx.storage.sql.exec('SELECT id, ver FROM rows ORDER BY id').toArray();
    return json({ rows: rows.map((r) => ({ id: r.id, ver: r.ver })) });
  }

  async hGetRow(id) {
    const r = this.ctx.storage.sql
      .exec('SELECT ver, nonce, ct FROM rows WHERE id = ?', id)
      .toArray();
    if (r.length === 0) return json({ error: 'not_found' }, 404); // §5: authenticated 404 WITH body
    const row = r[0];
    return json({
      id,
      ver: row.ver,
      nonce: b64Encode(toU8(row.nonce)),
      ct: b64Encode(toU8(row.ct)),
    });
  }

  /**
   * PUT /rows/{id} — RMW arbitration, the only server-side merge logic (§9):
   *   incoming.ver > stored.ver  → accept, store, return 200 + stored envelope
   *   incoming.ver <= stored.ver → reject silently-as-rebase, return 200 +
   *                                CURRENT stored envelope
   * New rows accept any ver >= 1 (WORKLOG D8 — §19 restore drill).
   */
  async hPutRow(req, id) {
    const { val, err } = await readJson(req);
    if (err) return badRequest(err);
    if (!val || typeof val !== 'object' || Array.isArray(val)) return badRequest('bad_body');

    const ver = val.ver;
    if (!Number.isInteger(ver) || ver < 1 || ver > VER_U32_MAX) return badRequest('bad_ver');
    const nonce = b64Decode(val.nonce);
    if (!nonce || nonce.length !== NONCE_LEN) return badRequest('bad_nonce');
    const ct = b64Decode(val.ct);
    if (!ct || ct.length > ROW_CT_MAX) return badRequest('bad_ct'); // §21

    const existing = this.ctx.storage.sql
      .exec('SELECT ver, nonce, ct FROM rows WHERE id = ?', id)
      .toArray();
    const now = Math.floor(Date.now() / 1000);

    if (existing.length === 0) {
      this.ctx.storage.sql.exec(
        'INSERT INTO rows (id, ver, nonce, ct, updated_at) VALUES (?, ?, ?, ?, ?)',
        id, ver, nonce, ct, now
      );
      return json({ id, ver, nonce: b64Encode(nonce), ct: b64Encode(ct) });
    }

    const stored = existing[0];
    if (ver > stored.ver) {
      this.ctx.storage.sql.exec(
        'UPDATE rows SET ver = ?, nonce = ?, ct = ?, updated_at = ? WHERE id = ?',
        ver, nonce, ct, now, id
      );
      return json({ id, ver, nonce: b64Encode(nonce), ct: b64Encode(ct) });
    }

    // Reject silently-as-rebase: return the CURRENT stored envelope.
    return json({
      id,
      ver: stored.ver,
      nonce: b64Encode(toU8(stored.nonce)),
      ct: b64Encode(toU8(stored.ct)),
    });
  }

  /** DELETE /rows/{id} — idempotent (§9). */
  async hDeleteRow(id) {
    this.ctx.storage.sql.exec('DELETE FROM rows WHERE id = ?', id);
    return json({});
  }

  /* -------------------- §19: backup (calendar scope) -------------------- */

  /**
   * POST /internal/backup — snapshot all rows + config into D1, prune
   * retention, sweep stale staging. Invoked by the Worker's daily cron
   * (03:00 UTC) and usable with INTERNAL_TOKEN for verification (WORKLOG D12).
   */
  async hBackup() {
    const day = new Date().toISOString().slice(0, 10); // UTC date
    const cutoff = new Date(Date.now() - BACKUP_RETENTION_DAYS * 86400000)
      .toISOString()
      .slice(0, 10);

    const rows = this.ctx.storage.sql.exec('SELECT id, ver, nonce, ct FROM rows').toArray();
    const cfg = await this.getConfig();

    const db = this.env.BACKUP;
    if (!db) return json({ error: 'no_backup_binding' }, 500);

    await db.exec(
      'CREATE TABLE IF NOT EXISTS backup (' +
        'day TEXT NOT NULL, id TEXT NOT NULL, ver INTEGER NOT NULL, nonce BLOB NOT NULL, ' +
        'ct BLOB NOT NULL, PRIMARY KEY (day, id))'
    );
    await db.exec(
      'CREATE TABLE IF NOT EXISTS config_backup (' +
        'day TEXT NOT NULL, salt TEXT NOT NULL, iters INTEGER NOT NULL, wrapped BLOB NOT NULL, ' +
        'auth_ui TEXT NOT NULL, auth_clock TEXT NOT NULL, ver INTEGER NOT NULL, PRIMARY KEY (day))'
    );

    const stmts = rows.map((r) =>
      db
        .prepare('INSERT OR REPLACE INTO backup (day, id, ver, nonce, ct) VALUES (?, ?, ?, ?, ?)')
        .bind(day, r.id, r.ver, toU8(r.nonce), toU8(r.ct))
    );
    if (cfg) {
      stmts.push(
        db
          .prepare(
            'INSERT OR REPLACE INTO config_backup (day, salt, iters, wrapped, auth_ui, auth_clock, ver) ' +
              'VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(day, cfg.salt, cfg.iters, cfg.wrapped, cfg.auth_ui, cfg.auth_clock, cfg.ver)
      );
    }
    stmts.push(db.prepare('DELETE FROM backup WHERE day < ?').bind(cutoff));
    stmts.push(db.prepare('DELETE FROM config_backup WHERE day < ?').bind(cutoff));
    await db.batch(stmts);

    // §19 staging sweep — `staged` is a table in THIS DO's SQLite, not in D1.
    // In calendar scope it is always empty (no photo staging); the sweep is the
    // specified 14-day backstop and costs one statement.
    this.ctx.storage.sql.exec(
      'DELETE FROM staged WHERE first_seen < ?',
      Math.floor(Date.now() / 1000) - STAGING_MAX_AGE_S
    );

    return json({ ok: true, day, rows: rows.length });
  }
}
