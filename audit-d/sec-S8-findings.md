# S8 — Protocol Conformance & Spec/Code Gap Audit

**Target:** calendar-web PoC, protocol v4.3 — LIVE worker `https://calendar-poc.sh-clock.workers.dev`
**Agent:** S8 (protocol conformance + spec/code gap analysis), coordinated 8-agent audit
**Scope:** protocol.md (root, v4.3) + docs/PROTOCOL-v4.1.md (base wire spec) + docs/PROTOCOL-v4.2.md (calendar delta), read fully; `worker/src/store.js` (all 720 lines), `worker/src/index.js` (91 lines), `js/api.js` (137 lines), `js/app.js` (3910 lines — call sites), `js/calendar-core.js` (§13c functions), `worker/wrangler.jsonc`, `docs/DEVIATIONS.md`, `WORKLOG.MD`.
**Live credentials:** from `/home/z/my-project/.secrets/credentials.json` — AUTH_UI `8b2d1be0…` (redacted). Local dev ADMIN_SECRET `6c84927f…`, INTERNAL_TOKEN `3967df54…` (redacted).
**Method:** every claim below is backed by (a) full code read with line numbers, and (b) execution — 118 local checks against the wrangler stack (`bash scripts/with-stack.sh`, ports 8787/8788) plus 35 live checks + 4 live raw-socket checks against production. Evidence files: `audit-d/s8-local.mjs`, `audit-d/s8-live.mjs`, `audit-d/s8-connect.mjs`, `audit-d/s8-final.mjs`, results in `audit-d/s8-live-results.json`, `audit-d/s8-live-raw.txt`, `audit-d/s8-final-local.json`, `/tmp/s8-local-results.json`. Local probe score: **116/118** (the 2 non-passes are the CONNECT finding below and a client-library limitation, both explained). Live score: **35/35**.

---

## TOP SUMMARY

| Severity | Count | Titles |
|---|---|---|
| **MEDIUM** | 2 | F1 epoch-not-bumped-on-force-wipe (permanent 304 ghost state); F2 stale §9 move order (data-loss trap for future spec-following clients) |
| **LOW** | 4 | F3 versioning 4.3-vs-"4.3.1" + exact-string client gate; F4 front-door unhandled exception → 500 on CONNECT (§4 law broken wherever the edge doesn't mask it); F5 no `Cache-Control: no-store` on JSON APIs; F6 §9c conditional headers vs claimed RFC 9110 §13.1.2 mapping |
| **INFO** | 4 | F7 stale v4.1 §8 `wrapped` 48B text (+ §9 ct wording ambiguity); F8 malformed §4 endpoint table row; F9 "Worker logs: nothing" vs cron count-logging; F10 `forbidden` kind unhandled in app.js UI |
| **(no HIGH)** | 0 | — |

The wire protocol itself (silent-drop law, §5 error taxonomy, §9 RMW, §9b/§9c/§9d extensions, §21 limits) is **overwhelmingly conformant and probe-verified in both directions**; all findings are edge/admin-path or documentation-level. The only two with real (respectively: client-desync, future-data-loss) impact are F1 and F2.

---

## FINDINGS (verified)

### F1 [MEDIUM] — §9d violation: force-bootstrap's destructive wipe never bumps (or resets) the manifest epoch → connected clients 304 forever and permanently display wiped rows

**Spec (protocol.md §9d, normative):** "The **epoch** is a server-side mutation counter: +1 for every accepted row INSERT, accepted UPDATE and REAL delete (an idempotent re-delete of a missing row does not bump it)."

**Code:** `worker/src/store.js:393-402` — `hBootstrap` force path executes `DELETE FROM rows` (a wipe of *every* row — N real deletes) and `DELETE FROM staged`, then re-creates config. `bumpEpoch()` (store.js:477-479) is called only from `hPutRow` insert (line 623), accepted update (line 636) and `hDeleteRow` real delete (line 657) — **never** from the force-wipe path.

**Probe (local, stack 8788):**
1. `PUT /rows/s8-epoch` (ver 1) → 200; `GET /rows` → etag `e<k>`; `GET /rows` + `If-None-Match: e<k>` → 304 (sanity, PASS).
2. `PUT /bootstrap {force:true, new material}` with ADMIN_SECRET → 200 `{"ver":1}` (wipe executed).
3. `GET /rows` + `If-None-Match: e<k>` **with the new AUTH_UI token** → **304** (`/tmp/s8-local-results.json`, check `L7 BUGCHECK`, PASS-as-bug) while a plain `GET /rows` shows **0 rows** (check `L7 manifest after wipe is empty`).

**Impact:** every §9d-compliant client that holds a pre-wipe etag is told "manifest unchanged" and keeps its local rows forever. The desync is **not self-healing**: the client skips the entire manifest block on 304 (`js/app.js:974` `if (!manifest.notModified)`), which also skips the only code path that would write something server-side on an empty store (the default-calendar bootstrap at `js/app.js:1044-1055`) — so no mutation ever occurs, the epoch never moves, and the 60 s autosync (`app.js:3858-3870`) re-304s indefinitely. The user sees a ghost calendar of rows the admin deliberately destroyed; new events created *elsewhere* would heal it, but in a single-client deployment nothing does. Affects the documented §8 force re-bootstrap and the §19 restore drill's "fresh force-bootstrap" first step whenever the operator keeps the same AUTH tokens and does not re-PUT all rows (the restore drill's own re-PUTs mask it: each INSERT bumps).

**Threat model:** not attacker-reachable (requires ADMIN_SECRET); it is a data-integrity/desync conformance bug in an admin path, exactly the "code does less than the spec" class.

**Fix (one line):** in `hBootstrap`'s force branch, after `DELETE FROM rows`, call `this.bumpEpoch()` (monotonic bump is safer than a reset-to-0: a reset could re-304 a *stale lower* etag from a pre-epoch era… in practice both work because old `"eN"` strings stop matching; the bump keeps the counter monotonic per §9d).

---

### F2 [MEDIUM] — protocol.md §9 states the calendar-move procedure as "DELETE then PUT"; the shipped client does the opposite (PUT then DELETE). Stale normative text = future-client data-loss trap

**Spec (protocol.md §9, "UNCHANGED semantics, restated"):** "DELETE+PUT is the calendar-move procedure (evt row ids embed the calendar uuid): `DELETE evt:{oldcal}:{uid}` then `PUT evt:{newcal}:{uid}`. Between the two the event is absent — a concurrent reader may observe the gap; clients reconcile at next sync."

**Code (the shipped v4.3 client):** `js/app.js:2571-2638` — comment: "Calendar MOVE (protocol.md: the calendar uuid is embedded in the row id, so moving = **PUT evt:{newcal}:{uid} FIRST, then DELETE the old row** — the create-before-delete order guarantees a PUT failure can never LOSE the event (wave-7 A2); a failed DELETE leaves a visible duplicate instead, which the next sync reconciles…". Then: `putRowRMW(newId, …, {allowCreate:true, local:{ver:0,payload:null}})` (line 2620), then `deleteRow(rowId)` (line 2628) with a recoverable-duplicate toast on failure (line 2634).

**Impact:** the server is indifferent (both orders are plain §9 row ops), but the *spec text is the contract for future clients* — and protocol.md §9 ("Compliance notes for the DAVx⁵ fork", §9 of the doc: "href ↔ row id… PUT-with-If-Match ↔ §9 RMW… DELETE ↔ idempotent delete") is the fork's implementation reference. A spec-following implementer codes delete-first: a PUT failure (network drop, 412, rebase exhaustion) after a successful DELETE destroys the only copy of the event — precisely the failure mode the shipped client was re-engineered (wave-7 A2) to eliminate. Additionally the spec's "Between the two the event is absent" claim is false for the shipped client (the real transient is a *duplicate*, not an absence) — anyone building concurrent-reader reconciliation on the spec's promise will get the opposite anomaly.

**Fix:** rewrite protocol.md §9's move paragraph to the implemented order (PUT-first, DELETE-second, duplicate-on-failure-is-recoverable) and note the wave-7 A2 rationale.

---

### F3 [LOW] — Versioning inconsistency (§22/§9c): §9c is documented as "NEW in v4.3.1" but `/version` reports `4.3`; and the client's version gate is exact-string, so ANY newer server silently loses the batch feature + shows a warning

**Spec:** protocol.md §9c heading: "§9c PUT conditional mode (NEW in **v4.3.1** — DAV compatibility)"; but §22/§8 of the same doc: "`GET /version` reports `"4.3"`" and the v4.2→v4.3 change table says `proto := "4.3"`.

**Code:** `worker/src/store.js:18` `const PROTO_VERSION = '4.3'` (live-verified: `/version` → `{"proto":"4.3"}`). Client: `js/app.js:716` `if (ver.proto !== '4.3') { state.batchOk = false; toast(...) }`.

**Probe/evidence:** live `/version` → `"4.3"` (check `V1 /version (ui) -> 200 proto 4.3`). No code path can report `4.3.1`, yet §9c shipped in this build (live 412/404-not_found/bad_if_match behavior verified — checks V3).

**Impact:** (a) A non-browser client that wants §9c cannot gate on version — the doc's own versioning law (v4.1 §22 "Additive evolution bumps the MINOR") was not applied to the 4.3.1 features; conversely a client hard-gating `proto === '4.3'` would be entitled to assume §9c absent. (b) protocol.md §5.4 promises "A newer server must not break the client (additive changes only)" — with the exact-string gate, a future 4.4/4.3.1 server does not *break data ops*, but silently degrades the v4.3 client to per-row GETs and surfaces a "Server reports protocol 4.4 … Deploy the updated worker" warning — a soft-gate implemented as an inequality in the wrong direction. (c) The §8 compatibility matrix's "v4.2 client hard-gates at unlock on proto === '4.2'" claim is symmetric evidence that exact-match gating is the ecosystem's habit — this repo's own doc-vs-code drift is how that class of bug happens.

**Fix:** bump `PROTO_VERSION` to the real version carrying §9c (or re-label §9c as v4.3), and make the client gate `major === 4 && minor >= 3` instead of `!==`.

---

### F4 [LOW] — Front door has no try/catch: a CONNECT request (any path, any/no token) crashes the Worker with a bare `500 Internal Server Error` text page — violating §4/L3's "No-auth → empty 404. Always. Everywhere" wherever the platform forwards it

**Spec (v4.1 §4 / protocol.md §3):** "SILENT DROP (L3): any request failing the bearer gate gets HTTP 404, Content-Length: 0, no body…" and "unknown routes (any method) → empty 404". Design law L3: "No-auth → empty 404. **Always. Everywhere**."

**Code:** `worker/src/index.js:42-73` — `async fetch(req, env)` has **no** exception handler; `new URL(req.url)` (line 54) and `stub.fetch(...)` (line 71) run bare. (The DO *does* catch everything → JSON `{"error":"internal"}` 500, store.js:224-233 — the front door does not.)

**Probe (local, raw sockets — `audit-d/s8-connect.mjs`):**
```
CONNECT /version HTTP/1.1  (+ valid AUTH_UI)  → HTTP/1.1 500 Internal Server Error … Content-Length: 21 … "Internal Server Error"
CONNECT /nope    HTTP/1.1  (no token)          → identical 500
CONNECT host:443 form (no token)               → identical 500
```
The 21-byte plain-text body is workerd's generated error page — i.e. an **uncaught exception in the Worker script**, not the DO's JSON 500. Response shape is outside the §5 taxonomy entirely (a spec-conforming client classifies it as generic `http` — verified in `js/api.js:71`).

**LIVE behavior (masked):** on `calendar-poc.sh-clock.workers.dev`, Cloudflare's *edge* intercepts these methods before the Worker — `TRACE /rows` (valid token) → **405 Not Allowed** (155-byte cloudflare HTML page); `CONNECT` (any form/token) → **400 Bad Request** (HTML) — see `audit-d/s8-live-raw.txt`. So on production the app's §4 law holds only *accidentally*: the observable live deviation is the edge's 405/400-with-HTML-body (uniform across all paths and tokens — no route/auth oracle, no internals leaked), but the code defect remains live for any non-CF-edge deployment (workerd self-host, future runtime changes, or any other exception source in the front door: an unhandled throw anywhere in `fetch()` becomes a 500 page).

**Impact:** low — no differentiation between routes or auth states (all CONNECTs fail identically), no stack/message leak (generic page). But it is a real "code does less than the spec" break of the silent-drop law, and a robustness hole: one `try/catch → silentDrop()` is cheap insurance for the entire relay.

**Fix:** wrap `index.js` fetch body in try/catch returning `silentDrop()` (404, empty); optionally also handle TRACE explicitly.

---

### F5 [LOW] — No `Cache-Control` (nor any freshness directive) on any JSON response; client `fetch()` uses default cache mode — a cacheable `/rows` or `/config` response would desync clients

**Spec:** §4 mandates the *absence* of cache headers only on the silent drop ("no cache headers" — verified, both stacks). Nothing in the spec mandates `no-store` on the JSON APIs; §9d's conditional-read design *assumes* responses are not served stale by intermediaries.

**Code/evidence:** `worker/src/store.js:118-123` `json()` sets only `content-type`. Live-verified headers: `/version`, `/config`, `/rows` 200 → **no `cache-control`, no `expires`** (checks `V1/V2`); the 304 sets only `etag` (store.js:497); the 200 manifest carries the etag **in the body only — no `ETag` response header** (check `V2 /rows 200 has NO ETag header`; this is per §9d's letter, which only requires the header on 304). Client: `js/api.js:37-42` — `fetch()` with no `cache: 'no-store'`.

**Impact:** browser heuristic caching does not apply (no `Last-Modified`), and Cloudflare does not cache these responses by default, so the *practical* risk today is low. But §9d exists precisely to make polling cheap; a shared cache (corporate proxy, a future CF cache rule, a service-worker addition) replaying a cached `/rows` 200 or `/config` would desync clients with no protocol-level defense. The `/config` response (bootstrap params) additionally lacks `Vary`-style protection — irrelevant while uncached, defense-in-depth once any caching layer appears.

**Fix:** add `'cache-control': 'no-store'` in `json()` and the 304 builder; or pass `cache: 'no-store'` in `api.js` fetches (or both).

---

### F6 [LOW] — §9c's claimed "maps 1:1 onto CalDAV PUT with If-Match/If-None-Match … RFC 9110 §13.1.2 semantics" is not exact: `If-Match: *` → 400 `bad_if_match`; etag-form `If-None-Match` on PUT is silently ignored; `GET /rows` ignores list/weak `If-None-Match` forms

**Spec (protocol.md §9c):** "This maps 1:1 onto CalDAV `PUT` with `If-Match`/`If-None-Match` so that DAV clients (the DAVx⁵ fork) get RFC 9110 §13.1.2 semantics with real status codes." (§9c itself only normatively defines `If-None-Match: *`, `If-Match: "<ver>"`, and malformed-If-Match → `400 bad_if_match`.)

**Code:** `worker/src/store.js:130-133` `parseEtagVer` = `/^\s*"([0-9]{1,10})"\s*$/` — `*` fails it → `bad_if_match` (store.js:595-598). `If-None-Match` values other than the literal `*` are never evaluated on PUT (only the `trim() === '*'` branch at store.js:613). `hManifest` (store.js:495-497) matches only the single exact quoted `"e<epoch>"` string.

**Probes (local, all reproduced):**
- `PUT … If-Match: *` → `400 {"error":"bad_if_match"}` (check `L3 If-Match *`). RFC 9110 §13.1.2: `If-Match: *` is *valid* and means "if the resource exists" → should proceed (or 412 only when missing). A DAVx5-style client sending `If-Match: *` gets an undocumented 400.
- `PUT … If-None-Match: "e5"` (etag-form, non-`*`) on a missing row → **200 create** (RMW path, condition ignored) — check `L3 If-None-Match "e5" … ignored`. RFC 9110 would compare the entity-tag and 412 on match; here the header is a no-op. A client believing it expressed a precondition got none.
- `GET /rows` with `If-None-Match: W/"eN"` → 200; with a list `"eN", "e999"` → 200; unquoted `eN` → 200 (checks `L4 weak/list/unquoted`). §9d only defines the exact quoted form, so this is spec-conformant — noted here because the same doc advertises RFC-semantics interop.

**Impact:** interop-only (the shipped web client sends no conditional headers — verified: `api.js` `putRow` sends exactly `{ver,nonce,ct}` + bearer, check `L5`). The DAV fork is the affected party: `If-Match:*` is a common client emission, and "maps 1:1" is the doc's promise. No security impact (all outcomes fail closed or fall back to RMW).

**Fix:** accept `If-Match: *` as exists-check (412 only when the row is missing); either reject or explicitly document etag-form `If-None-Match` on PUT; optionally support list/weak forms on `/rows`.

---

### F7 [INFO] — v4.1 §8 `wrapped` length text remains wrong ("48B = 12B nonce || 32B ct+tag") vs the 60-byte implementation; §9's "ct ≤ 65536 bytes base64" wording is ambiguous in the same doc family

**Evidence:** implementation `worker/src/store.js:22` `WRAPPED_LEN = 60`, enforced at store.js:384 (`bad_wrapped`); reference CLI `cli/bootstrap.mjs:26` `WRAPPED_LEN = 60`; **live** `/config` `wrapped` decodes to exactly **60 bytes** (check `V2 /config wrapped decodes to 60 bytes`). The 12+32 arithmetic in the v4.1 §8 text cannot hold a 32-byte key + 16-byte GCM tag. This is *documented* (docs/DEVIATIONS.md §"Spec findings" #1, WORKLOG D2) — but the normative v4.1 text was never corrected, and protocol.md (the repo-root "ENTIRE wire spec") does not restate the corrected value anywhere. A from-spec implementer fails bootstrap with `bad_wrapped` and must find DEVIATIONS.md to learn why. Secondary nit: protocol.md §9 "`ct` ≤ 65536 bytes base64" — the enforced rule (matching v4.1 §6/§21) is 65536 **decoded** bytes (store.js:582, probed: 65536 B accepted / 65537 B → `bad_ct`); the v4.3 phrasing invites misreading as a 65536-**character** limit (≈49 KB).

**Fix:** correct the v4.1 §8 text (or add an erratum block to protocol.md §2) and reword §9 to "ct ≤ 65536 decoded bytes".

---

### F8 [INFO] — protocol.md §4 endpoint table is malformed: the `POST /rows:batch` row is merged into `PUT /rows/{id}` (missing cell separator)

**Evidence:** `protocol.md:75` — `| \`POST /rows:batch\` | ui/clock | NEW | §9b                                    || \`PUT /rows/{id}\` | ui | — | RMW arbitration, §9 |` — one physical line containing two logical rows; renders as a broken table where the PUT row's class/notes columns are swallowed. The §9b/§9c/§9d sections themselves are correct; only the overview table is damaged. Impact: cosmetic/doc-quality (a reader scanning the endpoint table sees a garbled row and may miss that `/rows:batch` exists at the route table level).

**Fix:** split into two table rows.

---

### F9 [INFO] — §3 key ledger says "Worker logs: nothing, ever"; the backup cron logs `backup ok day=<day> rows=<count>`

**Evidence:** `worker/src/index.js:87` `console.log('backup ok day=' + j.day + ' rows=' + (j.rows | 0))`; v4.1 §3 key ledger: "Worker logs: nothing, ever". No ids, no params, no key material are ever logged (store.js:230 logs exception *messages* only, and the 500 body is a fixed string — verified: no internals in any probe response). Also `wrangler.jsonc:36` `observability.enabled: false` → logs are not persisted by default. The WORKLOG documents this as "counts only, never ids/params" — a defensible reading of the ledger's *intent* (the ledger line is about key material), but it contradicts the letter.

**Fix:** one-line spec erratum ("logs: counts only") or drop the console.log.

---

### F10 [INFO] — The `forbidden` (403-empty) error kind has no dedicated handling anywhere in app.js

**Evidence:** `js/api.js:65` classifies 403-empty → `kind:'forbidden'`; grep of `js/app.js` shows **zero** references to `forbidden` (the only kind-specific branches are `silent` at app.js:685/747/896 and `not_found` via `getRow`'s null-mapping, api.js:114). A 403 (only reachable if a mis-provisioned client presents the AUTH_CLOCK token as AUTH_UI — both derive from the same AES1, DEVIATIONS.md) surfaces as a generic "Login failed: forbidden_403" or "Sync problem: forbidden_403" toast. The classification itself is **correct** per §5 (verified in the L5 stub harness: 403-empty → `forbidden`, 403-with-body → `http`); only the UX remediation is absent. Impact: cosmetic.

**Fix:** optional toast explaining the capability class mismatch.

---

## VERIFIED-CONFORMANT — §-by-§ matrix (spec → code → probe)

Legend: **L** = local stack probe (8787/8788, `/tmp/s8-local-results.json`), **Lv** = live probe (`audit-d/s8-live-results.json`, `s8-live-raw.txt`, `s8-final-local.json`), **R** = full code read. Spec = v4.1 base + v4.2 delta + protocol.md v4.3.

### §1 Threat model / L1 untrusted relay
- Server is type-blind: stores/returns envelopes verbatim, compares only clear `ver`; never inspects `nonce`/`ct` (R: `hPutRow` touches `val.ver` only for arbitration; `nonce`/`ct` are decoded to bytes and bound as BLOBs, store.js:577-647). Verbatim storage + echo proven: accepted PUT echoes the **submitted** canonical b64 strings byte-identically (L: `ct=65536B accepted 200 + verbatim echo`; Lv: `V3 INM:* create own row -> 200 echo`).

### §2 Constants
| Constant | Spec | Code | Probe |
|---|---|---|---|
| KDF_ITERS | 100000 | store.js:19, enforced `=== KDF_ITERS` at :383 (`bad_iters`) | api-suite b-series (163/163 both stacks) |
| ROW_CT_MAX | 65536 | store.js:20, :582 | L: 65536 B ct accepted; 65537 B → `bad_ct` |
| VER_WIDTH u32, first 1 | u32 ≥ 1 | store.js:21, :578 | L: ver 0 / 4294967296 / 1.5 → `bad_ver`; ver 1 and 4294967295 accepted |
| GCM_NONCE_LEN 12 | 12 B | store.js:23, :580 | L: 11 B / 13 B → `bad_nonce` |
| WRAPPED 60 B | (48 B text — F7) | store.js:22, :384 | Lv: live `/config` wrapped = 60 B decoded |
| ID_MAX 256 | D9/v4.2 id budget | store.js:24, :360-363 (post-auth) | L: 256-char id accepted; 257 → `bad_id`; no-token 257 → silent 404 (gate first) |
| BATCH_MAX_IDS 256 | §9b | store.js:25, :529 | L: 256 ids → 200; 257 → `bad_ids` |
| BODY_MAX 1 MiB (D16 hygiene, whole JSON) | n/a (v4.1 §21 has photo caps) | store.js:26, :139-163 | L: body exactly 1048576 B passes; 1048577 → `too_large`; ~2 MiB → `too_large` in <10 s (no hang); >32 MiB (BODY_DRAIN_MAX) → connection torn down, no hang (F-final) |
| BACKUP_RETENTION 7 d | §2/§19 | store.js:28, :670-672, :706-707 | R + api-suite §19 phases (WORKLOG) |
| STAGING_MAX_AGE 14 d | §2/§19 | store.js:29, :713-716 | R |
| PASSWORD_LEN_MIN 40 | §2 | not enforced — PoC waiver, documented (DEVIATIONS.md "Security posture") | R |

### §3 Key hierarchy / key ledger
- Server holds only `wrapped` + AUTH_UI/AUTH_CLOCK (config table, store.js:199-203); AES1/K_data never server-side (R). Logs: exception messages only (store.js:230) + backup counts (F9). Observability off (wrangler.jsonc:36).

### §4 Auth + silent drop
- Bearer regex `^Bearer ([0-9a-f]{64})$` — strict lowercase hex64 (store.js:331); uppercase token / lowercase scheme / double space → empty 404 (L: `L6 uppercase/lowercase/double-space`). Constant-time compare over hex-decoded 32 bytes (`ctEqual`, store.js:97-102, 340-343) — spec's exact requirement.
- Gate before body consumption: unauthenticated ~2 MiB PUT → 404 empty, body never read (L: `oversized PUT unauthenticated`).
- Unknown routes (any method, any auth state) → empty 404: probed across a 6-method × 15-path matrix (incl. `/`, `/rows/`, `/rows/%zz`, `/VERSION`, `/version/`) — all silent (L: matrix). PATCH /config with **valid token** → empty 404 (L: raw-socket + fetch; **Lv: live `V1 PATCH /config`**). HEAD /version valid token → 404 empty (L raw; Lv live). TRACE /rows valid token → 404 empty on the local stack (L raw); live edge returns 405 HTML (F4/live note). CONNECT → F4.
- Wrong-secret `/bootstrap` (no/bad/UI token) → empty 404; admin+malformed → 400 `bad_json` (L). Admin/Internal tokens on app routes → empty 404 (L, both).
- Silent-drop shape: `Content-Length: 0`, no body, no `WWW-Authenticate`, no cache headers, header set byte-identical between "bad auth on known route" and "unknown route" (L raw-socket byte comparison; **Lv live: `V1 indistinguishable`** — an attacker without a valid token cannot distinguish route existence; with a valid token they can, by design — they're authenticated).
- OPTIONS preflight: front-door exemption (browsers never send Authorization), 204 + CORS for allowlisted origin on **any** path, empty 404 + no CORS for foreign/absent origin (L + Lv live). Allow-methods `GET, POST, PUT, DELETE, OPTIONS` (no PATCH) and allow-headers include `Authorization, Content-Type, If-Match, If-None-Match` (index.js:27-28; Lv live `V1 OPTIONS`).
- CORS decorate applies to all statuses incl. the silent 404 (Lv live check) — necessary for the browser to see the drop; allowlist = `https://sh-clock.github.io` (wrangler.jsonc:33).

### §5 Encoding & error policy
- Strict canonical base64 (standard alphabet, padded, O(1) canonicality check store.js:51-75): unpadded → `bad_nonce`; non-canonical `QR==` → 400 (L). Hex fields lowercase (`HEX64_RE`/`HEX32_RE`, store.js:31-32; uppercase `auth_ui` → 400, api-suite b7).
- Authenticated-but-malformed → `400 {"error":"<short string>"}`: 13 shapes probed (`bad_json`, `bad_body`, `bad_ver`, `bad_nonce`, `bad_ct`, `bad_id`, `bad_ids`, `bad_salt`, `bad_iters`, `bad_wrapped`, `bad_auth_ui`, `bad_auth_clock`, `bad_if_match`, `too_large`) — all with non-empty JSON bodies (L).
- Capability violation (clock writing rows) → 403 **empty** body, body drained so the response is deliverable: clock PUT/DELETE (incl. with conditional headers) → 403 empty; clock may read rows/batch/config/version/status/manifest (L).
- Authenticated-but-missing → `404 {"error":"not_found"}`: GET missing row (L+Lv), rewrap/config on un-bootstrapped store (R, api-suite), §9c If-Match on missing row (L+Lv).
- **Client taxonomy matches exactly** (`js/api.js:64-71`, stub-fetch harness L5): 404-empty → `silent`; 404 with foreign body (HTML or JSON with a different error) → `http`; 404 with `{"error":"not_found"}` → `not_found`; 403-empty → `forbidden`; 403-with-body → `http`; 500 JSON → `http`; network → `network`. A **304 without our If-None-Match → `ApiError('http', 304)`** — fails loud, never misread as "manifest unchanged" (api.js:51 requires the request to have sent `if-none-match`). `getRow` maps `not_found` → `null` (api.js:110-117). Unlock path distinguishes `silent` with a §5-conformant message (app.js:747-748).
- Unspecified JSON fields ignored (R: handlers read only known fields; api-suite r19). Timestamps unix seconds (store.js:603). (UTF-8 decode is non-fatal — U+FFFD leniency noted in WORKLOG A1; content-blind by design.)

### §6 Row envelope (server side)
- Envelope `{id, ver, nonce, ct}`; server stores verbatim, compares ver only, AAD never inspected (R). Acceptance/rebase via ver (§9 below). No minimum ct length / no content inspection (D16): arbitrary-length (≥1 B) ct accepted (L: 16/48/64/65536-byte ct rows all stored).

### §7 Storage schema
- `rows(id TEXT PK, ver INTEGER, nonce BLOB, ct BLOB, updated_at INTEGER)` (store.js:194-197); config singleton with clear+private columns (199-203); `staged` (205); plus internal `meta` epoch table (209-212) — additive, server-internal. D1 backup tables per §19 (681-689). SQL fully parameterized throughout (R).

### §8 Bootstrap / config / rewrap
- `PUT /bootstrap`: validation order salt→iters→wrapped→auth_ui→auth_clock (376-386); empty config → create, `200 {"ver":1}` (403-408); existing → `409 {"error":"exists"}` (389); `force:true` wipes rows+staged **then** config (crash-safe order, 393-402; the A1#2 fix — verified by prior wave's B2 test) — epoch gap is F1; R2 photo wipe out of scope (documented).
- `GET /config`: clear params only `{salt,iters,wrapped,ver}` — **live-verified**: no `auth_ui`/`auth_clock` keys in the response (check `V2 /config omits private columns`); wrapped 60 B (F7 note); auth required (no token → empty 404, L).
- `PUT /bootstrap/rewrap` (§20 Type A): single-statement atomic UPDATE of `wrapped` (+optional `salt`), `ver+1`, touches **nothing** else — no rows, no staged, no private column (430-440); missing config → 404 `not_found` (427); `200 {}` (441); wrong secret → empty 404 (L).

### §9 Row sync (GET/PUT/DELETE)
- `GET /rows` → `{rows:[{id,ver}]}` ordered by id, config row never included (499-500; Lv live manifest: 15 rows, 0 config). Auth either class (304 for clock too — L).
- `GET /rows/{id}` → full envelope or 404 `not_found` (503-515; L+Lv).
- `PUT /rows/{id}` (UI only): ver u32 ≥ 1 (577-578); new row accepts any ver ≥ 1 (618-627; §19 restore drill, WORKLOG D8); `incoming.ver > stored.ver` → accept + echo submitted envelope (631-637); otherwise → reject-as-rebase, **200** + CURRENT stored envelope (640-646) — probed at the u32 boundary (stored 4294967295, incoming 1 → echo of stored). Note: PUT-create returning 200 (not 201) is the spec's own letter ("return 200 + stored envelope") — intentional, documented here per task item 7.
- Client acceptance by **envelope identity** (nonce equality; WORKLOG D14): `app.js:1158` compares ver+nonce+ct; rebase → fetch+re-apply pure build, **at most 8 attempts** (`REBASE_MAX=8`, app.js:60, loop 1152-1180); create-rebase never overwrites a foreign row (1164-1166).
- `DELETE /rows/{id}` (UI only) → idempotent `200 {}` even when absent (650-659; L+Lv live: re-delete after delete → 200).
- Calendar move: client implements PUT-first (F2 — spec text stale).

### §9b `POST /rows:batch` (v4.3)
- Body `{"ids":[…]}`; count > 256 or duplicates or empty/non-array → `bad_ids`; shape (non-string/empty/>256 UTF-16 units) → `bad_id`; JSON/body malformed → `bad_json`/`bad_body` (523-533) — **all probed**, incl. the 256/257 boundary both for count and id length (L).
- Response `{"rows":[…]}` in **request order**: full envelope `{id,ver,nonce,ct}` (byte-identical field set to `GET /rows/{id}` — R: same fields, same encoding path) or `{id, missing:true}` (539-562) — probed with 256 ids all missing (L).
- Pure read: never bumps the epoch (L: `batch read never bumps`), works for the clock class (L), never touches nonce/ct (R).
- Fallback story (§5.1c/§8): client `batchRows` on `ApiError kind 'silent'` → `state.batchOk=false` → per-row `getRow` fallback (app.js:889-916, verified call site); version probe disables batch when `proto !== '4.3'` (app.js:712-726) — both mechanisms exist in code; >256-id sync sets are chunked at 256 (app.js:1004-1008). CORS allow-methods includes POST (live).

### §9c Conditional PUT (v4.3.x)
- `If-None-Match: *` create-only: new row → 200 + echo; existing → **412 empty body** (613-615) — L+**Lv live** (both reproduced on production with my own row).
- `If-Match: "<ver>"`: match → RMW as usual (200 accept when ver greater — L); mismatch → **412 empty** (610-612; L+Lv); missing row → **404 `not_found` with body** (606-609; L+Lv); malformed (non-quoted-decimal) → `400 bad_if_match` (595-598; L). Whitespace-tolerant regex (L: `' "2" '` accepted).
- Web client sends **no** conditional headers (api.js `putRow` — L5 stub verified: exactly `{ver,nonce,ct}` + bearer). Front door forwards `if-match`/`if-none-match` (index.js:60) and CORS allows them (live OPTIONS).
- RFC deltas → F6.

### §9d Conditional read / etag (v4.3)
- Manifest carries `etag:"e<epoch>"` (494; Lv live `e36`); `If-None-Match: "e<epoch>"` exact match → **304, empty body, `ETag` header set** (495-497; L+Lv).
- Epoch semantics probed end-to-end (L4): +1 on INSERT, +1 on accepted UPDATE, +1 on REAL delete; **no bump** on reject-as-rebase, on reads, on batch reads, on idempotent re-delete of a missing row — every clause of §9d verified. Deviation: force-bootstrap wipe (F1).
- Interop both directions: client without etag sends no header → plain 200; client ignores unknown manifest fields; 304 → `notModified:true` keeps local state (api.js:51-53; app.js:974, 1056-1057); etag dropped on lock so a fresh unlock cannot 304 into an empty render (app.js:783-786).
- Etag leaks only a mutation counter (no ids/vers) — matches §1's L1-surface note.

### §10 Status
- `GET /status` → `{"photo_pending":N}` with N = |staged| (462-465; Lv live 200; always 0 in calendar scope — matches protocol.md §4 table).

### §11 WS radar; §12 alarms; §14 todos; §15–§18 photos
- Omitted by owner order; documented in DEVIATIONS.md (§11 omission rationale: no row-change nudge frame exists in the spec; sync is pull-based). No vestigial routes (`grep`-clean route table, R) — nothing reachable to probe. Out of audit scope; noted for completeness.

### §13 Day buckets (DEPRECATED in v4.3) + §13c local derivation
- Client MUST NOT read/write cal: rows: **verified** — zero `cal:` writers/readers remain in app.js (grep: no `bucketId`/`writeBucket`/`rotateWindow`; the sync loop ignores non-evt/cmeta ids, app.js:981-1000 with the explicit deprecation comment at 983-984). All writes go through `core.evtId`/`core.cmetaId` (grammar-enforced, calendar-core.js:94-116: UUID cal, UID ≤ 200, no `:`).
- §13c local derivation exists: `deriveWindowBuckets(parsedRows, today)` (calendar-core.js:595-613), window `[today-1 … today+21]` = 23 buckets (`WINDOW_BACK=1`, `WINDOW_FWD=21`, :27-28, `windowDays` :66-69), ≤16 per bucket with deterministic (priority, id) drop (`CAP_PER_BUCKET=16`, :26, `capDerived` :580-585), `x:{pid}` ids with the v4.2 §13b normative `projIdHash` **verbatim** (lanes/imul/hex-slicing/version-5/variant-a nibbles, :565-577 vs PROTOCOL-v4.2.md §13b algorithm — matched clause by clause).
- One-time cleanup of legacy cal: rows: **done on production** — live manifest contains **0** `cal:` rows (2 cmeta + 13 evt only).
- protocol.md §13's own text (MUST NOT / SHOULD delete) matches the code. The *stale* normative text is §9's move order (F2), not §13.

### §19 Backup (calendar scope)
- Cron `0 3 * * *` (03:00 UTC daily, wrangler.jsonc:30) → `scheduled` calls `/internal/backup` with INTERNAL_TOKEN (index.js:76-90).
- Route is internal-family: silent 404 for no/UI tokens (L, probed); with INTERNAL_TOKEN → `200 {ok:true, day, rows:N}` — **probed locally** (F1 checks; response keys exactly `ok,day,rows` — no ids/params leaked).
- Snapshot copies all rows + config (clear **and** private columns) to D1 `backup`/`config_backup` (674-708), prunes days older than 7 (670-672, 706-707), sweeps `staged` older than 14 d (713-716). D1 binding present (wrangler.jsonc:22-27). Byte-fidelity of BLOB nonce/ct + retention boundaries + restore drill were verified by prior waves (WORKLOG B-series, run-local ALL GREEN); new-row-any-ver (§9) is what makes the drill legal.

### §20 Key rotation
- Type A (password change): `PUT /bootstrap/rewrap` — implemented, atomic, touches nothing else (see §8). Type B: documented exclusion (DEVIATIONS.md). No partial Type-B code paths exist to diverge (R).

### §21 Caps & limits
- Server-enforced row `ct ≤ 64 KiB` → `bad_ct` (probed at the byte boundary). Unauthenticated anything → empty 404 (probed, incl. oversized bodies). `ID_MAX 256` post-auth → `bad_id` (probed; pre-auth stays silent — the §5 class separation is correct, unlike the wave-A1 bug which is fixed in the current code, store.js:360-363 runs *after* the gate). `BATCH_MAX_IDS 256` (probed). `BODY_MAX 1 MiB` on the whole request JSON at the **DO** layer (the front door streams bodies unread — index.js:64-71 — so there is exactly one enforcement point; unauthenticated oversized bodies are dropped pre-read): probed exact-boundary pass/fail; ~2 MiB → clean `400 too_large` after drain (<10 s, no hang); > 32 MiB drain ceiling → connection teardown (documented design, store.js:141-146 comment; reproduced: "fetch threw / terminated", wrangler log shows the DO answered but the relay's stream read failed — no hang either way). Effective ct ceiling via BODY_MAX (~87.4 KB b64 for a 64 KiB ct) is comfortably above ROW_CT_MAX — the two caps never conflict. Photo-domain caps (preview/chunk/ack-rate): n/a (scope cut).
- Chunked request bodies (no Content-Length) are accepted and parsed correctly (L: raw-socket chunked PUT → 200 envelope); a PUT with neither Content-Length nor chunked framing errors out promptly (400/404) — no hang (L). Responses always carry explicit `Content-Length` (raw-socket verified; 404s are `content-length: 0`).

### §22 Versioning
- `/version` → `{"proto":"4.3"}` (458-460) — **live-verified**. Additive-only evolution held for 4.2→4.3 (new row types, §9b/§9c/§9d all additive; old-client tolerance verified in the client: unknown manifest fields ignored, per-row fallback). Version-gate deviations → F3.

### HTTP semantics summary (task item 7)
- PUT-create = 200 + envelope (not 201) — spec's own letter (§9 "return 200 + stored envelope"); intentional, matches client expectations (acceptance by identity, not status).
- DELETE idempotent 200 `{}` always (L+Lv).
- 304: empty body + `ETag` header, only for exact `"e<epoch>"` If-None-Match (L+Lv); api.js treats a foreign 304 as an `http` error (fails loud — safe).
- 412: empty body (L+Lv); 409 `exists`: JSON body (api-suite); 500 (DO): JSON `{"error":"internal"}`, no internals (R: message-only logging; never triggered by any probe input).
- No `WWW-Authenticate` anywhere; no cache directives on any response (F5); query strings ignored; trailing-slash/case variants are unknown routes (silent 404).
- Browser-fetch caching: no `Cache-Control` on JSON responses and default fetch cache mode (F5) — with no `Last-Modified`/`ETag` on 200s, current browsers/proxies do not serve stale copies in practice; flagged as defense-in-depth.

---

## Attack cross-derivation (task item 8)

| Finding | Exploitable? | How / why not |
|---|---|---|
| F1 epoch/force-wipe | No (admin-only trigger) | Requires ADMIN_SECRET. Impact is client-side ghost state after an intentional wipe; no attacker path, no confidentiality/integrity breach of stored rows. |
| F2 stale move order | Not today; tomorrow yes | No shipped client follows the doc's order. The DAVx5 fork (an announced deliverable, §9 "Compliance notes") implementing §9 verbatim gets a **permanent event-loss** path (DELETE succeeds, PUT fails). Doc fix required before the fork is built. |
| F3 versioning drift | Weakly | A future server bump silently degrades v4.3 clients (efficiency + warning noise, no data loss). A 4.3.1-gating client cannot discover §9c. DoS/noise-level only. |
| F4 CONNECT 500 | Informational | Unauthenticated 500 distinguishes "request reached a workerd runtime" — already public. No route/auth differentiation (identical for every path/token), no internals in the body. On production the edge answers before the Worker. |
| F5 no cache-control | Conditional | Requires an intermediary that caches without freshness info (non-default today). A stale cached `/rows`/`/config` would desync clients; not attacker-triggerable directly. |
| F6 RFC 9110 deltas | Interop only | All divergent outcomes fail closed (400/412) or fall back to RMW; no auth bypass, no overwrite. |
| F7/F8/F9/F10 | No | Documentation/UX only. |

No HIGH findings: the silent-drop law, error taxonomy, and size limits held under every adversarial probe (method matrix, byte-level 404 comparison, boundary bodies, pre/post-auth ordering, conditional-header fuzzing) on both the local stack and production.

---

## Probe inventory (for reproduction)

- `bash scripts/with-stack.sh --no-bootstrap bash -c 'set -a; eval "$(grep -E "^(ADMIN_SECRET|INTERNAL_TOKEN)=" worker/.dev.vars | sed "s/^/export /")"; set +a; node audit-d/s8-boot.mjs && node audit-d/s8-local.mjs'` → 116/118 (2 explained: CONNECT-500 = F4; 40 MiB teardown = documented BODY_DRAIN_MAX).
- `node audit-d/s8-live.mjs` → 35/35 live checks (uses `/home/z/my-project/.secrets/credentials.json`; own row `evt:sec-S8:probe1` created via conditional PUT and deleted; live manifest re-checked afterwards: 0 leftover S8 rows, etag `e36`).
- `audit-d/s8-live-raw.txt` — live raw TRACE/CONNECT edge behavior.
- `node audit-d/s8-final.mjs` (local) — backup shape, 32 MiB+ teardown, manifest cleanliness: 4/4.
- Note: local wrangler dev is flaky in this sandbox (api-suite FATALed twice on ECONNRESET before succeeding — matches WORKLOG N1); all probe scripts retry once on transient connection errors. TRACE could not be sent via undici (library limitation) — raw TCP sockets were used instead.
