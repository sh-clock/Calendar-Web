/**
 * Store — Durable Object (SQLite-backed) implementing the calendar slice of
 * PROTOCOL v4.1 (Encrypted Clock Ecosystem wire specification, 2026-10-19) + the v4.2 calendar delta (docs/PROTOCOL-v4.2.md): evt:{cal}:{uid} + cmeta:{uuid} row types on the same opaque store.
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

const PROTO_VERSION = '4.3';                       // §22 (v4.3: client stops maintaining cal: buckets; POST /rows:batch added — see protocol.md)
const KDF_ITERS_MIN = 100000;                      // §2 (sec-S7-F2: a RANGE now — 100k floor keeps the downgrade wall, up to 10M lets an operator re-wrap stronger without a wipe)
const KDF_ITERS_MAX = 10000000;                    // §2 upper bound (client crypto.js accepts the same range)
const ROW_CT_MAX = 65536;                          // §2 — ciphertext incl. tag
const ROW_CT_MIN = 16;                             // §2 (sec-S7-F5: a legal AES-256-GCM ct is >= the 16B tag — sub-tag blobs can only be junk rows)
const VER_U32_MAX = 4294967295;                    // §2 VER_WIDTH (u32)
const WRAPPED_LEN = 60;                            // WORKLOG D2: 12 nonce || 32 ct || 16 tag
const NONCE_LEN = 12;                              // §2 GCM_NONCE_LEN
const ID_MAX = 256;                                // WORKLOG D9
const BATCH_MAX_IDS = 256;                         // protocol.md §9b
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

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Strict base64 (standard alphabet, padded, CANONICAL — §5). Returns null on any violation. */
function b64Decode(str) {
  if (typeof str !== 'string' || str.length === 0 || str.length % 4 !== 0) return null;
  if (!B64_RE.test(str)) return null;
  const pad = str.indexOf('=');
  if (pad !== -1 && pad < str.length - 2) return null;
  // O(1) canonicality (efficiency E1-5): only the FINAL quantum can carry
  // non-zero padding bits — atob discards them silently ("QR==" ≡ "QQ=="),
  // and storing non-canonical input would break the client's envelope-
  // identity acceptance check (WORKLOG D14). All earlier quanta are pure
  // alphabet chars, so a tail-bits check is acceptance-equivalent to the
  // previous full re-encode comparison (verified over 10⁶ variants).
  const n = str.length;
  if (str[n - 1] === '=') {
    if (str[n - 2] === '=') {
      if (B64_ALPHABET.indexOf(str[n - 3]) & 0x0f) return null;
    } else {
      if (B64_ALPHABET.indexOf(str[n - 2]) & 0x03) return null;
    }
  }
  let bin;
  try { bin = atob(str); } catch { return null; }
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
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

/** §5 error policy helpers. */
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
    // sec-S8-F5: no intermediary (shared cache / future CF cache rule /
    // service worker) may replay a stale /config or /rows 200 — every JSON
    // response is uncachable. (The silent drop deliberately stays bare per §4.)
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function badRequest(msg) {
  return json({ error: msg }, 400);
}

/** §9c: 412 Precondition Failed (empty body). */
function preconditionFailed() {
  return new Response(null, { status: 412 });
}

/* ------------------------------------------------------------------ */
/* Conditional-header parsing (RFC 9110 §13.1.1 / §13.1.2)             */
/* ------------------------------------------------------------------ */

/** Parse If-Match / If-None-Match into {star:true} | {tags:[{weak,tag}]} |
 *  {malformed:true}. Opaque-tag comparison is EXACT STRING equality on the
 *  quoted value (entity-tags are opaque — "05" is NOT our "5"); the caller
 *  chooses strong (If-Match: weak never matches) vs weak (If-None-Match:
 *  the W/ flag is ignored) comparison per RFC 9110. */
function parseEtagList(header) {
  const v = header.trim();
  if (v === '*') return { star: true };
  const parts = v.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (parts.length === 0) return { malformed: true };
  const tags = [];
  for (const p of parts) {
    const m = /^(W\/)?"([^"]*)"$/.exec(p);
    if (!m) return { malformed: true };
    tags.push({ weak: m[1] === 'W/', tag: m[2] });
  }
  return { tags };
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
        // Manifest epoch (§9 conditional read): bumped on EVERY rows mutation
        // so GET /rows can answer If-None-Match with 304 without scanning.
        sql.exec(
          'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)'
        );
        sql.exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('epoch', 0)");
        // sec-S4-2 (atomic epoch): the §9d epoch bump now rides the SAME
        // SQLite statement as the row mutation via triggers — the crash window
        // between "row committed" and "epoch committed" (two separate implicit
        // transactions) could permanently desync the etag from row state.
        // Trigger semantics map 1:1 onto §9d: fires on INSERT / on an accepted
        // UPDATE / on a REAL delete only (an idempotent re-delete of a missing
        // row deletes nothing → no bump); a force-wipe `DELETE FROM rows`
        // bumps per destroyed row, so sec-S4-1/S8-F1 (stale-304 ghost state
        // after a wipe) is closed by construction. Verified on workerd DO-SQLite.
        sql.exec(
          "CREATE TRIGGER IF NOT EXISTS rows_bump_ins AFTER INSERT ON rows " +
            "BEGIN UPDATE meta SET v = v + 1 WHERE k = 'epoch'; END"
        );
        sql.exec(
          "CREATE TRIGGER IF NOT EXISTS rows_bump_upd AFTER UPDATE ON rows " +
            "BEGIN UPDATE meta SET v = v + 1 WHERE k = 'epoch'; END"
        );
        sql.exec(
          "CREATE TRIGGER IF NOT EXISTS rows_bump_del AFTER DELETE ON rows " +
            "BEGIN UPDATE meta SET v = v + 1 WHERE k = 'epoch'; END"
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
      // sec-S6-F4: log a FIXED tag + the exception CLASS only — never the
      // message (messages can interpolate payload-derived substrings in
      // future code; the class comes from a fixed runtime vocabulary).
      // Counts-only ledger (§3); observability stays disabled.
      console.error('store_error ' + (e && e.name ? e.name : 'Error'));
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
      handler = () => this.hManifest(req);
    } else if (path === '/rows:batch' && method === 'POST') {
      // protocol.md §9b — bulk envelope read (read-only: ui OR clock class).
      family = 'app';
      handler = () => this.hBatchGet(req);
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
        // sec-S2-L1: drain bodied rejections for BOTH PUT and DELETE (the
        // front door forwards bodies for every non-GET/HEAD method) so the
        // client receives the 403 instead of a torn connection.
        if (method === 'PUT' || method === 'DELETE') await readBodyBounded(req);
        return forbidden();
      }
    }

    // Authenticated-but-malformed (§5): the D9 id size cap maps to 400 like
    // every other field validation — never to a pre-auth silent drop.
    if (id !== null && id.length > ID_MAX) {
      // sec-S2-L1: drain bodied rejections (PUT and DELETE alike).
      if (method === 'PUT' || method === 'DELETE') await readBodyBounded(req);
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
    // sec-S7-F2: iters is a RANGE now (floor keeps the anti-downgrade wall —
    // an admin cannot bootstrap a cheap-to-brute-force universe; the ceiling
    // matches the client's accepted range). The §8 force wipe bumps the
    // manifest epoch automatically: the per-row DELETE triggers fire (sec-S4-1).
    if (!Number.isInteger(val.iters) || val.iters < KDF_ITERS_MIN || val.iters > KDF_ITERS_MAX) {
      return badRequest('bad_iters');
    }
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

    // sec-S7-F2: optional iters — a Type-A password rotation can also RAISE
    // the KDF cost atomically (validated in the §2 range). Every client
    // already derives with whatever /config reports (crypto.js accepts
    // 1..10M), so no client change is needed to pick this up.
    let iters = null;
    if (val.iters !== undefined) {
      if (!Number.isInteger(val.iters) || val.iters < KDF_ITERS_MIN || val.iters > KDF_ITERS_MAX) {
        return badRequest('bad_iters');
      }
      iters = val.iters;
    }

    const existing = await this.getConfig();
    if (!existing) return json({ error: 'not_found' }, 404); // WORKLOG D11

    const now = Math.floor(Date.now() / 1000);
    // Compose the SET clause from the present optional fields (fixed strings,
    // bound values — never interpolated).
    const sets = ['wrapped = ?'];
    const binds = [wrapped];
    if (salt) { sets.push('salt = ?'); binds.push(salt); }
    if (iters) { sets.push('iters = ?'); binds.push(iters); }
    sets.push('ver = ver + 1', 'updated_at = ?');
    binds.push(now);
    this.ctx.storage.sql.exec(
      'UPDATE config SET ' + sets.join(', ') + ' WHERE k = 1',
      ...binds
    );
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

  /** Current manifest epoch (bumped atomically by the rows triggers). */
  readEpoch() {
    const r = this.ctx.storage.sql
      .exec("SELECT v FROM meta WHERE k = 'epoch'")
      .toArray();
    return r.length ? Number(r[0].v) : 0;
  }

  /**
   * GET /rows — manifest (id, ver) + `etag` (manifest epoch).
   *
   * §9d conditional read: a client that sends `If-None-Match` and lists the
   * current epoch etag gets 304 (empty body) instead of the full manifest —
   * an idle 60 s poll then costs ~0 bytes. Additive and interoperable: old
   * servers ignore the header (plain 200), old clients ignore the `etag` field
   * (§22 ignore-unknown-fields). The epoch counts MUTATIONS, not rows (bumped
   * atomically by the rows triggers — see ensureSchema), so deletes are caught
   * too. Still zero-knowledge: the etag leaks only a mutation counter (L1).
   *
   * sec-S4-5 (RFC 9110 §13.1.2 conformance): weak comparison — `W/"e46"`
   * matches; a LIST matches if any element matches; `*` is false whenever a
   * current representation exists (GET /rows always has one → 304 + ETag);
   * a malformed value falls through to the plain 200 (rule 3: condition true).
   */
  async hManifest(req) {
    const epoch = this.readEpoch();
    const etag = '"e' + epoch + '"';
    const opaque = 'e' + epoch; // entity-tag value without the DQUOTEs
    const inm = req.headers.get('if-none-match');
    if (inm !== null) {
      const p = parseEtagList(inm);
      let match = false;
      if (p.star) match = true; // representation always exists → condition false → 304
      else if (p.tags) match = p.tags.some((t) => t.tag === opaque); // weak compare
      if (match) {
        return new Response(null, {
          status: 304,
          headers: { etag, 'cache-control': 'no-store' },
        });
      }
    }
    const rows = this.ctx.storage.sql.exec('SELECT id, ver FROM rows ORDER BY id').toArray();
    return json({ rows: rows.map((r) => ({ id: r.id, ver: r.ver })), etag });
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
   * POST /rows:batch — protocol.md §9b (v4.3). Body {ids:[...]} (unique,
   * ≤256 ids, each ≤256 chars) → {rows:[envelope | {id,missing:true}]} in
   * REQUEST ORDER. Pure read: envelopes are relayed verbatim; the server
   * never inspects nonce/ct (§1 threat model unchanged).
   */
  async hBatchGet(req) {
    const { val, err } = await readJson(req);
    if (err) return badRequest(err);
    if (!val || typeof val !== 'object' || Array.isArray(val)) return badRequest('bad_body');
    const ids = val.ids;
    if (!Array.isArray(ids) || ids.length === 0) return badRequest('bad_ids');
    if (ids.length > BATCH_MAX_IDS) return badRequest('bad_ids');
    for (const id of ids) {
      if (typeof id !== 'string' || !id || id.length > ID_MAX) return badRequest('bad_id');
    }
    if (new Set(ids).size !== ids.length) return badRequest('bad_ids'); // unique (§9b)

    // Efficiency E1-2: `WHERE id IN (…)` SELECTs instead of N per-id statements.
    // Cloudflare's SQLite caps statements at 100 BOUND PARAMETERS, so a batch
    // is chunked into ≤100-id queries and the results concatenated — response
    // byte-identical (envelopes in REQUEST ORDER, missing rows flagged).
    const out = [];
    const byId = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const placeholders = chunk.map(() => '?').join(',');
      const found = this.ctx.storage.sql
        .exec(`SELECT id, ver, nonce, ct FROM rows WHERE id IN (${placeholders})`, ...chunk)
        .toArray();
      for (const r of found) byId.set(r.id, r);
    }
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) {
        out.push({ id, missing: true });
      } else {
        out.push({
          id,
          ver: r.ver,
          nonce: b64Encode(toU8(r.nonce)),
          ct: b64Encode(toU8(r.ct)),
        });
      }
    }
    return json({ rows: out });
  }

  /**
   * PUT /rows/{id} — RMW arbitration, the only server-side merge logic (§9):
   *   incoming.ver > stored.ver  → accept, store, return 200 + stored envelope
   *   incoming.ver <= stored.ver → reject silently-as-rebase, return 200 +
   *                                CURRENT stored envelope
   * New rows accept any ver >= 1 (WORKLOG D8 — §19 restore drill).
   *
   * §9c conditional mode (sec-S4-3/S4-5/S8-F6 — now RFC 9110-exact):
   * evaluated in the §13.2.2 order — If-Match (step 1, STRONG comparison:
   * `*` = exists-check; a list matches only on exact opaque equality, weak
   * W/-tagged entries never match; a MISSING row fails every If-Match form
   * → 412, changed from the old 404) then If-None-Match (step 3, WEAK
   * comparison: a listed current etag → 412; `*` → 412 iff the row exists;
   * malformed → condition true → plain RMW per §13.1.2 rule 3). The web
   * client never sends these headers; DAV clients get RFC semantics.
   * The worker still only compares the CLEAR ver — never nonce/ct.
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
    // §21 + sec-S7-F5: 16 B tag floor (a legal AES-GCM ct is never shorter).
    if (!ct || ct.length < ROW_CT_MIN || ct.length > ROW_CT_MAX) return badRequest('bad_ct');

    const ifMatchHdr = req.headers.get('if-match');
    const ifNoneMatchHdr = req.headers.get('if-none-match');

    const existing = this.ctx.storage.sql
      .exec('SELECT ver, nonce, ct FROM rows WHERE id = ?', id)
      .toArray();
    const now = Math.floor(Date.now() / 1000);

    // ---- RFC 9110 §13.2.2 step 1: If-Match (strong) ----
    if (ifMatchHdr !== null) {
      const im = parseEtagList(ifMatchHdr);
      if (im.malformed) return badRequest('bad_if_match'); // §9c: fail closed
      let imOk;
      if (im.star) {
        imOk = existing.length > 0; // * → true iff the row exists
      } else {
        // Strong comparison: current etag (opaque "<ver>") must equal a
        // listed STRONG tag exactly — W/"5" never matches "5".
        const cur = existing.length ? String(existing[0].ver) : null;
        imOk = cur !== null && im.tags.some((t) => !t.weak && t.tag === cur);
      }
      if (!imOk) return preconditionFailed(); // incl. missing row (old code 404'd)
    }

    // ---- RFC 9110 §13.2.2 step 3: If-None-Match (weak) ----
    if (ifNoneMatchHdr !== null) {
      const inm = parseEtagList(ifNoneMatchHdr);
      // malformed → §13.1.2 rule 3: condition true → proceed (documented §9c)
      if (inm.star) {
        if (existing.length > 0) return preconditionFailed(); // create-only guard
      } else if (inm.tags) {
        // Weak comparison: the W/ flag is ignored — W/"5" matches "5".
        const cur = existing.length ? String(existing[0].ver) : null;
        if (cur !== null && inm.tags.some((t) => t.tag === cur)) return preconditionFailed();
      }
    }

    if (existing.length === 0) {
      this.ctx.storage.sql.exec(
        'INSERT INTO rows (id, ver, nonce, ct, updated_at) VALUES (?, ?, ?, ?, ?)',
        id, ver, nonce, ct, now
      );
      // Efficiency E1-4: the submitted strings passed the canonical b64Decode,
      // so they are byte-identical to re-encoding the decoded arrays — echo
      // them verbatim instead of paying an O(n) re-encode per accepted row.
      return json({ id, ver, nonce: val.nonce, ct: val.ct });
    }

    const stored = existing[0];
    if (ver > stored.ver) {
      this.ctx.storage.sql.exec(
        'UPDATE rows SET ver = ?, nonce = ?, ct = ?, updated_at = ? WHERE id = ?',
        ver, nonce, ct, now, id
      );
      return json({ id, ver, nonce: val.nonce, ct: val.ct });
    }

    // Reject silently-as-rebase: return the CURRENT stored envelope.
    return json({
      id,
      ver: stored.ver,
      nonce: b64Encode(toU8(stored.nonce)),
      ct: b64Encode(toU8(stored.ct)),
    });
  }

  /** DELETE /rows/{id} — idempotent (§9). The rows_bump_del trigger bumps
   *  the manifest epoch ONLY for a real delete (a re-delete of a missing row
   *  deletes nothing → no bump), exactly §9d. */
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

    // sec-S6-F3 (exact-day snapshot): the day bucket is now cleared before
    // the inserts — rows deleted earlier today no longer linger in tonight's
    // snapshot (the old INSERT OR REPLACE-only merge could resurrect deleted
    // events in a same-day restore). DELETE + inserts ride ONE db.batch.
    const stmts = [
      db.prepare('DELETE FROM backup WHERE day = ?').bind(day),
      db.prepare('DELETE FROM config_backup WHERE day = ?').bind(day),
    ];
    for (const r of rows) {
      stmts.push(
        db
          .prepare('INSERT OR REPLACE INTO backup (day, id, ver, nonce, ct) VALUES (?, ?, ?, ?, ?)')
          .bind(day, r.id, r.ver, toU8(r.nonce), toU8(r.ct))
      );
    }
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
