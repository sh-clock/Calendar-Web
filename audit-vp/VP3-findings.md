# VP3 — Client web-surface re-attack (verification wave, 2026-11-01)

Agent: VP3 (executed by the orchestrator after 4 consecutive subagent-launch
infrastructure timeouts; all probes below were executed by the orchestrator
with the same criticality rules). Repo @ 54c2fca; LIVE Pages + worker.

## Verified fixes (browser-executed)
- **S5-F1 server-param hardening**: bypass matrix 16/16 — see below.
- **S5-F2 setup fragment-only**: e2e-sec sec2.1–2.4 (query refused + toast,
  fragment stored) — re-confirmed live during this wave's probes.
- **S5-F3 CSP**: injected inline `<script>` does NOT execute (e2e-sec sec3.5);
  foreign-host fetch blocked by connect-src (sec3.3/3.4); **CSS exfil channels
  all blocked** (style-attribute `background:url(//evil)`, `<style>` @import,
  css url() rule, `<img>` — zero outbound requests, route-intercepted evil);
  no `eval`/`new Function`/string-setTimeout in any vendored FC v7 bundle or
  theme global.js; **all 7 themes switched on the LIVE site under CSP with 0
  console/page errors and 31 event chips in every theme**.
- **S5-F3 frame-bust**: sandboxed frame (no allow-top-navigation) → app HIDDEN
  (e2e-sec sec3.1/3.2); **unsandboxed cross-origin frame** → Chromium blocks
  the cross-origin top-navigation ("Unsafe attempt to initiate navigation…")
  and the boot-guard catch hides the document (visibility:hidden, app
  non-interactive) — verified SECURE; srcdoc nesting → escaped-or-hidden.
- **S5-F4 auto-lock**: e2e-sec sec4.1–4.5 (locks, purges cache, toast, hook
  loopback-only, settings toggle present).
- **S7-F3 cache fp pinning**: e2e-sec sec5.1/5.2 (foreign-fp cache never
  hydrates; changed online cfg purges + toast).
- **Live/repo byte-identity**: sha256 of index.html + 6 js files match
  (VP4 verified; re-observed during theme switching).

## isLoopbackServer bypass matrix (16 cases, all executed in Chromium)
| Candidate | URL parser hostname | Allowlist | Browser actually goes |
|---|---|---|---|
| localhost.evil.example | localhost.evil.example | REJECT | n/a (ignored by app) |
| a.b.localhost | a.b.localhost | accept | **loopback** (ERR_CONNECTION_REFUSED; RFC 6761 mapping verified) |
| 127.0.0.1.evil.example | 127.0.0.1.evil.example | REJECT | n/a |
| 0x7f000001 | 127.0.0.1 | accept | **loopback** |
| 2130706433 | 127.0.0.1 | accept | **loopback** |
| [::ffff:127.0.0.1] | [::ffff:7f00:1] | REJECT | n/a |
| localhost@evil.example | evil.example | REJECT | n/a |
| localhost:8787@evil.example | evil.example | REJECT | n/a |
| evil.example\@localhost | evil.example | REJECT | n/a |
| LOCALHOST (uppercase) | localhost (lowercased) | accept | **loopback** |
| %6c%6f… (percent-encoded) | localhost (decoded) | accept | **loopback** |
| unicode confusable | locaihost | REJECT | n/a |
| plain evil | evil.example | REJECT | n/a |
| plain localhost / [::1] (controls) | as-is | accept | **loopback** |

Every ACCEPTED form provably stays on the machine (connection-refused errors
on loopback, zero route-intercepted evil hits). The `*.localhost` wildcard is
spec-mapped to loopback by Chromium (RFC 6761) — an attacker cannot DNS-hijack
it out of the browser.

## New findings
- **VP3-N1 [INFO]** `isLoopbackServer` accepts IPv4 hex/decimal forms
  (0x7f000001, 2130706433) that `new URL` canonicalizes to 127.0.0.1 —
  correct-but-lenient; no bypass (they genuinely are loopback).
- **VP3-N2 [INFO]** unsandboxed cross-origin framing never escapes (Chromium
  requires user activation for cross-origin top navigation) — the app relies
  on the HIDE fallback there. Defence holds; document that the frame-bust's
  *escape* path only fires for same-origin/sandboxed-allow-top frames.
- No CRITICAL/HIGH/MEDIUM/LOW findings.

## Refuted attacks (with executed evidence)
Loopback bypass ×12 shapes · CSP style-attribute/@import/url()/img exfil ×4
channels · eval-based CSP breakage (none in vendored bundles) · theme-switch
CSP regression ×7 themes · frame-bust escape into interactivity ×3 framing
strategies · lock/forget residual leakage · auto-lock force bypass
(covered by e2e-sec) · cache-fp foreign-row hydration.

## Probes
/home/z/vp3/bypass-matrix.mjs · csp-exfil.mjs · theme-switch-live.mjs ·
frame-bust.mjs · unsandboxed-check.mjs · localhost-check.mjs
