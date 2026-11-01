# S4 — CONCURRENCY / STATE — audit findings

Agent: S4 (concurrency & state) of the coordinated 8-agent audit of the LIVE-deployed
Calendar-Web PoC (`https://calendar-poc.sh-clock.workers.dev`, proto 4.3).
Date: 2026-11-01. All findings verified on a real workerd + DO-SQLite stack
(`wrangler dev`) and — for the read-only subset — against the LIVE worker.

Method note: heavy matrices ran LOCALLY (shared stacks `scripts/with_stack.sh`
8787/8788 initially; later a PRIVATE stack on port 8799 with its own
`--persist-to` state and its own bootstrapped universe, because the shared
ports are contended by the 8 parallel audit agents — see "Environment notes").
LIVE worker received only: GET probes + conditional PUTs/DELETEs on my OWN rows
`evt:sec-S4:*` (cleaned up afterwards; verified absent from the live manifest).
No `/bootstrap`, `/bootstrap/rewrap`, `/internal/backup` was ever sent to LIVE.
Concurrency ≤ 8, ≤ ~100 requests per scenario.

Test scripts: `/home/z/s4/t1-rmw.mjs`, `t1b-interleave.mjs`, `t2-cond.mjs`,
`t3-epoch.mjs`, `t4-bootstrap.mjs`, `t5-rewrap.mjs`, `t6-final.mjs`,
`t7-time-backup.mjs`, `t8-batch.mjs`, `live.mjs` (+ `s4-stack.sh`, `boot.mjs`,
`lib.mjs`). Repo source was NOT modified.

## TOP SUMMARY

| Severity | Count | Titles |
|---|---|---|
| MEDIUM | 1 | S4-1 force bootstrap leaves the manifest epoch stale → 304 hides a destructive wipe |
| LOW | 2 | S4-2 row-write ∥ epoch-bump are separate transactions (crash-window stale-304); S4-3 PUT `If-None-Match` etag-forms silently ignored (DAV lost-update guard is a no-op) + §13.2 precedence violation |
| INFO | 5 | S4-4 non-canonical `If-Match` numerics accepted; S4-5 RFC-valid `If-Match` forms rejected / weak-list `If-None-Match` on `GET /rows` not implemented; S4-6 no-op rewrap bumps `config.ver`; S4-7 backup day-key semantics (cross-ref S6-F3); S4-8 epoch is a global per-universe counter |

RMW arbitration, DO serialization, epoch monotonicity (non-destructive paths),
batch snapshot consistency, rewrap rotation and bootstrap crash-ordering were
attacked hard and held — see VERIFIED-SECURE.

---

## FINDINGS

### S4-1 [MEDIUM] — `PUT /bootstrap` (force) does not invalidate the manifest epoch: a still-authenticated client's `If-None-Match` keeps answering 304 while its data has been wiped

**Where:** `worker/src/store.js` `hBootstrap` (lines 371–409) — the force path wipes
`rows`, `staged`, `config` and inserts the new config but never touches the `meta`
table holding the §9d manifest epoch (`readEpoch`/`bumpEpoch`, store.js:470–479).
`hManifest` (store.js:493–501) answers `304` purely on epoch equality.

**Evidence (LOCAL, private stack, real workerd — `t4-bootstrap.mjs`, 19/19 pass):**

```
3 rows seeded under material M1 (same auth_ui/auth_clock tokens — a supported,
documented operator action: force re-bootstrap reusing device tokens):
    GET /rows                 → 200 {"rows":[…3 evt:sec-S4:b1..b3 rows…],"etag":"e46"}
PUT /bootstrap force (same tokens, new KEK material) → 200 {"ver":1}
    GET /rows                 → 200 {"rows":[],"etag":"e46"}        ← manifest EMPTY, epoch UNCHANGED
    GET /rows  If-None-Match: "e46"  → HTTP 304  (empty body, ETag: "e46")
```

The 304 arrives while the manifest changed from 3 rows to 0 rows. The epoch only
resumes counting on the next accepted mutation (`e46 → e47` after one new PUT);
until then every poll with the cached etag 304s. protocol.md §9d states a client
"MUST treat 304 as 'manifest unchanged'" — here the manifest was destructively
changed and the server tells the client nothing changed.

**Threat-model impact:** after an operator force re-bootstrap with the same AUTH
tokens (re-key drill), any already-unlocked client (browser tab) keeps its cached
etag (js/app.js only clears it on lock — WORKLOG E1-1: "cleared on lock"), polls
`GET /rows` every 60 s, gets 304 forever, and renders its pre-wipe rows as live.
Worse, the client believes its state is current, so a user edit goes through
`putRowRMW` with `local.ver+1`; the row no longer exists, and hPutRow accepts ANY
`ver ≥ 1` on a missing row (store.js:618–628, WORKLOG D8) — the wiped event is
silently resurrected under the new universe. No crypto boundary is crossed (rows
stay AEAD-opaque; if AES1 changed the resurrected row simply becomes undecryptable
clutter), but the documented destructive-reset semantics are silently breakable by
a stale client, and data loss is hidden from the user for an unbounded time.

**Fix (one line, same shape as the A1 fix for the wipe ordering):** inside the
force branch of `hBootstrap`, after the config INSERT, execute
`UPDATE meta SET v = v + 1 WHERE k = 'epoch'` (or reset it — any change breaks the
stale equality). Add an api-suite pin: force bootstrap must change the manifest etag.

---

### S4-2 [LOW, hypothesis on the trigger — code-path verified] — row mutation and epoch bump are two separate implicit transactions: a crash between them permanently desyncs the etag from row state

**Where:** `worker/src/store.js`:
- accepted INSERT: `INSERT INTO rows …` (line 619–622) then `this.bumpEpoch()` (line 623) — two `sql.exec` calls;
- accepted UPDATE: `UPDATE rows …` (632–635) then `bumpEpoch()` (636);
- real DELETE: `DELETE FROM rows …` (654) then `bumpEpoch()` (657).

Each `sql.exec` is its own implicit transaction — this is the project's own
documented atomicity model (WORKLOG.MD line 111, finding A1, used to justify the
config-last bootstrap ordering; the current hBootstrap comment at store.js:394–398
also reasons in terms of "a crash mid-wipe" BETWEEN statements). Under that model
there is a real (microsecond) window in every accepted mutation where the row
change is committed but the epoch is not. If the isolate dies there (host failure,
eviction between statements), the store reboots with rows ≠ epoch; every
subsequent `GET /rows If-None-Match: <old etag>` answers 304 while the manifest
actually differs — permanently, until the next accepted mutation bumps the epoch.

**Evidence:** code-path proof above; not reproducible without fault injection
(killing workerd between two adjacent synchronous statements is not schedulable
from outside). Marked as hypothesis per audit rules; the two-statement structure
and the per-statement transaction model are verified facts.

**Threat-model impact:** same stale-304 data-loss-hiding class as S4-1, but
crash-triggered instead of admin-triggered. Not attacker-controllable.

**Fix:** wrap mutation + bump in `ctx.storage.transaction()` (store.js has no use
of it today), or make the epoch bump the SAME statement (e.g. a SQLite `AFTER
INSERT/UPDATE/DELETE ON rows` trigger updating `meta`), or bump the epoch FIRST —
the fail-safe direction (a crash then yields a spurious 200, never a stale 304).

---

### S4-3 [LOW] — PUT conditional mode implements only `If-None-Match: *` and `If-Match: "<ver>"`; etag-form `If-None-Match` on PUT is silently ignored, and `If-None-Match` is not ignored when `If-Match` is present (RFC 9110 §13.1.2/§13.2)

**Where:** `worker/src/store.js` `hPutRow` lines 591–616: `parseEtagVer` is applied
only to `If-Match` (594); `If-None-Match` is compared only as the literal string
`'*'` (613). The code comment (584–590) claims "CalDAV clients (DAVx⁵ fork) get
RFC 9110 §13.1.2 semantics" — an overclaim.

**Evidence (LOCAL, `t2-cond.mjs` 30/30 + `t6-final.mjs` 6/6; identical behavior
LIVE for the malformed case — see LIVE section):**

```
row evt:sec-S4:cond1 at stored ver 6:
PUT /rows/evt:sec-S4:cond1  If-None-Match: "6"   body {ver:7,…}
    → 200 {"id":…,"ver":7,…}      ← guard IGNORED; write proceeds.
       RFC 9110 §13.1.2: state-changing method + If-None-Match whose list matches
       the current representation → MUST respond 412. Here the current etag IS "6"
       and the write lands anyway.
PUT … If-None-Match: "*" (quoted star)            → 200 (ignored; only bare * is honored)
PUT … If-None-Match: garbage                       → 200 (ignored; asymmetry: malformed
                                                      If-Match gets 400 bad_if_match)
PUT … If-Match: "5" + If-None-Match: * (row at 5) → 412
       RFC 9110 §13.2: a recipient MUST ignore If-None-Match when If-Match is
       present → should have proceeded (200).
```

**Threat-model impact:** protocol.md §9c documents only the two supported forms,
and the shipped web client never sends conditional headers — so the product's own
clients are unaffected. The hazard is for the DAVx⁵ fork the conditional mode was
built for: a DAV client that uses `If-None-Match: "<etag>"` as its lost-update
guard (perfectly legal CalDAV/HTTP practice) gets a silent overwrite instead of a
412 conflict — exactly the failure the header exists to prevent. The §13.2
precedence bug additionally turns a legal header combination into a spurious 412.

**Fix:** in `hPutRow`, when `If-Match` is present, ignore `If-None-Match` entirely
(§13.2); when `If-None-Match` is present without `If-Match` on a PUT, parse it as
an etag list (strong comparison) and answer 412 if the current row ver matches any
listed value; keep `*` semantics. Correct the comment, or narrow the protocol.md
claim to "If-Match: \"<ver>\" and If-None-Match: * only".

---

### S4-4 [INFO] — `parseEtagVer` accepts non-canonical numeric etags (`"05"` ≡ `"5"`) and surrounding whitespace

`worker/src/store.js:129–133`: `/^\s*"([0-9]{1,10})"\s*$/` — a client sending
`If-Match: "05"` against a stored ver 5 gets a MATCH (proceeds to RMW, verified:
`"05" against stored 5 actual: 200 {"id":…,"ver":6,…}`), and `"  \"5\"  "` also
matches. The server's own etags are canonical decimal, so this only relaxes what a
client may send; comparison stays numeric. No security impact; document or tighten
the regex to `[1-9][0-9]*` semantics if byte-exact etag echo is desired.

### S4-5 [INFO] — RFC-valid `If-Match` forms are rejected as malformed; `GET /rows` `If-None-Match` implements none of weak/list/star semantics

All verified in `t2-cond.mjs` against store.js:591–598 (`bad_if_match` for
anything `parseEtagVer` rejects) and store.js:495–498 (exact string equality
`inm.trim() === etag`):

| Header | Actual | RFC 9110 intent | protocol.md §9c/§9d intent |
|---|---|---|---|
| `If-Match: *` (exists-check) | 400 `bad_if_match` | valid; proceed iff resource exists | "not a quoted decimal ver → 400" — documented subset |
| `If-Match: W/"5"` | 400 `bad_if_match` | valid; strong comparison → 412 | documented subset |
| `If-Match: "1", "2"` (list) | 400 `bad_if_match` | valid; 412 unless one matches | documented subset |
| `If-Match` on missing row | 404 `{error:"not_found"}` | 412 | 404 documented (§9c) |
| `GET /rows` `If-None-Match: W/"e<n>"` | 200 | weak comparison → 304 | only exact `"e<n>"` documented |
| `GET /rows` `If-None-Match: "e<n>", "e<m>"` | 200 | list → 304 if any matches | only exact form documented |
| `GET /rows` `If-None-Match: *` | 200 full manifest | 304 if any representation exists | only exact form documented |

Actual behavior matches the project's own spec everywhere in this table; the
divergence is purely from RFC 9110. Kept as INFO for the DAV-compat story (the
fork's PROPFIND/PUT flows must avoid list/weak/star forms).

### S4-6 [INFO] — a no-op rewrap still increments `config.ver`

`hRewrap` (store.js:430–440) does `ver = ver + 1` unconditionally. Verified in
`t5-rewrap.mjs`: re-submitting the currently-stored wrapped (identical bytes) →
200 and `config.ver` 3→4. Conservative direction (clients see a change when the
key material did not change); no impact beyond a spurious client re-unlock prompt.

### S4-7 [INFO] — §19 backup day-key semantics: UTC-midnight rollover vs 03:00 cron, and same-day snapshot merging (cross-ref S6-F3)

`hBackup` (store.js:668–719): `day = new Date().toISOString().slice(0,10)`; both
`backup` and `config_backup` are keyed `(day[,id])` with `INSERT OR REPLACE`, and
retention prunes `day < cutoff` where `cutoff = (now − 7d)` as a date string.
Verified locally (`t7-time-backup.mjs` 10/10): backup row count equals the
manifest row count; a second same-day backup is idempotent; retention keeps
exactly today + 7 prior days (8 snapshots) and ISO-string comparison is
chronology-isomorphic. Two day-boundary nuances: (a) the day key rolls at UTC
midnight while the cron fires at 03:00, so a manual backup near midnight lands on
a different day key than the cron run hours later; (b) multiple snapshots taken
within the SAME UTC day merge via INSERT OR REPLACE — rows deleted between them
survive in that day's snapshot until the NEXT day's snapshot replaces it (same
root behavior as S6-F3, seen here from the time-handling angle). Restore drills
must therefore treat a day's backup as "some point-in-time during that day", not
"end of day". Info only.

### S4-8 [INFO] — the manifest epoch is a single global counter for the whole universe

`readEpoch`/`bumpEpoch` (store.js:470–479) — one integer for ALL rows. Any client's
accepted mutation invalidates every other client's cached etag (each poll then
costs a full manifest 200). By design (protocol.md §9d: "counts MUTATIONS, not
rows"); noted because the LIVE etag moved `e28 → e34` during my session while my
own writes accounted for only part of the delta — other audit agents' writes on
their own rows bump the same counter. Zero-knowledge impact unchanged (§9d: leaks
only a mutation counter).

---

## VERIFIED-SECURE (attacked and held; evidence)

All items below were executed on real workerd + DO-SQLite (local stack); the
headline items were cross-checked on LIVE. Full logs: scripts listed above.

1. **RMW race, 8 parallel PUTs, distinct vers 1..8 (`t1-rmw.mjs` 18/18).** Final
   stored ver = 8 (highest), final envelope = the ver-8 submission, decrypts under
   AAD(id,8). Every response is a valid envelope: its own echo (accepted) or the
   envelope stored at its serialization point. Epoch bumped exactly once per
   accepted write (Δ=8, arrival order 1..8 this run). No 5xx, no torn JSON, no
   torn crypto. Live 4-way race (`live.mjs`): final ver 6, all responses valid,
   manifest reflects ver 6.
2. **Rebase storm, 8 parallel PUTs all at the stored ver:** all 8
   rejected-as-rebase with the IDENTICAL stored envelope, epoch frozen, row
   untouched. **8 parallel PUTs all at ver+1:** exactly ONE accepted (epoch Δ=1
   proves it), final row = the winner. Converges — no livelock possible.
3. **No infinite rebase loop is possible server-side:** `hPutRow`
   (store.js:572–647) is single-pass — no loops, no retries, always a finite 200
   with a complete envelope. Client side, `putRowRMW` (js/app.js:1131–1181) is
   bounded by `REBASE_MAX = 8` (js/app.js:60) and each iteration requires the
   stored ver to have advanced; stored ver is strictly monotonic (accepts only
   `ver > stored.ver`, new rows accept any `ver ≥ 1`), so the loop either succeeds
   or throws `rebase_exhausted`. `writeBucket` no longer exists in the client
   (grep: 0 matches — v4.3 removed the bucket write chain).
4. **True suspension point identified and RMW atomicity proven anyway
   (`t1b-interleave.mjs`).** Requests are NOT serialized end-to-end: the DO
   suspends in `readBodyBounded`'s `await reader.read()` (store.js:151) — an
   input-gate only closes around storage ops, and body reading is not one.
   Demonstrated: PUT(ver 2) with a slow-dripping 200 KB body, small PUT(ver 3)
   fired 120 ms later was fully processed DURING the drip (accepted, epoch Δ=1);
   when the slow PUT's body completed it was correctly rejected-as-rebase (2 ≤ 3)
   and echoed the ver-3 envelope. No torn state: after `await readJson(req)`
   (store.js:573) there is NO await before SELECT→write→bumpEpoch→respond
   (600–646), and workerd never preempts synchronous code — the check-and-set is
   atomic per request.
5. **Conditional races (`t2-cond.mjs`).** `If-None-Match: *` create storm (8
   parallel on a fresh id): exactly one 200, seven 412, epoch +1, stored row =
   the single winner. DELETE racing an `If-Match` PUT: both responses well-formed
   (200 `{}` / 404-with-body in the observed run), final state exactly one of the
   two serial orders, never a mixture. `If-Match` on missing row → 404
   `{error:"not_found"}`; `If-Match` mismatch → 412 empty; both per protocol.md §9c.
6. **Epoch/etag monotonicity under two writers (`t3-epoch.mjs` 15/15, OWN
   universe with self-generated tokens).** 20 sequential mutations alternating
   two writer clients across 3 rows: pre-mutation etag → 200 every time (ZERO
   stale 304s), etag +1 exactly per accepted mutation, strictly monotonic;
   current etag → 304 every time while unchanged. Rejected write → epoch frozen
   (304 persists). Real delete → +1; idempotent re-delete → frozen. 4 concurrent
   accepted mutations → +4 exactly. 6 extra mutation/probe pairs hunting a stale
   304 after a mutation: zero hits. A 304 appears ONLY when truly unchanged.
   Note: a universe has exactly ONE write-capable token class (auth_ui; clock is
   read-only 403, admin is app-route-silent) — N-writer scenarios are N clients
   sharing that token, which is what was exercised.
7. **Bootstrap force semantics (`t4-bootstrap.mjs` 19/19).** Non-force on
   existing config → 409 `{"error":"exists"}`. Force wipes rows+staged+config
   then inserts (manifest empty afterwards; config replaced atomically). Two
   CONCURRENT force bootstraps: both 200, exactly ONE config survives (loser's
   token gets the silent 404), the surviving config equals exactly one of the two
   payloads byte-for-byte, manifest empty — no half-state, no mixed config.
   Observers polling during the race saw only whole states. Validation precedes
   the wipe: force with bad_salt → 400 and rows+config intact; a later non-force
   still 409s — a rejected/partial force can never leave old-key rows adoptable
   by a non-force bootstrap. The documented crash-ordering (rows → staged →
   config → INSERT, store.js:393–408, no awaits between the execs) holds; it is
   the fixed form of WORKLOG A1's finding.
8. **Rewrap semantics (`t5-rewrap.mjs` 20/20).** Type-A rotation with salt:
   `config.ver` 1→2, salt+wrapped replaced; OLD password + NEW config → GCM
   unwrap FAILS (KEK rotation is real — verified with `deriveClientKeys`, the
   client's own unlock path mirrored in node); NEW password unwraps to the SAME
   AES1; AUTH_UI/K_data unchanged. Rows byte-identical and still decryptable under
   the original K_data; manifest epoch untouched. Without salt: ver 2→3, salt
   kept, previous password fails, new one unwraps the same AES1. Failed rewrap
   (59 B wrapped) → 400 `bad_wrapped`, config untouched. Rewrap racing a row
   write: both succeed; row content and config both correct (DO serialization).
9. **DO serialization assumptions (`t6-final.mjs` 6/6 + code).** One DO instance
   by construction: `env.STORE.idFromName('main')` with the constant
   `DO_NAME = 'main'` (index.js:11,55) — deterministic name → single object;
   `wrangler.jsonc` declares exactly one DO class (`Store`, `new_sqlite_classes`
   under migrations tag v1 — no `new_unique_id`). No route bypasses the DO: the
   front door's only logic is the CORS allowlist + preflight (index.js:49–52
   returns before any stub is created — verified: `OPTIONS` w/ allowlisted origin
   → 204 with CORS headers, no origin → 404, and unauthenticated `GET /version`
   → 404 empty proves the bearer gate lives INSIDE the DO); every non-OPTIONS
   request is relayed via `stub.fetch` (index.js:71), and `scheduled` targets the
   same idFromName (index.js:79). The worker relays only 4 headers
   (authorization, content-type, if-match, if-none-match — index.js:60).
10. **Batch consistency under mutation (`t8-batch.mjs` 15/15).** 150-row batch
    (forces the ≥2-chunk `WHERE id IN (…)` path, store.js:541–548) fired 30×
    while a writer continuously mutated 10 rows including the ids at the 99/100
    chunk boundary: every one of the 4,500 returned envelopes exactly matched a
    known accepted envelope for its row — ZERO torn or phantom envelopes, request
    order preserved, no missing rows, no 5xx. The whole multi-chunk response comes
    from one serialization point (no awaits between the chunk SELECTs,
    store.js:541–548). Validation matrix: duplicate ids / 257 ids / empty ids /
    non-array → 400 `bad_ids`; 257-char id → 400 `bad_id`.
11. **Time handling (`t7-time-backup.mjs` 10/10 + grep).** `updated_at` is
    write-only hygiene: it appears ONLY in the schema and INSERT/UPDATE
    statements (store.js:196,202,404,432,437,620,633) — never returned by any
    handler, never in a WHERE/ORDER BY/UNIQUE, and not even selected by the §19
    backup (its D1 schema has no updated_at column, store.js:681–689). Two
    accepted writes landing in the same wall-clock second are handled fine (ver
    1→2, correct final state); nothing keys on updated_at uniqueness.
12. **LIVE read-only subset (`live.mjs` 16/16).** `GET /version` → 200
    `{"proto":"4.3"}`; `GET /config` with owner token (redacted `8b2d1be0…`) →
    200 clear params (iters 100000, ver 1); `GET /rows` → manifest + etag
    (`"e28"` at session start); `If-None-Match` with the current etag → 304 empty
    + `ETag` header; `If-None-Match: "e0"` → 200 (never a spurious 304); own-row
    conditional PUT sequence behaved identically to local (create 200 echo,
    `If-Match "1"`+ver2 → 200, stale `If-Match "1"` → 412 empty, `If-None-Match:
    *` → 412 empty, `If-Match: W/"2"` → 400 `bad_if_match`); 4-parallel race →
    final ver 6; DELETE + idempotent re-DELETE → 200 `{}`; final manifest
    verified free of `evt:sec-S4:*` rows. Front-door CORS verified (204 preflight
    for the allowlisted origin; silent 404 for a foreign origin; `Vary: Origin`
    on decorated responses).

---

## HYPOTHESES (clearly marked, not verified)

- **S4-2's trigger** (isolate death between the row statement and the epoch bump)
  is not schedulable from outside workerd; only the two-statement structure and
  the per-statement transaction model are verified. The fix is cheap enough that
  the finding stands on the code path alone.
- **hBackup under a mid-flight force bootstrap:** the snapshot (rows read at
  store.js:674–675, synchronously with the config read) is a consistent
  point-in-time even if a force bootstrap wipes the universe during the
  subsequent D1 awaits (the arrays are already materialized) — reasoned from the
  code, not stress-tested (would require racing an admin op against the internal
  cron endpoint with fault injection).

## Environment notes (not product findings)

- The shared local stacks (8787/8788, `scripts/with_stack.sh`) are contended by
  the parallel audit agents: the wrapper's global `pkill -f workerd` +
  `pkill -f 'wrangler dev'` kills other agents' mid-run stacks, and cross-agent
  requests appear in the shared logs (e.g. agent S7's `s7-probe-event-1` row ids
  in my 8787 log; an api-suite failure where another agent's force bootstrap
  rotated the universe's auth tokens mid-run). All S4 matrices were therefore
  re-run on a private stack (port 8799, private `--persist-to`, own universe,
  process-scoped kills) with 100% green results; the one earlier api-suite crash
  ("Workers runtime crashed and is being restarted") coincided with foreign
  pkills and did not reproduce on the isolated stack.
- Sandbox flake: two `with_stack.sh` boots failed (ECONNREFUSED / ECONNRESET)
  before any test request was sent; both recovered on retry or on the private
  stack. Not attributable to the worker code.

## Cleanup

- LIVE: all `evt:sec-S4:*` rows deleted; verified absent from the live manifest
  (post-cleanup etag `e34`). No config/rows of other agents touched; no admin or
  internal endpoints called on LIVE.
- LOCAL: private stack state under `/home/z/s4/state`; the shared 8787/8788
  universes were left as with_stack.sh re-bootstraps them (api-suite material).
- No repo source files were modified; test scripts live outside the repo in
  `/home/z/s4/`.
