# VP4 — Live Protocol Probe (conformance + attack matrix, non-destructive)

**Agent:** VP4 (live non-destructive protocol probe), 6-agent verification wave.
**Target:** LIVE worker `https://calendar-poc.sh-clock.workers.dev` (proto 4.3, redeployed today with the security wave; universe rotated) + LIVE client `https://sh-clock.github.io/Calendar-Web/` (header/asset checks only).
**Source of truth (white-box):** `/home/z/my-project/calendar-web` @ `c2654d9` (`worker/src/index.js`, `worker/src/store.js`, `protocol.md` §4 "Transport hygiene", §9c/§9d).
**Date:** 2026-11-01. Probe script: `/home/z/vp4-probe.mjs` (outside the repo; the tool sandbox cannot write `/tmp`). Full machine evidence (every request+response, tokens redacted): `/home/z/vp4-evidence.json`.

**Credentials:** `auth_ui` redacted `d2e6c5b2…`, `auth_clock` redacted `f9d647e8…` (from `/home/z/my-project/.secrets/credentials.json`, the ROTATED universe); OLD leaked `auth_ui` redacted `8b2d1be0…` (recovered at runtime from the DAVx fork's KAT test file — see finding VP4-F2). `ADMIN_SECRET` / `INTERNAL_TOKEN` (`/home/z/my-project/.secrets/prod.env`) were **never read into any probe and never sent** — no admin/internal endpoint was touched.

**Request budget:** 40 requests to the LIVE worker + 7 static-asset fetches on the GitHub Pages client host (index.html + 6 `js/*.js`) = 47 total live requests, strictly sequential with ≥1.05 s spacing (52 s wall), no bursts, no load test. Writes were confined to my own rows prefixed `evt:vp4-` (one row: `evt:vp4-a`, created via §9 RMW PUT with 16 B random ct, 4 accepted mutations, 1 DELETE) — rejected probes (`bad_ct`/`bad_ver`/412/403/bad_ids) executed no SQL (code: `store.js` hPutRow returns before any INSERT/UPDATE on every rejection path; hBatchGet is a pure read).

---

## SUMMARY

| Severity | Count | Titles |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 0 | — |
| MEDIUM | 0 | — |
| LOW | 0 | — |
| INFO | 2 | VP4-F1 (dead old token still committed as KAT in the sibling davx repo — inert on live); VP4-F2 (request-budget interpretation note: 40 worker + 7 pages) |

**Live conformance score: 75/76 scripted checks passed; the single FAIL was a bug in my own check H2 (it counted the §9d 304 conditional reads as "3xx redirects"), corrected post-run and re-derived from the recorded evidence: 0 stray redirects. No target-side deviation from protocol.md was found in the entire matrix.**

**Store integrity:** manifest row-set BEFORE == AFTER — 8 rows (2 `cmeta:` + 6 `evt:`), ids **and** vers byte-identical before/after; 0 `evt:vp4-` rows remain; manifest epoch `e81 → e86` (+5 = exactly my 1 INSERT + 3 UPDATEs + 1 DELETE — the sec-S4-2 atomic triggers verified live). No owner row was read via row-fetch (only the manifest, which is the id/ver listing), written, or deleted.

---

## FINDINGS

### VP4-F1 [INFO] — The rotated (dead) AUTH_UI token is still committed as a KAT constant in the sibling davx repo

**Evidence:** the OLD leaked token (full 64-hex, redacted `8b2d1be0…`) is embedded verbatim in
`/home/z/my-project/davx/rowstore/src/test/kotlin/at/bitfire/davdroid/resource/rowstore/RowStoreAccountTest.kt` (`katAuthUiHex`, also `RowStoreCalDavCollectionTest.kt`). The calendar-web repo itself is clean at `c2654d9` (git history purge + secret stripping per sec-S7-F1; `git grep` over all revisions finds only the redacted 8-hex form in audit notes).

**Why INFO only:** the token is **verified dead on LIVE** this run — silent 404 on every probed app route (see verified item 7), so its continued presence is credential-shaped noise, not a live secret. It is also outside this wave's repo (`davx/` is the DAVx⁵ fork workspace). Recommended hygiene: replace the KAT constant with a synthetic hex64 (KATs do not need a once-live value).

### VP4-F2 [INFO] — Budget interpretation: 40 worker requests + 7 client-asset fetches

The hard rule "≤40 total requests" cannot literally cover the mandated matrix (it needs ≥45 distinct live checks) plus the mandated `js/*.js` sha256 asset comparisons. Interpretation used: **40 requests against the LIVE WORKER** (the shared DO / probe target) + **7 static-asset GETs on the GitHub Pages CDN host** for item 8 (explicitly scoped "header/asset checks only"). Both sets were paced identically (≥1.05 s, sequential, 52 s total) — categorically nowhere near load testing. Disclosed here for the record; no second run was needed.

---

## VERIFIED BEHAVIORS (live, with evidence)

CF-infra headers (`cf-ray`, `date`, `nel`, `report-to`, `alt-svc`, `connection`, `server`, `content-encoding`, `transfer-encoding`) are elided from dumps below for readability; the evidence JSON has them. All 40 worker responses (every status class) carried exactly `vary: Origin` + `strict-transport-security: max-age=31536000`.

### 1. Transport hygiene (protocol.md §4, sec-S1-1/S1-3, S8-F4/F5)

- **http→https 308 upgrade, pre-auth/pre-CORS:** `GET http://calendar-poc.sh-clock.workers.dev/version?vp4=transport` (no token) →

  ```
  HTTP 308, 0 B body
  location: https://calendar-poc.sh-clock.workers.dev/version?vp4=transport
  vary: Origin
  strict-transport-security: max-age=31536000
  (no access-control-* — the upgrade runs before any origin/CORS logic, worker/src/index.js:100-108)
  ```

  The no-token request got **308, not the old silent-404** → proves the bearer gate is unreachable over cleartext HTTP (S1-1 fixed). Path+query preserved byte-exactly; Location is https-once → **no redirect loop** (H2: 0 stray 3xx; the only 3xx are the deliberate 308 and §9d 304s).
- **vary + HSTS on EVERY worker response, all 8 status classes** observed: 200 (×10), 204, 304 (×3), 308, 400 (×6), 403, 404 (×13), 412 (×5) — H3/H4: 40/40 responses carry `vary: Origin` and `strict-transport-security: max-age=31536000`. Undecorated (foreign/absent-origin) responses now carry them too — the S1-3 gap is closed:

  ```
  05 GET /rows  If-None-Match: garbage!!   (valid ui token, NO Origin header)
  HTTP 200, 717 B, application/json
  cache-control: no-store · vary: Origin · strict-transport-security: max-age=31536000
  (no access-control-* — undecorated variant)
  ```
- **expose-headers on allowlisted responses (S1-2):** the 3 CORS-decorated responses (01 200-manifest, 02 304, 08 204-preflight) all carry `access-control-expose-headers: ETag` (+ full `access-control-allow-origin/methods/headers/max-age`). The §9d 304's `etag` header is therefore browser-readable. Sample (probe 02):

  ```
  02 GET /rows  Authorization: Bearer d2e6c5b2…  Origin: https://sh-clock.github.io  If-None-Match: "e81"
  HTTP 304, 0 B
  etag: "e81" · cache-control: no-store · vary: Origin · strict-transport-security: max-age=31536000
  access-control-allow-origin: https://sh-clock.github.io · access-control-expose-headers: ETag
  access-control-allow-methods: GET, POST, PUT, DELETE, OPTIONS
  access-control-allow-headers: Authorization, Content-Type, If-Match, If-None-Match · access-control-max-age: 86400
  ```
- **no-store on every JSON/304 worker response** (H5: 19/19 — 200s, the 400s with `{"error":…}` bodies, the 304s); **silent drops carry NO cache-control and empty bodies** (H6: 13/13 silent 404s bare, `content-length: 0`, no content-type, no `www-authenticate` anywhere in the run).

### 2. Silent-drop uniformity + origin spoofing (§4/§5)

- **Byte-identical 404s across gate failures:** unknown route (`GET /vp4-unknown-route`, no token) vs no-token on known route (`GET /version`) vs bad/OLD token on known route (`GET /version`, `Bearer 8b2d1be0…`) — identical status (404), body (0 bytes), and header set modulo per-request CF-infra (cf-ray/date): `content-length: 0, strict-transport-security: max-age=31536000, vary: Origin` and nothing else. The worker-local OPTIONS drop (null origin) has the identical shape. **No differentiator leaks which gate failed** (store.js:381-402 single gate; index.js:116 worker-local drop).
- **Origin spoofing matrix (all via OPTIONS, answered at the front door — the same `allowedOrigin()` call decides preflight and response decoration, index.js:110-118/137):** `null`, trailing slash `https://sh-clock.github.io/`, uppercase `HTTPS://SH-CLOCK.GITHUB.IO`, userinfo `https://sh-clock.github.io@evil.example`, subdomain `https://evil.sh-clock.github.io`, suffix `https://sh-clock.github.io.evil.com` → **all silent 404 with ZERO `access-control-*` headers** (vary+HSTS present). Positive control: exact allowlisted origin → 204 + full CORS set. H7: across the whole run, `access-control-allow-origin` appeared on exactly 3 responses, always the exact allowlisted value. Absent Origin → no ACAO (every no-Origin response undecorated).

### 3. Conditional live (§9c/§9d) — on my own `evt:vp4-a` row (created v1, 16 B ct)

| # | Request | Result | Expected |
|---|---|---|---|
| 02 | `GET /rows` INM `"e81"` (exact, allowlisted origin) | **304**, empty, `etag: "e81"`, expose-headers | 304 ✓ |
| 03 | INM `"e424242", W/"e81"` | **304** (list + weak form; `W/` ignored in weak compare) | 304 ✓ |
| 04 | INM `*` | **304** (manifest always has a current representation) | 304 per §9d ✓ (confirmed) |
| 05 | INM `garbage!!` | **200** plain (§13.1.2 rule 3 fall-through) | 200 ✓ |
| 24 | `PUT` v2, 65536 B ct, `If-Match: "99", "1"` | **200** echo v2 (list containing current proceeds; ct=65536 accepted) | proceeds ✓ |
| 26 | `PUT` v3, `If-Match: "1"` (stale) | **412**, empty | 412 ✓ |
| 27 | `PUT` on MISSING row `evt:vp4-zz`, `If-Match: *` | **412**, empty | 412 (NEW — was 404 pre-wave) ✓ |
| 28 | `PUT` v3, `If-Match: W/"2"` | **412** (weak never matches in strong compare) | 412 ✓ |
| 29 | `PUT` v3, `If-None-Match: W/"2"` at current ver | **412** (etag-form, weak match) | 412 ✓ |
| 30 | `PUT` v3, `If-Match: "2"` + `If-None-Match: "2"` | **412** (passing If-Match does NOT suppress If-None-Match — §13.2.2 order) | 412 ✓ |
| 31 | `PUT` v3, `If-Match: notquoted` | **400 `{"error":"bad_if_match"}`** (fail closed) | 400 ✓ |
| 32 | `PUT` v3, `If-None-Match: garbage!!` | **200** echo v3 (malformed INM ignored — proceeds) | proceeds ✓ |
| 40 | `GET /rows` INM `"e81"` AFTER my mutations+delete | **200** (not 304 — epoch moved; no ghost-304) | 200 ✓ |

412 shape: `content-length: 0` + vary + HSTS only (no envelope, no cache-control, no content-type) — exactly §9c. The epoch arithmetic closed the loop: `e81 → e86` = +5 for my 1 INSERT + 3 UPDATE + 1 DELETE (sec-S4-2 triggers fire live; sec-S4-1/S8-F1 ghost-304 class refuted on live).

### 4. Boundaries live (§2/sec-S7-F5, S7-F2)

- `ct` exactly **16 B → 200 accepted** (echo envelope identity: id/ver/nonce/ct byte-identical to submission); **15 B → 400 `bad_ct`**; **65536 B → 200 accepted** (87445 B echo); **65537 B → 400 `bad_ct`**.
- `ver` u32: **4294967295 accepted** (200, echo ver=4294967295); **4294967296 → 400 `bad_ver`**.
- `/config` (valid new ui token) → `200 {"salt":"e3ae6da9…","iters":600000,"wrapped":"…","ver":1}` — **iters 600 000** (§2 range 100 k–10 M floor respected on the rotated universe; server range code store.js:19-20; client `js/crypto.js:109` accepts 1–10 M ⊇ server range, documented protocol.md §2 — client-range acceptance verified by code read as mandated). `/config` leaks no private columns (keys: salt,iters,wrapped,ver only).

### 5. Batch §9b

- **257 ids → 400 `bad_ids`**; **duplicate ids → 400 `bad_ids`**.
- **256 ids (my 1 existing row buried at index 128 of a scrambled list, 255 missing, sent with the CLOCK token) → 200**: response length 256, `rows[i].id === ids[i]` for all 256 (**request-order preserved exactly**), exactly 1 full envelope (ver=4294967295, nonce/ct byte-identical to my stored envelope) + 255 `{id, missing:true}` flags. No owner row was requested or returned.

### 6. Timing sanity (qualitative, n≤5 per class shown; no study built)

Worker-only per-status latencies (ms): 200: `222,24,25,65,90` (min 24, max 222 — first-request cold); 204: `62`; 304: `39,47,25`; 308: `53`; 400: `26,49,30,34,32`; 403: `32`; 404: `51,41,14,90,21` (min 14, max 90); 412: `32,29,33,26,37`. The silent-404 band (14–90 ms) fully overlaps the authenticated-200 (24–222 ms) and 412 (26–37 ms) bands — **no status-code timing oracle introduced by the new redirect/header paths**.

### 7. Rotation aftermath

- **OLD leaked token `8b2d1be0…` dead on every probed app route:** `GET /version`, `GET /config`, `GET /status`, `GET /rows`, `POST /rows:batch` → all silent 404, byte-shape-identical to the no-token drop. (`GET /rows/{id}` not separately probed — the bearer gate is one shared code path executed before any handler for all app-family routes, store.js:380-402, verified by code read; the 404-gate itself was live-proven on 5 routes + `PUT /rows/{id}` gate-403 below.)
- **New `auth_ui` (`d2e6c5b2…`) works:** manifest/config/PUT/DELETE/batch all 200; `/config` salt+wrapped+ver match the rotated `/home/z/my-project/.secrets/credentials.json` exactly (universe rotation consistent).
- **`auth_clock` (`f9d647e8…`) reads but cannot write:** `POST /rows:batch` with clock token → 200 (full read); `PUT /rows/evt:vp4-x` with clock token → **403, empty body** (capability gate; body-drain fix sec-S2-L1 live — response delivered, no torn connection).

### 8. Client pages assets (GitHub Pages)

- Live `index.html` **sha256 byte-identical to repo** (`0a3995418656ad44…`); references `js/boot-guard.js` as a blocking **head** script (position 1059, before `css/style.css`/`js/app.js`); carries the **CSP meta** (content identical to repo: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://calendar-poc.sh-clock.workers.dev http://localhost:* http://127.0.0.1:*; …`) and **referrer meta `no-referrer`** (sec-S5-F3 deployed).
- **All 6 `js/*.js` sha256-match the repo:** boot-guard.js `b5c61a9e7e0a…`, app.js `2eb5062ee02f…`, api.js `b5c5adafa3f6…`, crypto.js `5ab359a7b7a9…`, calendar-core.js `3f1b062edb58…`, ical.js `3cb91eae0d4f…` — the deployed client is exactly `c2654d9`. (Pages host headers are GitHub defaults: HSTS `max-age=31556952`, assets `cache-control: max-age=600` — static-host policy, out of worker scope.)

### Hunt results (all clean)

No 5xx anywhere (H1). No redirect loops / stray 3xx (H2, corrected — see REFUTED). vary+HSTS on every worker response (H3/H4). No cacheable JSON (H5). Silent drops bare (H6). ACAO only ever the exact allowlisted value (H7) and always with `expose-headers: ETag` (H8). **No header injection / reflection:** no response header contains any attacker-supplied substring (`evil.example`, `notquoted`, `garbage!!`, `e424242`); CRLF in an Origin value is rejected client-side by the fetch runtime before transmission (H10 — undici `Headers.append` rejects; the worker's own `Headers` and the CF edge enforce the same, and `allowedOrigin()` only ever echoes an exact allowlisted match, so no reflection path exists, index.js:14-18/51-57).

---

## REFUTED (attack hypotheses tried and died)

1. **"My own check H2 flagged stray redirects"** — false positive of the probe script itself: the three flagged responses were the §9d **304 Not Modified** conditional reads (`If-None-Match` exact/list+weak/star), which my regex wrongly counted in `300 ≤ status < 400`. Corrected (exclude 304, exclude the deliberate 308) and re-derived from the recorded evidence: **0 stray redirects**. Target behavior is correct per store.js:577-582.
2. **Gate-failure oracle via silent-drop shape** — refuted: unknown-route / no-token / bad-token / old-token / foreign-origin-OPTIONS drops are byte- and header-set-identical (see §2 above).
3. **CORS bypass via origin spoofing** — refuted for all 6 mandated variants (+ absent origin): no `access-control-*` on any non-allowlisted response; ACAO never echoes anything but the exact allowlisted string.
4. **Stale-304 ghost state after mutations (S4-1/S8-F1 class)** — refuted live: epoch `e81→e86` tracked my 5 mutations exactly; a pre-mutation etag gets 200, never 304.
5. **Sub-tag ciphertext smuggling (15 B) / oversize ct (65537 B) / ver overflow (4294967296)** — refuted: 400 `bad_ct`/`bad_ct`/`bad_ver` respectively; boundaries accept exactly 16 B and 65536 B and ver=4294967295.
6. **Batch id-list abuse (257 / duplicates / order scrambling)** — refuted: `bad_ids` ×2; order preserved exactly with missing flags.
7. **Old-token resurrection on any app route** — refuted (5 routes probed + shared-gate code proof); clock-class write escalation — refuted (403).
8. **Status-code timing oracle from the new redirect/header work** — refuted qualitatively (overlapping latency bands, §6 above).
9. **Client asset drift / CSP-strip on the deployed pages** — refuted (byte-identical index.html + all 6 js files, CSP + referrer + boot-guard present).

---

## Notes for the coordinator / other agents

- The live manifest now holds **8 rows** (2 `cmeta:` + 6 `evt:`) vs 15 pre-rotation (S8's audit) — consistent with the force-rotation + reseed described in `c2654d9`; owner demo data is intact and was untouched (ids+vers identical before/after my probe).
- VP4-F1 (dead token in davx KAT) is the only cross-workspace hygiene item surfaced; it requires no calendar-web change.
- Probe script: `/home/z/vp4-probe.mjs` (single sequential run, pacing-enforced); machine evidence with every request/response (tokens redacted to 8 hex): `/home/z/vp4-evidence.json`.
