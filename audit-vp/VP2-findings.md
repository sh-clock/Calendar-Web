# VP2 — CRYPTO / AUTH RE-ATTACK (verification of the S7/S2 hardening wave + attacks on the new surface)

**Agent:** VP2 (crypto/auth re-attack), 6-agent verification wave
**Repo:** `/home/z/my-project/calendar-web` @ `c2654d9` (= `origin/main`, byte-identical to what `raw.githubusercontent.com/sh-clock/Calendar-Web/main` serves — verified)
**LIVE worker:** `https://calendar-poc.sh-clock.workers.dev` (proto `4.3`) — read-only, **2 worker requests** used (GET /config, GET /version with the current AUTH_UI); 5 GitHub fetches for the S7-F1 cleanliness / rotation-completeness probes. No DDoS, no password cracking, no writes anywhere.
**Method:** full read of `js/crypto.js`, `worker/src/store.js`, `cli/bootstrap.mjs`, `scripts/lib-prod-material.mjs`, `test/crypto-parity.mjs`, `js/app.js` (unlock/hydrate/write-cache paths), `scripts/gen-kat.py`, `worker/src/index.js`; private local stack `wrangler dev --port 8794 --persist-to /tmp/vp2-persist` with a **dedicated admin hex64** (`dc9b2954…`, `.dev.vars` copy under `/tmp/vp2-worker/`, precise process kills only — no `with-stack.sh`, no sibling pkills); harness `audit-vp/vp2-stack.mjs` (**73/73 green**); git-history scans over all 53 reachable commits; filesystem-wide material hunt. All key material in this report is redacted to 8 hex chars. No tracked file modified; no push; no deploy.

---

## Severity table

| ID | Severity | Finding (1 line) |
|---|---|---|
| **VP2-N1** | **MEDIUM** | The S7-F1 history purge (git filter-repo) scrubbed three **non-secret, public test-vector** KAT literals in `test/crypto-parity.mjs` (`kDataHex/authUiHex/authClockHex` → `'*SCRUBBED*<='` in **every reachable commit**), breaking the crypto-parity suite at HEAD: 5 FAILs + hard crash (`ERR_CRYPTO_INVALID_KEYLEN`) at §6 — the "full battery green (… 38 …)" claim in commit `2e5bcc2` is not reproducible. |
| **VP2-N2** | **LOW** | The NEW-universe live bearer tokens (full `AUTH_UI` — write class — and `AUTH_CLOCK`) sit in **world-readable, group-writable** `/home/z/vp4-evidence.json` (mode 664) — a copy of current-universe credential material **outside** the sanctioned `.secrets/` layout (also holds the full OLD, now-dead AUTH_UI). |
| VP2-O1 | INFO | Hygiene observations, no exposure: `.secrets/credentials.json` is mode 755 (CLI writes 0600 — verified); `/tmp/my-project/.secrets/prod.env` is 755 but both parent dirs are 0700 (effectively private); old-material 8-char redacted prefixes persist (by design) in tracked `audit-d/*.md`. |

No HIGH/CRITICAL findings. All four original findings under VP2's scope (S7-F1, S7-F2, S7-F3, S2 bearer gate) are **verified fixed**; all five mandated attack classes are **refuted by execution**. The two new findings are a test-integrity regression (VP2-N1) and a local-sandbox hygiene item (VP2-N2) — neither affects the LIVE deployment's confidentiality or integrity.

---

## Findings

### VP2-N1 [MEDIUM] — S7-F1 history-purge scrub over-reached into `test/crypto-parity.mjs`: the KAT suite is broken at HEAD (and in all reachable history)

**Evidence (executed):**
1. `node test/crypto-parity.mjs` at `c2654d9` → 22 checks print (5 **FAIL**: `KAT browser deriveKeys: K_data`, `KAT … AUTH_UI`, `KAT node … K_data`, `… AUTH_UI`, `… AUTH_CLOCK`), then **crashes**:
   ```
   RangeError: Invalid key length  (ERR_CRYPTO_INVALID_KEYLEN)
     at decryptRow (cli/bootstrap.mjs:147)  ←  createDecipheriv with an EMPTY key
     at test/crypto-parity.mjs:165          ←  Buffer.from(KAT.kDataHex,'hex')
   ```
   Root cause: `test/crypto-parity.mjs:58-60` reads `kDataHex: '*SCRUBBED*<=', authUiHex: '*SCRUBBED*<=', authClockHex: '*SCRUBBED*<='`. Node's lenient hex decode turns `'*SCRUBBED*<='` into a 0-byte buffer → invalid AES key → crash; the three deriveKeys KAT checks compare real 64-hex output against the placeholder string → FAIL.
2. **The scrub exists in every reachable commit** — `git show <rev>:test/crypto-parity.mjs | grep -c SCRUBBED` = 3 for all of `c26a976` (file origin), `7fdc558`, `2e5bcc2`, `c2654d9`. `.git/filter-repo/` (`commit-map`, `changed-refs` = `refs/heads/main`) proves the history was rewritten by git filter-repo; a blob callback replaced these three literals everywhere (51 of 53 commits re-hashed; `git fsck --unreachable` → nothing left).
3. **The scrubbed values were NOT secrets.** `scripts/gen-kat.py` (in-repo) regenerates them from fully public inputs: `PASSWORD="kat-password-0123456789"`, `SALT=00112233…eeff`, `AES1=bytes(range(32))` → `HKDF-SHA256(AES1, salt="", info="clock-v4/<domain>")`:
   - `k_data` = `222fade7…`, `auth_ui` = `083a2df4…`, `auth_clock` = `0b24e01e…`
   - Independently recomputed with Node `hkdfSync` — identical; matches the FAIL-detail output the broken test itself prints. Zero relation to OLD (`6cdf2298…`/`8b2d1be0…`/`df88174c…`/`cf554ff8…`) or NEW (`148eb179…`/`d2e6c5b2…`/…) deployment material (verified by direct comparison).
   - The sibling literals `aes1Hex: '000102…1f'` and `wrappedHex: '0102…3514'` — equally public, equally 64+-hex-shaped — were left untouched, so the callback was a targeted (mis)classification, not a blanket hex64 rule.
4. **Proof of exact fix:** `audit-vp/vp2-parity-restore.mjs` (a copy with only the three literals restored to the gen-kat.py values) → **`crypto-parity: 38 passed, 0 failed`**. The construction itself is therefore still KAT-proven; only the repo's copy of the pins is dead.
5. The CI hex guard (`git grep -En '[0-9a-f]{64}' -- scripts/ worker/ cli/ js/ index.html`) does **not** cover `test/` — restoring the literals cannot trip it, and its current emptiness is unaffected.

**Impact:** no production impact (test-only), but the flagship independent-implementation KAT pin (browser WebCrypto == Node mirror == Python reference) is unusable at HEAD, any future regression in `deriveKeys`/HKDF domains would not be caught, and the fix-wave commit `2e5bcc2` explicitly claims "full battery green (… +38 …)" — a claim that cannot be reproduced at that commit (the scrub rode the same wave). Root-cause note for ops: the filter-repo callback's secret list over-matched field names that *look* like deployment secrets (`kData`/`authUi`/`authClock`) in a file whose whole purpose is public known-answer data.

**Fix (concrete):** restore the three literals in `test/crypto-parity.mjs` to the `gen-kat.py` outputs (`222fade7…`, `083a2df4…`, `0b24e01e…` — regenerate with `python3 scripts/gen-kat.py`), re-run `node test/crypto-parity.mjs` (expect 38/38), and re-baseline the battery claim. Optionally: make the CI guard an allowlist (known public vectors) instead of a path filter so `test/` is covered without false positives.

---

### VP2-N2 [LOW] — NEW-universe live bearer tokens world-readable at `/home/z/vp4-evidence.json` (mode 664), outside the sanctioned `.secrets/` layout

**Evidence (executed):** filesystem-wide hunt for all 7 NEW-material values (`aes1`, `k_data`, `auth_ui`, `auth_clock`, `salt`, prod `ADMIN_SECRET`, prod `INTERNAL_TOKEN` — values never printed) over `/tmp`, `/home`, `/var/tmp`, `/opt`, `/srv` (hidden files included; values redacted in all output):

| Location | Mode | Contents | Assessment |
|---|---|---|---|
| `/home/z/vp4-evidence.json` | **664** (rw-rw-r--) | full NEW `auth_ui` + `auth_clock` hex64 **and** the full OLD (dead) `auth_ui` | **flagged** — current-universe WRITE-class token readable by every local account; sibling VP4's evidence file (not modified by VP2) |
| `/home/z/my-project/.secrets/credentials.json` | 755 | full NEW material | sanctioned location (mandate whitelist); mode note in VP2-O1 |
| `/home/z/my-project/.secrets/prod.env` | 755 | NEW ADMIN_SECRET + INTERNAL_TOKEN | sanctioned location; mode note in VP2-O1 |
| `/tmp/my-project/.secrets/prod.env` | 755 (parents `drwx------` ×2) | NEW ADMIN_SECRET + INTERNAL_TOKEN | **effectively private** — unreachable past the 0700 parents |
| `/tmp/local-material*.json` | 600 | OLD local-stack material only (no NEW values matched) | as the mandate stated — inert (dead universe) |

No other copy of any NEW value exists anywhere scanned (my own transient pattern file was chmod 600 and deleted; harness/logs contain zero hex64 strings — self-audited).

**Impact:** this is a single-user sandbox (uid `z` only), so there is no second reader today; in any multi-user context this file hands out the live UI-class (write) credential. The repo-side exposure (S7-F1's class of issue) remains fully closed — this is purely local-hygiene, introduced by the verification wave itself.

**Fix:** siblings write evidence redacted-to-8-chars (as every report in this repo does) or `chmod 600`; orchestrator should remove the file after the wave. (Also note `.secrets/credentials.json` is 755 although `cli/bootstrap.mjs` writes 0600 — `--out` mode verified 0600 in my own CLI run; something in the operator's copy flow loosened it. Tighten to 600 when convenient.)

---

## VERIFIED — original findings fixed (evidence per item)

1. **S7-F1 repo cleanliness — VERIFIED FIXED.**
   - CI guard at HEAD: `git grep -En '[0-9a-f]{64}' -- scripts/ worker/ cli/ js/ index.html` → **empty** (exit 1). Whole-tree tracked scan: only `test/crypto-parity.mjs` contains 64-hex-shaped strings — all public test vectors (see VP2-N1).
   - **All-history scan** (all 53 commits in `git rev-list --all`): none of the 7 NEW-material values (aes1/k_data/auth_ui/auth_clock/salt/ADMIN/INTERNAL) appears in any commit → CLEAN.
   - OLD values (`6cdf2298…`, `8b2d1be0…`, `df88174c…`, `cf554ff8…`): **no full 64-hex value in any reachable blob** (`git grep -E '<prefix>[0-9a-f]{56}'` over all revs → 0 hits for all four). The only occurrences are the ≤8-char redacted prefixes inside the tracked `audit-d/sec-S*-findings.md` audit trail (information-free by redaction design; `e7c4efca…`/`gtOMiuuJ…` likewise — public config data, prefixes only).
   - History purge executed: `.git/filter-repo/` present (`changed-refs: refs/heads/main`), `git fsck --unreachable` → nothing; local `origin/main` == HEAD == remote.
   - **GitHub serves clean content:** `raw.githubusercontent.com/…/main/scripts/lib-prod-material.mjs` and `…/scripts/seed-prod.mjs` → HTTP 200, **0 hex64 constants**, byte-identical to local HEAD.
2. **S7-F2 iters range + rewrap-iters — VERIFIED FIXED** (local stack, 73/73; `store.js:437-444` bootstrap, `:491-497` rewrap, `KDF_ITERS_MIN/MAX` `:19-20`):
   - bootstrap rejects `99999` and `10000001` → `400 bad_iters` — plus 10 more coercion shapes (`0`, `-1`, `100000.5`, `"100000"`, `"600000"`, `null`, `true`, `1e9`, `99999.0000001`, raw-JSON `NaN`): all `400 bad_iters`.
   - bootstrap accepts `100000` (→ /config reports it) and `600000` (force) — A1-A5.
   - rewrap-with-iters: optional field, validated `[100000, 10000000]`; boundaries accepted and **self-consistent** (the (salt, wrapped, iters) triple derives back to the same AES1 — C3/C4 at both 100000 and 10000000); 12 malformed rewraps leave /config **byte-identical** (C2). Single-statement `UPDATE config SET …` (`store.js:511-514`) → atomic.
   - CLI: `KDF_ITERS = 600000` default (`bootstrap.mjs:29`), rewrap body carries `iters` (`:300`), post-rewrap GET /config cross-checked (`:314`); full operator path re-run live on the private stack (B1-B9: new pw unwraps the SAME AES1, old pw fails, AUTH tokens unchanged, ver bumps).
   - **LIVE:** GET /config (current AUTH_UI) → `{iters: 600000, salt: e3ae6da9…, wrapped: <matches new credentials byte-exactly>, ver: 1}` — the deployed universe IS the rotated one at the raised cost (independently confirms VP4).
3. **S7-F3 client cache pinning — VERIFIED FIXED** (`js/app.js`): `hydrateLocalCache` refuses any cache whose `o.fp !== state.cfgFp` (`:588`); `writeLocalCache` stamps `fp: state.cfgFp` (`:624`); online unlock purges `LS_CACHE` **before derivation** when cached salt/wrapped differ from the server's (`:722-728`), refreshes `LS_CFG` (`:733`), then sets `cfgFp = salt|wrapped` (`:753`); `lock()` nulls cfgFp + purges (`:852`, `:859`); `forgetBrowser` drops `LS_CFG` (`:886`). Simulated end-to-end in Phase E (13/13): offline stale-cfg unlock with a revoked password reproduces the documented trade-off (bounded by "the profile already held that plaintext"), the next online unlock purges + fails the revoked password + refuses the stale cache; a force-re-bootstrapped fresh universe cannot be poisoned by old caches (fp mismatch → hydration refused), and old-universe `K_data` cannot decrypt new-universe rows (E13).
4. **Crypto KATs — construction VERIFIED, repo copy BROKEN (VP2-N1):** `test/crypto-parity.mjs` at HEAD crashes (above); the identical suite with the three public literals restored passes **38/38** (`audit-vp/vp2-parity-restore.mjs`). Browser/node/Python three-way parity, AAD binding, b64 canonicality, rewrap material semantics — all still pinned by that run.
5. **S2 bearer gate — VERIFIED INTACT at c2654d9:** `ctEqual` (`store.js:98-104`) is still full-length constant-time (XOR-accumulate over all 32 bytes, single terminal branch; the length early-return is unreachable from gate input — regex `^Bearer ([0-9a-f]{64})$` `:382` + `hexDecode(·,32)` `:383`, stored tokens `HEX64_RE`-validated `:433-434`, env secrets hexDecode-checked `:387-388`). Class-matrix spot-checks on my own universe: non-admin (ui/clock/internal/unknown/none) on `/bootstrap` + `/bootstrap/rewrap` → **empty 404** (C5 ×5); admin on an app route → empty 404 (C7); clock PUT row → 403 empty (C8); ui junk row → post-gate 400 validation (C9/C10). S2-L1's drain fix covers PUT **and** DELETE (`:407`, `:416`). `GET /config` returns exactly `{iters,salt,ver,wrapped}` — live key-scan + local (A3).

---

## REFUTED — attacks on the new surface (each disproven by execution or pinned by code+execution)

1. **NEW material exposure (repo / history / GitHub / filesystem):** refuted — see the scans in S7-F1 verification and VP2-N2's table: repo and all 53 commits clean, remote serves clean blobs, dangling pre-rewrite commits not served (below), and the only out-of-.secrets copy of NEW tokens is the sibling evidence file (VP2-N2, local-only).
2. **iters coercion:** refuted — 22 malformed shapes across bootstrap+rewrap (string, float, NaN-raw, negative, zero, huge, boolean, null) all rejected `400 bad_iters` with config byte-identical after; the only accepting path is admin-class (see #3).
3. **Non-admin iters control:** refuted — config is written only by `/bootstrap` and `/bootstrap/rewrap`, both `family='admin'` (`store.js:327-332`, gate `:397-398`); ui/clock/internal/unknown/no-token all get the empty 404 on both routes (C5). There is no other config-writing route (rows/staged/meta only).
4. **Rewrap races → torn (salt,iters,wrapped) triple via GET /config:** refuted — 12 concurrent rewraps (alternating with/without iters) + 8 concurrent row PUTs + 10 interleaved GET /config: every mid-race snapshot classifies as a whole state (pre-state or exactly one proposal's triple), final config equals exactly one proposal, `config.ver == before + 12` (each rewrap bumps once), rows untouched and still ver-1 (D1-D7). Code basis: the rewrap is ONE SQLite `UPDATE` with bound parameters (`store.js:511-514`) — atomic per statement; the DO input gate serializes storage access, so no reader can observe a half-applied SET.
5. **Row PUTs corrupting config / rewrap corrupting rows:** refuted — disjoint tables, no cross-table transaction anywhere in `store.js`; D7 verified rows byte-stable across the rewrap storm.
6. **Stale-cfg poisoning a fresh universe:** refuted — the fp (`salt|wrapped`) pinning means a cache decrypted under old material can only hydrate when the cfg fingerprint is byte-equal (fresh random 16-byte salt ⇒ collision infeasible; E12); online unlock purges before derivation; force re-bootstrap → old cache refused (E9-E11). The only residual is the **documented** offline-stale-unlock trade-off (`app.js:735-748`), which exposes nothing the profile didn't already hold and self-heals on the first online unlock (E5-E8). No NEW path found.
7. **Cross-universe key confusion:** refuted — rows of a fresh universe are undecryptable under the previous universe's `K_data` (E13), matching S7's Type-B semantics; rotation completeness confirmed below.
8. **Rotation completeness (OLD material unreachable):** refuted as an attack, verified as fixed — LIVE /config equals the NEW credentials exactly (salt/wrapped/ver/iters) and `HKDF(AES1)` reproduces k_data/auth_ui/auth_clock (material self-consistent); old tokens dead (VP4, live-confirmed; the old AUTH_UI also present-but-dead in `/home/z/vp4-evidence.json`); no full old value in any reachable blob; and GitHub no longer serves the pre-rewrite history: probing `raw.githubusercontent.com/sh-clock/Calendar-Web/<old-sha>/scripts/seed-prod.mjs` for the pre-scrub-era commit `cbfacc8c…` (old equivalent of `7fdc558`, whose tree contained the OLD K_data per S7-F1) → **HTTP 404**, while the same path at `main` → 200 (control). D1 backup (server-side, INTERNAL_TOKEN-gated, 7-day retention) can hold only OLD-universe ciphertext — dead material with the old rows wiped by the force rotation.
9. **Bearer-gate bypass / class confusion on the hardened code:** refuted — spot-checks above + the gate code is byte-equivalent to what S2's 46-probe matrix exercised (only the drain lines changed, `:407/:416`, both now drain PUT+DELETE); front door forwards only `authorization/content-type/if-match/if-none-match` (`index.js:125`) and logs counts only (`:86`).

---

## Notes & handoff

- **VP2-N1 fix is one commit:** restore 3 literals (public values from `scripts/gen-kat.py`), rerun `node test/crypto-parity.mjs` → 38/38. Harness for re-verification: `audit-vp/vp2-stack.mjs` (73/73, needs the private stack recipe in its header) and `audit-vp/vp2-parity-restore.mjs`.
- Client `deriveKeys` accepts `1..10 000 000` (`crypto.js:109`) while the server floors at 100 000 — intentional forward-compatibility; a *malicious server* could serve a low iters, but the offline attack cost is fixed by the iters baked into the operator-wrapped blob, and a hostile server is the accepted S5 threat model. INFO only.
- `git filter-repo`'s commit-map is preserved in `.git/filter-repo/commit-map` — useful for any future old-SHA reachability re-probe on GitHub (dangling commits can transiently survive force-pushes; my probe found them already gone).
- Live request budget: worker 2/8 (GET /config, GET /version). GitHub fetches: 5 (2 clean-file, 2 old-SHA, 1 control). Local stack killed precisely (`/tmp/vp2-wrangler.pid` tree; no sibling process touched). Transient secret-bearing temp files deleted; `/tmp/vp2-mat.json` (my local-universe material, 0600) left for re-runs and is inert outside port 8794.

**Bottom line:** the S7/S2 hardening wave's crypto/auth fixes are real and hold under re-attack (range-checked iters with atomic rewrap, admin-only config writes, fp-pinned cache with purge-before-derivation, intact constant-time gate, fully rotated + purged deployment). The wave's one self-inflicted wound is VP2-N1: the purge broke its own KAT suite and the "38/38 green" claim that shipped with it — trivially restorable, and the only finding that needs a code change. VP2-N2 is sibling hygiene for the orchestrator.
