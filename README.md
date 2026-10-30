# Calendar-Web — encrypted calendar PoC

End-to-end-encrypted **calendar** (the calendar feature of "PROTOCOL v4.1 —
Encrypted Clock Ecosystem"), built as a Proof of Concept:

- **Server**: Cloudflare Worker + Durable Object (SQLite, primary storage) +
  D1 (daily backup). The server stores **opaque encrypted envelopes** only —
  it never sees plaintext (L1: untrusted relay).
- **Client**: dependency-free static web app (GitHub Pages). All cryptography
  is native WebCrypto: PBKDF2-HMAC-SHA256 (100 000 iterations) → AES-256-GCM
  → HKDF-SHA256 subkeys. Rows are encrypted with AAD binding row id + version.

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
| `docs/DEVIATIONS.md` | every spec deviation/interpretation, with reasoning |
| `WORKLOG.MD` | shared coordination log (commandments, decisions, audits) |

## Running locally

```bash
npm install
cd worker && printf 'ADMIN_SECRET=%s\nINTERNAL_TOKEN=%s\nALLOWED_ORIGIN=http://localhost:8787\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .dev.vars && cd ..
npm run test:local   # starts real workerd, runs ALL suites, triggers the cron, verifies D1
```

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
