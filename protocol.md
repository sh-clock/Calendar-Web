# PROTOCOL v4.3 — Encrypted Clock Ecosystem, calendar domain

Copyright © 2026 — GPLv3 (see LICENSE). Normative specification of the wire
protocol spoken between the calendar web client (this repo), the Cloudflare
Worker + Durable Object (`worker/`), and future clients (the clock device,
the DAVx⁵ fork).

v4.3 supersedes v4.2 (docs/PROTOCOL-v4.2.md). It exists because v4.2's
client-side maintenance of derived day buckets made every mutation cost
24–58 HTTP requests and coupled rendering to a long, fragile write chain.
v4.3 changes ONLY the client's sync strategy and adds ONE read endpoint;
the storage model, envelope crypto, auth and threat model are unchanged.

```
CHANGES v4.2 → v4.3                                     server   client
  §9b  NEW      POST /rows:batch (bulk envelope read)      ADD      USE
  §13  REMOVED  client-side bucket rotation/derivation     —        STOP
  §13c NEW      clock preview = LOCAL derivation           —        USE
  §11  CHANGED  mutations update local state directly      —        USE
  §22  version  proto := "4.3"                             BUMP     soft-gate
```

## 1. Threat model (UNCHANGED from v4.1 — normative)

The Worker/Durable Object is an **untrusted relay (L1)**. It stores and
returns opaque envelopes, compares only the clear integer `ver`, and **can
never read or infer any event data**: row payloads are AES-256-GCM
ciphertext under `K_data`, which exists only on unlocked clients
(browser/clock/DAVx fork) — never on the server, never in Worker memory,
never in logs. `POST /rows:batch` (§9b) changes nothing here: the Worker
concatenates and returns envelopes verbatim without interpreting them.
The server sees: row ids (see §7 for what ids leak by design), vers,
envelope byte lengths, and request timing. That is the entire surface.

**Capability handles (sec-S6-F2, clarified):** "zero-knowledge" here means
*content* zero-knowledge. The server necessarily stores — and backs up to
D1 (§19) — the derived AUTH_UI/AUTH_CLOCK bearer tokens, because the bearer
gate must compare them. A server-side compromise (or the account owner)
can therefore read and write ciphertext envelopes, but never decrypt them.
Event UIDs are part of that server-visible metadata surface — see the §2
opacity requirement.

## 2. Storage model (UNCHANGED from v4.2)

The Durable Object keeps one SQLite table of opaque rows:

| column     | type    | meaning                                    |
|------------|---------|--------------------------------------------|
| `id`       | TEXT PK | row id (grammar in §7)                     |
| `ver`      | INTEGER | monotonic u32, client-supplied (§9)        |
| `nonce`    | BLOB    | 12-byte GCM nonce (opaque to server)       |
| `ct`       | BLOB    | ciphertext+tag, ≤ 64 KiB (opaque)          |
| `updated_at`| INTEGER| unix seconds (hygiene only)                |

Row id grammar (unchanged):
- `cmeta:{uuid-v4}` — calendar metadata row. Payload (plaintext, after
  decrypt): `{"v":1,"name":str≤100,"color":"#RRGGBB"}`.
- `evt:{cal-uuid}:{uid}` — one event "file": payload is RFC 5545
  VCALENDAR text, exactly one UID, master VEVENT + RECURRENCE-ID
  exceptions (see docs/PROTOCOL-v4.2.md §5 — still normative).
- `cal:{yyyymmdd}` — **DEPRECATED day buckets** (see §13c).

**UID opacity (sec-S6-F1, normative):** event `uid`s MUST be
content-independent (a UUID). Row ids are server-visible metadata (§7):
manifest, request URLs, D1 `backup.id`. A slugified event title in a uid
puts the SUMMARY in that metadata — a §1 invariant break. Clients that
generate ids MUST use `crypto.randomUUID()` (or equivalent CSPRNG output
carrying no payload-derived bytes).

**Envelope bounds (sec-S7-F5, normative):** `ct` is `16 ≤ len ≤ 65536`
DECODED bytes — a legal AES-256-GCM ciphertext is never shorter than its
16-byte tag. Sub-tag blobs are rejected with `400 bad_ct`.

**KDF iterations (sec-S7-F2, normative):** `iters` is server-validated in
the range **100 000 ≤ iters ≤ 10 000 000**. The floor is the anti-downgrade
wall (an admin cannot bootstrap a cheap-to-brute-force universe); the
ceiling matches what clients accept (`js/crypto.js` derives with whatever
`/config` reports). New universes SHOULD use ≥ 600 000 (OWASP 2023+
guidance for PBKDF2-HMAC-SHA256); a Type-A rewrap MAY raise `iters` in
place (§20 note in §9c-below).

## 3. Auth (UNCHANGED from v4.1 §4)

- `GET /config` returns CLEAR params only: `{salt, iters, wrapped, ver}`.
- Client derives: password --PBKDF2-HMAC-SHA256(salt, iters)--> KEK;
  KEK --AES-256-GCM unwrap--> AES1; AES1 --HKDF-SHA256(salt="",
  info="clock-v4/<domain>")--> subkeys (AUTH_UI, AUTH_CLOCK, K_data).
- Bearer gate: `Authorization: Bearer <hex64>`; class UI may read+write,
  class CLOCK may read only (403 empty body on writes); wrong/missing
  token → empty 404 (silent drop); unknown routes → empty 404.
- CORS allowlist at the Worker front door (unchanged).

## 4. Endpoints

| method & path            | class | v4.3 | notes                                  |
|--------------------------|-------|------|----------------------------------------|
| `GET /version`           | ui/clock | — | `{"proto":"4.3"}`                      |
| `GET /config`            | ui/clock | — | clear bootstrap params                 |
| `GET /status`            | ui/clock | — | `{"photo_pending":0}` (calendar scope) |
| `GET /rows`              | ui/clock | — | manifest `{rows:[{id,ver}]}` + `etag`  |
| `GET /rows/{id}`         | ui/clock | — | envelope or 404 `{error:"not_found"}`  |
| `POST /rows:batch`       | ui/clock | NEW | §9b                                    |
| `PUT /rows/{id}`         | ui     | —   | RMW arbitration, §9                    |
| `DELETE /rows/{id}`      | ui     | —   | idempotent                             |
| `PUT /bootstrap`         | admin  | —   | §8 (unchanged)                         |
| `PUT /bootstrap/rewrap`  | admin  | —   | §20 Type A rotation (iters optional)  |
| `POST /internal/backup`  | internal | — | §19 cron snapshot                      |

**Transport hygiene (sec-S1/S8 hardening, normative):** every response
leaving the Worker carries `Vary: Origin` (the CORS-decorated and
undecorated variants of one URL differ) and
`Strict-Transport-Security: max-age=31536000`. A cleartext `http:` request
to a non-loopback host is upgraded with **308** to `https:` before any
auth/CORS logic runs (loopback is exempt — `wrangler dev` and the local
stacks are http by design). JSON responses and 304s carry
`Cache-Control: no-store` (no intermediary may replay a stale `/config` or
manifest); the silent drop deliberately carries NO freshness headers (§4
law: body-empty 404 with no `WWW-Authenticate` and no cache directives).
CORS-decorated responses expose the `ETag` header
(`Access-Control-Expose-Headers: ETag`) so browser clients can read the
§9d validator. An internal Worker error is indistinguishable from an
unknown route (empty 404) at BOTH the front door and the DO.

**§3 erratum (worker logs):** the v4.1 key-ledger line "Worker logs:
nothing, ever" is implemented as: exception CLASS tags only
(`store_error TypeError`) plus the backup cron's day/row COUNTS — never
ids, params, key material, or exception messages.

### §9b `POST /rows:batch` (NEW in v4.3)

Request body (JSON): `{"ids": [string, …]}` — at most **256** ids, each a
non-empty string ≤ 256 UTF-16 code units (the v4.1 §5 authenticated-
malformed id cap, carried over verbatim), all unique. Violations → `400 {error:"bad_ids"}`
(count/uniqueness) / `bad_id` (shape) / `bad_json` / `bad_body` (malformed
body). Response 200: `{"rows": [ … ]}` where each element is, **in request
order**:
- `{"id", "ver", "nonce", "ct"}` — the full envelope, byte-identical to
  what `GET /rows/{id}` would return, or
- `{"id", "missing": true}` — the row does not exist.

The endpoint is a pure read: the Worker resolves ids against SQLite and
relays envelopes; it never touches `nonce`/`ct`. It exists so that a sync
that discovers N changed rows costs ONE request instead of N (v4.2's
per-row GETs were the amplification root cause together with buckets).
A v4.2 worker returns the silent-drop empty 404 for this route; v4.3
clients fall back to per-row `GET /rows/{id}` (see §5.1c and §8 for the
browser-vs-non-browser nuance).

### §9d `GET /rows` conditional read (v4.3 addition, efficiency)

`GET /rows` now returns an `etag` field alongside the manifest:
`{"rows":[{id,ver}…], "etag":"e<epoch>"}`, and answers a matching
`If-None-Match` with **304** (empty body, `ETag` header set) when nothing
has mutated since.

- The **epoch** is a server-side mutation counter: +1 for every accepted
  row INSERT, accepted UPDATE and REAL delete (an idempotent re-delete of
  a missing row does not bump it). Row reads never bump it. The bump rides
  the SAME SQLite statement as the row mutation (AFTER-INSERT/UPDATE/DELETE
  triggers on the `rows` table — sec-S4-2), so no crash window can leave
  the etag stale, and a **force re-bootstrap's wipe bumps it per destroyed
  row** (sec-S4-1/S8-F1: a client holding a pre-wipe etag is never answered
  a ghost 304).
- `If-None-Match` forms (RFC 9110 §13.1.2, weak comparison): the exact
  quoted `"e<epoch>"`; a `W/`-prefixed weak tag of the same value; a LIST
  containing any current tag; or `*` (the manifest resource always has a
  current representation → 304). A malformed value falls through to the
  plain 200 (§13.1.2 evaluation rule 3: "otherwise, the condition is true").
- Additive and interoperable in both directions: clients that send no
  `If-None-Match` always get a plain 200; servers without the extension
  ignore the header and answer a plain 200 (old clients ignore the new
  `etag` field per §22 ignore-unknown-fields). A v4.3 client MUST treat
  304 as "manifest unchanged" and keep its local state.
- Motivation: an idle 60 s autosync re-downloaded the full manifest
  (~94 B/row — ~4.6 MB over an 8-hour day at 100 rows). With the
  conditional read an unchanged poll costs one request with ~0 bytes.
- Threat model (§1) unchanged: the etag leaks only a mutation COUNTER —
  no row ids, no vers, no payload-derived data. The server still
  compares only clear integers.

### §9c PUT conditional mode (NEW in v4.3.1 — DAV compatibility, RFC 9110-exact)

Clients MAY send standard HTTP conditional headers with `PUT /rows/{id}`.
They are evaluated in the RFC 9110 §13.2.2 order — **If-Match first
(strong comparison), then If-None-Match (weak comparison)**:

- `If-Match: *` — exists-check: proceeds iff the row exists; a missing row
  → **412** (empty body).
- `If-Match: "<ver>"` — a list of STRONG entity-tags: proceeds iff one
  equals the current row etag (the decimal `ver` string) by EXACT opaque
  equality — `W/"5"` never matches `"5"`, and `"05"` is not `"5"`. A
  mismatch (or a missing row — no current representation, so nothing can
  match) → **412** (empty body).
- `If-None-Match: *` — create-only guard: 412 iff the row already exists.
- `If-None-Match: "<ver>"` (or a list) — 412 when the CURRENT row etag
  weak-matches any listed tag (weak comparison: `W/"5"` ≡ `"5"`). This is
  the DAV lost-update guard.
- A malformed `If-Match` (not `*` / not a quoted-tag list) →
  `400 bad_if_match` (fail closed). A malformed `If-None-Match` is
  IGNORED per §13.1.2 rule 3 ("otherwise, the condition is true") — the
  PUT proceeds under the plain §9 RMW law.
- When both headers are present, both are evaluated in order (If-Match
  step 1, If-None-Match step 3) — a passing If-Match does NOT suppress
  If-None-Match.
- On any 412 the response carries no envelope — the client should re-read
  the row (`GET`/`§9b`) to learn the current state, which is exactly
  CalDAV conflict-handling behavior.

`PUT /bootstrap/rewrap` (§20 Type A) additionally accepts an optional
`iters` field (validated in the §2 range), updated atomically with the new
`wrapped` — a password rotation can raise the KDF cost without a wipe
(sec-S7-F2).

This maps onto CalDAV `PUT` with `If-Match`/`If-None-Match` so that DAV
clients (the DAVx⁵ fork) get RFC 9110 semantics with real status codes.
The web client sends no conditional headers and keeps the 200+echo
arbitration of §9. The Worker still compares only the clear `ver` — it
never inspects `nonce`/`ct` (threat model unchanged).

### §9 PUT /rows/{id} (UNCHANGED semantics, restated)

- No stored row: accept any `ver ≥ 1`, store, echo the submitted
  envelope (200).
- Stored row, `incoming.ver > stored.ver`: accept, store, echo submitted
  envelope (200).
- Otherwise: reject-as-rebase — store nothing, return the CURRENT stored
  envelope (200). The client detects acceptance by envelope identity
  (nonce equality), not by status code.
- `ver` is a u32 ≥ 1; `nonce` is 12 bytes base64 (canonical, padded);
  `ct` is 16..65536 DECODED bytes, base64 (canonical, padded).
- **Calendar-move procedure (sec-S8-F2, corrected):** evt row ids embed
  the calendar uuid, so moving = `PUT evt:{newcal}:{uid}` FIRST, then
  `DELETE evt:{oldcal}:{uid}`. The create-before-delete order guarantees
  a PUT failure can never LOSE the event (wave-7 A2); a failed DELETE
  leaves a visible duplicate that the next sync reconciles. The transient
  state between the two is a DUPLICATE, not an absence.

## 5. Client sync strategy (§11 — CHANGED in v4.3, normative)

Reads and writes are **decoupled**:

1. **Sync (read-only, failure-tolerant):**
   a. `GET /rows` → manifest.
   b. Ignore `cal:` ids (deprecated, §13c). For each `evt:`/`cmeta:` id
      where the manifest ver differs from the locally cached ver (or the
      id is unknown, or the row is flagged corrupt → retry), collect it.
   c. If any: `POST /rows:batch` with the collected ids (≤256 per call;
      chunk larger sets). Degrade to per-row GETs when the server does
      not implement §9b — in the browser this is driven by the §5.4 version
      probe; the empty-404 detection only applies to non-CORS clients (§8).
   d. Decrypt+parse each returned row **individually**; a failing row is
      flagged corrupt and NEVER blocks the others. `missing` rows are
      dropped from local state. Render ALWAYS runs after a sync, with
      whatever succeeded.
   e. Cost: 1 request when nothing changed; 2 when anything did.
2. **Mutations (write path, no sync chain):**
   a. RMW the target row directly. The client already knows the current
      `ver` from its state (manifest-verged); encrypt payload with
      AAD(id, ver+1) and `PUT` it — **one request** in the common case.
   b. If the echo is not the submitted envelope (rebase), fetch the row
      (batch or GET), re-apply the (pure) build function to the fresh
      payload, and retry — at most 8 times.
   c. On acceptance, update local state (`ver`, new parsed payload) and
      re-render immediately. **No full sync follows a mutation.** The
      next sync picks up other devices' rows.
   d. A `DELETE` updates local state and re-renders immediately.
3. **Autosync (NEW, allowed because sync is now 1–2 requests):** poll
   every 60 s while the document is visible, plus once on focus/
   visibility change. It must never show a modal overlay nor block
   user input; concurrent runs are serialized behind one in-flight
   promise; a mutation in flight defers the poll.
4. **Version gate (soft):** after unlock, read `/version`. If the server
   is older than 4.3 the client still works (rows API unchanged) but
   uses per-row GETs and shows a non-blocking warning. A newer server
   must not break the client (additive changes only).

## 6. Day buckets (§13 — DEPRECATED in v4.3)

v4.2 clients derived 23 `cal:{yyyymmdd}` day-bucket rows (the v4.1 §13
clock projection) and re-wrote them on every mutation — the request
amplification and fragile write chain that motivated v4.3. In v4.3:

- Clients MUST NOT read, create, rotate, or write `cal:` rows.
- The clock preview in the web client is a **LOCAL derivation**
  (§13c) — same §13 format, computed in-memory from evt rows by the
  pure function `deriveWindowBuckets` (calendar-core.js).
- Existing `cal:` rows are a derived cache with no reader; deployments
  SHOULD delete them once (one-time cleanup; they are never source of
  truth — the v4.2 spec itself rotated/overwrote them freely).
- A future clock device holds K_data and reads evt rows directly (or a
  future protocol version may reintroduce server-side projections; that
  is out of scope here).

### §13c Local clock-preview derivation

`deriveWindowBuckets(parsedEvtRows, today)` — window [today−1, today+21];
per-day entries `{id:"x:"+projIdHash(cal,uid), date, hh, mm, title≤500,
priority 1|2}`, cancelled events excluded, ≤16 per bucket, deterministic
order — identical to the v4.2 projection (see docs/PROTOCOL-v4.2.md
§13/§13b for the normative hash and entry spec, unchanged).

## 7. What the server can infer (by design, unchanged)

Row ids (calendar uuid, event uid, deprecated day), vers and their
update times, envelope sizes. NOTHING about event content — **provided
clients honour the §2 UID-opacity requirement** (a content-derived uid
would leak its derivation input here). This is the documented v4.1
trade-off; v4.3 does not change it.

**§19 backup semantics (sec-S6-F3):** each daily D1 snapshot is EXACT —
the day's bucket is cleared before the inserts (deleted-earlier-today rows
do not linger until tomorrow). A snapshot for day D is the point-in-time
state of the LAST backup run during D (UTC); the cron fires at 03:00 UTC.
Private columns (AUTH tokens, wrapped) are replicated — same trust domain
as the DO itself (§1 capability handles).

## 8. Compatibility

- v4.3 worker ↔ v4.3 client: full behaviour (batch sync).
- **v4.3 worker ↔ v4.2 client: the v4.2 CLIENT hard-gates at unlock on
  `proto === "4.2"` and REFUSES to unlock against a 4.3 server.** There is
  no service worker, so a page reload fetches the v4.3 client and fixes it;
  but a long-lived cached tab will show "Login failed" until reloaded.
  (Wave-7 C1 — this matrix previously claimed compatibility; that was
  wrong for the shipped v4.2 client.)
- v4.2 worker ↔ v4.3 client: rows read/write work over per-row GETs. The
  §5.1c empty-404 batch degrade does NOT trigger in the browser against a
  genuine v4.2 worker, because the v4.2 front door's CORS allow-methods
  lacked POST — the batch preflight fails first (a `network` ApiError, not
  the silent 404). The effective protection is the §5.4 version probe,
  which disables batch for any server reporting < 4.3. Non-browser clients
  (no CORS) would hit the empty-404 path as described. (Wave-7 C3.)
- Envelope format, key hierarchy, bootstrap, rewrap, backup: unchanged.
- `GET /version` reports `"4.3"`.

## 9. Compliance notes for the DAVx⁵ fork (Task 2.2)

The fork maps CalDAV onto this store: href ↔ row id (`evt:{cal}:{uid}`),
ETag ↔ decimal `ver` string, PROPFIND-listing ↔ `GET /rows` manifest
diff, addressbook-multiget ↔ `POST /rows:batch` (or per-row GETs),
PUT-with-If-Match ↔ §9 RMW (rebase → 412 PreconditionFailed), DELETE ↔
idempotent delete. Crypto: PBKDF2 → AES-GCM envelope with AAD
`id || u32be(ver)` (js/crypto.js is the reference; KAT vectors in
test/crypto-parity.mjs). The worker's blindness (§1) is what makes the
fork safe against a hostile server.
