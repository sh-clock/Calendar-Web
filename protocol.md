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
| `GET /rows`              | ui/clock | — | manifest `{rows:[{id,ver}]}`           |
| `GET /rows/{id}`         | ui/clock | — | envelope or 404 `{error:"not_found"}`  |
| `POST /rows:batch`       | ui/clock | NEW | §9b                                    || `PUT /rows/{id}`         | ui     | —   | RMW arbitration, §9                    |
| `DELETE /rows/{id}`      | ui     | —   | idempotent                             |
| `PUT /bootstrap`         | admin  | —   | §8 (unchanged)                         |
| `PUT /bootstrap/rewrap`  | admin  | —   | §20 Type A rotation (unchanged)        |
| `POST /internal/backup`  | internal | — | §19 cron snapshot (unchanged)          |

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

### §9 PUT /rows/{id} (UNCHANGED semantics, restated)

- No stored row: accept any `ver ≥ 1`, store, echo the submitted
  envelope (200).
- Stored row, `incoming.ver > stored.ver`: accept, store, echo submitted
  envelope (200).
- Otherwise: reject-as-rebase — store nothing, return the CURRENT stored
  envelope (200). The client detects acceptance by envelope identity
  (nonce equality), not by status code.
- `ver` is a u32 ≥ 1; `nonce` is 12 bytes base64 (canonical, padded);
  `ct` ≤ 65536 bytes base64.
- DELETE+PUT is the calendar-move procedure (evt row ids embed the
  calendar uuid): `DELETE evt:{oldcal}:{uid}` then
  `PUT evt:{newcal}:{uid}`. Between the two the event is absent — a
  concurrent reader may observe the gap; clients reconcile at next sync.

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
update times, envelope sizes. NOTHING about event content. This is the
documented v4.1 trade-off; v4.3 does not change it.

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
