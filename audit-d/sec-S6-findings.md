# sec-S6 — Zero-Knowledge Invariant + Server Data Exposure

Agent S6 of the 8-agent coordinated audit. Target: **LIVE** Worker
`https://calendar-poc.sh-clock.workers.dev` (proto 4.3) + repo
`/home/z/my-project/calendar-web` (full read of `worker/src/store.js` (720 lines),
`worker/src/index.js`, `protocol.md`, `docs/PROTOCOL-v4.1.md` §3/§7/§19,
`js/crypto.js`, `js/api.js`, `js/calendar-core.js`, `js/app.js` (uid paths),
`worker/wrangler.jsonc`, seeding scripts).

Method: read-only live probes + dedicated `evt:sec-S6:*` test rows (all deleted,
verified via manifest), local `with-stack.sh` stack for exception-path +
wrangler-log + D1-snapshot evidence, one (1) production `/internal/backup` call
with the owner's INTERNAL_TOKEN for evidence. No repo modifications, no
bootstrap, no destructive live ops.

## TOP SUMMARY

| Severity | Count | Titles |
|---|---|---|
| HIGH | 1 | F1 — Plaintext event titles leak into row ids (live manifest shows 6 title-slug UIDs) |
| LOW | 2 | F2 — AUTH_UI/AUTH_CLOCK replicated into D1 `config_backup`; F3 — deletions don't propagate to same-day D1 backup buckets |
| INFO | 3 | F4 — `console.error('store error: '+e.message)` is not literally "counts only" (no payload-derived substring reachable — proof below); F5 — row ids travel in request URLs (edge/dev logging surfaces); F6 — local-vs-edge input-filter divergence (NUL ids, `%zz`) |

**Invariant verdict (short): the server CODE is content-blind — I could not make it
read, branch on, or log a single payload-derived byte; but the invariant is BROKEN
ON LIVE DATA by the client-side seeding tools, which put slugified event TITLES
into row ids (F1). The Worker/DO/D1 therefore demonstrably holds
plaintext-derived event data (titles) today.** Full verdict at the end.

---

## FINDINGS

### F1 [HIGH] — Plaintext event titles leak into row ids on the LIVE deployment

**Class:** invariant break (server data exposure) · **Root cause:** client-side
seeding tools, not the server code.

**Evidence (LIVE, 2026-11-01, owner AUTH_UI token, ids redacted to uid part):**
`GET /rows` → 200, 15 rows, `etag:"e21"`. Of 13 `evt:` rows, **6 carry
title-slug UIDs**:

```
evt    cal=<uuid-redacted> uid="lunch-with-alex-37cb2f68"            ver=1
evt    cal=<uuid-redacted> uid="weekend-trip-f4e789a3"               ver=5
evt    cal=<uuid-redacted> uid="monthly-retrospective-e9a418fa"      ver=1
evt    cal=<uuid-redacted> uid="project-review-3bd88884"            ver=2
evt    cal=<uuid-redacted> uid="team-standup-3b712671"               ver=6
evt    cal=<uuid-redacted> uid="welcome-to-calendar-v4-3-065f7c06"   ver=1
```
(The other 7 evt rows use random-UUID UIDs — created by the shipped web client,
which is safe: `js/app.js` `const uid = crypto.randomUUID();` inside `saveEvent`.)

**Code path:** `scripts/reseed-prod.mjs:75-78`
```js
const mk = (cal, title, props) => {
  const uid = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + randomUUID().slice(0, 8);
  return { id: 'evt:' + cal + ':' + uid, payload: vcal(uid, props) };
};
```
`scripts/seed-prod.mjs:124-190` does the same with fixed readable prefixes
(`'welcome-v43-'`, `'standup-'`, `'lunch-'`, `'review-'`, `'trip-'`, `'monthly-'`).

**Why this breaks the invariant:** `protocol.md` §1 (normative): the Worker/DO
"can never read or infer any event data". §7 quantifies the by-design leak as
"Row ids (calendar uuid, event uid, deprecated day), vers and their update
times, envelope sizes. **NOTHING about event content.**" A slugified UID *is*
event content (the SUMMARY). Every party the threat model worries about —
Cloudflare (DO SQLite, D1 `backup.id`, request URLs, any edge URL telemetry),
any AUTH_UI/AUTH_CLOCK token holder (manifest), the D1 backup file — can read
these six titles without the password. The titles also ride in URLs
(`PUT/GET/DELETE /rows/evt:<cal>:lunch-with-alex-37cb2f68`), compounding F5.
`protocol.md` §2 constrains the UID grammar in no way that forbids this, so the
spec text itself has a hole: it relies on clients choosing opaque UIDs and never
says so.

**Impact:** 6/13 live events have their titles exposed in cleartext to the
server-side namespace (and to anyone who ever gets a token or a log line with a
URL). Descriptions, times, locations, recurrence remain protected. It is demo
seed data (`credentials.json`: "PoC dummy credentials"), which caps real-world
damage but not the invariant breach.

**Fix (concrete):**
1. Migrate the 6 rows: for each, decrypt client-side, `PUT` under a fresh
   `evt:{cal}:{randomUUID()}` id, `DELETE` the old id (the web client's
   calendar-move procedure, protocol.md §9).
2. Change `reseed-prod.mjs:76` / `seed-prod.mjs` to `uid = crypto.randomUUID()`
   (keep the pretty title only inside the encrypted SUMMARY).
3. Accept the 7-day D1 prune for the old `backup.id` values, or purge the
   `backup` rows for the affected days in D1; note deleted ids also linger in
   DO SQLite free pages until natural reuse (inherent, ciphertext-class risk only).
4. Spec hardening: protocol.md §2 should state "event UIDs MUST be
   content-independent (e.g. UUID) — ids are server-visible metadata".

---

### F2 [LOW] — AUTH_UI/AUTH_CLOCK are replicated into D1 `config_backup` (capability blast radius)

**Class:** documented design, honest severity assessment (scope item 3).

**Code:** `store.js:696-705` — `hBackup` copies the full config row into D1:
```js
db.prepare('INSERT OR REPLACE INTO config_backup (day, salt, iters, wrapped, auth_ui, auth_clock, ver) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .bind(day, cfg.salt, cfg.iters, cfg.wrapped, cfg.auth_ui, cfg.auth_clock, cfg.ver)
```
**Evidence (local stack, D1 snapshot dump of the miniflare D1 file):**
`config_backup` = `{day:"2026-11-01", salt:"b042dd1f…", iters:100000, wlen:60,
auth_ui:"d3997c10…[redacted, 64 hex]", auth_clock:"b94e0297…[redacted]",
ver:3}` — full bearer tokens present.

**Assessment:** the DO itself already stores `auth_ui`/`auth_clock` (the bearer
gate must compare them; `docs/PROTOCOL-v4.1.md:132-135`: "They are the ONLY
server-readable secrets"), and `docs/PROTOCOL-v4.1.md:216-218` documents the D1
`config_backup` private column. So the *content* zero-knowledge property
(K_data never server-side) is untouched — the tokens grant read/write API
access, not decryption. What D1 *adds*:
- a **second storage system** with its own access paths (D1 HTTP API, dashboard,
  API tokens, and **D1 Time Travel** point-in-time snapshots, which can outlive
  the app-level 7-day retention);
- tokens survive in D1 across a `PUT /bootstrap/rewrap` (Type A keeps AES1 →
  same AUTH_* — verified by derivation design, `cli/bootstrap.mjs:263-266`),
  and across a force re-bootstrap until the old day-buckets prune (those stale
  tokens then fail the gate — harmless).

Under the stated threat model (D1 account-private) this is LOW: it widens the
credential's footprint, it does not create a new class of attacker. It is worth
stating plainly in the docs that "zero-knowledge" here means *content*
zero-knowledge — the server holds and backs up capability handles that let the
account owner act as the user without the password.

**Fix (optional hardening):** don't back up `auth_ui`/`auth_clock` (they are
HKDF-derived from AES1 and can be re-derived during a restore drill from the
unwrapped master key; the CLI already has `subkey()`); or store them
HKDF-hashed (gate compares hashes) so D1 holds only verifier material.

---

### F3 [LOW] — Deletions do not propagate to the same-day D1 backup bucket

**Class:** §19 backup fidelity / deletion privacy.

**Evidence (local):** after storing 3 `evt:sec-S6:*` rows, running
`POST /internal/backup` (rows=6), then deleting 3 of them and triggering the
cron (`/cdn-cgi/local/scheduled` → log line `backup ok day=2026-11-01 rows=3`),
the D1 `backup` table for day `2026-11-01` still contained **16** rows while the
DO held **3**. Code cause: `store.js:691-708` — the snapshot is
`INSERT OR REPLACE` per (day,id); ids absent from the DO are never DELETEd from
the current day bucket; pruning only removes whole days older than 7
(`store.js:706-707`).

**Impact:** a deleted event's *ciphertext* row persists in D1 for up to ~7 days
(and possibly longer via D1 Time Travel). Content stays opaque (K_data
server-side absent), so this is a metadata/expectation issue, not a content
leak — but the documented restore drill (`docs/PROTOCOL-v4.1.md:607-612`:
"read D1 snapshot for day → PUT /rows/* verbatim") would **resurrect deleted
events**. Also interacts with F1: deleted title-slug ids keep leaking titles
from D1 for the retention window.

**Fix:** make `hBackup` transactional per day: `DELETE FROM backup WHERE day=?`
before the inserts (same for `config_backup`), so each snapshot is exact.

---

### F4 [INFO] — `console.error('store error: ' + e.message)` is not literally "counts only"

**Class:** invariant wording deviation; no data leak demonstrated (scope item 1).

**Code:** `worker/src/store.js:228-233` — the DO's catch-all logs the exception
message. §3 key ledger (`docs/PROTOCOL-v4.1.md:140`): "Worker logs: nothing,
ever"; task invariant: "Worker logs: nothing (counts only)".

**Attack surface enumerated and tested (local + live, zero 500s produced, zero
`store error` lines in `/tmp/wrangler-8787.log` across all probes):**

| Candidate throw site | Guard | Test result |
|---|---|---|
| `JSON.parse` in `readJson` (store.js:171) incl. deep-nesting `RangeError` (50 000 `[`) | own try/catch → 400 `bad_json` | local+live: 400 bad_json, no log |
| `atob` in `b64Decode` (store.js:71) | own try/catch → null → 400 `bad_nonce`/`bad_ct` | local+live: 400, no log |
| `decodeURIComponent` on `%zz`/`%ED%A0%80` (store.js:304) | own try/catch → silent 404 | local+live: 404 empty, no log |
| `new URL(req.url)` (store.js:267, index.js:54) | edge pre-filters malformed URLs | live: CF edge 400 HTML for `%zz`, `%00`, `OPTIONS *` — never reaches worker |
| `sql.exec` bind of id (NUL `%00`, astral `%F0%9F%98%80`, quotes, 300 chars) | length gate after auth (store.js:360-363); types pre-validated | local: NUL/astral rows stored+echoed, no throw; live: edge blocks `%00`, `bad_id` 400 for 300 chars |
| batch `WHERE id IN (…)` with lone-surrogate id (`"\ud800"` via JSON) | no throw in workerd SQLite binding | local+live: 200 `{id, missing:true}`, no log |
| `ver` bounds (1.5, 2^53+1, 1e999-class) | `Number.isInteger` + u32 range → 400 `bad_ver` | local+live: 400, no log |
| `parseEtagVer` / If-Match garbage | regex → 400 `bad_if_match` | local+live: 400, no log |
| oversized/short/chunked-malformed bodies | `readBodyBounded` caps → 400 `too_large`; malformed chunked → **runtime** 500 (local: body `Error: Network connection lost.`, a workerd fixed string; no `store error` line emitted — failure surfaced at the front-Worker transport, not the DO JS) | local raw-socket probes |
| `JSON.stringify` in `json()` | inputs are b64-charset (pure ASCII) strings or SQLite scalars; ES2019 well-formed stringify cannot throw on these | code analysis |
| D1 `db.exec`/`db.batch` in `hBackup` | fixed SQL text, opaque binds; errors are D1 fixed-class messages (`D1_ERROR: …`, see WORKLOG.MD:101 for a historical one) | code + WORKLOG evidence |

**Conclusion:** every client-reachable parse/validate failure is caught before
the catch-all, and every binding is type-constrained; the only messages that
can reach `console.error` are runtime/transport/SQLite/D1 **fixed strings**
containing no user-derived substring. The deviation from "nothing (counts
only)" is therefore cosmetic today, but the line *is* a payload-adjacent log
hazard if future code adds string interpolation to thrown errors.
**Fix:** log a fixed tag + exception class only
(`console.error('store error: internal')` or `console.error('store_error count=1')`),
or keep a counter. (Prior round A2 already recorded the same interpretation
note — WORKLOG.MD:158.)

---

### F5 [INFO] — Row ids travel in request URLs; the operative guard is `observability.enabled=false`

**Class:** platform logging exposure (scope item 7).

**Evidence:**
- `worker/wrangler.jsonc:35-37`: `"observability": { "enabled": false }` —
  confirmed; no `tail_consumers`, no Logpush, no analytics bindings anywhere in
  the config (only `durable_objects`, `d1_databases`, `triggers.crons`, `vars`).
- Local dev demonstrably logs every URL: `/tmp/wrangler-8787.log` contains
  `[wrangler:info] PUT /rows/evt:sec-S6:nul%00row 200 OK (5ms)` etc. — full row
  ids in cleartext.
- Production: Cloudflare's edge necessarily processes request URLs (routing,
  WAF/abuse telemetry — account-invisible, retained per CF policy), and Workers
  Logs (observability) would include invocation URLs if ever enabled. With F1
  live, that means **event titles in URLs**.

**Assessment:** row ids are already documented L1 metadata (§1/§7) — the server
sees them by design — so URL-carried ids are an accepted-risk INFO *given*
observability stays off. The invariant wording "Worker logs: nothing" refers to
worker-emitted logs and holds; but note the interplay: enabling observability
tomorrow would put ids (today: titles) into a log system. **Fix:** keep
observability off (or add a redaction note to ops docs); resolve F1 and the
residual risk collapses to uuid-namespace metadata.

---

### F6 [INFO] — Local workerd vs production edge input-filter divergence

**Class:** environment difference (worth recording for restore drills/tests).

**Evidence:** locally, `PUT /rows/evt:sec-S6:n%00ul` → **200 stored**
(id `"evt:sec-S6:n\u0000row"`, manifest lists it, D1 backup copies it); live,
the same URL → **400 from the Cloudflare edge** (canned HTML, `Server: cloudflare`,
never reaches the Worker). Likewise `%zz` non-canonical escapes: local → app
silent 404; live → edge 400. `OPTIONS *` → live edge 400; local miniflare →
runtime 500 `TypeError: Fetch API cannot load: http://x*/` (dev-only artifact;
message contains the attacker's own Host header, reflected only to the
attacker, no worker log line).
**Impact:** tests that rely on edge-rejected inputs pass locally but behave
differently in prod; NUL-bearing ids cannot exist in production storage via
HTTP, so no live exposure. No action required beyond awareness (and F3 covers
D1 id hygiene anyway).

---

## VERIFIED-SECURE (invariant proofs)

**1. No server-side decryption exists — full touchpoint enumeration of `ct`/`nonce`.**
`grep -n "nonce|\.ct\b|wrapped" worker/src/store.js` yields exactly these
classes, each byte-preserving or length-only:
- `b64Decode(val.nonce)` / `b64Decode(val.ct)` + length checks (`store.js:579-582`;
  `NONCE_LEN=12`, `ROW_CT_MAX=65536`) — strict-canonical decode, **only
  `.length` is inspected**;
- SQLite BLOB binds (`store.js:620-621, 633-634`) and SELECTs
  (`store.js:505, 601, 674`) — opaque pass-through;
- `b64Encode(toU8(row.nonce/ct))` in `hGetRow`/`hPutRow`(rebase)/`hBatchGet`
  (`store.js:512-513, 644-645, 557-558`) — byte-preserving re-encode;
- verbatim echo of the **submitted b64 strings** on accept (`store.js:627, 637`)
  — ciphertext echo (the strings passed `B64_RE`, pure ASCII);
- D1 backup binds (`store.js:693-694`) — opaque copy.
There is **no** `crypto`/`subtle`/`decrypt`/`encrypt` anywhere in
`worker/src/` (verified by grep; only `atob`/`btoa`/`TextDecoder` exist, for
JSON/base64 handling). **No code path branches on row content** — the only
comparisons are `ver` (clear integer), `id` (equality/length), and ETag strings
(§9c). No `indexOf`/`slice`/`match` on `ct`/`nonce` beyond the b64 charset test.

**2. The Worker front door never inspects bodies.** `index.js:57-71` forwards
exactly 4 headers (`authorization`, `content-type`, `if-match`,
`if-none-match`) and streams `req.body` unread to the DO; the DO authenticates
**before** reading any body (`store.js:329-356` gate precedes `readJson`;
unauthenticated bodies are never consumed; the 403/bad_id paths explicitly
drain (`store.js:353, 361`) only so the status reaches the client).

**3. `/config` returns CLEAR params only.** LIVE:
`GET /config` (AUTH_UI) → `200 {"salt":"e7c4efca…","iters":100000,"wrapped":"gtOMiuuJ…","ver":1}`
— programmatically checked: keys are exactly `salt,iters,wrapped,ver`;
`auth_ui present: false`, `auth_clock present: false`. Code: `hConfig`
(`store.js:444-454`) selects the same columns it returns. Same shape with the
CLOCK token. `updated_at` is stored (`store.js:195-196`) but returned by **no**
route (manifest returns id+ver only, `store.js:499-500`).

**4. Every response body is either fixed-string, count, or ciphertext.**
LIVE-verified shapes: `{"proto":"4.3"}`; `{"photo_pending":0}` (staged count —
calendar scope always 0); manifest `{rows:[{id,ver}],etag}`; row envelope
`{id,ver,nonce,ct}` (GET echoes stored bytes; PUT accept echoes submitted
ciphertext; PUT rebase returns the **stored** envelope — verified live:
submitted nonce `BBBB…` ver1 vs stored ver1 `AAAA…` → response carried `AAAA…`);
batch `{rows:[envelope|{id,missing:true}]}` in request order; DELETE `{}`;
backup `{ok:true,day:"2026-11-01",rows:15}` (LIVE, owner INTERNAL_TOKEN —
counts + day only, no ids); errors are the fixed set
`bad_json|bad_body|too_large|bad_ids|bad_id|bad_ver|bad_nonce|bad_ct|bad_if_match|bad_salt|bad_iters|bad_wrapped|bad_auth_ui|bad_auth_clock|exists|not_found|internal`
(all 400/404/409/500 with fixed strings — every one of the reachable ones
probed live or locally). 403 and silent-drop are empty bodies. No response
anywhere contains a server-computed function of plaintext.

**5. The bearer gate is constant-time and pre-parse** (`store.js:329-356`):
hex-decoded 32-byte compare via `ctEqual`; wrong/missing/admin/internal tokens
on app routes → uniform empty 404 (LIVE verified for `/config`, `/rows`,
`/version`, `/internal/backup` with UI token and with no token). CORS:
allowlisted origin echoed (`https://sh-clock.github.io` → 204 + ACAO; evil
origin → 404, no ACAO) — no data-exposure differential.

**6. Logs are counts-only in practice.** The ONLY two log statements in the
worker source: `store.js:230` (exception message — see F4: fixed strings only,
unreachable with payload data) and `index.js:87`
`console.log('backup ok day=' + j.day + ' rows=' + (j.rows | 0))` — day +
count. Local cron-trigger evidence: wrangler log line
`backup ok day=2026-11-01 rows=3`. The cron's failure path
(`throw new Error('backup_failed_' + res.status)`, index.js:84) contains only a
status code and surfaces as an uncaught exception (tail-only visibility; no
persistent log with observability off).

**7. No route exposes the D1 backup, and the backup lands nowhere else.**
All routes enumerated (`store.js:276-327`): bootstrap, bootstrap/rewrap, config,
version, status, rows, rows:batch, rows/{id}, internal/backup. Only `hBackup`
touches `this.env.BACKUP` and it only **writes** (`CREATE TABLE`, `INSERT OR
REPLACE`, day-prune). `wrangler.jsonc` has **no R2 binding** (only
`durable_objects` + `d1_databases` + cron) — verified; the §19 snapshot exists
solely in D1 (plus the DO's own SQLite, which is primary storage, not a copy).
`/internal/backup` is silent to UI/no tokens (LIVE: both → empty 404).

**8. Exception-message attack surface: closed** (matrix in F4 — 26 malformed
input classes across live+local produced zero application 500s and zero
`store error` log lines; all parse failures are pre-caught; all SQL is
parameterized with pre-validated types; the runtime-level 500s observed locally
carry fixed workerd strings).

**9. Docs-vs-reality on the L1 metadata surface:** §1/§7 promise the server sees
ids, vers, lengths, timing — reality matches exactly (manifest, etag epoch
(§9d), envelope sizes via GET/batch, request URLs), **except** F1 (titles in
ids), which is undocumented and contradicts §7's "NOTHING about event content".

---

## Cleanup / side effects

- All `evt:sec-S6:*` rows deleted; final manifest re-checked: **15 rows, 0
  sec-S6 remaining** (`etag "e28"`). The NUL-id row never existed live (edge
  400). One production `/internal/backup` was executed with the owner's
  INTERNAL_TOKEN (permitted; response recorded above; it re-snapshotted the
  same 15 rows for day 2026-11-01).
- Local stack: state under `/tmp/wrangler-e2e` was used read-mostly (bootstrap
  universes recreated by with-stack.sh as usual). No repo files modified; probe
  scripts live in `/home/z/sec-s6-work/` (outside the repo).

## Hypotheses (clearly marked, not verified)

- **H1:** D1 *Time Travel* retention exceeding the 7-day app prune (F2/F3
  amplification) — plausible from Cloudflare product behavior; not verifiable
  without account access to the prod D1 dashboard. Marked hypothesis, not a finding.
- **H2:** `sql.exec` binding a lone-surrogate id **stores** it lossily (WTF-8 →
  U+FFFD) — observed only as a no-throw miss on SELECT; no write path can carry
  a lone surrogate (URL path is pre-rejected by `decodeURIComponent`, batch is
  read-only), so it is unreachable and irrelevant.

---

## VERDICT — does the zero-knowledge invariant hold?

**As code: YES, and it is unusually clean.** After a full read of all 720 lines
of `store.js` and the front door, plus ~60 live and local adversarial probes
(exception-message injection, parsing oracles, response-shape fuzzing, raw-socket
malformed HTTP, D1 snapshot inspection), I found **no path by which the
Worker/DO reads, decrypts, branches on, or logs event payload content**: there
are no crypto primitives server-side, every `ct`/`nonce` touchpoint is
byte-preserving or length-only, `/config` returns exactly the clear params,
every error body is a fixed string, and the only two log statements emit
counts/day and (worst case) fixed runtime exception text — zero 500s were
reachable by crafted input at all.

**As deployed: NO — the invariant is broken by the data, not the code.** The
live store's row-id namespace contains slugified event titles
(`lunch-with-alex-37cb2f68`, `team-standup-3b712671`, …) written by
`scripts/reseed-prod.mjs`/`seed-prod.mjs`, so the Worker, the DO SQLite, the D1
backup, every manifest response, and every request URL currently expose
plaintext-derived event data (titles) without the password — a direct violation
of §1's "can never read or infer any event data" and §7's "NOTHING about event
content". Fix is cheap (F1: re-put under random UUIDs + fix the seeders), after
which the invariant holds in both letter and spirit, with the two LOW
credential-retention/deletion-propagation items (F2, F3) as the remaining
documented-trade-off surface.
