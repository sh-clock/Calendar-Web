# Calendar-Web — encrypted calendar PoC

End-to-end-encrypted **calendar** (the calendar feature of PROTOCOL v4.1 —
Encrypted Clock Ecosystem — plus the **v4.2 calendar delta**), built as a
Proof of Concept:

- **Server**: Cloudflare Worker + Durable Object (SQLite, primary storage) +
  D1 (daily backup). The server stores **opaque encrypted envelopes** only —
  it never sees plaintext (L1: untrusted relay). The v4.2 change server-side
  is exactly the §22 version string: `evt:`/`cmeta:` rows are ordinary
  opaque rows on the same store.
- **Client**: static web app (GitHub Pages; UI modeled on Proton Calendar,
  see `docs/PROVENANCE.md`). Cryptography is native WebCrypto:
  PBKDF2-HMAC-SHA256 (100 000 iterations) → AES-256-GCM → HKDF-SHA256
  subkeys. Rows are encrypted with AAD binding row id + version.
- **Data model (v4.2)**: per-event rows carry full RFC 5545 iCalendar
  (recurring events, exceptions, reminders, all-day, multi-day);
  per-calendar metadata rows; the v4.1 §13 day buckets are a derived
  projection for the clock. RRULE expansion uses the vendored
  `rrule.js` 2.8.1 (`js/vendor/`, BSD-3-Clause).

```
PASSWORD --PBKDF2--> KEK --unwrap--> AES1 --HKDF--> K_data, AUTH_UI, AUTH_CLOCK
rows: AES-256-GCM(K_data, nonce, payload, AAD = id || u32be(ver))
```

## Layout

| Path | What |
| --- | --- |
| `index.html`, `js/`, `css/` | static web client (served by GitHub Pages) |
| `worker/` | Cloudflare Worker + Durable Object (`wrangler deploy`) |
| `cli/bootstrap.mjs` | bootstrap CLI (generates material, PUTs /bootstrap) |
| `test/` | unit tests + full HTTP conformance suite + local orchestrator |
| `docs/PROTOCOL-v4.1.md` | the v4.1 base wire specification (verbatim) |
| `docs/PROTOCOL-v4.2.md` | the v4.2 calendar delta (evt/cmeta rows, §13b projection) |
| `docs/DEVIATIONS.md` | every spec deviation/interpretation, with reasoning |
| `docs/PROVENANCE.md` | GPL-3.0 port provenance (Proton WebClients, rrule.js) |
| `WORKLOG.MD` | shared coordination log (commandments, decisions, audits) |

## Running locally

```bash
npm install
cd worker && printf 'ADMIN_SECRET=%s\nINTERNAL_TOKEN=%s\nALLOWED_ORIGIN=https://sh-clock.github.io,http://localhost:8787\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .dev.vars && cd ..
npm run test:local   # starts real workerd, runs ALL suites, triggers the cron, verifies D1
```

(`ALLOWED_ORIGIN` is an exact-match list — include the production origin or
the CORS phases fail.)

## Deploying

```bash
cd worker && npx wrangler deploy            # uses CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
echo "<hex64>" | npx wrangler secret put ADMIN_SECRET
echo "<hex64>" | npx wrangler secret put INTERNAL_TOKEN
node cli/bootstrap.mjs --url https://<worker>.workers.dev --admin <hex64> --password <pw>
```

## PoC security disclaimer

The password is the designated test value `password` and the master key is a
dummy generated at bootstrap — **nothing here is production-secure** (by
explicit owner instruction). Credentials are delivered out-of-band and are
never committed to this repository.

## UI (v4.4): FullCalendar

The calendar view layer is [FullCalendar v6.1.22](https://github.com/fullcalendar/fullcalendar)
(MIT), vendored **verbatim** as the official prebuilt bundles
(`js/vendor/fullcalendar/` — core, daygrid, timegrid, interaction,
multimonth, list, each with its MIT licence). All rendering, drag & drop,
resizing, selection, "+N more" popovers, the now-indicator and the toolbar
are FullCalendar's own implementations, driven only through its documented
options. The protocol (v4.3), the worker, the crypto layer and the sync
engine are unchanged — see `protocol.md` and `docs/PROVENANCE.md`.

Theme and appearance customisation lives under the **Settings** menu
(top-right gear): light/dark/system theme, accent colour, first day of
week, 12/24-hour time, time-grid slot size, week numbers, density and the
custom-view day count — persisted per browser and applied live.
