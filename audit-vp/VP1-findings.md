# VP1 — Worker Code Re-Attack (white-box + local execution)

**Agent:** VP1 (deep white-box re-attack of the security-wave worker code), verification wave.
**Target:** repo `/home/z/my-project/calendar-web` @ `54c2fca` — `worker/src/index.js` (145 lines) and `worker/src/store.js` (824 lines) read COMPLETELY; `protocol.md` §9c/§9d/§4, `worker/wrangler.jsonc`, `test/front-door-unit.mjs`, reference findings `audit-d/sec-S1-findings.md`, `sec-S4-findings.md`, `sec-S8-findings.md`.
**Date:** 2026-11-01. Method: private local stack `npx wrangler dev --port 8793 --persist-to /tmp/vp1-persist` (own universe, own `.dev.vars` secrets), driven with node `fetch` + raw TCP sockets; the front door additionally unit-driven in-process with a stubbed DO binding (pattern of `test/front-door-unit.mjs`); D1 backup store inspected offline via python `sqlite3` on a file copy. LIVE worker: **8 read-only requests, no admin endpoints** (see LIVE section).
**Probe scripts (outside the repo):** `/home/z/vp1/probe.mjs` (103 checks), `/home/z/vp1/backup-race.mjs` (14), `/home/z/vp1/sock.mjs` (7 raw-socket), `/home/z/vp1/fd308.mjs` (39 front-door unit), `/home/z/vp1/final.mjs` (17), `/home/z/vp1/live.sh` (8 live). Repo source NOT modified; `git status` clean except untracked `audit-vp/`.

**Credentials:** private universe bootstrapped via `cli/bootstrap.mjs` (iters 600 000, password `vppw`); `auth_ui` redacted `ff258d8d…`, `auth_clock` redacted `0c920499…`. Dev-stack `ADMIN_SECRET` redacted `6c84927f…`, `INTERNAL_TOKEN` redacted `3967df54…` (read from `worker/.dev.vars`, local dev values only). LIVE token from `/home/z/my-project/.secrets/credentials.json`, redacted `d2e6c5b2…`-class, never printed. All tokens below are redacted to 8 hex chars.

---

## SUMMARY

| Severity | Count | Titles |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 0 | — |
| MEDIUM | 0 | — |
| LOW | 0 | — |
| INFO | 5 | VP1-N1 parseEtagList trims Unicode whitespace beyond RFC OWS; VP1-N2 comma-bearing opaque tags mis-split (fail-closed); VP1-N3 silent-drop/403/412 carry no `no-store` while 404 is default-cacheable per RFC 9111 (inert); VP1-N4 in-flight authenticated write survives a force rotation (sub-second window, epoch stays exact); VP1-N5 308 carries no CORS decoration — browser preflighted calls over an `http://` API URL hard-fail at the redirect (by design; non-browser clients get the upgrade) |

**JOB 1 (fix verification): 194/194 local+unit checks green (103 probe + 14 backup/race + 7 raw-socket + 39 front-door unit + 17 final + 14 `front-door-unit`), 8/8 live checks green, `front-door-unit` 14/14.** Every fix from the S1/S4/S8 disposition was re-verified behaviorally on a private workerd stack, and the deployed LIVE worker matches the repo code for every externally observable fix (308/HSTS/vary/expose-ETag/no-store/304-etag). **JOB 2 (re-attack): zero new exploitable findings** — every attack below was executed locally and died against the code; residual observations are INFO-grade tolerance/interop notes (VP1-N1..N5).

---

## JOB 1 — FIXES VERIFIED (code read + executed evidence)

### 1. Front door: 308 http→https, HSTS+vary everywhere, expose ETag, no-store, catch→404 (sec-S1-1/S1-2/S1-3/S8-F4/S8-F5)

Code: `index.js:45-48` (`BASE_HEADERS` = vary+HSTS), `:51-58` (`decorate` stamps them on EVERY relayed response, decorated or not), `:67-71` (front-door catch → bare 404 with the same `BASE_HEADERS`), `:100-108` (308 before any auth/CORS logic), `:32` (`access-control-expose-headers: ETag`); `store.js:120-128` (`json()` sets `no-store`), `:578-581` (304 builder sets etag+no-store).

Executed (local + live + unit):
- **fd.1/fd.1b + H1-H9 (39 unit checks):** `http://<non-localhost>/…` → **308** with `Location: https://…` (scheme only — host/port/path/query preserved), `vary: Origin` + HSTS; loopback matrix: `localhost`, `127.0.0.1`, `[::1]`, `sub.localhost`, `LOCALHOST`, `127.1`, `0x7f000001`, `2130706433` all exempt (relayed, DO reached ×1); `localhost.evil.com`, `evil.com.localhost.`, `[::ffff:127.0.0.1]`, `127.0.0.1.evil.com`, `localhostexample.com` all → 308. HTTPS never redirected.
- **A1-A6:** silent 404 = empty body + vary+HSTS, no content-type/cache-control; preflight allowlisted → 204 + full CORS incl `access-control-expose-headers: ETag` + vary + HSTS; foreign-origin preflight → bare 404 + vary+HSTS; JSON 200 → `cache-control: no-store` + vary + HSTS (+ACAO/expose when decorated, none when undecorated — both stamped); 304 → `etag` + `no-store` + vary + HSTS.
- **A7/A7b:** 8 silent-drop shapes (no-auth /rows, unknown route, wrong-class admin route, method confusion GET /rows:batch, HEAD /version, bad token, ui-token /internal/backup, no-auth /bootstrap) — **identical application-level header sets** (only transport framing differs). Uniformity holds under the new headers.
- **H10:** DO exception (stub throws) for GET/POST/PUT/DELETE/HEAD/PATCH/OPTIONS → **empty 404 + vary+HSTS** — the §4/S8-F4 law holds at the front door, no 500 leak.
- **LIVE (read-only):** `http://…/version` → **308 + `Location: https://…` + HSTS + vary**; `https://` no-auth → 404 empty + vary + HSTS; OPTIONS allowlisted → 204 + expose ETag; OPTIONS evil → 404 + vary + HSTS; GET /version → 200 + no-store; GET /rows → 200 + no-store (+etag in body); INM current → **304 + `etag: "e86"` + no-store**; INM stale → 200 + no-store. Deployed code == repo @54c2fca.
- `node test/front-door-unit.mjs` → **14 passed** (re-run after all probes).

### 2. Epoch bumps via SQLite triggers (sec-S4-1/S4-2/S8-F1)

Code: `store.js:249-260` — three `AFTER INSERT/UPDATE/DELETE ON rows` triggers doing `UPDATE meta SET v=v+1`; no non-trigger mutation of `meta` exists (grep: only `INSERT OR IGNORE … 'epoch', 0` at `:239` and the trigger bodies); `readEpoch` `:544-549`; `hBootstrap` force wipe `:460-462` relies on the per-row DELETE trigger.

Executed (`probe.mjs` B*, `backup-race.mjs` F1-F3):
- INSERT +1 (B2); accepted UPDATE +1 (B3); **rejected rebase PUT does NOT bump** (B4); real DELETE +1 (B5); **idempotent re-delete does NOT bump** (B6).
- **Force wipe bumps per destroyed row** (B8: N rows → +N, manifest empty, etag = new epoch); **pre-wipe etag then gets 200, not a ghost 304** (B8c — the S4-1 regression test); post-wipe etag still 304s (B8d); wipe on an empty store leaves the epoch unchanged (B9 — manifest genuinely unchanged, so 304 remains correct).
- Parallel exactness: 8 distinct INSERTs → +8 exactly (B12); 8 parallel DELETEs of one row → +1 exactly (B11); 4 parallel PUTs vers 1..4 → +4 (final ver 4, all accepted in serialization order — matches S4's verified RMW law).
- **Wipe-vs-PUT race (slow-drip body suspension in `readBodyBounded`, force bootstrap fired mid-drip):** PUT response arrives intact (200 echo), victim wiped, raced row = exactly one serial order (post-wipe INSERT), **epoch accounting exact (+wipe +insert)**, manifest consistent with etag — no ghost 304, no torn state (F1).
- **Token-revocation variant (F-rev):** force rotation to NEW tokens mid-drip — old token dead for all NEW requests (404), new token valid, but the in-flight PUT still lands (see VP1-N4); universe restorable.
- **Trigger amplification:** 50-row force wipe = **50 bumps in 4 ms** wall time — linear O(N), admin-only (F3). No quadratic blow-up, no recursion (trigger updates `meta`, which carries no trigger).
- **Divergence hunt (code):** every `rows` mutation is one of INSERT `:718-721` / UPDATE `:730-733` / DELETE `:750` / `DELETE FROM rows` `:460` — all trigger-covered in the SAME statement (one implicit transaction) → no crash window can leave rows ≠ epoch (S4-2 closed by construction). `hManifest` reads epoch and rows in one synchronous block (no await between `:568-584`).

### 3. RFC 9110-exact conditional PUT + GET /rows forms (sec-S4-3/S4-5/S8-F6)

Code: `store.js:148-160` (`parseEtagList`: star | weak/strong tag list | malformed), `:688-715` (§13.2.2 order: If-Match step 1 strong → 412 on false incl. missing row; If-None-Match step 3 weak → 412 on true for PUT), `:567-586` (GET /rows INM weak/list/star).

Executed (`probe.mjs` C*, 46 conditional checks; row held at ver 5, incoming ver 6, ver verified after every case):
- **If-Match:** `"5"` → 200 write; `"4"` → 412; `W/"5"` → 412 (weak never matches); `"4", "5"` list → 200; `"4", W/"5"` → 412 (weak entries excluded); `*` on existing → 200; `*` on missing → **412**; `"5"` on missing → **412** (was 404 — fix verified); `"05"` → 412 (opaque equality); `""` (legal empty opaque tag) → 412; garbage / `"a""b"` / `*, "5"` / `"5", *` / unterminated / unquoted / `w/"5"` → **400 `bad_if_match`** (fail closed).
- **If-None-Match:** `"5"` current → **412** (the DAV lost-update guard now real — S4-3 fixed); `W/"5"` → 412 (weak match); `"4","5"` list → 412; `"4"` → 200 write; `*` on existing → 412; `*` on missing → 200 create; `"9"` on missing → 200 create; garbage / `"a""b"` / `*, "5"` → **ignored** (plain RMW, §13.1.2 rule 3).
- **§13.2.2 order with both headers:** IM `"5"` + INM `"5"` → 412 (step 3 evaluated after a true step 1 — RFC 9110 §13.2.2 step 1 says "if true, continue to step 3", where step 3 IS If-None-Match; the fixer's refutation of S4-3's "ignore INM" claim is CORRECT per the RFC text); IM `"5"` + INM `*` → 412; IM `"5"` + INM `"9"` → 200; IM `"4"` + INM `"9"` → 412 (step-1 false wins); IM garbage + INM garbage → 400 (IM malformed checked first).
- **GET /rows INM:** exact → 304; `W/` weak → 304; list any-match → 304; `*` → 304 (representation always exists); stale → 200; garbage → 200; empty → 200; `*, "e…"` mixed → 200 (malformed ignored); no-match list → 200. Live: current `"e86"` → 304 + etag + no-store; stale `"e85"` → 200.
- **Fuzz (raw sockets):** duplicate If-Match lines → joined list, `"5"` matches → 200; duplicate If-None-Match → joined → 304; NUL in value → transport 400 (fail closed, no 5xx); raw CR → transport 400 (no smuggling); fullwidth `"８"` → 412 (opaque, never matches `"8"`); **2001-tag If-Match list → 200 in 8 ms — no ReDoS** (linear split/trim/regex; Cloudflare header-size limits bound the input).

### 4. iters range / ct range / 403+bad_id drains / exact-day backup (sec-S7-F2/S7-F5/S2-L1/S6-F3)

- **iters (bootstrap `:442-444`, rewrap `:492-497`):** 99999 / 100000.5 / `"600000"` / null / −1 / 10000001 → 400 `bad_iters` (both routes); 100000 and 10000000 pass (bootstrap → 409 `exists` on the live universe, proving validation passed; rewrap → 200 with `/config` reflecting 10M, then lowering to 100k, then restoring 600k — lowering within range is the documented operator capability, floor intact).
- **ct (`:677-678`):** 15 B → 400 `bad_ct`; **16 B → 200**; **65536 B → 200**; 65537 B → 400.
- **Drains (`:404-417`):** clock-token PUT with 2 MB body → 403 received cleanly; clock-token DELETE with 2 MB body → 403; 257-char id PUT/DELETE with 2 MB body → 400 `bad_id` received; ui-token PUT 2 MB valid id → 400 `too_large` — no torn connections, `sec-S2-L1` holds for PUT and DELETE.
- **Backup (`hBackup :761-822`, DELETE+INSERT in ONE `db.batch`):** UI token → silent 404; INTERNAL_TOKEN → 200 `{ok,day,rows}` with keys exactly `ok,day,rows`; **exact-day snapshot: delete a row, re-backup same day → D1 bucket contains exactly the survivors (deleted row NOT resurrected — S6-F3 fixed)**; third same-day backup idempotent; `config_backup` exactly one day-key row; response logs counts only. D1 verified by direct SQLite inspection of the persisted database file.
- **§5 taxonomy:** 400-with-body (+no-store), 409 `{error:"exists"}`, authenticated 404-with-body, 403 empty (no ct/cc), 412 empty, silent 404 empty, `bad_ver` (1.5/0/>u32), `bad_nonce`, uppercase-hex Bearer → silent 404 — all as specified.
- **Batch unchanged:** order preserved, `missing:true` flags, clock-class allowed (read), dup/empty/non-array/257-ids → 400, GET → 404.

---

## JOB 2 — NEW FINDINGS (all INFO; each executed locally)

### VP1-N1 [INFO] — `parseEtagList` trims Unicode whitespace beyond RFC OWS (`store.js:149`)

`header.trim()` (JS `String.prototype.trim`) removes ALL Unicode WhiteSpace — NBSP (U+00A0), U+2028, U+3000… — not just the RFC's SP/HTAB. Raw-socket proof: `If-Match: \u00A0"7"\u00A0` (row at ver 7) → **200 write**, where an RFC-strict parser would treat the value as one malformed token (our own law: → 400 `bad_if_match`).
**Impact: none as an attack** — the tag must still equal the stored ver by exact opaque equality, so the "bypass" direction only *accepts a well-formed tag the client wrapped in NBSP*; a client controlling the header could simply send `"7"` correctly. Not sendable through browser fetch (non-ByteString header values are rejected client-side; NUL/values >255 need raw sockets — workerd 400s NUL at transport). Interop tolerance note only. Fix if desired: trim only `' '`/`'\t'`.

### VP1-N2 [INFO] — comma-bearing opaque tags are mis-split by `parseEtagList` (`store.js:151`)

`v.split(',')` cannot see quote boundaries: a legal RFC entity-tag like `If-Match: "a,b"` splits into `"a` + `b"` → malformed → **400 `bad_if_match`** (If-Match) or ignored (If-None-Match). Both directions fail closed (400/ignore → no write via that path), and our own etags are pure decimal / `e<decimal` — never comma-bearing — so only a DAV client quoting a comma inside an opaque tag is affected (it receives 400 instead of 412-no-match). Interop note; a stream-parser would be RFC-exact.

### VP1-N3 [INFO] — silent-drop 404 (and 403/412) responses carry no `no-store`, while 404 is default-cacheable per RFC 9111 §4.2.1

The S8-F5 fix scoped `cache-control: no-store` to JSON 200s and the 304 (`store.js:126`, `:580`). The bare 404 (silent drop — §4 law: "no cache headers") and the empty 403/412 builders (`:117`, `:136`) have no cache directives. RFC 9111 §4.2.1 lists 404 among default-cacheable status codes, so a shared cache that ignores the absent freshness hints could in principle store an unauthenticated silent-404 for `GET /rows` (key: URL + `Vary: Origin`) and later serve it to the same-origin authenticated client (sync would see "404" → logged-out semantics).
**Why INFO / inert:** heuristic storage without `Last-Modified`/explicit lifetime is not implemented by browsers (they require explicit headers), Cloudflare does not cache dynamic worker responses (S1-3: no `cf-cache-status` header on any live probe), and the §4 spec MANDATES the bare silent drop — this is the documented, deliberate tension between the S8-F5 fix scope and the §4 law. Defense-in-depth option: stamp `no-store` on every response in `decorate()` (the §4 letter concerns *differentiation*, which is preserved — all silent drops would still be byte-identical to each other).

### VP1-N4 [INFO] — an in-flight authenticated write survives a force rotation (sub-second window)

Race executed locally (slow-drip PUT body → suspension inside `readBodyBounded`; force bootstrap with NEW `auth_ui`/`auth_clock` fired mid-drip): the PUT — authenticated BEFORE the wipe — still completes with a 200 echo and **INSERTs its row into the new universe** (`store.js:381-395` bearer gate runs before `readJson`, and nothing re-checks config at write time). All NEW requests with the old token correctly 404. Manifest epoch stays exact (wipe bumps + insert bump — verified), so clients SEE the resurrected row (no ghost-304); the row is AEAD-opaque clutter undecryptable under changed key material (or a valid row in a tokens-only rotation).
**Why INFO:** admin-triggered, window = body-drain time of one in-flight request, no integrity breach of the wipe itself (epoch + manifest consistent), same class as S4's documented "rewrap racing a row write: both succeed". Closing it would require binding writes to a config generation (e.g. re-read `config.ver` after the body read) — not warranted for this PoC's threat model.

### VP1-N5 [INFO] — the 308 upgrade carries no CORS decoration (redirect precedes CORS by design)

`index.js:100-108` returns the 308 before the origin allowlist runs, so a browser CORS-preflighted request (any request with `Authorization`) sent to an `http://` API URL fails hard at the preflight (308 is not 2xx → fetch `TypeError`) instead of being upgraded. Non-browser clients (curl, the DAVx⁵ fork) receive the 308 and can re-issue over https. `Authorization`/conditional headers are never forwarded to the DO on the redirect path (unit H7: DO called 0 times) and the body is dropped — no token leak; browsers additionally strip `Authorization` on the cross-origin (scheme-changing) redirect follow. **Net effect matches the fix's intent** (an `http://` server URL becomes non-functional for the web client, forcing correct configuration) — recorded so the behavior isn't mistaken for a regression.

---

## VERIFIED-SECURE (attacked and refuted, with evidence)

1. **308 open-redirect — REFUTED.** `Location` is built from the request's own parsed URL with only the scheme changed (`index.js:100-107`): host never substituted. Unit: userinfo (`http://user:pw@host/` → `https://user:pw@host/…`, same host — and userinfo never actually reaches a server, clients strip it), port+query preserved (`http://evil.example:8080/a%20b?c=d&e=%41` → https same), IDN → punycode same host, backslash authority `http://good.example\@evil.example/x` → host `good.example` (WHATWG `\`→`/`), CR/LF in path/query **stripped by the WHATWG URL parser** (no raw CR/LF in `Location`, no response splitting; even a CR-bearing value would throw inside `Headers` and land in the front-door catch → 404). Sock: raw CR in a header value → transport 400.
2. **parseEtagList ReDoS / huge-list amplification — REFUTED.** 2001-tag If-Match list matched in **8 ms** (row at ver 5, one strong match at the tail); parser is split/trim/regex per part — all linear, no nested quantifiers. Header size is platform-bounded.
3. **Trigger epoch divergence — REFUTED.** Every rows mutation is trigger-covered in the same statement (atomic); every non-mutating path (rebase-reject, re-delete, reads, rewrap, no-op bootstrap) leaves the epoch frozen; counts exact under sequential, parallel (×8), and raced (wipe∥PUT) workloads; crash-window desync structurally impossible (S4-2 closed); force-wipe bumps per destroyed row (S4-1/S8-F1 closed); empty-store wipe correctly no-op.
4. **Trigger amplification DoS — REFUTED.** 50-row wipe = 50 trigger fires in 4 ms; linear, admin-only; trigger target table (`meta`) has no trigger → no recursion.
5. **Backup day-key atomicity / same-day resurrection — REFUTED (fix holds).** DELETE+INSERTs+retention in one `db.batch` (single transaction); direct D1 SQLite inspection after delete+re-backup shows exactly the survivors; idempotent re-backup; retention prunes only `day < cutoff`.
6. **Duplicate-header confusion — REFUTED.** Duplicate If-Match/If-None-Match merge into a list (RFC-equivalent union); duplicate Authorization → joined value fails `^Bearer ([0-9a-f]{64})$` → silent 404; NUL → transport 400; raw CR → transport 400 (no smuggling).
7. **iters downgrade — REFUTED.** Floor 100 000 / ceiling 10 000 000 enforced on BOTH bootstrap and rewrap; non-integers, strings, null, negatives, out-of-range → 400; in-range lowering is the documented operator capability (floor intact — the anti-downgrade wall is the floor itself).
8. **ct range bypass — REFUTED.** 15 B and 65 537 B rejected; exactly 16 B (tag-only) and 65 536 B accepted.
9. **403/bad_id connection teardown — REFUTED.** 2 MB bodies on clock-PUT/clock-DELETE/bad-id-PUT/bad-id-DELETE all drain to clean 403/400 responses (S2-L1 for both methods).
10. **Origin spoofing at the front door — REFUTED (unit H12, 10 variants).** `null`, trailing slash/dot, uppercase, subdomain, suffix, userinfo — all undecorated; exact + OWS-trimmed match decorated; multi-entry allowlist with trim works.
11. **Silent-drop uniformity under the new headers — VERIFIED.** 8 distinct silent-drop triggers produce byte-identical application-level header sets (`vary` + HSTS, nothing else, empty body) — the S1-3/S8-F4 fixes added headers uniformly and broke no §4 signal.
12. **Batch surface — UNCHANGED.** Order, missing-flags, read-class access, validation matrix (dup/empty/non-array/257) all as in the S-audit baseline; GET → 404.
13. **LIVE deployed parity — VERIFIED (8 read-only requests).** 308+Location+HSTS+vary; silent 404+vary+HSTS; 204 preflight + expose ETag; no-store on /version, /rows 200 and 304; 304 with `ETag: "e86"`; stale etag → 200. No admin endpoint touched; nothing written.

## Conformance notes (documented scope, not findings)

- `GET /rows` and `GET /rows/{id}` ignore `If-Match` (RFC 9110 applies If-Match to any method → a false condition would 412; here → plain 200/404-with-body). protocol.md §9d documents If-None-Match only for `/rows`; fail-open on reads (a client can simply omit the header) — same documented-deviation class as S4-5's table.
- The 200 manifest carries the etag in the body only (no `ETag` response header on 200s) — per §9d's letter, already dispositioned by S8-F5.

---

## Hypotheses (unverified, flagged per rules)

- The VP1-N3 cache scenario requires an intermediary that heuristically stores a directive-less 404 — not implementable by any cache I can name; not probed further (would need a hostile shared proxy in front of the worker, which the deployment does not have).
- VP1-N4's window could in principle be widened by a slow body drip up to `BODY_DRAIN_MAX` (32 MB); an operator rotation racing a legitimately huge upload is the same admin-timing class — not escalated.

## Environment notes

- The task's bootstrap directive used a placeholder admin (`aaaa…`) — correctly rejected with silent 404 by the admin gate (a positive control of §4); the private stack was bootstrapped with the local dev `ADMIN_SECRET` from `worker/.dev.vars`.
- First probe runs crashed mid-file on non-ByteString header values (client-side undici) and left two stray rows (`vp1-c…`, `vp1-victim…`) which initially skewed epoch-count assertions; the store itself behaved exactly per spec once the harness was fixed and the strays purged — no server-side anomaly was involved.
- Stack killed precisely (`pkill -f 'wrangler dev --port 8793'`); repo `git status` clean (only untracked `audit-vp/`); no tracked file modified, nothing pushed or deployed.

## Cleanup

- Local private universe left bootstrapped with the original material (restored after the revocation race); all probe rows deleted (final manifest empty; epoch consistent).
- LIVE: 8 read-only requests total (2 unauthenticated, 2 preflights, 4 authenticated GETs with conditional headers); zero writes, zero admin/internal endpoints, zero rows read beyond the id/ver manifest.
