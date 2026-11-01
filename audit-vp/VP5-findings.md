# VP5 — Full-battery re-run + test-quality audit

- **Repo:** `/home/z/my-project/calendar-web` @ `54c2fca794437aee4f8cc23de104883648211198` (working tree clean except `audit-vp/`)
- **Agent:** VERIFICATION-PENTEST VP5 (battery re-run + NEW-test quality audit)
- **Method:** every suite run exactly as specified (fresh universe per stack suite; `run-local` run alone); audit performed adversarially — every suspected test bug proven statically (assertion + code path) and, where possible, dynamically (scratch probe under `/home/z/vp5/`, no repo files modified).
- **Scratch evidence:** `/home/z/vp5/*.log` (full stdout per suite), `/home/z/vp5/vp5-sec51-probe.mjs` (sec5.1 vacuousness probe).

## JOB 1 — full battery (13 suites, ALL GREEN)

| # | Suite | Command | Expected | Result | Evidence (stdout tail) |
|---|-------|---------|----------|--------|------------------------|
| 1 | core-unit | `node test/core-unit.mjs` | 176 | **176/0** | `core-unit: 176 passed, 0 failed` |
| 2 | core-tasks | `node test/core-tasks.mjs` | 62 | **62/0** | `core-tasks: 62 passed, 0 failed` |
| 3 | crypto-parity (recently repaired) | `node test/crypto-parity.mjs` | 38 | **38/0** | `crypto-parity: 38 passed, 0 failed` (incl. `Type A rewrap: AUTH tokens unchanged`) |
| 4 | front-door-unit | `node test/front-door-unit.mjs` | 14 | **14/0** | `front-door-unit: 14 passed` |
| 5 | run-local (run ALONE, own wrangler :8787) | `node test/run-local.mjs` | ALL GREEN | **ALL GREEN** | `api-suite: 202 passed, 0 failed (target http://127.0.0.1:8787)` … `restore drill: all restored rows decrypt under the ORIGINAL K_data` … `run-local: ALL GREEN (dev log: /tmp/wrangler-dev.log)` |
| 6 | api-suite (fresh universe) | `bash scripts/with-stack.sh --fresh node test/api-suite.mjs` | 202 (+2 bootstrap runs) | **202/0** ×3 | bootstrap: `api-suite: 202 passed, 0 failed (target http://127.0.0.1:8787)` + `(…8788)`; suite: `api-suite: 202 passed, 0 failed (target http://127.0.0.1:8787)` |
| 7 | smoke-v7 | `bash scripts/with-stack.sh node scripts/smoke-v7.mjs` | 43 | **43/0** | `smoke-v7: 43 passed, 0 failed` |
| 8 | e2e-fc | `bash scripts/with-stack.sh node scripts/e2e-fc.mjs` | 50 | **50/0** | `=== RESULT: 50 passed, 0 failed ===` (+0 page/console errors) |
| 9 | e2e-fc-fixes | `bash scripts/with-stack.sh node scripts/e2e-fc-fixes.mjs` | 25 | **25/0** | `=== RESULT: 25 passed, 0 failed ===` (+0 page/console errors) |
| 10 | e2e-sec | `bash scripts/with-stack.sh node scripts/e2e-sec.mjs` | 24 | **24/0** | `e2e-sec: 24 passed, 0 failed` |
| 11 | stress-A6-1-edge-time (fresh) | `bash scripts/with-stack.sh --fresh node test/stress/stress-A6-1-edge-time.mjs` | 46 | **46/0** | `=== GROUP 1 (EDGE-TIME EVENTS): 46 passed, 0 failed ===` |
| 12 | stress-A6-2-recurring (fresh) | `bash scripts/with-stack.sh --fresh node test/stress/stress-A6-2-recurring.mjs` | 41 | **41/0** | `=== GROUP 2 (RECURRING EDITS): 41 passed, 0 failed ===` |
| 13 | stress-A6-3-dnd (fresh) | `bash scripts/with-stack.sh --fresh node test/stress/stress-A6-3-dnd.mjs` | 38 | **38/0** | `=== GROUP 3 (DND STRESS): 38 passed, 0 failed ===` |

No suite failed; no stop-condition hit. The with-stack `--fresh` bootstrap phase itself ran api-suite twice per invocation and exited 0 (exit-2 path never triggered).

## JOB 2 — test-quality audit (assume WRONG; prove or refute)

### VP5-Q1 — MEDIUM — `e2e-sec.mjs` sec5.1 does NOT exercise the S7-F3 cache-fingerprint pin it claims to test (vacuous for its named claim)

- **Assertion** (`scripts/e2e-sec.mjs:241`): `ok('sec5.1 foreign-fp cache never repainted (sync rewrote it)', ghost === false || ghost === 'no-cache', …)` after the sequence: poison cache (foreign `fp` + ghost event) → `page.click('#btn-lock')` → re-unlock.
- **Why it is vacuous for the pin:** `lock()` calls `purgeLocalCache()` (`js/app.js:859` → `js/app.js:632-638`). The poisoned cache is **deleted before the re-unlock**, so `hydrateLocalCache()` takes the no-object early return at `js/app.js:583` (`if (!o || typeof o !== 'object' || o.v !== 1) return false;`) and **never reaches the fp pin at `js/app.js:588`** (`if (!state.cfgFp || o.fp !== state.cfgFp) return false;`). The end-state "ghost not in cache" is fully explained by lock-purge + sync rewrite; deleting line 588 entirely would leave sec5.1 green.
- **Dynamic proof** (`/home/z/vp5/vp5-sec51-probe.mjs`, run under `with-stack`, replicating sec5.1 exactly and reading localStorage between lock and re-unlock):
  ```
  A) cache right after poison: {"v":1,"fp":"ffffffff|AAAAAAAA","cals":[{…
  A) cache right after #btn-lock (BEFORE re-unlock): null (PURGED)
  A) sec5.1 assertion value after full flow: ghost=false
  ```
- **The feature itself works** (probe part B — poison, then `page.reload()` instead of lock, re-unlock):
  ```
  B) poisoned cache present before reload: yes (fp="ffffffff|AAAAAAAA")
  B) cache still present at re-unlock start: yes
  B) ghost painted in DOM across 20 samples over ~5s: false
  B) ghost in cache after settle: false
  ```
  i.e. the pin is real and correct — only the test bypasses it. Suggested fix (NOT applied): replace the `#btn-lock` click with `page.goto(BASE + '/index.html')` (reload keeps localStorage, no purge), then re-unlock and assert the ghost never paints/persists.

### VP5-Q2 — LOW — `e2e-sec.mjs` sec5.2: "cfg refresh" half of the check name is unasserted; the collected field is a self-comparison tautology

- **Evidence** (`scripts/e2e-sec.mjs:271-275`):
  ```js
  const r = await page.evaluate(() => ({
    purgedToast: [...document.querySelectorAll('.toast')].some((t) => /key material changed/.test(t.textContent)),
    cfgFresh: JSON.parse(localStorage.getItem('clock_poc_cfg_v45')).wrapped === JSON.parse(localStorage.getItem('clock_poc_cfg_v45')).wrapped,
  }));
  ok('sec5.2 changed server material → purge toast + cfg refresh', r.purgedToast === true, JSON.stringify(r));
  ```
  `cfgFresh` compares the identical expression to itself — **always true**, and it is never used by the `ok()`. The check as a whole can still fail (via `purgedToast` — a real assertion matching the toast at `js/app.js:727`), but the "cfg refresh" claim in the name is dead code that would have been a tautology if wired in. The refresh behavior itself is real (`js/app.js:733` re-caches the fresh cfg).

### VP5-Q3 — LOW — `front-door-unit.mjs` fd.3 overclaims "body untouched" (bodiless GET); header-value anchors partial

- `fd.3` (`test/front-door-unit.mjs:78`) is named "DO reached, body untouched" but issues a **GET with no body** — the front door's request-body streaming path is never exercised by the suite.
- `fd.3b` (:80-83) pins exact values for `if-match`/`if-none-match` (good) but only asserts **presence** (`!== null`) for `authorization` and `content-type` — a mangled token would still pass.
- Neither is a false-pass; both are weakened anchors. Overall verdict on this file stands (see clean bill below): it is NOT a stub self-test.

### VP5-Q4 — LOW (latent) — auto-lock busy-skip permanently disarms; manual Lock silently no-ops while busy

- **Timer path** (`js/app.js:909-915`): the callback does `autoLockTimer = null;` **before** the guard, then `if (state.api && !state.busy) { lock(); … }` — if the 15-min expiry lands on a busy instant there is **no re-arm**: auto-lock stays disarmed until the next user activity (which, for an idle user, never comes).
- **Reachability today (why LOW, not higher):** `Api` aborts every request at 30 s (`js/api.js:33-35`), busy windows are user-initiated saves/deletes whose initiating `pointerdown` re-arms the timer (`js/app.js:4038-4040`), and the 60 s autosync never sets busy (`js/app.js:1208-1211` guards on `state.busy`). The gap is one future long-busy-operation away from being a real security bug; a one-line re-arm (or a retry timer) would close it.
- **Manual path** (`js/app.js:846-847`): `lock()` opens with `if (state.busy) return;` — the topbar Lock button remains clickable during busy (`#syncbar` is a non-blocking top bar, `css/style.css:144-148`), so a click during a save is **silently ignored with no feedback**; the user may walk away believing the app locked.
- **No timer leaks found:** `armAutoLock` clears before setting (:907), `disarmAutoLock` clears (:918-921), `lock()` disarms (:849), unlock arms once post-`showApp` (:801). `noteUserActivity`'s 1 Hz throttle (:925) only coalesces re-arms.

### VP5-Q5 — INFO — `FAST_ITERS` threading is consistent but duplicated as literals

- `FAST_ITERS = 100000` (`test/api-suite.mjs:109`) builds MAT/MAT2/rewrap material; the same value is re-hardcoded as the literal `100000` at every derive/bootstrap site (:131, :142, :152, :181, :191, :394, :576, :1032, :1134, :1220, B2 :894). Verified consistent end-to-end: material built at 100k ↔ bootstrapped at 100k ↔ derived at 100k; SEC-I's 600k material/derivation/server-value are self-consistent (:867-873); the seed-phase rewraps pass no `iters` so the server keeps 100k (`worker/src/store.js:491-508` optional-iters SET clause), matching `MATERIAL_OUT`'s `iters: 100000` (:1343) and `run-local`'s §19 fidelity compare. A future change to the constant fails **loudly** (PBKDF2 unwrap mismatch), not silently — acceptable, but the constant is not truly threaded.

### VP5-Q6 — INFO — settings "Reset to defaults" re-enables autoLock without arming

- `js/app.js:3824-3836` sets `settings = { …SETTINGS_DEFAULTS }` (autoLock: true) but never calls `armAutoLock()`. Self-heals on the next pointerdown/keydown/wheel/touchstart (the user is mid-interaction), so impact is nil. The direct toggle path is correct (disarm/arm at :3810-3815).

### Clean bill (audited adversarially, no findings)

- **api-suite SEC-C (19 checks, :1219-1274):** real RFC 9110 §13.2.2 matrix against the live worker. The hardcoded quoted-vers etags (`"2"`, `"3"`…) match the server's row-etag convention (`worker/src/store.js:696-699` compares `String(existing[0].ver)`); each step's expected stored ver is correctly tracked through the whole sequence (secC.1→19); secC.4 pins the **empty 412 body**; secC.15 proves BOTH headers are evaluated in order (If-Match ok + If-None-Match `*` → 412); secC.16 pins the documented fail-closed `400 bad_if_match`; secC.17-19 pin the missing-row semantics (412/412/200). No check can pass vacuously — every one asserts an exact status (+ body/error-code where it matters).
- **api-suite SEC-D (5 checks, :1280-1294):** real conditional-read forms; secD.1/secD.3 also pin the echoed ETag header; secD.2's list, secD.4 stale→200, secD.5 malformed→200 match `hManifest` (`worker/src/store.js:567-586`, weak compare, `*` ⇒ 304 because the representation always exists). Minor (not a finding): secD.4/5 assert status only — still discriminating (304 would fail them).
- **api-suite SEC-H (6 checks, :1300-1333):** exact values pinned — `cache-control: no-store` on /config and on 304s; `vary: Origin` + `strict-transport-security: max-age=31536000` on decorated AND silent-drop responses; `access-control-expose-headers: ETag` + ACAO echo only for the allowlisted origin; secH.5/6 prove the 2 MiB clock-DELETE is drained to a clean empty 403 **and wrote nothing** (404 not_found after). secH.3's HSTS is presence-only — value pinned by secH.2.
- **api-suite SEC-I (7 checks, :855-876) + placement:** secI.1/2 (400 below floor / above ceiling) vs secI.3 (409 for in-range 600k) form a sandwich that proves iters validation precedes the exists-check (`worker/src/store.js:437-450`); secI.4/5 pin the atomic wrapped+iters update; secI.6 performs a real 600k-iteration PBKDF2 unwrap proving the Type-A AES1 invariant; secI.7 pins the rewrap floor. **SEC-I is correctly placed BEFORE the B2 wipe** (block order :849-876 < :879-910), and the placement is load-bearing: B2 force-bootstraps back to 100k MAT material, on which the seed phase, `MATERIAL_OUT`, and run-local's §19 fidelity + restore drill all depend (misplacement breaks downstream, not api-suite itself).
- **r2.1b (:551):** real inclusive-floor anchor — 4 B ct → 400 `bad_ct` (r2.1), **16 B (bare GCM tag) → 200**, 17 B → 200 (r2.2), matching `ROW_CT_MIN = 16` (`worker/src/store.js:678`).
- **b2.6 (:905):** real — asserts BOTH `stale.status === 200` (no 304 against the pre-wipe etag) AND `after.etag !== etagBeforeWipe`; its precondition is guarded (b2.1 seeds ≥2 rows so the force-wipe actually fires the per-row DELETE triggers). Matches the trigger-based epoch design (`worker/src/store.js:249-259`).
- **front-door-unit.mjs overall — NOT a stub self-test:** the module under test is the real `worker/src/index.js` (`import` at :11); only the DO binding is stubbed, and the stub's recorded `seen` array is what *proves* the forwarding (fd.2 asserts the relayed URL `https://do.internal/rows`; fd.3b asserts exactly the 4-header allowlist survives and `x-evil`/`cookie`/`x-forwarded-for` are dropped — the real loop at `index.js:122-128`). fd.1 exercises the real manually-built 308 (+ query preservation, vary/HSTS); fd.4 the real front-door try/catch (404, no 500 leak); fd.5/5b the real preflight origin gate incl. `seen.length === 0` (DO not reached); fd.7 the real 304 relay (status + etag + empty body). Nits captured as VP5-Q3.
- **e2e-sec sec1–sec4 + sec6 — real browser interactions, no selector-that-matches-nothing passes:** every toast check is `.some()` over a live `querySelectorAll('.toast')` (empty list ⇒ false ⇒ FAIL); `waitForSelector('#app:not([hidden])', 25 s)` throws on timeout; `#password`/`#btn-lock`/`button[type=submit]` are real elements (a missing selector aborts the await). sec1 pins LS_SERVER untouched + toast + URL-bar cleaning; sec1.4/sec2.4 pin the positive fragment paths; sec3 stands up a genuine loopback attacker HTTP server framing the app with `sandbox="allow-scripts"` and checks **computed** `visibility:hidden` (frame-bust) + CSP connect-src/script-src enforcement via real fetch/DOM injection; sec4 unlocks with the real material password and asserts lock + cache purge + toast via the loopback-only `__autolockForce` hook (guarded by `isLoopbackHost()`, `js/app.js:4041-4048`); sec6 intercepts real `/version` responses for all four semver cases. (Minor, not a finding: sec4.5's `/Auto-locked/` matches both the natural and the forced toast text — it verifies the forced-hook toast path.)
- **js/boot-guard.js:** sound. The throw-based frame-bust (:22-38) covers both cases — `top.location` assignment throwing (sandbox without allow-top-navigation) and succeeding (navigation proceeds; the framed copy stays hidden until the top replaces it, denying the attacker pixels in the interim). Theme-boot precedence (v45 settings → legacy v44/v4.3 keys → OS; `'system'` always follows OS) is implemented exactly as documented (:48-58); every localStorage access is guarded; the framed case skips theme-boot via early `return` (no point painting a hidden app).
- **Auto-lock machinery (beyond Q4/Q6):** armed on unlock only after success (:801, `state.api` set at :758); activity listeners `pointerdown/keydown/wheel/touchstart` deliberately exclude bare `mousemove` — moving the mouse over the page does NOT keep it unlocked (conservative, security-positive); `__autolockForce` mirrors the timer's semantics and is loopback-gated.

## Verdict

**Battery: 13/13 suites GREEN at `54c2fca` (176 + 62 + 38 + 14 + run-local ALL GREEN + 202 + 43 + 50 + 25 + 24 + 46 + 41 + 38), zero failures, zero stop-conditions.**

**Test quality:** no fabricated results — every audited check drives the real system and asserts discriminating outcomes. One MEDIUM defect (VP5-Q1: sec5.1 is vacuous *for the fp-pin claim it names* — the pin itself is proven functional by probe part B), one LOW tautology-adjacent dead field (VP5-Q2), one LOW overclaim in front-door-unit (VP5-Q3), one LOW latent auto-lock gap in product code (VP5-Q4), plus three informational notes. Nothing warrants blocking the release; VP5-Q1 and VP5-Q2 deserve a follow-up patch to the e2e-sec suite, and VP5-Q4 a one-line re-arm hardening.

**No files modified; no push/deploy performed. Scratch evidence in `/home/z/vp5/`.**
