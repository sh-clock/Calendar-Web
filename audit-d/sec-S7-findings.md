# S7 — CRYPTOGRAPHIC PROTOCOL REVIEW (theoretical + verified-by-execution)

**Agent:** S7 (crypto) · 8-agent coordinated audit of the LIVE Calendar-Web PoC
**Repo:** `/home/z/my-project/calendar-web` (public mirror: `github.com/sh-clock/Calendar-Web`)
**LIVE worker:** `https://calendar-poc.sh-clock.workers.dev` (proto `4.3`, read-only access)
**Method:** every claim below was verified by executing real crypto (Node 24.22.1 native
WebCrypto / `node:crypto`) against the REAL material (`.secrets/credentials.json`, the LIVE
`/config`, and a locally-bootstrapped private universe via `scripts/with-stack.sh --fresh
--no-bootstrap` + `cli/bootstrap.mjs`), plus one real-browser drive of `js/app.js` with
`agent-browser`. Harnesses: `/home/z/s7/s7-crypto.mjs` (60 checks), `/home/z/s7/s7-stack.mjs`
(34 checks), `/home/z/s7/s7-drive.sh` (browser). Baseline `test/crypto-parity.mjs`: 38/38 green.
All key material in this report is redacted to 8 hex chars. No repo source was modified; the
live worker was only read (GET).

**LIVE config snapshot (bearer = owner's AUTH_UI from credentials.json):**
`{"salt":"e7c4efca…","iters":100000,"wrapped":"gtOMiuuJ…(60B)","ver":1}` · `/version` →
`{"proto":"4.3"}` · unauthenticated `GET /config` → empty 404 (silent drop, as specified).

---

## FINDINGS (severity-ordered; counts: 1 CRITICAL · 2 MEDIUM · 2 LOW · 1 INFO)

### F1 [CRITICAL] — LIVE `K_data` + `AUTH_UI` are committed to the PUBLIC GitHub repo: full read/write compromise of the deployed instance; the PBKDF2 wall is bypassed for anyone who can read the repo

**Evidence (executed):**
- `git grep` over `HEAD` attributes exactly which LIVE secrets are tracked:
  - LIVE `K_data` `6cdf2298…` → committed in `scripts/seed-prod.mjs`, `scripts/reseed-prod.mjs`, `scripts/decrypt-prod.mjs`, `scripts/check-seed.mjs`
  - LIVE `AUTH_UI` `8b2d1be0…` → committed in those 4 **plus** `scripts/e2e-prod.mjs`, `scripts/debug-prod-render.mjs`, `scripts/measure-week.mjs`, `scripts/measure-month.mjs` (8 files)
  - LIVE `AES1` `df88174c…` and `AUTH_CLOCK` `cf554ff8…` are **not** in any tracked file (the
    "never committed" discipline was applied to AES1 only — but `K_data` has *equivalent power
    over all row data*, and `AUTH_UI` is the wire credential).
- The repo is public and the files are fetchable anonymously:
  `curl https://raw.githubusercontent.com/sh-clock/Calendar-Web/main/scripts/seed-prod.mjs`
  → HTTP **200**, body contains `kDataHex: '6cdf2298…'` and `authUiHex: '8b2d1be0…'` (byte-identical to `.secrets/credentials.json`).
- The committed token is **live-valid** (read-only proof, owner-permitted GET):
  `GET https://calendar-poc.sh-clock.workers.dev/rows` with the repo-committed `AUTH_UI` →
  **200** manifest (`cmeta:a6268eb7…`, `evt:…:lunch-with-alex-37cb2f68`, `evt:…:weekend-trip-f4e789a3 ver 5`, …).
- Write capability is historically proven by the repo itself: commit `f2fb7ef` ("Production
  live + verified … seeded demo data …") used exactly these constants to PUT live rows
  (`scripts/seed-prod.mjs` encrypts with the committed `K_data` under `AAD(id,ver)` and PUTs
  with the committed `AUTH_UI`).

**Threat-model impact:** the §1 threat model's core claim — "the Worker can never read or
infer any event data" — holds against the *Worker*, but is void against the *public*: any
internet user can (a) decrypt every live row (`K_data`), (b) forge/overwrite any row at any
higher `ver` (RMW accepts `ver > stored`), (c) delete rows (`AUTH_UI` is the UI-class
writer). The password/PBKDF2 wall protects nothing here: `K_data` was never behind it
(derived-client-side), and the repository published it. This also retroactively voids the
live deployment's use for any real data (the seeded demo events are already world-readable
in principle). Note the PoC owner *did* designate the AES1 as a dummy and "not assuming it
is secure" (WORKLOG line 48), and WORKLOG line 91 claims "Final AES1 … never committed to
the repo" — true for AES1, false for the derived row key and the AUTH_UI.

**Fix (concrete):**
1. Rotate the universe: `node cli/bootstrap.mjs --url <live> --admin <secret> --password <newPw> --force --out .secrets/credentials.json` (documented destructive wipe of rows) — or implement Type B (§20) to keep data.
2. Strip the constants from all 8 scripts (read them from `.secrets/…`, which the existing
   `.gitignore` (`secrets*.json`) already excludes) **and** purge git history
   (`git filter-repo` / BFG) — rotation alone is insufficient while old commits keep the
   current `K_data`.
3. Add a CI grep guard for 64-hex literals matching deployed material.

---

### F2 [MEDIUM] — PBKDF2-HMAC-SHA256 at 100 000 iterations is below current (2026) guidance, and the server-side `iters === 100000` pin makes an upgrade a protocol change (though a small and client-compatible one)

**Evidence (executed):**
- LIVE `/config` reports `iters: 100000`; `cli/bootstrap.mjs:25` `KDF_ITERS = 100000`;
  `worker/src/store.js:19` same, and `hBootstrap` **rejects anything else**:
  `PUT /bootstrap` with `iters: 600000` → `400 {"error":"bad_iters"}`; with `iters: 100001` →
  same (S1/S2, local stack). `hRewrap` accepts only `{wrapped, salt}` — there is no `iters`
  parameter, so a password rotation cannot raise the KDF cost (`R5`: iters still 100000 after rewrap).
- Parameter reality: 100k PBKDF2-SHA256 is 6× below OWASP's 600k recommendation (2023+
  cheat sheet; Argon2id is the modern preference). Native single-core cost on this machine:
  100k ≈ 13.5 ms, 600k ≈ 80.5 ms, 1M ≈ 141.5 ms — i.e. the server-side cost of 600k is
  trivial, and the per-unlock client cost (~5×80 ms WebCrypto) is acceptable. At 100k, an
  off-the-shelf GPU rig tests on the order of 10⁴–10⁵ passwords/s/GPU — the 8-char LIVE test
  password is a dictionary word, but password cracking is out of scope; this finding assesses
  the *parameter* only.
- The saving grace (verified by code + execution): the **clients are already
  forward-compatible** — `js/crypto.js:109` validates `iters` as any integer `1..10 000 000`
  and derives with whatever `/config` says; same in `cli/bootstrap.mjs:100`
  (`deriveClientKeys`). Only the *server* pins equality.

**Threat-model impact (PoC):** owner-designated dummy password/material (DEVIATIONS: spec
§2 `PASSWORD_LEN_MIN 40` is deliberately waived — also unenforced in client and CLI, so a
real deployment would inherit that). Against the documented threat model the severity is
moderate: the wall is only as strong as the password; with F1 the wall is already moot for
the current deployment.

**Fix (concrete):** make the cost movable without breaking clients — (a) `hBootstrap`:
range-check `1 ≤ iters ≤ 10 000 000` instead of `=== KDF_ITERS`; (b) `hRewrap`: accept an
optional `iters` field (validated in range) and update `config.iters` atomically with the
new `wrapped`; (c) operator then re-wraps at 600k+ (one admin call); every client picks the
new `iters` up from `/config` at next unlock — **zero client changes required** (verified:
the client range already accepts it). Bump the minor protocol version and document in §8/§20.

---

### F3 [MEDIUM] — Offline unlock accepts a REVOKED password through the stale `LS_CFG` cache; `LS_CACHE`/`LS_CFG` are not pinned to `config.ver` (executed in the real browser)

**Evidence (executed, real app + real rewrap, own local universe):**
Browser drive (`/home/z/s7/s7-drive.sh`, phases in this order):
1. Unlock online with OLD password → app paints; `LS_CFG` = `{"salt":…,"iters":100000,"wrapped":…,"ver":1}`; `LS_CACHE` (`clock_poc_cache_v45`) contains the **decrypted plaintext** of the probe event (`grep -c "S7 secret probe event"` → 1) — plaintext-at-rest in localStorage is the documented local-first design (purged on Lock, app.js:623-629, 780-782).
2. Server-side Type A rewrap (admin `PUT /bootstrap/rewrap`): `config.ver` 1→2, new salt+wrapped (R1-R5, R6: OLD password → `unlock_failed` online).
3. **The browser then goes offline before any online unlock attempt** (server URL pointed at
   a dead port): reload → OLD password → **unlock SUCCEEDS**: `#app` visible, the stale
   decrypted event painted, toast "Server unreachable — showing your locally cached
   calendar", and `LS_CFG` still the OLD `ver:1` config. The rotated-away password
   re-derived AES1 from the stale public config and hydrated `LS_CACHE`.
4. Back online: OLD password → "Unlock failed: wrong password…" and `LS_CFG` is refreshed
   to `ver:2` even though the attempt failed (the config fetch precedes derivation,
   app.js:673-677) — this closes the stale window from then on.
5. NEW password online → unlocks, same data (Type A keeps AES1/K_data, R7/R8/R12).

**Code basis:** `unlock()` offline fallback `js/app.js:678-688` (uses cached `LS_CFG` on
`ApiError('network')`); `hydrateLocalCache()` `app.js:578-603` validates only the cache's
own shape (`o.v === 1`) — it never compares `cfg.ver`, salt, or wrapped; `hRewrap` bumps
`config.ver` (store.js:430-440) but nothing on the client consumes it; and a **force
re-bootstrap resets `config.ver` to 1** (store.js:403-407), so even a ver pin would not
catch that case.

**Threat-model impact:** an attacker needs the old password *and* the browser profile
(offline window before first reconnect) — but the same stale-unlock also fires after a
**force re-bootstrap to a new universe**: the app paints the destroyed universe's events
from cache with no signal that the config changed (integrity/UX issue; confidentiality is
bounded by "the profile already held that plaintext"). Under Type A the old password holder
can *always* re-derive AES1 from any old copy of the public config (the old `wrapped` blob
stays valid forever — D1 backups keep it 7 days; §20 defines Type B as the answer), so the
client-side gap mainly matters for the stale-data/universe-wipe case and for giving a
revoked password a working UI.

**Fix (concrete):** persist a config fingerprint with the cache (e.g. `ver` + first 8 bytes
of salt+wrapped) in `LS_CFG`/`LS_CACHE`; refuse offline unlock (or hydrate read-only with a
prominent "config may have changed" state) when the last-seen `ver` is unknown to be
current; purge `LS_CACHE` whenever an online `/config` differs from the cached one (cheap:
the client already fetches config on every unlock); make force re-bootstrap keep
`config.ver` monotonic.

---

### F4 [LOW] — AUTH tokens: no revocation/disable path short of a destructive force re-bootstrap; the derived-token design means a password change never rotates them; tokens live in many places (one of them public — F1)

**Evidence (executed + code):**
- Rewrap leaves `auth_ui`/`auth_clock` untouched (verified R9: the OLD `AUTH_UI` still
  authenticates after the rotation; `hRewrap` store.js:412-442 never writes the private
  column — by design, since AUTH_* = HKDF(AES1) and AES1 is unchanged in Type A).
- The only implemented rotations are: force re-bootstrap (wipes ALL rows + staged,
  store.js:393-402) or §20 Type B (explicitly unimplemented — DEVIATIONS). §4 lists
  "disabled token" among silent-drop conditions, but **no disable mechanism exists** in the
  store (no flag, no route).
- Token-in-N-places enumeration: (1) DO `config` private column (store.js:200-202);
  (2) D1 `config_backup` rows, 7-day retention (store.js:696-704); (3) browser
  `localStorage['clock_poc_auth_ui']` (app.js:51, 644 — at rest, survives browser restarts;
  `forgetBrowser` removes it); (4) JS heap (`state.api.token`); (5) operator's
  `credentials.json` (out-of-band, 0600); (6) **the public GitHub repo** (F1).
- Positive: server-side comparison is constant-time over the hex-decoded 32 bytes
  (store.js:96-102, gate 329-343 — verified read; the WORKLOG's A2 note about the
  client-side non-constant-time *local* comparison stands but is not remotely triggerable).

**Impact:** a leaked AUTH_UI cannot be invalidated without destroying the data (force) or
an unimplemented drill (Type B). In the PoC posture (dummy material) this is a documented
structural limitation; combined with F1 it is what makes the leaked token permanently valid.

**Fix:** implement a Type-B-lite: admin route `PUT /bootstrap/rotate-auth` that registers
`AUTH_UI'`/`AUTH_CLOCK'` derived as `HKDF(AES1, info + u32be(counter))` with a config-stored
counter (protocol change, §3/§20); or at minimum a `PUT /bootstrap/disable {class}` flag
honored at the bearer gate.

---

### F5 [LOW] — Server stores junk envelopes it could cheaply reject: no lower bound on `ct` (sub-16B "ciphertext" accepted) and cross-`ver` envelope transplants accepted (content-blind by design, but the damage is one 400 away)

**Evidence (executed, local universe):**
- `PUT` with an 8-byte `ct` → **200 accepted** (`F8`); the client's GCM decrypt then always
  fails (`F9`) → row flagged `corrupt` forever (no rewrite path — by policy). Only the
  *upper* bound `ct ≤ 65536` is enforced (store.js:582; `F10`: 65537B → `400 bad_ct`).
- `PUT` of a ver-2 envelope's exact `nonce`+`ct` under `ver: 3` → **accepted** (`F3`-test);
  no client can ever decrypt it (`F4`-test: AAD binds `ver`) → the row is bricked for every
  reader. The server cannot detect this (it never inspects `nonce`/`ct` — L1 by design), so
  this is an inherent property of the verbatim-relay model, surfaced here for the record.

**Impact:** a buggy/malicious UI-class writer (or the F1 public attacker) can destroy row
availability; confidentiality is unaffected. In the threat model the server is untrusted
anyway — the *client* correctly refuses to rewrite corrupt rows (app.js:1142, 1176).

**Fix:** enforce `16 ≤ ct.length ≤ 65536` at `hPutRow` (a legal GCM ct is ≥ tag size);
optionally reject `ct.length < 16` at `hRewrap`/`hBootstrap` too (wrapped is already
length-pinned at 60). The cross-ver transplant is undetectable without breaking L1 — accept
and document.

---

### F6 [INFO] — Spec↔code conformance nits (documented, none exploitable)

1. **§8 `wrapped` "48B" literal is wrong** in PROTOCOL-v4.1 (12+32+16 = 60). Code and CLI
   implement 60 and *enforce* it (client `bad_config` for 48/59/61B — T2.10; server
   `bad_wrapped` for 59B — R3). Already recorded as DEVIATIONS #1; spec should be fixed.
2. **AAD id encoding is UTF-8, not spec-literal "ASCII(id)"** (crypto.js:153, bootstrap.mjs:121)
   — equivalent for every spec-legal id (grammar is ASCII); both implementations byte-agree,
   KAT-pinned including a non-ASCII probe (`test/crypto-parity.mjs` §3). Harmless, but the
   spec text and the code disagree on paper for foreign ids.
3. **`crypto.js:13-14` comment is factually wrong**: it claims the explicit empty HKDF salt
   is "not the RFC 5869 default" — under HMAC zero-padding, `salt=""` and the RFC default
   (HashLen zero bytes) are **mathematically identical** (verified:
   `HMAC(key="") == HMAC(key=32×0x00)`, both HKDF paths produce the same PRK). All
   implementations agree, so this is a doc nit only.
4. **`PASSWORD_LEN_MIN 40` (§2) is enforced nowhere** (client, CLI, server) — owner-waived
   for the PoC (DEVIATIONS), but the check is also absent for any future deployment.
5. **§4 "disabled token"** silent-drop condition has no implementation (see F4).
6. **`config.ver` resets to 1 on force re-bootstrap** (store.js:404-407) — non-monotonic;
   interacts with F3's proposed pinning.

---

## VERIFIED-SECURE (each property PROVEN by execution against real material)

All checks green: **Part 1 (LIVE material, browser module on Node WebCrypto): 60/60** ·
**Part 2 (local stack, own universe): 34/34** · browser drive: all 6 phases behaved exactly
as asserted · baseline `test/crypto-parity.mjs`: 38/38.

1. **Key hierarchy reproduces the LIVE deployment end-to-end.** `deriveKeys('password',
   live salt, 100000, live wrapped)` (the shipped browser module `js/crypto.js`) yields
   exactly the CLI-registered `AES1` (`df88174c…`), `K_data` (`6cdf2298…`) and `AUTH_UI`
   (`8b2d1be0…`); the Node mirror agrees on all three (T1.1-T1.4). KAT vectors pin both to
   an independent Python implementation (`test/crypto-parity.mjs`, 38/38).
2. **HKDF domain separation and info binding.** `HKDF(AES1, 'clock-v4/K_data') ==
   live K_data`, `HKDF(AES1, 'clock-v4/AUTH_UI') == live AUTH_UI`, `…AUTH_CLOCK` likewise
   (T3.2-T3.4). All five spec info strings are pairwise distinct and produce five distinct
   32-byte outputs (T3.10/T3.11). Swapped infos give different keys (T3.5/T3.6).
3. **Subkey one-wayness / no cross-domain derivation.** `HKDF(K_data, AUTH_UI-info) ≠
   AUTH_UI`, `HKDF(K_data, K_data-info) ≠ K_data`, `HKDF(AUTH_UI, K_data-info) ≠ K_data`
   (T3.7-T3.9) — holding K_data gives no path to any other domain key (relevant to F1: the
   leaked K_data does *not* reveal AES1, AUTH_UI or AUTH_CLOCK).
4. **PBKDF2 wall.** With only the public config (salt/iters/wrapped), the sole route to any
   key is the GCM unwrap; a wrong KEK returns *nothing* (GCM tag; T7.2), the correct one
   returns exactly AES1 (T7.3), and 1-char password changes fully avalanche the KEK (T7.1).
5. **Single generic unlock failure shape (no oracle).** Seven wrong passwords (case, space,
   accent, empty, …) all produce the *identical* `Error('unlock_failed')` (T2-T2.8);
   bit-flips in the wrapped blob's nonce/ct/tag are indistinguishable from a wrong password
   (T2.9) — failure occurs at the GCM tag, never earlier, and GCM has no padding (no
   padding-oracle class). Length deviations fail up-front as `bad_config` (T2.10: 48/59/61B).
6. **AAD binds row identity AND version.** With the LIVE `K_data`: correct `(id, ver)`
   decrypts (T4.1); every cross-id confusion (neighbour uuid, prefix extension/truncation,
   other row family) and every cross-ver confusion (1,2,4,5,255,4294967295) FAILS AEAD
   (T4.2/T4.3 — 11 executed decrypt attempts); bit-flipped ct and foreign nonces fail
   (T4.4/T4.5). The `id||u32be(ver)` encoding is injective (0 collisions over 800 crafted
   NUL-embedding pairs, T4.6); `rowAad` enforces `1 ≤ ver ≤ 4294967295` (T4.7), matching the
   server's `VER_U32_MAX` (F11-F13 wire-verified: ver 0 → `bad_ver`, 4294967295 accepted,
   4294967296 → `bad_ver`).
7. **Rollback replay is doubly blocked.** (a) *Cryptographic*: an old ver-N ct cannot be
   decrypted under ver N+1 — executed with the LIVE key (T5.1) and wire-verified via the
   transplant test (F3/F4: server-stored transplant fails client AEAD); (b) *Procedural*:
   the D14 acceptance predicate (`stored.ver === submitted.ver && nonce === && ct ===`,
   app.js:1158) rejects a malicious server's old-envelope echo (T5.2), and the honest server
   itself rejects an old-ver PUT as rebase, returning the CURRENT envelope (F2, wire). A
   replayed old envelope decrypts only as the old row (T5.3) — the client can never be made
   to *accept* a rollback as its own write.
8. **Nonce hygiene.** `encryptRow` draws a fresh 12-byte CSPRNG nonce per call
   (crypto.js:163): 500 encryptions across mixed ids/vers → 500 distinct nonces with the
   LIVE key (T6.1); the rebase path re-encrypts with a fresh nonce at `ver+1` each attempt
   (putRowRMW app.js:1152-1157 — no path re-PUTs an old nonce+ct under a new ver; the only
   verbatim re-PUT in the system is the §19 restore drill at the *same* ver); row nonces
   never collide with the wrapped blob's nonce (different key domain anyway, T6.2).
9. **GCM key-domain discipline.** `K_data` is imported as an AES key only via
   `importRowKey(kData)` (app.js:694 — sole production call site); the AUTH tokens are used
   only as bearer hex (Api constructor, api.js:22-29) and never as key material
   (repo grep). `AES1` itself is destructured at app.js:689, never persisted, never sent
   (no `localStorage`/network reference — repo grep; `api.js` bodies carry only
   `{ver,nonce,ct}`).
10. **Type A rewrap semantics (executed on a live local universe).** Admin `PUT
    /bootstrap/rewrap` atomically rotates `wrapped`+`salt`, bumps `config.ver` 1→2 (R1/R5);
    OLD password then fails online (R6); NEW password unwraps the SAME AES1 (R7) with the
    SAME `K_data` (R8) and SAME AUTH tokens (R9) — KEK genuinely changed (R10: different
    PBKDF2 output; R11: fresh wrap nonce); rows are byte-untouched and still decrypt under
    the old K_data (R12) — no data migration needed for Type A. Non-admin rewrap → silent
    404 (R2); 59B wrapped → `bad_wrapped` (R3); bad salt → `bad_salt` (R4); rewrap on
    un-bootstrapped config → 404 `not_found` (S3). AUTH_CLOCK (read-only class) still
    passes the gate post-rewrap (R13).
11. **Type B / cross-universe isolation.** A row encrypted under `K_data(AES1_u1)` is
    UNREADABLE under `K_data(AES1_u2)` from an independently bootstrapped universe (F5/F6)
    — rotating AES1 without re-encrypting rows bricks them, exactly as §20 Type B's
    re-encryption step implies; the client never calls rewrap (rotation is operator-only —
    no `rewrap` reference in `js/`, verified by grep), and the local-first cache story around
    rotation is F3 above (executed: stale offline unlock succeeds; online reconciliation
    self-heals — sync drops rows absent from the manifest, app.js:1016-1023).
12. **Randomness is CSPRNG everywhere in first-party code.** Nonces/salt/AES1:
    `crypto.getRandomValues` / `node:crypto.randomBytes` (crypto.js:163, bootstrap.mjs:63,
    74-75); calendar/event ids: `crypto.randomUUID()` (app.js:1045, 2522, 3351). Repo-wide
    grep for `Math.random`/`Date.now` in security contexts: **zero** hits in first-party JS
    (only a FullCalendar UI lib and an autosync debounce at app.js:3863; `Date.now` in
    store.js is the spec'd `updated_at` "hygiene only" timestamps).
13. **Envelope/wire shape laws (server-side, executed).** nonce exactly 12B (`bad_nonce`,
    F7); ct ≤ 65536 (`bad_ct`, F10); new rows accept any `ver ≥ 1`; bootstrap rejects
    `iters ≠ 100000` (S1/S2) and enforces `wrapped` = 60B canonical b64; `/config` returns
    clear params only — no private column keys in the response (S8); unauthenticated routes
    uniformly empty-404 (live: `GET /config` without bearer → empty 404).
14. **Constant conformance, three-way (spec §2/§6/§8 vs code vs CLI vs LIVE):**

    | Constant | Spec (v4.1) | Client `js/crypto.js` | Server `worker/src/store.js` | CLI `cli/bootstrap.mjs` | LIVE (executed) |
    |---|---|---|---|---|---|
    | GCM nonce 12B | §2 `GCM_NONCE_LEN 12` | :163 `getRandomValues(12)` | :23 `NONCE_LEN=12`, :580 `bad_nonce` | :63 `randomBytes(12)` | ✓ T8.5, F7 |
    | GCM tag 16B | §2 `GCM_TAG_LEN 16` | implicit (ct‖tag; T8.4: 2B pt → 18B ct) | no lower bound (F5) | :66/:140 tag 16 | ✓ T8.4 |
    | ver u32 ≥1, ≤ 2³²−1 | §2 `VER_WIDTH` | :152 `1..4294967295` | :21 `VER_U32_MAX`, :578 | :117 same | ✓ F11-F13, T4.7 |
    | KDF iters 100000 | §2 | uses cfg.iters, accepts 1..10M (:109) | pinned `=== 100000` (:19, :383) | :25 `KDF_ITERS` | 100000 (F2) |
    | wrapped 60B | §8 says "48B" (**spec bug**) | :114 `!== 60 → bad_config` | :22 `WRAPPED_LEN=60` (:384, :418) | :26 `WRAPPED_LEN=60` | 60B ✓ T8.2/T8.3 |
    | ct ≤ 64 KiB incl tag | §2/§21 | (payload soft-cap, app layer) | :20/:582 `bad_ct` | — | ✓ F10 |
    | salt 16B (hex32) | §2 | :106 regex | :376/:422 `HEX32_RE` | :74 `randomBytes(16)` | `e7c4efca…` ✓ |
    | HKDF salt "" , info `clock-v4/<domain>` | §3 | :94 explicit empty | — (never derives) | :57 `Buffer.alloc(0)` | parity ✓ T3.12 |
    | AAD = id‖u32be(ver) | §6 "ASCII(id)" | UTF-8 (≡ASCII for legal ids) | opaque (never parsed) | UTF-8 mirror | KAT ✓ (F6.2) |
    | `PASSWORD_LEN_MIN 40` | §2 | **not enforced** | n/a (never sees pw) | **not enforced** | 'password' (waived, F6.4) |

---

## Summary

| Severity | Count | Findings |
|---|---|---|
| CRITICAL | 1 | F1 live K_data + AUTH_UI committed to the public repo (read/write compromise of the deployment) |
| MEDIUM | 2 | F2 PBKDF2 100k below 2026 norms + server-pinned (upgrade = small protocol change); F3 offline unlock with a revoked password via unpinned LS_CFG/LS_CACHE |
| LOW | 2 | F4 no AUTH-token revocation path (force-rebootstrap-only); F5 server stores sub-tag ct / cross-ver transplants (junk rows) |
| INFO | 1 | F6 spec↔code nits (48B literal, UTF-8 AAD, HKDF-salt doc nit, unenforced PASSWORD_LEN_MIN, §4 "disabled token", config.ver reset) |

**Overall cryptographic verdict:** the *construction* is sound and now unusually well-proven
(PBKDF2 → GCM unwrap → HKDF subkeys with real domain separation; AAD-bound envelopes with
executed cross-id/cross-ver/rollback/nonce-reuse negative tests; constant-time bearer gate;
CSPRNG-only randomness; KAT-pinned three-implementation parity). The deployment's security
is nonetheless **fully compromised by F1** (published `K_data` + `AUTH_UI`), and the
operational knobs around the construction (iters pinning, token revocation, cache
invalidation on config change) are the concrete hardening items F2-F4.
