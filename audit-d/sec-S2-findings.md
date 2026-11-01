# S2 — Authentication / Bearer Gate — Security Audit Findings

- **Agent:** S2 (authentication / bearer gate), coordinated 8-agent audit
- **Target (LIVE):** `https://calendar-poc.sh-clock.workers.dev` — Calendar-Web PoC, PROTOCOL v4.3 deployed (`GET /version` → `{"proto":"4.3"}`)
- **Repo audited:** `/home/z/my-project/calendar-web` @ `worker/src/store.js` (bearer gate `route()` L266–366, `getConfig()` L236–250, `ctEqual()` L96–102, `hexDecode()` L77–85), `worker/src/index.js` (front-door header forwarding L57–65, OPTIONS L49–52), `protocol.md` §3 + `docs/PROTOCOL-v4.1.md` §4 (silent drop) / §5 (error policy), `js/crypto.js` (client-side `authUi` derivation), `js/api.js` (client bearer attach), `cli/bootstrap.mjs` (material generation).
- **Method:** live HTTP probes (credential material from `/home/z/my-project/.secrets/credentials.json` — UI token redacted to `8b2d1be0…`, clock token to `cf554ff8…`; the file **does** contain a live `auth_clock_hex`, contrary to the brief's assumption — it was used for read-only probes and rejected-write probes only), plus local probes against a wrangler dev stack on a **dedicated port 8799** with S2's own bootstrapped universe (own admin-secret-gated bootstrap via `cli/bootstrap.mjs` material; `ADMIN_SECRET`/`INTERNAL_TOKEN` from `worker/.dev.vars`, never printed), including the unbootstrapped state on a fresh persist dir. No brute-force/enumeration was performed (single random unknown tokens only). No destructive LIVE operation was performed (no `/bootstrap`, no `/bootstrap/rewrap`, no `/internal/backup`, no DELETE of any row; all clock-class write attempts were rejected by the gate before any handler ran and were followed by `not_found` verification).
- **Normative gate spec:** §4: `Authorization: Bearer <hex64>`; wrong/missing token, wrong-secret `/bootstrap`, unknown routes → **empty 404, Content-Length 0, no body, no WWW-Authenticate, no cache headers**; comparison constant-time over the hex-decoded 32 bytes. §5: authenticated-malformed → `400 {"error":…}`; capability violation (clock writing) → **403 empty**; missing resource → `404 {"error":"not_found"}` (with body); no response may explain which gate failed.

## Summary

| Severity | Count | Titles |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 0 | — |
| MEDIUM | 0 | — |
| LOW | 2 | L-1 clock-class DELETE (and other non-drained rejections) can miss the §5 response shape on bodied requests; L-2 `GET /config` offline-password-cracking surface exposed to the read-only CLOCK class |
| INFO | 6 | I-1 bearer grammar matrix (fail-closed; OWS-only leniency); I-2 token-class matrix (no confusion); I-3 flat timing profile (no oracle); I-4 unbootstrapped state invisible; I-5 audit-infra contention note; I-6 §4 "disabled token" has no implementation |

**Bottom line:** the bearer gate itself is implemented exactly to spec and I found **no authentication bypass of any kind** — no grammar forgery, no class confusion, no route/bootstrap-state oracle, no timing oracle, no private-column or credential echo. The two LOWs are robustness/design-hardening items at the gate's edges (body-drain asymmetry; `wrapped`-blob exposure to the clock class), not bypasses.

---

## Findings

### [LOW-1] The 403 capability rejection drains the request body for PUT only — DELETE-with-body degrades to a non-§5 response (dev stack; production OK at tested sizes)

**Code:** `worker/src/store.js` L352–355:
```js
if (requireUi && cls !== 'ui') {
  if (method === 'PUT') await readBodyBounded(req); // drain so the 403 reaches the client cleanly
  return forbidden();
}
```
Only `PUT` is drained. A `DELETE` carrying a request body (the front door forwards bodies for every non-GET/HEAD method, `index.js` L65) is answered before its body is consumed.

**Evidence (local, S2 dedicated universe, clock token = own material):**
```
5.03 clock DELETE 2MiB body (DELETE has no drain)  -> HTTP 500, len=31, body="Error: Network connection lost."
     (reproduced twice, two independent stack runs: first run P2.24 and final run 5.03)
5.01 clock PUT 2MiB body -> 403, len=0, cla=0, no WWW-Authenticate, empty body   (drain works: §5-conformant)
5.04 clock PUT 33MiB body (> BODY_DRAIN_MAX 32MiB) -> 403 delivered cleanly in 159ms (drain-abort path still answers)
5.02 UI PUT 2MiB body (> BODY_MAX 1MiB) -> 400 {"error":"too_large"}              (authenticated oversized → drained, 400)
```
**Evidence (LIVE, production):** `DELETE /rows/s2-gate-probe` with clock token `cf554ff8…` + 64KiB body → `403`, `content-length: 0`, empty body — the production edge absorbs the unconsumed body at this size:
```
L3 clock DELETE /rows/s2-gate-probe 64KiB body -> 403   len=0 cla=0 wwwa=(absent)
L1 clock PUT  64KiB body -> 403   L2 clock PUT 512KiB body -> 403   (drained in production)
L4 unknown-token PUT 64KiB -> 404   L5 no-token PUT 64KiB -> 404    (silent drop delivered)
L7 UI GET /rows/s2-gate-probe after all of the above -> 404 {"error":"not_found"}  (no write ever happened)
```
The same root cause affects *any* rejection that returns before reading the body (all silent drops): locally a 2MiB unauthenticated PUT once surfaced as `UND_ERR_SOCKET` instead of the 404 (nondeterministic — one run delivered the clean 404, one run the socket error); live at 64KiB the 404 is always delivered. The `index.js` L67–70 comment acknowledges the intent ("the DO authenticates from headers BEFORE reading any body"), but only the two PUT paths (403 L353, `bad_id` 400 L361) actually drain.

**Threat-model impact:** requires possession of a **valid clock-class token** (a legitimate read-only device) issuing a body-carrying DELETE, or any client pushing a large body alongside a request that gets silently dropped. The request is still **rejected** — verified zero side effects (`not_found` after every attempt; no row created, nothing enumerated). Impact is protocol-shape deviation (client sees a 500/reset instead of the §5-mandated empty 403) and single-connection robustness — not an auth bypass and not server-side DoS.

**Fix:** drain on every bodied rejection, e.g. in the 403 branch: `if (req.body) await readBodyBounded(req);` (covers PUT *and* DELETE), and optionally in `silentDrop()` call sites for bodied requests if §5-clean delivery of the drop to misbehaving clients is desired. Keep the `BODY_DRAIN_MAX` abort semantics.

### [LOW-2] `GET /config` hands the offline-password-cracking surface (salt+iters+wrapped) to the read-only CLOCK class

**Code:** `worker/src/store.js` L282–284 (`/config` is family `app`, `requireUi = false`) → ui **or** clock pass; `hConfig()` L445–454 returns `{salt, iters, wrapped, ver}`.

**Evidence (LIVE):**
```
B02 clock GET /config -> 200 {"salt":"e7c4efca4c020b3b5194f79f96a51d11","iters":100000,"wrapped":"gtOMiuuJlG5W…(80 b64 chars)","ver":1}
    keys = ["iters","salt","ver","wrapped"]  — auth_ui/auth_clock NOT present (see VERIFIED-SECURE #5)
```
**Threat model:** the clock device is the lower-assurance credential class (read-only appliance; per §3 key ledger it holds `AUTH_CLOCK` and derives keys from NVS at boot — it has **no documented need** for `/config`). A leaked clock token now yields the `wrapped` KEK-blob + salt + iters, enabling a fully **offline** brute-force of the unlock password (PBKDF2-HMAC-SHA256, `KDF_ITERS = 100000` — §2; hBootstrap L383 *enforces* exactly 100000, so deployments cannot raise it unilaterally). A successful crack recovers AES1 → `AUTH_UI` (**write** class) + `K_data` — a read-only credential compromise escalates to full read/write, conditional only on password strength. This is a *protocol-design* property (§3/§4 specify `/config` = ui/clock, clear params by design; the PoC ships a dummy AES1), not an implementation bug — hence LOW, not MEDIUM.

**Fix (pick any, spec-bump required for the first two):** (1) restrict `GET /config` to the UI class (`requireUi = true` on that route — the clock never needs it); (2) raise `KDF_ITERS` (OWASP 2023 guidance for PBKDF2-HMAC-SHA256: 600k) in the next protocol version and relax the server-side equality check to `iters >= minimum`; (3) at minimum, document that clock-token custody must equal password custody.

### [INFO-1] Bearer grammar is strict and fail-closed; the only leniency is HTTP OWS normalization, which cannot forge a token

Full probe matrix on `GET /version` (app route), LIVE unless marked `local` (dedicated stack). Live UI token redacted `<UI>`:

| Probe | Result |
|---|---|
| `Authorization: Bearer <UI>` | **200** `{"proto":"4.3"}` (control) |
| uppercase hex (`<UI>.toUpperCase()`) | 404, len 0, empty |
| 63 chars / 65 chars | 404 empty / 404 empty |
| `Bearer  <UI>` (double space) | 404 empty |
| `bearer <UI>` / `BEARER <UI>` (scheme case) | 404 empty / 404 empty |
| `Bearer\t<UI>` (tab separator) | 404 empty |
| `Bearer <UI> x` (trailing non-OWS) | 404 empty (live raw R2) |
| `Bearer <UI> ` / `Bearer <UI>\t` (trailing OWS) | **200** — RFC 9112 field-value OWS is stripped by the HTTP layer before `headers.get()`; verified live raw R3/R6 and local raw L-R5/R6/L-R7 (leading SP after colon also 200) |
| `Bearer` (scheme only) / empty value / `Basic <UI>` / 64 non-hex chars | 404 empty ×4 |
| field-name case `AUTHORIZATION:` | 200 (field names case-insensitive per RFC — expected, harmless) |
| two `Authorization` header lines | LIVE: CF edge `400` (155-byte HTML, `Server: cloudflare`) before the Worker (raw R1/R4); LOCAL (DO level): **404 empty** (raw L-R1/L-R2 — the runtime combines duplicate field lines into one comma-joined value per the Fetch spec, which fails `/^Bearer ([0-9a-f]{64})$/`). No "first header wins" confusion. |
| CR inside the value (split attempt) | 400 at parser (live edge R5 + local L-R4 — 26-byte text/plain). |
| bare LF in value (local L-R9) | treated as line terminator by the local parser → effective clean header → 200; parser leniency only — the value that reaches the gate is still exactly `Bearer <64hex>`. |

**Code:** `store.js` L331 `const m = /^Bearer ([0-9a-f]{64})$/.exec(header);` — JS `$` (no `m` flag) does **not** match before a trailing newline (verified: `re.exec('Bearer '+tok+'\n') → null`), so a smuggled `\n` cannot terminate early; `hexDecode()` L77–85 re-validates length+`HEX64_RE` (lowercase-only) before any comparison. Every deviation lands in the **silent drop** (`silentDrop()` L109–111: `Response(null,{status:404})` — no body, no `WWW-Authenticate`, no cache headers; confirmed on every 404 above). OWS normalization is length- and charset-neutral on the hex payload, so it can never map an unknown token onto a known one. Non-string header values cannot occur (HTTP field values are strings by the time `headers.get()` returns; `|| ''` handles absent).

### [INFO-2] Token-class partitioning is airtight (no class confusion, no route-existence hints)

Verified matrix (LIVE where `live:`, else local dedicated universe; `SD` = silent drop = empty 404):

| Token \ Route family | app routes (config/version/status/rows/rows:batch/GET row) | app write routes (PUT/DELETE row) | admin routes (/bootstrap, /bootstrap/rewrap) | internal (/internal/backup) |
|---|---|---|---|---|
| **UI** | 200 (live A01/B14, local 3.01) | 200 write (local 4.07/4.11) | **SD** (live B04/B05 — no hint the route exists) | **SD** (live B06) |
| **CLOCK** | 200 read (live B01–B03, B10; local 3.02/3.07) | **403 empty, zero side effects** (live B07/B08 + L1–L3; local 4.01/4.02, then `not_found` at 4.03) | **SD** (local 3.09) | **SD** (local — by class matrix) |
| **ADMIN** | **SD** (local 3.03/3.05 — admin is *not* ui/clock, L351) | **SD** (implied, same check) | passes gate (local 1.11/2.01/2.02: 400/200/409 — admin class works without config) | **SD** (local 3.11) |
| **INTERNAL** | **SD** (local 3.04/3.06) | **SD** | **SD** | passes gate (local 1.13/3.12 → 200 `{"ok":true,…}` — works unbootstrapped too) |
| **unknown/random** | **SD** (live A12; local 1.02) | **SD** (live B11-class) | **SD** (live B11/B12) | **SD** (local 1.14) |
| **no token** | **SD** (live A11/B13) | **SD** | **SD** | **SD** (local 1.14) |

Ordering nuance (documented, §5-consistent): the capability check precedes the id-length validation — clock PUT with a 300-char id → **403** (local 4.05) while UI gets **400 `bad_id`** (local 4.06); code comment L358–359 states the intent ("never to a pre-auth silent drop"). The clock class also legitimately reads `POST /rows:batch` (live B10 → `{"rows":[{"id":"s2-gate-probe","missing":true}]}`, local 4.04) — read-only per §9b, no `requireUi` on that route (L294–297). Env-secret classes fail closed: a malformed `ADMIN_SECRET`/`INTERNAL_TOKEN` makes `hexDecode` return `null` (L336–337) → those classes simply never match → permanent silent drop.

### [INFO-3] Timing profile is flat — no route-family, validity, class, or prefix oracle at observable granularity

**Local (dedicated stack, warmup 40 then 60 interleaved rounds × 6 classes, medians / p10 / p90 in ms):**
```
A app/no-auth        GET /version : 5.96 / 4.13 / 10.03
B app/unknown-token  GET /version : 5.50 / 4.20 /  9.01
C app/valid-UI       GET /version : 6.03 / 3.92 /  8.81
D app/valid-CLOCK    GET /version : 5.90 / 4.25 / 10.74
E adm/no-auth        PUT /bootstrap: 5.30 / 4.00 / 7.64
F adm/unknown-token  PUT /bootstrap: 5.84 / 3.98 / 10.81
```
All classes are statistically indistinguishable (overlapping p10–p90). **LIVE** (n=10 each, WAN): no-auth 34.6ms vs unknown-token 22.7ms vs valid-UI 22.1ms medians — jitter dominates, and crucially unknown-vs-valid is indistinguishable. **Code reasons the flatness:** (a) `getConfig()` runs only when a well-formed token exists (L334) — the delta vs no-auth is one SQLite SELECT on a ≤1-row table plus 4× `hexDecode` (µs — invisible under ~5ms request overhead), so an unauthenticated admin-route request does **not** take measurably longer than an app-route one (E≈A above); (b) `ctEqual` L97–102 XOR-accumulates all 32 bytes with no per-byte branch — **no prefix early-exit**; (c) the `else if` chain (L340–343) short-circuits only on *full* equality; (d) the `a.length !== b.length` early return (L98) is unreachable from attacker input: the regex pins 64 hex chars → 32 bytes, bootstrap validates `HEX64_RE` on stored tokens (L378–379), and env secrets are `hexDecode(·,32)`-checked — so **no token-length leak either**. **Prefix-oracle micro-benchmark** (identical `ctEqual` code, interleaved randomized order, n=7): 0/8/16/24/31-byte prefix matches → 9.38 / 9.52 / 9.31 / 9.35 / 8.85 ms per 2×10⁵ calls — flat, no monotonic signal. No brute-force demonstration was performed (out of scope per rules); conclusion is qualitative: **no practical timing side channel at the gate**.

### [INFO-4] Missing-config (unbootstrapped) state is invisible to every non-holder; no route family leaks bootstrap state

**Code-path proof:** the only tokens that pass the app-family gate (`cls === 'ui' || 'clock'`) are `hexDecode(cfg.auth_ui/…)` (L338–339) — they *exist iff the universe is bootstrapped*. With `cfg === null`, every app route silently drops for every class except admin/internal — and those two classes are *also* rejected by L351 (`cls !== 'ui' && cls !== 'clock'`). The cfg-dependent authenticated responses (`hConfig`/`hRewrap` `404 {"error":"not_found"}`, L447/L427) are therefore **unreachable without either the ADMIN secret or a cfg-derived token** — dead code for outsiders, by construction.

**Probes (local, fresh persist dir, before S2's own bootstrap):** all 16 phase-1 probes conform — `/version`, `/config`, `/rows`, `/status` return the identical empty 404 for no-token/random/admin/internal (1.01–1.08); `PUT /bootstrap` with random/no token → SD (1.09/1.10) while ADMIN reaches the handler (400 `bad_json`, 1.11 — route existence disclosed *only* to the admin-secret holder); `GET /bootstrap` even with ADMIN → SD (1.12, method not routed); `POST /internal/backup` with INTERNAL works unbootstrapped (200, `rows:0`, no config data — 1.13) and is SD for no-auth/admin (1.14/1.15); rewrap with ADMIN → `404 {"error":"not_found"}` (1.16, admin-only bootstrap-state disclosure, per WORKLOG D11). The LIVE universe is bootstrapped and was not touched. Cross-check live: `GET /config` without token → SD (B13) — the `wrapped` blob is not publicly readable.

### [INFO-5] Audit-infrastructure contention corrupted early local runs (process note, not a target flaw)

The shared `with-stack.sh` stacks (8787/8788) are concurrently re-bootstrapped and `pkill -f workerd`-ed by sibling agents (S4/S5/S7/S8 observed in `ps` during S2's runs; e.g. `bash scripts/with-stack.sh node /home/z/s4/t4-bootstrap.mjs`). Hard evidence of contamination: on a `--fresh --no-bootstrap` run, probe 1.16 (`PUT /bootstrap/rewrap`, ADMIN) returned `404 {"error":"not_found"}` (no config row) and **one second later** probe 2.01 (`PUT /bootstrap`, ADMIN) returned `409 {"error":"exists"}` — a foreign admin's bootstrap landed between two adjacent requests of a universe S2 had just proven empty; subsequent socket errors were sibling pkills. S2 therefore re-ran **all** local evidence on a dedicated stack (port 8799, private `--persist-to`, own material, plus a salt-match contamination guard that aborts on foreign config). Other agents relying on 8787/8788 mid-run evidence should do the same. (Side observation for the report: the superseded-bootstrap episode also demonstrates that any ADMIN-secret holder can silently adopt/replace a universe — that is admin power per §8, not a vulnerability.)

### [INFO-6] §4 lists "disabled token" → silent drop, but no disable/rotation mechanism exists in the code

`docs/PROTOCOL-v4.1.md` §4 says the silent drop applies to "missing token, unknown token, **disabled token**, wrong-secret /bootstrap"; `store.js` has no disable/enable flag on `config` (columns: salt, iters, wrapped, auth_ui, auth_clock, ver, updated_at — L199–203) and no §20 Type B token-rotation implementation. Fail-neutral (nothing to disable), but the documented gate vocabulary overstates the implemented controls — a documentation gap worth closing in protocol.md before the next revision.

---

## VERIFIED-SECURE (attack classes refuted, with evidence)

1. **Bearer-grammar forgery / auth-header smuggling** — refuted: 14 malformed variants all → silent drop (INFO-1 table); duplicate header lines fail closed at both the CF edge (400) and DO level (combined value → 404); CR-in-value rejected by parsers; regex `$` cannot be newline-terminated; OWS normalization is forge-neutral.
2. **Token-class confusion (all four classes × all route families)** — refuted: 24-cell matrix (INFO-2) behaves exactly as §4 specifies; admin/internal get *nothing* on app routes; ui/clock get *nothing* on admin/internal routes (no route-existence hint: same empty 404 as unknown routes — live B04/B05/B06 vs C06 all byte-identical).
3. **Route-existence / bootstrap-state oracle** — refuted: unknown routes, wrong methods (GET /bootstrap, PATCH/HEAD), and unbootstrapped app routes all return the byte-identical empty 404 (INFO-2 + INFO-4; live C06/C08/C09, local 1.01–1.16); only the matching env-secret class can observe its own family's routes.
4. **Timing side channels (route family / token validity / token class / prefix match / token length)** — refuted at observable granularity (INFO-3: flat interleaved medians locally, indistinguishable live, flat ctEqual micro-benchmark, unreachable length check, full-equality-only short-circuit).
5. **Private-column disclosure (`auth_ui`/`auth_clock`)** — refuted: `GET /config` returns exactly `{iters, salt, ver, wrapped}` (live key-scan: `contains auth_ui? false contains auth_clock? false`; code `hConfig` L448–453); `getConfig()` selects the private columns (L238) but they are never serialized into any response — `/version`, `/status`, `/rows`, row envelopes, `:batch`, 403/400/404/412/304 bodies all scanned clean.
6. **Credential echo in error paths** — refuted: automated scan of **46 live + 46 local + 17 raw-socket + 7 live-drain responses** for token material in bodies *and* headers (including every elicitable error shape: `400 bad_json/bad_id/bad_ids/bad_if_match/too_large`, auth'd `404 not_found`, silent 404, 403 empty, 412 empty ×2, 304, 200 echoes, 204 preflight) → **CLEAN**; no `WWW-Authenticate` on any 404/403; silent drop carries no cache headers. The app's catch-all 500 (L228–232) returns a fixed `{"error":"internal"}` and logs only `e.message` server-side.
7. **Clock-token write attempts** — refuted: PUT/DELETE → 403 empty with **zero side effects** (`not_found` verified after every attempt — live B09/L7, local 4.03); clock writes with 2MiB/33MiB bodies still rejected cleanly (PUT drained, local 5.01/5.04; live L1/L2); `:batch` remains read-only for clock.
8. **Request-splitting via Authorization header** — refuted: CR in value → parser 400 (live edge R5 + local L-R4); bare-LF is normalized to a line terminator with the effective value still exact-match-only (local L-R9).
9. **Unauthenticated bodied requests corrupting or probing state** — refuted: no-token/unknown-token PUTs with junk and 64KiB–2MiB bodies → 404, nothing written (live L4/L5/L7; local 5.05 + `not_found` checks).
10. **CORS preflight as an auth bypass** — refuted: browsers cannot send `Authorization` on `OPTIONS` by design; the front door gates preflight on the origin allowlist (live C14: allowlisted origin → 204 + CORS headers; C15: non-allowlisted → empty 404, no CORS headers — `index.js` L49–52); the front door forwards only `authorization`, `content-type`, `if-match`, `if-none-match` (L60–63), so no other client header can influence the gate.
11. **Client-side credential handling (adjacent check)** — `js/api.js` validates the token as `/^[0-9a-f]{64}$/` and attaches it solely as an `Authorization: Bearer` header (never a URL/query parameter); `js/crypto.js` `deriveKeys()` derives only `AUTH_UI` for the browser (the web client cannot even hold the clock token); no `localStorage`/`sessionStorage`/`indexedDB` usage exists anywhere in `js/` except the documented provisioning/local-first caches in `app.js` (`LS_TOKEN` provisioning code delivered out-of-band via `#setup=` URL *fragment* — fragments are never sent to servers; XSS exposure of the localStorage token is S5/S8's scope, flagged to them).

---

## Appendix — evidence index

- **Live suites:** `/home/z/my-project/s2-probe/s2-live.mjs` (46 probes: A01–A16 bearer grammar, B01–B14 class confusion, C01–C15 error shapes/CORS, D1–D3 timing), `s2-live-raw.mjs` (R1–R7 raw-TLS header shapes + `/config` key-scan), `s2-live-drain.mjs` (L1–L7 production drain paths). Token material redacted in all output; scripts never print tokens.
- **Local suites (dedicated stack, port 8799, private persist dir):** `s2-run-local.sh` (launcher + contamination guard), `s2-final.mjs` (46 probes: phases 1–7 incl. unbootstrapped state, own-universe bootstrap with 409 existence check, class matrix, 403/412 shapes, 2MiB/33MiB drain paths, interleaved timing, ctEqual/regex micro-proofs), `s2-local-raw.mjs` (L-R0–L-R9 raw-socket header shapes at DO level), `s2-diag.mjs` (bootstrap-persistence discrimination used to isolate the INFO-5 contention).
- **Key code lines:** gate `store.js` L329–344; family checks L346–356; 403-drain L352–355; id-cap drain L360–363; `ctEqual` L96–102; `hexDecode` L77–85; `silentDrop` L108–111; `forbidden` L113–116; `getConfig` L236–250; `hConfig` L444–454; front-door forwarding `index.js` L57–65; OPTIONS `index.js` L49–52.
- **Redacted live credentials used:** UI `8b2d1be0…` (64 hex), CLOCK `cf554ff8…` (64 hex) — both from `/home/z/my-project/.secrets/credentials.json`; ADMIN_SECRET/INTERNAL_TOKEN (local stacks only) never printed.
