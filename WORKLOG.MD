# WORKLOG.MD — Shared Audit & Development Coordination Log

> This file is the single source of truth for cross-agent coordination.
> ALL parallel audit agents MUST read this file BEFORE auditing and MUST append their findings here.
> Combine all found errors here and cross-check them before acting on any single report.

---

## THE COMMANDMENTS (PERMANENT — MUST NOT BE FORGOTTEN)

1. **PRIORITISE ACCURACY ABOVE ALL ELSE.** Accuracy is valued over everything.
2. **TEST ALL WORK PRIOR TO SHIPPING.** No exceptions.
3. **UTILISE VLM AND PIXEL-PEEPING** capabilities to ENSURE output is CORRECT. Visual audits are JUST AS IMPORTANT as code audits — do NOT assume code translates to correct visuals.
4. **DO NOT ONLY PERFORM A SMOKE TEST — A FULL AUDIT MUST BE CONDUCTED.**
5. **USE MULTIPLE PARALLEL AGENTS** to perform CONSTANT code checks.
6. **Once an error is identified: PAUSE.** Check the offending lines AND surrounding context to ensure it is NOT a FALSE POSITIVE before acting.
7. **If a separate platform is being used (i.e. ESP32-S3), EMULATE IT AS BEST AS POSSIBLE.**
   - IF POSSIBLE, use WELL-ESTABLISHED EMULATORS (e.g. Espressif QEMU fork, Renode, Wokwi CLI) to achieve this purpose.
   - IF NOT POSSIBLE (i.e. certain hardware components): ATTEMPT TO EMULATE ALL HARDWARE COMPONENTS (i.e. ILI9488-based screen) using a HOMEMADE EMULATOR built FROM REPUTABLE DOCUMENTATION (datasheets, vendor reference manuals, real open-source drivers).
8. **PRIORITISE COPYING VERBATIM CODE FROM OPEN-SOURCE PROJECTS THAT ALLOW THIS** (GPL or similar licences) — to reduce the chance of LLM-induced error. PORT LOGIC where required, ensuring functionality remains VERBATIM. Licence attribution must be preserved.
9. **Once a SIGNIFICANT portion is written, LAUNCH 3+ PARALLEL AGENTS TO AUDIT the new sections** — it is BETTER TO PREVENT BUGS DURING WRITING than to HUNT them down later.
10. **If ANY ERRORS are found, CONTINUE LAUNCHING AUDIT AGENTS UNTIL NO MORE ERRORS ARE FOUND.**
11. **ENSURE ALL AGENTS DO NOT HAVE A CORRUPTED CONTEXT** — agents MUST NOT ASSUME ANY CODE IS CORRECT. They MUST be CRITICAL and HARSH in their inspections.
12. **PERFORM CONSISTENT PUSHES TO AN EXTERNAL REPO (if possible)** to ensure progress is not lost should a hang or crash occur. At minimum: frequent local git commits (small, atomic, descriptive messages).
13. **AUDITING MUST BE CONDUCTED LIKE A REAL HUMAN DEVELOPER.**
    - This means ACTUALLY COMMUNICATING with the UI and ENSURING it works AS INTENDED.
    - Use of harnesses AND debugging code is ALLOWED and ENCOURAGED — as long as it lives on a SEPARATE BRANCH.
14. **PARALLEL AGENTS MUST UTILISE THIS SHARED WORKLOG.MD TO COORDINATE AUDITS** — combine all found errors and cross-check them here.
15. **EFFICIENCY IS THE SECOND MOST VALUED THING — CODE MUST BE EFFICIENT.**
    - Example of what NOT to do: write a full FIPS JS implementation of AES when native crypto libraries exist.
16. **DO NOT USE SHORTCUTS. NO MANUAL PATCHES / HACKS.** ALL CODE MUST BE FULLY UNDERSTOOD. Do **NOT** implement patches/hacks to 'fix' the OUTPUT.
17. **IF CONTEXT IS RUNNING OUT: STOP AND REPORT WHAT HAS BEEN DONE.** The ORDER to CONTINUE will be given.
18. **READ RELEVANT CODE FULLY — DO NOT SKIM READ.**
19. **DO NOT HALLUCINATE OR 'OVERTHINK' REFERENCES** UNTIL HARD EVIDENCE can be EXTRACTED from REAL REPOS OR RELEVANT DOCUMENTATION. DO NOT ASSUME ANYTHING WITHOUT EVIDENCE.
20. **DO NOT BE LAZY. DO NOT FAIL.**
21. **IF IT IS NOT POSSIBLE TO MEET THESE COMMANDMENTS, STOP AND REPORT WHY.**
22. **RESPOND IN ENGLISH ONLY.**
23. **ACCURACY > EFFICIENCY > EVERYTHING ELSE.**

---

## TASK (from user, 2026-10-30)

Implement **ONLY the calendar feature** of PROTOCOL v4.1 (see
`/home/z/my-project/upload/Pasted Content_1793349203747.txt`) on the user's
Cloudflare account. Do NOT implement photos or to-do lists. The CLOCK has NOT
been built — Proof of Concept ONLY. Test password: `password` (user-designated,
known-insecure). Generate a **dummy AES key** and deliver it to the user. Serve
the web client via GitHub Pages (repo: sh-clock/Calendar-Web).

---

## Environment Facts (VERIFIED 2026-10-30, evidence-based)

- Sandbox: Node v24.22.1, npm 11.19.1, git 2.47.3, OpenSSL 3.5.7; network OK to npm registry / Cloudflare API / GitHub API.
- **Cloudflare**: account-scoped token (NOTE: `user/tokens/verify` returns "Invalid API Token" — that endpoint is for user tokens; account-level APIs work, which is the evidence the token is account-scoped and functional). Account ID `2677059f4553d3e1d840f1faccb914be` ("Sh-clock@proton.me's Account"). workers.dev subdomain: `sh-clock` → final URL `https://calendar-poc.sh-clock.workers.dev`. Existing workers on the account: `api`, `client` (dashboard templates; UNTOUCHED). Existing D1 DBs: `calendar`, `settings`, `alarm` (all empty; UNTOUCHED by us).
- **Created for this PoC**: D1 database `calendar-poc-backup` id `010ed43d-a145-400e-adba-e790c00349c3` (region APAC).
- **GitHub**: PAT valid; repo `sh-clock/Calendar-Web` — public, EMPTY (no branches), default branch `main`, Pages NOT yet enabled, token has admin+push. First push creates `main`.
- wrangler 4.156.0 pinned as devDependency; workerd 1.20261023.1 binary present (local workerd emulation viable).
- Emulation note (Commandment 7): target platform is Cloudflare Workers runtime — emulated **locally via workerd** (the actual open-source Cloudflare runtime, `wrangler dev`), which is the highest-fidelity emulator available. The ESP32-S3 clock does not exist in this PoC (user-stated), so no hardware emulation is required; the clock's *reader behaviour* (§13: render today+7 from cached buckets) is represented by a read-only "Clock preview" panel in the web client.

---

## Scope Decisions (each is documented, evidence-based, and reported to the user)

- **D1 [SCOPE]** Implement ONLY the calendar: §4 auth+silent-drop, §5 encoding/error policy, §6 row envelope (server side: opaque storage + `ver` RMW), §7 DO SQLite primary storage, §8 bootstrap/config/rewrap, §9 row sync (GET/PUT/DELETE), §10 status (always 0 without photo domain), §22 version. §19 daily backup at 03:00 UTC (calendar scope: rows + config). EXCLUDED per user order: photos (§15–§18, R2, blob routes), todos (§14). §11 WS radar omitted: it carries ONLY clock-status + alarm-event frames — there is NO row-change nudge frame in §11 (row sync is pull-based via GET /rows manifest), and no clock exists in this PoC.
- **D2 [SPEC BUG — §8 `wrapped`]** Spec says `"<b64, 48B = 12B nonce || 32B ct+tag of AES1 under KEK>"`. Internally inconsistent: 12+32≠48, and 32B cannot hold a 32B master key plus a 16B GCM tag. The only cryptographically valid reading: `wrapped = nonce(12) || ct(32) || tag(16)` = **60 bytes total**, where "48B" counts the ct||tag portion (exactly mirroring §2/§15.1 `KPHOTO_WRAPPED_LEN 48 = 32 ct + 16 tag`). IMPLEMENTED: 60 bytes; server enforces 60.
- **D3 [INFERENCE — §3]** The literal HKDF info string for K_data is not spelled out (it is for K_wrap/K_c2u/AUTH_*). Following `info = "clock-v4/<domain>"`: `clock-v4/K_data`, `clock-v4/AUTH_UI`, `clock-v4/AUTH_CLOCK` (the latter two are explicit in §3).
- **D4 [SPEC CONFLICT — §3 vs §8]** §8 requires AUTH on `GET /config`, but §3's unlock flow needs `/config` BEFORE any key exists (AUTH_UI is derived FROM AES1 which is wrapped INSIDE config). Resolution: `/config` stays authenticated (keeps L3 intact — anonymous peers get nothing); the web client provisions AUTH_UI once via a setup link (`?setup=<hex64>` — the browser analogue of the clock's "setup channel" NVS provisioning). Flagged to the user in the final report.
- **D5 [EXTENSION]** PoC web writer uses event-id prefix `w:` (§13 defines `d:`=DAVx5, `t:`=trudido for the phone forks). Additive; ownership rules enforced verbatim.
- **D6 [ADDITION]** CORS allowlist layer (spec targets native clients; a browser UI on GitHub Pages needs it). Allowed origin: `https://sh-clock.github.io`. Preflight OPTIONS is exempt from the bearer gate (browsers never send Authorization on preflight); disallowed origins receive NO CORS headers → the browser itself enforces the silent drop. No cookies are used → no CSRF surface.
- **D7 [DECISION]** Bootstrap enforces `iters == 100000` (§2 KDF_ITERS is protocol law, visible in clear).
- **D8 [DECISION]** New-row PUT accepts any `ver >= 1` (u32): §19's restore drill must PUT verbatim envelopes with preserved `ver` values onto a fresh server.
- **D9 [DECISION]** Row id length cap 256 chars (server-visible size cap; §21 rationale: caps that map to real budgets).
- **D10 [DECISION]** `config.ver` increments on rewrap (GET /config returns `{"ver":N}`; rewrap returns `200 {}` per §8).
- **D11 [DECISION]** rewrap / GET /config against a not-yet-bootstrapped server → `404 {"error":"not_found"}` (§5 authenticated-but-missing).
- **D12 [LAYOUT]** D1 backup writes are performed inside the DO (`POST /internal/backup`, gated by INTERNAL_TOKEN — a server-internal capability handle). The Worker's scheduled handler (cron `0 3 * * *`) triggers it. Verified locally; fallback documented if D1-in-DO were unsupported.
- **D13 [SERVER SECRETS]** ADMIN_SECRET and INTERNAL_TOKEN are generated as 64-char lowercase hex (uniform bearer format → strict hex64 parsing + constant-time compare for every token class).
- **D14 [SPEC CLARIFICATION — §9 rebase detection]** When `incoming.ver == stored.ver`, the returned envelope has the same `ver` as submitted, so `ver` alone cannot distinguish accept from rebase. Client-side resolution: compare the **returned envelope identity** (nonce+ct echo) with the submitted one — nonce is fresh-random per write, so identity match proves acceptance. Implemented in the web client; server behaviour is exactly per spec text.
- **D15 [AUTH MODEL]** Three route families: admin routes (`/bootstrap`, `/bootstrap/rewrap` — only ADMIN_SECRET authenticates; anything else, including valid app tokens, is "wrong-secret /bootstrap" → empty 404 per §4); app routes (config/version/status/rows — only AUTH_UI/AUTH_CLOCK authenticate; within them, PUT/DELETE rows require the UI class → `403` empty body per §5 "capability violation, e.g. clock writing rows"); internal routes (`/internal/backup` — only INTERNAL_TOKEN; invisible to everyone else).
- **D16 [CONTENT-BLINDNESS]** Server enforces only: `ct <= 64KiB`, `nonce == 12B`, `ver` u32 ≥ 1, strict base64/hex formats, body ≤ 1MiB hygiene cap. No minimum ct length, no content inspection (L1).

---

## Project State

- **Status:** Local verification ALL GREEN (workerd). Parallel audit wave in progress.
- **Repo:** /home/z/my-project/calendar-web (git main; pushes to sh-clock/Calendar-Web)
- **Worker name:** `calendar-poc` → https://calendar-poc.sh-clock.workers.dev
- **Test password (user-designated):** `password` — PBKDF2-HMAC-SHA256, 100000 iters.
- **Final AES1:** dummy key generated at final bootstrap; delivered to user in the final report (never committed to the repo).

## Build & Verification Log

| Date | Phase | Result |
|------|-------|--------|
| 2026-10-30 | Local workerd suite (`npm run test:local`) | core-unit 71/71; api-suite 94/94; §19 cron trigger OK; D1 backup verified (rows + config_backup for today); 7-day retention prune verified. |

### Bugs found & fixed during local verification (each cross-checked — verdicts recorded)

1. `[ORCH] [BLOCKER] worker/src/store.js` — the §19 staging sweep statement was placed in the **D1** batch (`DELETE FROM staged …`) although `staged` is a **DO-SQLite** table → `D1_ERROR: no such table: staged`. Evidence: /tmp/wrangler-dev2.log. **VERDICT: CONFIRMED → FIXED** (sweep now runs on `ctx.storage.sql`).
2. `[ORCH] [BLOCKER] cli/bootstrap.mjs` — Node crypto mirror `encryptRow`/`decryptRow` never called `setAAD(rowAad(id, ver))`: the §6 AAD binding was absent from the entire Node test path (the browser `js/crypto.js` was correct). Detected by test `e3b` (replayed envelope at wrong ver decrypted successfully). **VERDICT: CONFIRMED → FIXED** (setAAD in both functions).
3. `[ORCH] [MAJOR] test/run-local.mjs` — `d1Query` declared `async` (but synchronous via spawnSync) and called without `await` → results were Promises → the stale-row check always evaluated to `-1`. **VERDICT: CONFIRMED → FIXED** (function made synchronous).
4. `[ORCH] [MINOR] test/api-suite.mjs r18b` — the "unpadded base64" test constructed `"...==".slice(0,-1) + "="`, which is byte-identical to the original valid string; the server response (200) was CORRECT. **VERDICT: FALSE POSITIVE (server) → test fixed** (strips all `=` padding).

<!-- AGENT-A1-FINDINGS -->
<!-- AGENT-A2-FINDINGS -->
<!-- AGENT-A3-FINDINGS -->
<!-- AGENT-A4-FINDINGS -->

## Change Log

| Date | Author | Change |
|------|--------|--------|
| 2026-10-30 | Main orchestrator | WORKLOG created; commandments embedded verbatim. |
| 2026-10-30 | Main orchestrator | Task received; environment verified (CF account, D1 created, GH repo state); scope decisions D1–D16 recorded. |
| 2026-10-30 | Main orchestrator | Worker + web client + CLI + tests written; local workerd suite ALL GREEN after fixing findings 1–3 and correcting false positive 4. |
