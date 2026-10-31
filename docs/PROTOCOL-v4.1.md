An AI agent formed this protocol. I want you to use this implement ONLY the calendar feaure - You are to build this on the cloudflare account I gave access to. Do NOT implement the other photos and to do lists.
NOTE: the CLOCK HAS NOT BEEN BUILT. This serves as a Proof of concept ONLY! Use the (*I KNOW, very insecure **TEST** password of 'password' ) for tests and generate a dummy AES key which you will send to me (I am not assuming it is secure)
Finally, this should be served via github pages.

================================================================================
PROTOCOL v4.1 — ENCRYPTED CLOCK ECOSYSTEM, WIRE SPECIFICATION
2026-10-19 — supersedes v4.0
================================================================================

0. CHANGE LOG v4.0 -> v4.1
--------------------------------------------------------------------------------
This document is the COMPLETE, INTEGRATED specification: all of v4.0 plus the
photo domain. It is the sole reference; v4.0 may be retired.

  v4.1 additions (per project plan §9):
  * §15 Photo crypto profile: per-photo K_photo; originals sealed with
    secretstream XChaCha20-Poly1305 in 1MiB chunks; previews with secretbox
    XSalsa20-Poly1305; K_photo wrapped under K_data (AES-GCM, deterministic
    per-uid nonce).
  * §16 photo_index: monthly bucket rows ("P"+yyyymm, overflow "-2", "-3"),
    fixed 512-entry padded binary buckets, ct <=64KiB, RMW arbitration.
  * §17 Blob routes: PUT/GET /blob/pv/{uid}, PUT/GET /blob/orig/{uid}/{n:04d},
    POST /photo/ack (120/min).
  * §18 PHOTO_PULL session sub-protocol: charging+WiFi+outside-bed gate,
    400 photos/45min caps, CRC32 journal, resumable, ack-then-delete.
  * §10 GET /status: clear photo_pending counter.
  * §11 WS status frame carries photo_pending.
  * §9 Row sync: DELETE /rows/{id} added (bucket rotation, todo roll-off).
  * §14 todos promoted from draft to first-class row type.
  * §19 D1 backup scope: todos + photo_index included.
  * §20 Rotation: staging drain-before-commit; k_photo_wrapped re-wrap batch.
  * §12/§13: alarm row and calendar bucket schemas canonicalized.

  Inherited from v4.0 (unchanged): passive threat model, all-symmetric key
  hierarchy (PASSWORD -> KEK -> AES1 -> HKDF subkeys), row-level AES-GCM,
  empty-404 silent drop, DO SQLite primary + daily D1 backup, hibernating WS
  radar, silent-drop law for the password-less.

1. SCOPE, THREAT MODEL, DESIGN LAWS
--------------------------------------------------------------------------------
Participants: one user. Clients: ESP32-S3 clock, phone forks (Clock, DAVx5,
trudido, ente-later), CLI. Server: Cloudflare Worker + Durable Object (SQLite)
+ R2, with D1 as backup target. Single tenant.

Threat model (PASSIVE):
  T1  The server is honest-but-curious. It must learn nothing about content:
      no plaintext of rows, blobs, frames. It sees metadata only: row ids,
      version counters, ciphertext sizes, timing, IP.
  T2  The server must not be able to fabricate data any client accepts. All
      application data is AEAD-authenticated under keys it never holds.
  T3  Peers without valid authentication learn nothing and get nothing: every
      unauthenticated request is answered with an empty 404 (the "silent
      drop"). No error differentiation, no existence oracle, no enumeration.
  T4  Active network attackers are out of scope beyond TLS; the AEAD layer is
      the confidentiality/integrity boundary, TLS is transport hygiene only.
  Out of scope: a malicious server (that is the active model — rejected in
  design), traffic-analysis resistance, multi-user isolation.

Design laws:
  L1  Server is an untrusted relay: it stores and forwards opaque bytes.
  L2  All-symmetric crypto. Row/WS/auth: AES-256-GCM (hardware on ESP32-S3).
      Photo blobs: NaCl family (§15) for ente-core compatibility.
  L3  No-auth -> empty 404. Always. Everywhere (§4).
  L4  Clock is offline-first: alarms, display, and cached rows work with the
      network gone. Nothing on the clock blocks on the server.
  L5  The protocol serves the goal; features that do not serve the
      clock/phone/photo triangle are cut.
  L6  Steady state fits Workers free tier + R2 $5/mo.

Server-enforced vs client-enforced: the server enforces only what is visible
in clear (sizes, ver comparisons, rates, bearer gates). Content-derived caps
(05:00 alarm floor, <=12 alarms, <=64 todos, <=16 events/day, working-set
rules) are CLIENT-enforced conventions; the server cannot read them and must
not try.

2. CONSTANTS
--------------------------------------------------------------------------------
  PASSWORD_LEN_MIN        40 characters (user-chosen, high entropy required)
  KDF                     PBKDF2-HMAC-SHA256
  KDF_SALT_LEN            16 bytes (random, stored clear in config)
  KDF_ITERS               100000
  MASTER_KEY_LEN          32 bytes (AES1)
  HKDF                    HKDF-SHA256, ikm = AES1, salt = "" (zero-len),
                          info = ASCII domain string (see §3)
  AUTH_TOKEN_LEN          32 bytes (transported as 64 lowercase hex chars)
  GCM_NONCE_LEN           12 bytes
  GCM_TAG_LEN             16 bytes
  ROW_CT_MAX              65536 bytes (64KiB, ciphertext incl. tag)
  UID_LEN                 12 random bytes (transported as 24 lowercase hex)
  SHA16_LEN               8 bytes of sha256 (transported as 16 lowercase hex)
  PREVIEW_PT_MAX          262144 bytes (256KiB plaintext)
  CHUNK_PT_MAX            1048576 bytes (1MiB plaintext, last chunk <= that)
  SECRETSTREAM_HDR        24 bytes; per-frame overhead +17 bytes
  SECRETBOX_NONCE         24 bytes; overhead +16 bytes
  KPHOTO_WRAPPED_LEN      48 bytes (32 ct + 16 tag; nonce derived, see §15.4)
  BUCKET_ENTRIES          512 fixed slots per photo_index bucket
  BUCKET_ENTRY_LEN        80 bytes (77 used + 3 reserved zero)
  BUCKET_HDR_LEN          16 bytes
  VER_WIDTH               u32, first accepted value 1
  PULL_MAX_PHOTOS         400 per session
  PULL_MAX_MINUTES        45 per session
  ACK_RATE_MAX            120 per minute
  WS_PING_INTERVAL        300 s +- 60 s jitter
  WS_IDLE_CLOSE           600 s
  EVENT_REPLAY_WINDOW     120 s
  STAGING_MAX_AGE         14 days (cron sweep)
  BACKUP_RETENTION        7 daily snapshots (D1)
  CHUNK_DIGITS            4 (chunk index zero-padded, n:0000..9999)

3. KEY HIERARCHY AND DERIVATION
--------------------------------------------------------------------------------
  PASSWORD (>=40 chars, human-held, never stored anywhere)
      |
      |  KEK = PBKDF2-HMAC-SHA256(PASSWORD, salt, 100000), 32B
      v
    KEK  --unwraps-->  AES1 (32B random master; wrap stored in config row;
      |                 AES1 itself provisioned into clock NVS over the
      |                 setup channel; never leaves devices except wrapped)
      |
      |  HKDF-SHA256(ikm = AES1, salt = "", info = "clock-v4/<domain>")
      v
    K_data      all row encryption (rows, photo_index buckets)
    K_wrap      K_photo wrapping key        (info "clock-v4/K_photo_wrap")
    K_c2u       WebSocket radar frames      (info "clock-v4/K_c2u")
    AUTH_UI     bearer token, phone + CLI   (info "clock-v4/AUTH_UI")
    AUTH_CLOCK  bearer token, clock         (info "clock-v4/AUTH_CLOCK")

Rules:
  * KEK exists only transiently while unwrapping AES1 (CLI bootstrap, phone
    unlock). Never persisted, never transmitted.
  * AES1 is long-lived. Compromise procedure is §20 Type B rotation.
  * AUTH_* are registered in the config row's private column at bootstrap
    (the server must read them to gate requests; it is a capability handle,
    not content). They are the ONLY server-readable secrets, and they read
    nothing.
  * Key ledger (canonical, v4.1 §9.9 of the plan):
      clock NVS       : AES1
      phone Keystore  : K_data, K_wrap, K_c2u, AUTH_UI (cached after unlock)
      DO config row   : wrap(KEK, AES1), AUTH_UI, AUTH_CLOCK (private col)
      Worker logs     : nothing, ever
  * Phones derive keys at unlock: fetch /config (salt, iters, wrapped) ->
    KEK -> AES1 -> HKDF subkeys. Clock derives at boot from NVS.

4. AUTHENTICATION AND THE SILENT DROP
--------------------------------------------------------------------------------
  * Every HTTP request (except /bootstrap, which uses ADMIN_SECRET) carries
    "Authorization: Bearer <hex64>" with AUTH_UI or AUTH_CLOCK.
  * WebSocket upgrade carries the same header. Frame origin (ui vs clock) is
    bound to the connection's bearer class by the server (§11).
  * SILENT DROP (L3): any request failing the bearer gate gets HTTP 404,
    Content-Length: 0, no body, no WWW-Authenticate, no cache headers.
    Applies to: missing token, unknown token, disabled token, wrong-secret
    /bootstrap, and unknown routes (naturally).
  * Server-side comparison is constant-time over the hex-decoded 32 bytes.
  * Token rotation is part of §20 Type B.

5. ENCODING AND ERROR POLICY
--------------------------------------------------------------------------------
  * All bodies UTF-8 JSON unless stated otherwise. Binary ciphertext fields
    are base64 (standard alphabet, padded). Hex fields are lowercase.
  * Authenticated but malformed request  -> 400 {"error":"<short string>"}.
  * Authenticated but forbidden action
    (capability violation, e.g. clock writing rows) -> 403, empty body.
  * Authenticated but missing resource   -> 404 {"error":"not_found"}.
    NOTE the asymmetry: this 404 has a body; the unauthenticated 404 is
    empty. Clients MUST NOT treat the two as the same condition class, and
    no response ever explains WHICH gate failed (L3); the CLI's --explain
    mode reproduces the gate logic locally instead.
  * Unspecified fields in JSON objects are ignored (forward compatibility).
  * All timestamps are Unix seconds u32 UTC.

6. ROW ENVELOPE
--------------------------------------------------------------------------------
A row is the single unit of application state. One envelope format for every
row type; the server is type-blind.

  Envelope (all fields clear to the server):
    id      text    globally unique; namespaced (see §12-§16)
    ver     u32     monotone per row, first value 1
    nonce   12B     random per write
    ct      bytes   AES-256-GCM(K_data, nonce, plaintext, AAD)

  Encryption:
    key  = K_data
    AAD  = ASCII(id) || u32be(ver)   // binds ct to row identity AND version:
                                     // a stale envelope replayed under a
                                     // newer ver fails AEAD client-side
    plaintext = payload bytes (JSON for text rows, fixed binary for buckets)

  Rules:
  * The server stores/returns envelopes verbatim. It compares ver (clear)
    for RMW arbitration; it cannot read anything else.
  * nonce MUST be fresh per write (random 12B); reuse across writes of the
    same row with the same key is forbidden.
  * ct length is observable metadata. Fixed-size binary buckets (§16) defeat
    the count/length oracle where cardinality matters; text row sizes are
    accepted residual metadata (passive model).
  * Size limits: ct <= ROW_CT_MAX (65536). Larger payloads are illegal.
  * AAD binds ver (above): rollback of a row to an older authenticated
    envelope is detectable client-side — defense in depth on top of the
    §9 RMW rule.

7. SERVER STORAGE
--------------------------------------------------------------------------------
  Durable Object (primary, SQLite-backed):
    rows        ( id TEXT PRIMARY KEY, ver INTEGER NOT NULL,
                  nonce BLOB NOT NULL, ct BLOB NOT NULL,
                  updated_at INTEGER NOT NULL )
    config      ( singleton; clear TEXT params + PRIVATE column )
                  private column: AUTH_UI, AUTH_CLOCK (server-readable)
                  clear fields: salt, iters, wrapped
    staged      ( uid TEXT PRIMARY KEY, first_seen INTEGER NOT NULL )
                  approximates "photos in flight"; see §17
    (acks are fire-and-forget bookkeeping; not persisted)

  D1 (backup target only, written by daily cron, §19):
    backup      ( day TEXT, id TEXT, ver INTEGER, nonce BLOB, ct BLOB )
    config_backup ( day TEXT, clear params, private column )

  R2 (photo bytes only, §15/§17):
    p/{uid}.pv          sealed preview        PERMANENT
    p/{uid}/{n:04d}     sealed original chunk STAGING (deleted on ack)

  Capacity note: 40k photos ~= 79 photo_index buckets ~= 3.3MB in DO SQLite.
  Structured rows are a few hundred envelopes. DO free tier is never a
  constraint at single-user scale.

8. ENDPOINTS: BOOTSTRAP AND CONFIG
--------------------------------------------------------------------------------
  PUT /bootstrap
    Auth: Authorization: Bearer <ADMIN_SECRET>   (Worker env secret, set at
    deploy by the owner; the only admin credential; rotate via wrangler).
    Body:
      { "salt":   "<hex32>",
        "iters":  100000,
        "wrapped":"<b64, 48B = 12B nonce || 32B ct+tag of AES1 under KEK>",
        "auth_ui":    "<hex64>",
        "auth_clock": "<hex64>" }
    Semantics:
      * If config is empty  -> create config, store params + private column,
                               200 {"ver":1}.
      * If config exists    -> 409 {"error":"exists"}. Re-bootstrap requires
                               ADMIN_SECRET + {"force":true} and DESTRUCTIVELY
                               wipes all rows + staged + R2 p/* (documented,
                               deliberate: no silent re-key path).
      * Wrong ADMIN_SECRET  -> EMPTY 404 (silent drop; no existence oracle).
    The CLI performs bootstrap; it generates salt, AES1, subkeys, AUTH_*.

  GET /config
    Auth: AUTH_UI or AUTH_CLOCK. Returns CLEAR params only:
      { "salt":"<hex32>", "iters":100000,
        "wrapped":"<b64>", "ver":N }
    The private column is never returned. Clients use this to derive keys.

  PUT /bootstrap/rewrap
    Auth: ADMIN_SECRET. Body:
      { "wrapped":"<b64, 48B>", "salt":"<hex32>" }   // salt optional
    Semantics: atomically replaces the wrapped AES1 blob (and, if present,
    the KDF salt) in config. Touches NOTHING else — no rows, no staged,
    no private column. This is the Type A rotation route (§20).
    200 {} ; wrong ADMIN_SECRET -> empty 404.

9. ENDPOINTS: ROW SYNC
--------------------------------------------------------------------------------
  GET /rows
    Auth: AUTH_UI or AUTH_CLOCK. Returns manifest (clear metadata; ids are
    random/pseudonymous by construction):
      { "rows": [ {"id":"...", "ver":N}, ... ] }
    Excludes the config row.

  GET /rows/{id}
    Auth: either token. 200 -> full envelope:
      { "id":"...", "ver":N, "nonce":"<b64>", "ct":"<b64>" }
    Missing -> 404 {"error":"not_found"} (authenticated 404, see §5).

  PUT /rows/{id}
    Auth: AUTH_UI ONLY (the clock never writes rows; it acks via WS, §11).
    Body: envelope without id: { "ver":N, "nonce":"<b64>", "ct":"<b64>" }
    RMW arbitration (the only server-side merge logic in the whole protocol):
      incoming.ver > stored.ver  -> accept, store, return 200 + stored env
      incoming.ver <= stored.ver -> REJECT silently-as-rebase:
                                    return 200 + CURRENT stored envelope
    Clients distinguish outcomes by comparing returned ver with their
    submitted ver; on mismatch they rebase (re-read, re-apply, re-send with
    ver = stored.ver + 1).
    Body ct > ROW_CT_MAX -> 400.

  DELETE /rows/{id}
    Auth: AUTH_UI ONLY. 200 {} on success (idempotent: also 200 if absent).
    Used for: calendar bucket rotation (sliding window), todo roll-off,
    photo_index correction. NOT used for photo staging (that is ack-driven).

  notes
  * There are no table endpoints. Row ids carry the namespace; the row store
    is flat. This keeps the trusted surface at zero merge logic beyond ver.
  * Total row count is bounded by client discipline (§12-§16 caps); the
    server does not enforce content caps it cannot see.

10. ENDPOINT: STATUS
--------------------------------------------------------------------------------
  GET /status
    Auth: either token. Clear, tiny:
      { "photo_pending": N }
    N = |staged| — uids currently holding staging objects in R2 (§17).
    Acked uids are removed from the set, so the counter self-corrects.
    Approximate by design; the index is ground truth (clients decrypt
    buckets and diff).
    Leak analysis: chunk PUTs already expose staging counts as key metadata;
    this reveals nothing new. Used by the phone UI ("clock has N to pull")
    and folded into the WS status frame (§11).

11. WEBSOCKET RADAR
--------------------------------------------------------------------------------
  GET /ws  (Upgrade)
    Auth: AUTH_UI or AUTH_CLOCK on the upgrade request. Class binding: the
    server tags each connection ui or clock and enforces origin rules below.
    Server: Durable Object websocket, HIBERNATION enabled — the DO wakes on
    frame, relays, sleeps. No frame storage, no delivery guarantee; rows are
    truth, WS is a nudge.

  Frame (binary):
    kind    u8      0x01 = status, 0x02 = event
    ts      u32     Unix seconds
    nonce   12B
    ct      AES-256-GCM(K_c2u, nonce, plaintext, AAD = "ws")

  status plaintext (JSON, both directions, fields optional/null as n/a):
    { "src":"clock"|"ui", "battery":u8|null, "charging":bool|null,
      "state":"present"|"away"|"night"|null, "photo_pending":u32|null }
    clock sends battery/charging/state; ui sends state (presence assessment)
    and photo_pending (mirrors GET /status for the clock's UI).

  event plaintext (JSON):
    { "event":"ring"|"silenced"|"snoozed"|"exit_proof", "alm":"alm:{uuid}" }
    Direction rules (server-enforced by connection class, plaintext unseen):
      clock -> ui : ring, silenced, snoozed
      ui    -> clock : exit_proof
    A DO MUST NOT relay a frame to the SAME class it originated from, and
    MUST NOT let a clock-class connection originate exit_proof (the
    require_exit proof comes only from an authenticated UI session).
    Replay: receivers reject |now - ts| > EVENT_REPLAY_WINDOW.

  Keepalive & lifecycle:
    client ping frame every WS_PING_INTERVAL (+-jitter); server closes idle
    connections after WS_IDLE_CLOSE; clients reconnect with jittered backoff
    30s -> 600s (storms protection; counted in the M6 quota audit).

12. ROW TYPE: ALARMS
--------------------------------------------------------------------------------
  id          "alm:{uuid4}"        count cap 12 (client-enforced; oldest
                                   disabled row evicted by the phone fork)
  writer      AUTH_UI (phone Clock fork / CLI)
  reader      clock (caches >=14 days ahead; L4 offline authority)
  payload     JSON:
    { "kind":"weekly"|"once",
      "days": 0..127,             // weekly: bit0=Mon .. bit6=Sun
      "date": "YYYY-MM-DD",       // once only
      "hh": H, "mm": M,           // H:M; CLIENT-enforced floor 05:00
      "label": "text",
      "enabled": bool,
      "require_exit": bool }

  Semantics:
  * kind weekly fires on masked weekdays; kind once fires on date and is
    then self-suppressed (phone sets enabled=false after the ring event;
    the clock locally suppresses re-fire even if the phone was offline).
  * 05:00 floor: client-enforced convention (§1). A decrypted alarm with
    hh < 5 is treated as corrupted and ignored by the clock.
  * require_exit=true: the clock rings with escalation (repeat every 5 min)
    until an exit_proof event (§11) arrives for that alarm id. Local
    dismiss-at-clock is NOT honored for require_exit rows. require_exit=false
    rows dismiss at the clock normally.
  * Trigger authority is ALWAYS the clock (L4). The phone proposes, the
    clock fires. Ring/silenced/snoozed flow back as clock events.
  * The clock ACKs alarms as WS events, never as row writes.

13. ROW TYPE: CALENDAR BUCKETS
--------------------------------------------------------------------------------
  id          "cal:{yyyymmdd}"     sliding window of 23 live buckets
                                   [today-1 .. today+21] (client-enforced;
                                   writers rotate: DELETE buckets that slide
                                   out, create buckets that slide in)
  writer      AUTH_UI, two writers: DAVx5 fork and trudido fork
  reader      clock (renders today + next 7 days from cached buckets)
  payload     JSON:
    { "events": [
        { "id":"d:{uuid}"|"t:{uuid}",   // ownership prefix, immutable
          "date":"YYYY-MM-DD",
          "hh":H, "mm":M,
          "title":"text",
          "priority":u8 }               // 0 = highest
      ] }

  Dual-writer merge (the heart of the calendar):
  * Ownership: a writer creates/edits ONLY rows whose entries carry its own
    prefix ("d:" = DAVx5, "t:" = trudido). It NEVER rewrites the other
    prefix's entries. The daily RMW is a union over both prefixes.
  * RMW + ver: same envelope rule as §9. A writer's RMW is accepted iff
    incoming.ver > stored.ver; otherwise it receives the current bucket and
    rebases (re-applies its own change on top of the union it just read).
  * Capacity: <=16 events per bucket-day. A writer over cap drops ITS OWN
    lowest-priority entries (never the other writer's) and surfaces the
    drop in its UI.
  * The clock never writes calendar rows.

14. ROW TYPE: TODOS  (first-class as of v4.1)
--------------------------------------------------------------------------------
  id          "todo:{uuid4}"       count cap 64 (client-enforced)
  writer      AUTH_UI (trudido fork only)
  reader      clock (renders read-only list), other UI clients
  payload     JSON:
    { "text":"...",
      "done": bool,
      "done_at": u32|null,          // set when done=true
      "pri": u8 }                   // 0 = highest

  Working set rule (client-enforced, trudido):
    sync set = all rows with done=false, PLUS done=true rows with
    done_at within the last 7 days. Older completed todos roll off:
    trudido DELETEs their rows (§9) while Hive (local truth) retains them.
  * Hive is the source of truth; cloud rows are a mirror/cache.
  * Conflict policy: last-writer-wins per row id via ver; trudido re-reads
    before local mutation; divergence window is one sync cycle.
  * The clock does not complete todos (render-only).

15. PHOTO CRYPTO PROFILE (v4.1 — the NaCl domain)
--------------------------------------------------------------------------------
Two crypto domains coexist by design (L2): rows/WS/auth use AES-GCM
(§6, §11 — hardware on ESP32-S3); photo BYTES use the NaCl family, matching
ente's rust core primitives (secretbox.rs / stream.rs) for fork reuse.

15.1 Key material
    K_photo     32B random per photo, generated by the uploader at seal
                time. Never stored in the clear; never derived from
                content. One photo, one key, forever.
    wrap        K_photo is wrapped under K_wrap (HKDF from AES1, §3):
                AES-256-GCM(K_wrap, nonce, K_photo, AAD = ASCII("kp:"+uid))
                nonce = HKDF-SHA256(ikm = K_wrap, info =
                          "clock-v4/K_photo_nonce" || uid), 12B
                DETERMINISTIC per uid — safe because the wrapped key is
                fresh random material per photo (no two uids share keys).
                Wrapped form is 48 bytes (32 ct + 16 tag), stored INSIDE
                the photo_index entry (§16) -> the index row is the single
                capability for preview + original, and rotation re-wraps
                entries instead of re-encrypting bytes (§20).

15.2 Preview sealing (secretbox XSalsa20-Poly1305)
    body = nonce(24B) || secretbox(K_photo, nonce, preview_bytes)
    preview plaintext <= PREVIEW_PT_MAX (256KiB); source preview is a
    client-side downscale (long edge per client policy; R2 storage budget
    in plan §12).

15.3 Original sealing (secretstream XChaCha20-Poly1305, chunked)
    state = crypto_secretstream_xchacha20poly1305_init_push(K_photo)
    chunk 0     body = header(24B) || ct(<=1MiB, +17B tag)
    chunk 1..N  body = ct(<=1MiB, +17B tag)          [stream continues]
    final chunk tagged FINAL; N = ceil(size / 1MiB), N <= 9999 (§2).
    Streaming-friendly (resumable uploads/pulls), per-frame authenticated,
    tamper-evident end to end. Chunk boundaries land on exact 1MiB
    plaintext multiples; only the final chunk may be short.

15.4 Integrity bookkeeping
    sha256 computed by the uploader over the PLAINTEXT at seal time; the
    entry carries sha16 (first 8 bytes, hex). The clock verifies sha16 on
    pull (corruption check). Full-hash verification is optional upstream.

15.5 Argon2id: NOT used on the wire. ente fork internals may keep Argon2id
    where its own code expects it (local vault derivation); the protocol
    depends only on secretbox + secretstream. Our KDF remains PBKDF2-SHA256
    (§3) — one KDF decision, made once.

15.6 R2 object layout (server-side, keys visible to server — metadata only)
    p/{uid}.pv          permanent sealed preview
    p/{uid}/{n:04d}     staging chunks, n zero-padded 4 digits
    No other object classes exist. R2 never holds plaintext. Staging is
    deleted on ack (§17); a daily cron sweeps staging older than
    STAGING_MAX_AGE (14d) as the failure-path backstop (§19).

16. ROW TYPE: photo_index BUCKETS  (v4.1)
--------------------------------------------------------------------------------
  id          "P{yyyymm}"          one bucket per calendar month
              "P{yyyymm}-2"        overflow, then "-3", "-4", ...
  writer      AUTH_UI (CLI in era A; ente fork in era B; §17 flow)
  reader      clock (manifest of record for PHOTO_PULL), other UI clients
  payload     FIXED-SIZE BINARY (defeats count/length oracle):

    bucket := hdr(16B) || entry x 512 (padded, fixed 80B each)
    hdr    := magic "PIDX"(4B) || fmt u8(=1) || reserved(3B)
              || yyyymm u32 || count u16 || next_overflow u8 || reserved(1B)
    entry  := uid          12B   (raw bytes; hex form used on routes)
              sha16         8B   (raw bytes; sha256[0:8])
              bytes        u32   (original plaintext size)
              taken_ts     u32   (EXIF-derived, 0 if unknown)
              flags         u8   (bit0 = deleted-tombstone)
              k_wrapped    48B   (K_photo wrapped, §15.1)
              reserved      3B   (zero)

    plaintext = 16 + 512*80 = 40,976B; ct = +16 = 40,992 <= ROW_CT_MAX.
    Unused slots are ZERO-FILLED — ciphertext length is constant for a
    given bucket, leaks nothing about fill level.
    The bucket's envelope ver doubles as the bucket head ver for RMW.

  Rules:
  * 40k photos ~= 79 buckets ~= 3.3MB in DO SQLite (plan §12 budget holds).
  * count = live (non-tombstone) entries in THIS bucket.
  * Deletion is tombstone-first (flags bit0) so deletes replicate by row
    sync; tombstones are purged by the writer when a bucket compacts.
  * Uploader writes the bucket AFTER all bytes are staged in R2 (§17):
    the index row is the commit record.
  * uid filenames make SD writes idempotent (uid.jpg); sha16 verifies.

17. BLOB ROUTES  (v4.1 — 5 routes, both bearer classes, L3 everywhere)
--------------------------------------------------------------------------------
  PUT /blob/pv/{uid}
    Auth: AUTH_UI. Body: sealed preview (§15.2), <= 24 + 256KiB + 16.
    Server: stores to R2 p/{uid}.pv, adds uid to staged if new (§7).
    200 {} ; oversize -> 400.

  GET /blob/pv/{uid}
    Auth: either. 200 -> body bytes; missing -> 404 {"error":"not_found"}.
    (Clock fetches previews lazily for display.)

  PUT /blob/orig/{uid}/{n:04d}
    Auth: AUTH_UI. Body: sealed chunk (§15.3).
      n = 0 -> body = header(24) || ct; n > 0 -> body = ct only.
    Server: stores p/{uid}/{n:04d}; uid added to staged on first PUT of
    that uid (any n; retries are idempotent same-key overwrites).
    200 {} ; oversize -> 400.

  GET /blob/orig/{uid}/{n:04d}
    Auth: either. 200 -> chunk bytes; missing -> 404 {"error":"not_found"}.

  POST /photo/ack
    Auth: either (clock acks in era A/B; CLI may ack in tests).
    Rate: ACK_RATE_MAX 120/min per principal (server-enforced).
    Body: { "uid":"<hex24>" }
    Semantics (ACK-THEN-DELETE — the pipeline's atomicity, §7.6 of plan):
      1. delete all p/{uid}/* staging objects from R2
      2. remove uid from staged (photo_pending --)
      3. 200 {}
    Idempotent: acking an unknown/already-acked uid is 200 {} (no-op).
    The ACK does NOT touch photo_index rows; tombstoning/removal from the
    index remains a writer-side (AUTH_UI) row operation.

  Upload commit order (era A CLI and era B fork both):
    seal -> PUT pv -> PUT orig chunks (0..N) -> RMW photo_index bucket
    (PUT /rows/P{yyyymm}) -> [clock pulls, acks] -> staging deleted.
    A crash before the index write leaves orphan staging that the 14d
    sweep reclaims; a crash after it leaves a pullable photo. No window
    where the index references missing bytes.

18. PHOTO_PULL SESSION SUB-PROTOCOL  (v4.1, clock-driven)
--------------------------------------------------------------------------------
Gate (ALL must hold, clock-local): charging AND WiFi associated AND outside
the bed window (clock-local schedule). Outside the gate the clock does not
pull, period — the pipeline waits for the next night.

Session run (per night, caps: PULL_MAX_PHOTOS=400, PULL_MAX_MINUTES=45):
  1.  GET /rows                     (manifest; note P* bucket versions)
  2.  GET /rows/P{yyyymm} [...]     decrypt buckets, build server entry set
  3.  diff vs SD inventory + journal -> work list (uids missing on SD,
       non-tombstone), oldest taken_ts first
  4.  for each uid on the work list:
        unwrap K_photo from k_wrapped (§15.1)
        GET /blob/pv/{uid} (optional, display cache)   [lazily, any time]
        for n = 0 .. ceil(bytes/1MiB)-1:
            GET /blob/orig/{uid}/{n:04d}
            secretstream-decrypt (chunk 0 consumes the 24B header)
            append journal frame CHUNK_DONE {uid, n}   (CRC32, see below)
        verify sha16 (§15.4); mismatch -> discard file, journal ERROR,
               do NOT ack, surface in next status
        rename to /photos/{YYYY}/{MM}/{uid}.jpg  (YYYY/MM from taken_ts;
               taken_ts == 0 -> "undated/")
        journal frame PHOTO_DONE {uid}
        POST /photo/ack {"uid"} -> journal ACK_SENT {uid}
  5.  session ends on: work list empty | 400 photos | 45 min | gate lost

Journal (local SD file, append-only, per-frame integrity):
    frame := len u16 || crc32 u32 || type u8 || payload
    types : SESSION_START, CHUNK_DONE{uid,n}, PHOTO_DONE{uid},
            ACK_SENT{uid}, ERROR{uid,reason}, SESSION_END
    Crash recovery: on boot, replay journal; CHUNK_DONE without PHOTO_DONE
    -> truncate partial file, redo that photo; PHOTO_DONE without ACK_SENT
    -> re-ack only (bytes are safe, uid filenames are idempotent).
    Journal compacts after a fully-acked, fully-reconciled session.

  * photo_pending ground truth is computed by the clock itself from bucket
    diffs (§10 note); /status and WS mirrors are convenience only.
  * The clock never writes rows and never holds AUTH_UI (L4 + least
    privilege: AUTH_CLOCK is GET-only for blobs, ack-only for photos).
  * Previews are optional display-side; an SD archive is complete without
    any preview ever fetched.

19. BACKUP AND RESTORE  (scope extended in v4.1)
--------------------------------------------------------------------------------
  Cron (Worker scheduled, daily 03:00 UTC):
    1. copy every row from DO rows -> D1 backup(day=today, ...)
    2. copy config clear params + private column -> config_backup(day)
    3. prune backup/config_backup rows older than BACKUP_RETENTION (7 days)
    4. staging sweep: list R2 p/* where any object older than
       STAGING_MAX_AGE -> delete that uid's staging objects, remove from
       staged (§15.6 backstop; the index row survives, uploader re-stages
       on demand)
  Backup volume: ~100 rows/day at full working set (1 config + 12 alarms +
  23 cal + 64 todos + photo_index buckets).

  Restore (CLI drill, M6 exit criterion in the plan):
    read D1 snapshot for day -> re-create config -> PUT /rows/* envelopes
    verbatim (ver values preserved) -> clock re-syncs from rows; R2 previews
    for already-acked photos are NOT in D1 (they live only in R2); the drill
    therefore restores state, not bytes — original photos live on SD and on
    source devices by design (plan §7.6).

20. KEY ROTATION  (extended in v4.1)
--------------------------------------------------------------------------------
  Type A — PASSWORD change (routine):
    new salt, KEK' = PBKDF2(new PASSWORD, salt'), re-wrap AES1 under KEK';
    CLI calls PUT /bootstrap/rewrap (§8) with {wrapped', salt'} — an
    atomic config-params update that touches no rows and no bytes.
    No data re-encryption anywhere. Clients re-unlock with the new
    PASSWORD. Clock NVS untouched (AES1 unchanged).
  Type B — AES1 compromise (rare, structural):
    1. DRAIN: photo staging must reach zero (every staged uid acked);
       photo_pending == 0 is the pre-commit gate.
    2. QUIET: no row writes for the rotation window (minutes at this scale).
    3. CLI generates AES1', derives K_*', re-encrypts EVERY row (fresh
       nonce, ver + 1 each), PUTs them all.
    4. CLI re-wraps every k_wrapped entry field under K_wrap' (K_photo
       values unchanged) -> preview bytes, original chunks, and SD archive
       are ALL untouched (they are sealed under K_photo, rotation-invariant
       by construction).
    5. New AUTH_UI', AUTH_CLOCK' registered (Type B implies token rotation).
    6. Commit config (new wrapped, new salt optional); re-provision clock
       NVS over the setup channel; phones re-derive at next unlock.
  Invariant: rotation NEVER re-encrypts photo bytes. Worst case re-encrypts
  a few hundred small rows and re-wraps ~40k x 48B entry fields.

21. CAPS AND RATE LIMITS (consolidated)
--------------------------------------------------------------------------------
  Server-enforced (visible in clear):
    row ct                     <= 64KiB
    preview body               <= 24 + 256KiB + 16
    chunk body                 <= 1MiB + 17 (chunk 0: +24 header)
    chunk count per photo      <= 9999 (4-digit index)
    ack rate                   <= 120/min per principal
    unauthenticated anything   -> empty 404 (silent drop)
  Client-enforced (conventions; server cannot see them):
    alarms <= 12, floor 05:00
    calendar 23 buckets, <=16 events/day, id-prefix ownership
    todos <= 64, working set = open + 7-day done
    photo_index 512 entries/bucket (+overflow rows)
    pull 400 photos / 45 min / session, gate = charging+WiFi+not-bed
    WS ping 300s +-60s, backoff 30->600s
  Rationale: caps that map to real budgets (flash wear, thermal, free tier,
  R2 10GB) are worth their complexity; caps that only map to paranoia are
  client-side discipline, not wire law.

22. VERSIONING AND COMPATIBILITY
--------------------------------------------------------------------------------
  * This document is protocol version 4.1. GET /version (auth: either)
    returns { "proto":"4.1" } — clear, metadata only.
  * Additive evolution bumps the MINOR (4.2): new optional fields, new row
    types, new routes. Clients MUST ignore unknown JSON fields and unknown
    journal frame types.
  * Breaking changes bump MAJOR and require a migration plan (none planned;
    the rotation machinery of §20 is the migration vehicle if one ever is).
  * Clients advertise nothing; the server is version-blind beyond /version.
  * Rule of thumb maintained from v4.0: if a change cannot be explained in
    one paragraph as "more opaque bytes, same trust model", it does not go
    into a minor version.
