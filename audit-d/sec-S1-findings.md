# S1 — NETWORK / ROUTER / EDGE SURFACE — audit findings

Agent: S1 (network/router) of the 8-agent coordinated audit.
Target: LIVE worker `https://calendar-poc.sh-clock.workers.dev` (proto 4.3, verified live),
LIVE client `https://sh-clock.github.io/Calendar-Web/`, repo `/home/z/my-project/calendar-web`.
Date: 2026-11-01. Method: live HTTP probes (curl), one real-browser CORS test via the local
`with-stack.sh` stack (same front-door code, dev origin allowlist), WHATWG URL/Headers parity
checks in node, full code read of `worker/src/index.js`, `worker/src/store.js` (route() + helpers),
`protocol.md`, `js/api.js`. Rate: ~55 live requests total, all read-only or provably non-writing.

Credentials used for authenticated probes: the owner's live test tokens from
`/home/z/my-project/.secrets/credentials.json` — `auth_ui` redacted to `8b2d1be0…`,
`auth_clock` redacted to `cf554ff8…`. Local stack test token (local universe only, not prod
data): `b0728ba9…`. No ADMIN_SECRET / INTERNAL_TOKEN value was ever printed or used.
All conditional PUT probes below were verified non-writing: manifest etag was `"e21"` before
AND after the probe set.

## SUMMARY

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH     | 0 |
| MEDIUM   | 1     |
| LOW      | 3     |
| INFO     | 3     |

- S1-1 MEDIUM — Worker API answers over plain HTTP with no redirect and no HSTS (bearer tokens accepted in cleartext)
- S1-2 LOW — `Access-Control-Expose-Headers: ETag` missing: browser JS cannot read the ETag (or any non-safelisted) response header; client relies on a silent fallback
- S1-3 LOW — `Vary: Origin` omitted on undecorated responses (disallowed/no-origin) — cache-poisoning precondition, inert today
- S1-4 LOW — GitHub Pages client ships without CSP / X-Frame-Options / X-Content-Type-Options / Referrer-Policy (headers reported only; S5 owns deep client analysis)
- S1-5 INFO — CORS preflight is path-blind: 204 for any path, including `/internal/backup`, `/bootstrap`, unknown paths
- S1-6 INFO — workers.dev subdomain takeover: not currently possible (info only)
- S1-7 INFO — Edge rejects duplicate `Authorization` and foreign `Host` headers before the Worker (relied-upon edge behavior, undocumented in repo)

---

## S1-1 MEDIUM — API served over plain HTTP, no redirect, no HSTS

**Evidence (live):**

```
$ curl -sS -D - 'http://calendar-poc.sh-clock.workers.dev/version' \
    -H 'Authorization: Bearer 8b2d1be0…' -H 'Origin: https://sh-clock.github.io'
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Access-Control-Allow-Origin: https://sh-clock.github.io
Vary: Origin
access-control-max-age: 86400
Server: cloudflare
{"proto":"4.3"}
```

- Plain-HTTP GET with the live UI bearer token returns **200 with the full body and full CORS
  decoration** — no 301/308 to https, no `Location` header (a tokenless http GET returns the
  silent 404, proving the request reaches the Worker, not an edge error page).
- No `Strict-Transport-Security` header on **any** live worker response (checked on 200/204/304/
  400/403/404/412 probes; `grep -i strict-transport` over all captured headers → no match).

**Why it matters (threat model: attacker wants to read/write the user's encrypted data):**
An active network attacker (rogue AP, ARP spoof, hostile LAN) who can get the client to talk to
`http://calendar-poc.sh-clock.workers.dev` captures the `Authorization: Bearer …` header in
cleartext → full read (GET /rows, GET /rows/{id}, POST /rows:batch) and full write (PUT/DELETE)
of the user's encrypted envelopes. The web client defaults to `https://…` (`js/app.js:50`) but
the server URL is user-editable (`index.html:88`, `<input id="server" type="url">` — `type=url`
accepts `http://`), persisted in localStorage and overridable via `?server=` (`js/app.js:649`);
the DAVx5 fork / clock device are also free to use http. No HSTS means the browser will never
refuse an http request to this origin, and the worker itself happily serves it.

**Fix (concrete):** in `worker/src/index.js` `fetch()`, before anything else:

```js
const url = new URL(req.url);
if (url.protocol === 'http:') {
  url.protocol = 'https:';
  return Response.redirect(url.toString(), 308);
}
```

and add `'strict-transport-security': 'max-age=31536000; includeSubDomains'` to every response
(e.g. in `decorate()` / `corsHeaders()` and on the preflight 204). Belt-and-braces: enable
"Always Use HTTPS" if the subdomain is ever moved onto a zone.

---

## S1-2 LOW — No `Access-Control-Expose-Headers`: browser cannot read ETag (or any non-safelisted header)

**Evidence (real browser, local stack — same front-door code, allowlisted origin):**

Page at `http://localhost:8080/index.html` (allowlisted in the dev config) executing
`fetch('http://localhost:8787/rows', {headers:{authorization:'Bearer b0728ba9…'}})`:

```json
{"s1":200,"etagHdr200":null,"ctHdr":"application/json; charset=utf-8",
 "acao":null,"vary":null,"etagBody":"\"e80\"","nrows":3,
 "s2":304,"etagHdr304":null,"body304len":0}
```

The request **succeeds** (200, body parsed, 304 on If-None-Match), but `headers.get('etag')`,
`headers.get('access-control-allow-origin')`, `headers.get('vary')` all return **null in the
browser** — only CORS-safelisted response headers (`Content-Type`, `Cache-Control`, …) are
readable cross-origin. curl sees `etag: "e80"` on the same response. Live worker responses
contain **no `access-control-expose-headers`** anywhere (checked across all captured headers).
This is spec behavior (Fetch §CORS-safelisted response-header name: ETag is not in the list),
not a server bug in decoration.

**Why it matters:** `js/api.js:52` reads `res.headers.get('etag')` on 304 — in the deployed
browser this is **always null**; the feature only works because of the fallback
`|| extraHeaders['if-none-match']` (client echoes its own value). That fallback is load-bearing
and undocumented; any future client logic that trusts response headers cross-origin (ETag from a
200, future `Deprecation`/`Sunset` headers, a browser-based DAV fork mapping ETag↔ver) silently
gets `null`. It also masks protocol diagnostics: the client cannot even verify that the server
honored its conditional header.

**Fix:** add to `corsHeaders()` (`worker/src/index.js:20-32`):
`'access-control-expose-headers': 'ETag'`. Consider exposing nothing else (keep the surface
minimal). Optionally add a client-side comment in `js/api.js:52` that the browser header is
unreliable today.

---

## S1-3 LOW — `Vary: Origin` missing on undecorated responses

**Evidence (live):** same URL, same moment, differing only in Origin:

```
$ curl -sS -D - 'https://calendar-poc.sh-clock.workers.dev/version' \
    -H 'Authorization: Bearer 8b2d1be0…' -H 'Origin: https://sh-clock.github.io'
HTTP/2 200 … vary: Origin + full access-control-* set

$ curl -sS -D - 'https://calendar-poc.sh-clock.workers.dev/version' \
    -H 'Authorization: Bearer 8b2d1be0…' -H 'Origin: https://evil.example'
HTTP/2 200 … no vary, no access-control-* headers (body identical)
```

Code path: `decorate()` (`worker/src/index.js:35-40`) returns the DO response **unchanged**
(`if (!origin) return res;`) — so `vary: Origin` is attached only when the origin was
allowlisted. The 304 case: `inm-evil` (If-None-Match match, evil origin) → `304`, `etag: "e21"`,
no `vary`, no CORS headers.

**Why it matters:** the response for a given URL legitimately differs by Origin (CORS decoration
present or absent). Any intermediary cache that keys by URL only and ignores the missing Vary
could store the *undecorated* 200/304 and later serve it to the **legit** origin → the real
client's fetch fails CORS ("network" `ApiError` per `js/api.js:47`) → sync/unlock breakage
(availability attack, "break the system"). Today this is inert: Cloudflare does not cache these
responses (no `cf-cache-status` header at all on any probe; dynamic worker responses), and the
client talks directly to the worker. It is a defense-in-depth gap, not an exploitable bug.

**Fix:** always stamp `vary: Origin` (and ideally the HSTS header) on every response leaving the
worker — e.g. move `vary` out of `corsHeaders()` into a final wrapper applied in both the
decorated and undecorated branches of `decorate()`.

---

## S1-4 LOW — GitHub Pages client has no CSP / X-Frame-Options / X-Content-Type-Options / Referrer-Policy

**Evidence (live, `curl -I https://sh-clock.github.io/Calendar-Web/`):**

```
HTTP/2 200
server: GitHub.com
content-type: text/html; charset=utf-8
access-control-allow-origin: *
strict-transport-security: max-age=31556952
etag: "6ae6bc8d-2728"
cache-control: max-age=600
x-proxy-cache: MISS / x-cache: HIT …
```

Present: HSTS (GH default), ACAO `*` (fine for public static assets). **Absent:** `content-security-policy`,
`x-frame-options`, `x-content-type-options`, `referrer-policy`.

**Why it matters:** this is the page that accepts the user's password and derives all keys/tokens
in-browser. No XFO/frame-ancestors → the unlock UI is frameable (clickjacking a password prompt);
no CSP → any injected script runs unconstrained; no Referrer-Policy → URLs (which can carry the
`#setup=` provisioning fragment client-side and `?server=` params) may leak to third parties via
referrer. Per the task split, S5 owns the deep client analysis — this finding reports the header
surface only.

**Fix:** GitHub Pages cannot set custom HTTP headers; use `<meta http-equiv="content-security-policy" …>`
(with a nonce-less strict policy appropriate for the vendor scripts), `<meta name="referrer" content="no-referrer">`,
and a framebusting guard (`if (top !== self) top.location = self.location`) as best-effort; or
serve the client from a host that supports real headers (same-origin with the API would also
remove the whole CORS surface).

---

## S1-5 INFO — Preflight is path-blind (204 for any path from an allowlisted origin)

**Evidence (live):** `OPTIONS` with `Origin: https://sh-clock.github.io`:

- `/internal/backup` → `204` + full CORS headers
- `/bootstrap` → `204` + full CORS headers
- `/totally/unknown/path` → `204` + full CORS headers

Code: `worker/src/index.js:49-52` — the OPTIONS branch answers before any path inspection.

**Why it matters / why INFO:** the preflight reveals only "this origin is allowlisted" — nothing
about routes, tokens, or data; the bearer gate is unaffected (browsers never send Authorization
on preflight). This is standard CORS behavior. No fix required (restricting preflight to known
paths would add nothing and break future routes).

---

## S1-6 INFO — workers.dev subdomain takeover: not currently possible

**Evidence:** `calendar-poc.sh-clock.workers.dev` actively serves the deployed worker (all probes
above hit it; `GET /version` with the live token returns `{"proto":"4.3"}` matching the repo).
workers.dev subdomains are claimed by the owning account while a worker/script is deployed on
them. Takeover would require the account to delete the deployment (or lose the account/subdomain
claim) — an account-security concern, not a code concern. No action beyond standard account
hygiene (2FA on the Cloudflare account, since a compromised account = full data
read/write/wipe via `/bootstrap` force).

---

## S1-7 INFO — Cloudflare edge rejects duplicate Authorization and foreign Host headers before the Worker

**Evidence (live):**

```
$ curl 'https://calendar-poc.sh-clock.workers.dev/version' \
    -H 'Authorization: Bearer 8b2d1be0…' -H 'Authorization: Bearer 111…111'
HTTP/2 400 … server: cloudflare, cf-ray: -, content-type: text/html
<html><head><title>400 Bad Request</title></head><body><center><h1>400 Bad Request</h1></center><hr><center>cloudflare</center></body></html>
   (edge-generated page; elided CF infra headers elsewhere in this report for readability)

$ curl 'https://calendar-poc.sh-clock.workers.dev/version' -H 'Host: evil.example'  → HTTP/2 403 (edge HTML)
$ curl 'https://calendar-poc.sh-clock.workers.dev/version' -H 'Host: sh-clock.github.io' → HTTP/2 403 (edge HTML)
```

**Analysis:** two `Authorization` headers never reach the worker/DO — the edge rejects them with
its own 400 (`cf-ray: -` = rejected pre-routing). Even if they did, workerd's `Headers.get()`
joins duplicates as `"Bearer a, Bearer b"` (verified in node), which fails the DO's
`/^Bearer ([0-9a-f]{64})$/` regex (`store.js:331`) → silent 404: no "which token wins" confusion
is possible. Foreign `Host` values are rejected with an edge 403 before the worker — the
allowlist is purely `Origin`-based (a normal Host + spoofed Origin is correctly filtered by the
origin allowlist). This edge behavior is relied upon but undocumented in the repo — noted for
completeness. No fix needed.

---

# VERIFIED-SECURE (attack classes tried and refuted, with evidence)

All evidence below is live against `https://calendar-poc.sh-clock.workers.dev` unless marked
local/browser/node.

**CORS allowlist integrity (scope 1):**
1. **Dev allowlist leak into prod — REFUTED.** `OPTIONS /version` with
   `Origin: http://localhost:8787` / `http://127.0.0.1:8787` / `http://localhost:8080` /
   `http://127.0.0.1:8080` (the exact dev `.dev.vars` entries) → all `404`, empty body, **no
   CORS headers**. The prod allowlist behaves as exactly `{https://sh-clock.github.io}` (matches
   `worker/wrangler.jsonc` `vars.ALLOWED_ORIGIN`). Positive control: allowlisted origin → `204`
   + `access-control-allow-origin/methods/headers/max-age` + `vary: Origin`
   (`GET, POST, PUT, DELETE, OPTIONS` / `Authorization, Content-Type, If-Match, If-None-Match`,
   od-verified).
2. **Origin spoofing — REFUTED (exact string match, `index.js:14-18`):**
   `Origin: null` → 404; no Origin → 404; `https://sh-clock.github.io/` (trailing slash) → 404;
   `https://sh-clock.github.io.` (trailing dot) → 404; `HTTPS://SH-CLOCK.GITHUB.IO` → 404;
   `https://sh-clock.github.io@evil.example` (userinfo) → 404;
   `https://evil.sh-clock.github.io` (subdomain) → 404;
   `https://sh-clock.github.io.evil.com` (suffix) → 404; `http://sh-clock.github.io` → 404;
   duplicate Origin headers → 404 (joined value cannot exact-match).
   Header-name case (`oRiGiN:`) → 204 (case-insensitive name lookup — correct, not a bypass).
   Trailing-space value `https://sh-clock.github.io␠` → 204 (HTTP OWS trimming; node `Headers`
   test confirms the trim; only the allowlisted origin itself benefits — no bypass possible).
3. **Disallowed-origin GET forwarding (scope 1, documented behavior):** the front door forwards
   disallowed-origin requests to the DO and merely skips decoration — `GET /version` with valid
   token + `Origin: https://evil.example` → `200` full body, **no** ACAO/vary; same for `GET
   /rows` If-None-Match match → `304` with `etag`, no CORS headers. **What a browser attacker
   can read: nothing.** Real-browser proof (local stack, disallowed origin :8081 → worker :8787):
   cors-mode fetch with token → `TypeError: Failed to fetch` (Authorization triggers preflight,
   preflight gets no CORS headers → request never sent); `mode:'no-cors'` → response `type:
   "opaque"`, `status: 0`, body unreadable (and the browser strips the Authorization header on
   no-cors requests, so the DO silent-drops it anyway); cross-origin PUT with token →
   `TypeError` (preflight blocked). A non-browser client reads everything (CORS is not the auth
   boundary — the bearer gate is; consistent with the L1 threat model).
4. **No credentialed CORS:** `access-control-allow-credentials` absent from every response; no
   cookies are set or read (WORKLOG D6). No CSRF surface: all state-changing requests require
   the `Authorization` header, which forces a preflight that fails for every origin except
   `https://sh-clock.github.io`.
5. **Error responses keep CORS for the legit client (scope 4):** with allowlisted origin, the
   full CORS set is present on `400 bad_if_match`, `403` (clock-token write attempt), `404`
   not_found-with-body, `412` (If-None-Match `*` on existing row), `304` (with `etag`), and
   silent-drop `404`s — the legit client never degrades to a network error on any protocol
   status.
6. **Silent drop hygiene (scope 1/4):** every unauthenticated/unknown-route `404` is
   body-empty (`content-length: 0`), no `WWW-Authenticate`, no cache headers, no content-type —
   no status/body differentiation leaks to disallowed origins (verified for `/bootstrap`,
   `/internal/backup`, `/rows:batch` GET, PATCH, HEAD, POST /version, //rows, /rows/, /ROWS,
   /v%C3%A9rsion). No content-type-sniffing surface: bodies are `application/json` or empty.

**Route/table confusion (scope 2):**

7. `GET /rows/` (empty id) → silent 404 (`store.js:308`). `GET //rows` → silent 404
   (double slash NOT normalized — node URL parity: pathname stays `//rows`).
8. Dot-segment handling is WHATWG-normalized **before** DO routing: `/./rows` → 200 manifest;
   `/rows/../version` → 200 `{"proto":"4.3"}`; `/rows/%2e%2e` → pathname becomes `/` → silent
   404 (node parity: `new URL('https://x/rows/%2e%2e').pathname === '/'`; uppercase `%2E%2E`
   identical). **No bypass exists because no route is gated by path** — all authorization is
   token-class based (`store.js:266-356`); normalization only selects which public route runs,
   and every route still passes the bearer gate.
9. Backslash: `/\rows` → `//rows` → silent 404; `/rows\x` → `/rows/x` → row id `x` →
   authenticated `404 {"error":"not_found"}` (node parity: `\` is a path separator for special
   schemes). Ids are opaque; a backslash can only rename which id is looked up, never bypass a
   gate.
10. Percent-encoded ids decode once via `decodeURIComponent` after the `/rows/` prefix:
    `/rows/evt%3Aabc%3Adef` → id `evt:abc:def` → not_found; `/rows/a%2Fb` → id `a/b` →
    not_found; `/rows/%2F%2F` → id `//` → not_found. Malformed percent-encoding is caught
    (`store.js:303-307`). Row-id length cap enforced post-auth: 257-char id → `400
    {"error":"bad_id"}`.
11. Method confusion: `GET /rows:batch` → silent 404; `POST /rows:batch/` → silent 404;
    `PATCH /rows/x` → silent 404; `HEAD /version` → silent 404; `POST /version` → silent 404;
    `/ROWS` → silent 404; `/v%C3%A9rsion` → silent 404. Route table is exact
    (`path === '/…' && method === '…'`, `store.js:276-327`).
12. Query-string abuse: `/config?x=1&force=1` → 200 normal config (query ignored, no param
    injection); `/version?` → 200. The worker concatenates `url.pathname + url.search` verbatim
    into the DO URL (`index.js:71`); URL→URL reparse is stable (node parity) — no
    reparse-confusion path found.

**Forwarded-header surface (scope 3):**

13. Only `authorization, content-type, if-match, if-none-match` are forwarded
    (`index.js:60-63`). Live: sending `Cookie`, `X-Forwarded-For`, `X-Real-IP`, `X-Custom`,
    `Forwarded` alongside a valid token changes nothing (`GET /version` → 200 identical to
    baseline). Code path: the DO reads only `authorization` (`store.js:330`), `if-none-match`
    (`store.js:495`), `if-match`/`if-none-match` (`store.js:591-592`); `content-type` is never
    read (`readJson` parses the body regardless). No other request header can influence DO
    behavior.
14. Authorization parsing is exact: `bearer`/`BEARER` scheme case → silent 404
    (`/^Bearer ([0-9a-f]{64})$/`, `store.js:331`); double space → 404; token with trailing
    garbage → 404. Header-name case `AUTHORIZATION:` → 200 (name lookup is case-insensitive —
    same header, by design). Duplicate Authorization headers are rejected by the edge (S1-7).
15. Conditional headers forward correctly and are honored read-only:
    `If-None-Match: "e21"` → `304` + `etag: "e21"`; garbage `If-None-Match` → plain 200;
    `If-Match: "1"` on a missing row → `404 {"error":"not_found"}` (no write); `If-None-Match:
    *` on an existing row → `412` (no write); malformed `If-Match: notquoted` → `400
    {"error":"bad_if_match"}` (no write). **Integrity check: manifest etag was `"e21"` before
    and after the entire PUT probe set — nothing was written to the live store by this audit.**
16. Capability gate live: clock token (`cf554ff8…`) on `PUT /rows/s1-audit-probe` → `403` empty
    body + CORS headers (read-only class cannot write; `store.js:352-355`).

**Response headers / caching (scope 4):**

17. No server-side caching anywhere: `GET /config` carries **no** `etag`, no `cache-control`,
    no `cf-cache-status` (same for `/version`, `/rows` 200s) — a stale-config cache cannot break
    unlock. The only conditional machinery is the explicit `If-None-Match` ↔ `etag` pair on
    `/rows` (`store.js:493-501`). 304 responses carry `etag` and (for allowlisted origins) full
    CORS headers.
18. `access-control-max-age: 86400` is attached to ALL decorated responses (all statuses,
    incl. silent-drop 404s for allowlisted origins) but is only *effective* on preflight
    responses — documented deviation (WORKLOG A1), verified live in the header dumps.

**Edge/TLS (scope 5):** see S1-1 for the negative findings (no redirect, no HSTS). TLS itself
is Cloudflare-managed and valid (all https probes succeeded without `-k`). workers.dev
takeover: S1-6. Edge header hygiene: duplicate-Authorization 400 / foreign-Host 403 (S1-7).

**Deployed-version check:** `GET /version` with the live UI token → `{"proto":"4.3"}` — the
live worker matches the repo HEAD protocol (v4.3 with `/rows:batch`, conditional reads, §9c
conditional PUTs — all three verified live above).

---

## HYPOTHESES (unverified, flagged per rules)

- **H1:** A very long URL or row id (>~8 KB) might hit an edge/URL length limit before the DO's
  own caps — not probed (would shade into load testing; the DO's 256-char id cap and 1 MiB body
  cap bound the realistic surface).
- **H2:** `staged` rows and the §19 backup path could be influenced by timing of probes near the
  03:00 UTC cron — out of scope (S4/S7 own backup integrity); no backup was triggered by this
  audit (no INTERNAL_TOKEN requests were made).
- **H3:** The `Vary: Origin` gap (S1-3) would become exploitable if the worker were ever placed
  behind a caching zone/CDN — configuration-dependent, not verifiable on the current deployment.

## Notes for other agents

- S5: browser cannot read any non-safelisted response header cross-origin (S1-2) — relevant to
  any client code touching `res.headers`; GH Pages header gaps listed in S1-4.
- S2/S3 (app/DO): the front door is a faithful pipe — every route-method confusion attempt died
  at the DO route table (items 7-12); id decode-once semantics and the 256-char cap are the only
  id-shaping rules.
- S4/S7 (backup/ops): `/internal/backup` and `/bootstrap` are silent to unauthenticated probes
  (items 6/16); edge rejects foreign Host and duplicate Authorization (S1-7).
