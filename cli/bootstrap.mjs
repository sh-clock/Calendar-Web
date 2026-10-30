#!/usr/bin/env node
/**
 * bootstrap.mjs — CLI bootstrap for the Calendar PoC (protocol v4.1, §8).
 *
 * "The CLI performs bootstrap; it generates salt, AES1, subkeys, AUTH_*" (§3).
 * Node native crypto ONLY (Commandment 15: PBKDF2 / HKDF / AES-256-GCM are all
 * native — nothing is hand-rolled).
 *
 * Material generated:
 *   salt    16 random bytes (hex32, clear in config)
 *   AES1    32 random bytes — THE master key (dummy key for this PoC, per user)
 *   KEK     PBKDF2-HMAC-SHA256(password, salt, 100000), 32B (transient)
 *   wrapped nonce(12) || AES-256-GCM(KEK, nonce, AES1) → ct(32) || tag(16)
 *           = 60 bytes (WORKLOG D2)
 *   AUTH_UI / AUTH_CLOCK = HKDF-SHA256(AES1, salt="", info="clock-v4/AUTH_UI" |
 *           "clock-v4/AUTH_CLOCK"), hex64 (§3 — tokens are DERIVED, not random)
 *
 * Usage:
 *   node cli/bootstrap.mjs --url https://calendar-poc.sh-clock.workers.dev \
 *       --admin <hex64> --password <pw> [--force] [--out secrets.json]
 */

import { randomBytes, pbkdf2Sync, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';

export const KDF_ITERS = 100000;
export const WRAPPED_LEN = 60;

const hex = (b) => Buffer.from(b).toString('hex');

/** HKDF-SHA256 subkey (§3): ikm=AES1, salt="" (explicit empty), info=domain. */
export function subkey(aes1, info) {
  return Buffer.from(hkdfSync('sha256', aes1, Buffer.alloc(0), Buffer.from(info, 'ascii'), 32));
}

/** Build all bootstrap material for a password. Returns Buffer/hex fields. */
export function buildBootstrapMaterial(password) {
  const salt = randomBytes(16);
  const aes1 = randomBytes(32); // dummy master key for the PoC (user-designated)
  const kek = pbkdf2Sync(Buffer.from(String(password), 'utf8'), salt, KDF_ITERS, 32, 'sha256');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, nonce);
  const ct = Buffer.concat([cipher.update(aes1), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrapped = Buffer.concat([nonce, ct, tag]);
  if (wrapped.length !== WRAPPED_LEN) throw new Error('wrapped_len');
  return {
    saltHex: hex(salt),
    iters: KDF_ITERS,
    wrappedB64: wrapped.toString('base64'),
    aes1,
    aes1Hex: hex(aes1),
    authUiHex: hex(subkey(aes1, 'clock-v4/AUTH_UI')),
    authClockHex: hex(subkey(aes1, 'clock-v4/AUTH_CLOCK')),
    kDataHex: hex(subkey(aes1, 'clock-v4/K_data')),
  };
}

/** Node mirror of the browser unlock path (used by the test suite + verification). */
export function deriveClientKeys(password, saltHex, iters, wrappedB64) {
  const salt = Buffer.from(saltHex, 'hex');
  const wrapped = Buffer.from(wrappedB64, 'base64');
  if (wrapped.length !== WRAPPED_LEN) throw new Error('bad_config: wrapped must be 60 bytes');
  const kek = pbkdf2Sync(Buffer.from(String(password), 'utf8'), salt, iters, 32, 'sha256');
  const d = createDecipheriv('aes-256-gcm', kek, wrapped.subarray(0, 12));
  d.setAuthTag(wrapped.subarray(44));
  const aes1 = Buffer.concat([d.update(wrapped.subarray(12, 44)), d.final()]); // throws on wrong password
  return {
    aes1,
    kData: subkey(aes1, 'clock-v4/K_data'),
    authUi: subkey(aes1, 'clock-v4/AUTH_UI'),
    authClock: subkey(aes1, 'clock-v4/AUTH_CLOCK'),
  };
}

/** Row crypto helpers (Node mirror of js/crypto.js — used by the test suite). */
export function rowAad(id, ver) {
  const idB = Buffer.from(id, 'ascii');
  const v = Buffer.alloc(4);
  v.writeUInt32BE(ver >>> 0, 0);
  return Buffer.concat([idB, v]);
}

export function encryptRow(kData, id, ver, payload) {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kData, nonce);
  c.setAAD(rowAad(id, ver)); // §6: AAD = ASCII(id) || u32be(ver)
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
  return { nonce: Buffer.concat([nonce]), ct: Buffer.concat([ct, c.getAuthTag()]) };
}

export function decryptRow(kData, id, ver, nonceB64, ctB64) {
  const nonce = Buffer.from(nonceB64, 'base64');
  const ctAndTag = Buffer.from(ctB64, 'base64');
  const d = createDecipheriv('aes-256-gcm', kData, nonce);
  d.setAAD(rowAad(id, ver)); // §6: binds ct to row identity AND version
  d.setAuthTag(ctAndTag.subarray(ctAndTag.length - 16));
  const pt = Buffer.concat([
    d.update(ctAndTag.subarray(0, ctAndTag.length - 16)),
    d.final(),
  ]);
  return JSON.parse(pt.toString('utf8'));
}

/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--admin') out.admin = argv[++i];
    else if (a === '--password') out.password = argv[++i];
    else if (a === '--force') out.force = true;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown_arg: ' + a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.url || !args.admin || !args.password) {
    console.log(
      'Usage: node cli/bootstrap.mjs --url <https://worker...> --admin <hex64> --password <pw> [--force] [--out file.json]'
    );
    process.exit(args.help ? 0 : 2);
  }
  if (!/^[0-9a-f]{64}$/.test(args.admin)) {
    console.error('ERROR: --admin must be 64 lowercase hex chars');
    process.exit(2);
  }

  const mat = buildBootstrapMaterial(args.password);

  // Self-verification before touching the server: the wrap must unwrap back to
  // AES1 under the SAME password (catches any material construction bug).
  const roundtrip = deriveClientKeys(args.password, mat.saltHex, mat.iters, mat.wrappedB64);
  if (!roundtrip.aes1.equals(mat.aes1)) {
    console.error('ERROR: self-verification failed (wrap/unwrap mismatch)');
    process.exit(1);
  }

  const res = await fetch(args.url.replace(/\/+$/, '') + '/bootstrap', {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + args.admin, 'content-type': 'application/json' },
    body: JSON.stringify({
      salt: mat.saltHex,
      iters: mat.iters,
      wrapped: mat.wrappedB64,
      auth_ui: mat.authUiHex,
      auth_clock: mat.authClockHex,
      ...(args.force ? { force: true } : {}),
    }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  if (res.status !== 200 || !body || body.ver !== 1) {
    console.error(`ERROR: bootstrap failed: HTTP ${res.status} ${text}`);
    process.exit(1);
  }

  // Verify the registered tokens actually authenticate (§8: server-readable
  // capability handles) and that GET /config returns exactly the clear params.
  const cfgRes = await fetch(args.url.replace(/\/+$/, '') + '/config', {
    headers: { authorization: 'Bearer ' + mat.authUiHex },
  });
  const cfg = await cfgRes.json().catch(() => null);
  if (cfgRes.status !== 200 || !cfg || cfg.salt !== mat.saltHex || cfg.wrapped !== mat.wrappedB64) {
    console.error('ERROR: post-bootstrap verification failed (GET /config mismatch)');
    process.exit(1);
  }
  const rowsRes = await fetch(args.url.replace(/\/+$/, '') + '/rows', {
    headers: { authorization: 'Bearer ' + mat.authClockHex },
  });
  const rows = await rowsRes.json().catch(() => null);
  if (rowsRes.status !== 200 || !rows || !Array.isArray(rows.rows)) {
    console.error('ERROR: post-bootstrap verification failed (GET /rows)');
    process.exit(1);
  }

  const report = {
    server: args.url.replace(/\/+$/, ''),
    note: 'PoC dummy credentials — NOT secure (test password, dummy AES key).',
    password_note: 'password is not stored here; it is the unlock password you supplied',
    salt: mat.saltHex,
    iters: mat.iters,
    wrapped_b64: mat.wrappedB64,
    aes1_hex: mat.aes1Hex,
    k_data_hex: mat.kDataHex,
    auth_ui_hex: mat.authUiHex,
    auth_clock_hex: mat.authClockHex,
    config_ver: cfg.ver,
  };
  const out = JSON.stringify(report, null, 2);
  if (args.out) {
    const fs = await import('node:fs');
    fs.writeFileSync(args.out, out + '\n', { mode: 0o600 });
    console.error('Credentials written to ' + args.out + ' (mode 0600, not for committing)');
  }
  console.log(out);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('ERROR: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  });
}
