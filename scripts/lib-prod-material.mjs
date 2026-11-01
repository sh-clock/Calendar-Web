// lib-prod-material.mjs — loads the operator's deployment material for the
// prod helper scripts WITHOUT ever embedding it in the repo (sec-S7-F1:
// the live K_data + AUTH_UI used to be committed here — full read/write
// compromise of the deployment, anonymously fetchable from the public repo).
//
// Resolution order:
//   1. CALENDAR_SECRETS env var (explicit path)
//   2. /home/z/my-project/.secrets/credentials.json (the operator's layout)
//   3. <repo>/.secrets/credentials.json
// The file is the cli/bootstrap.mjs --out JSON (mode 0600, git-ignored).
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveSecretsPath() {
  const candidates = [
    process.env.CALENDAR_SECRETS,
    '/home/z/my-project/.secrets/credentials.json',
    path.join(ROOT, '.secrets', 'credentials.json'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    'prod material not found — pass --out material from `node cli/bootstrap.mjs` and point ' +
    'CALENDAR_SECRETS at it (the credentials file is NEVER committed; see sec-S7-F1).'
  );
}

const raw = JSON.parse(readFileSync(resolveSecretsPath(), 'utf8'));

function need(field) {
  const v = raw[field];
  if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) {
    throw new Error('secrets file lacks a valid 64-hex "' + field + '" — re-run cli/bootstrap.mjs --out');
  }
  return v;
}

export const SERVER = (raw.server || 'https://calendar-poc.sh-clock.workers.dev').replace(/\/+$/, '');
export const AUTH_UI = need('auth_ui_hex');
export const AUTH_CLOCK = raw.auth_clock_hex && /^[0-9a-f]{64}$/.test(raw.auth_clock_hex) ? raw.auth_clock_hex : null;
export const K_DATA = Uint8Array.from(Buffer.from(need('k_data_hex'), 'hex'));
export const AES1 = raw.aes1_hex && /^[0-9a-f]{64}$/.test(raw.aes1_hex) ? Uint8Array.from(Buffer.from(raw.aes1_hex, 'hex')) : null;
export const ITERS = Number(raw.iters) || 100000;
