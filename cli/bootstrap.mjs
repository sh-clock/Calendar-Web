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

// sec-S7-F2: default KDF cost for NEW universes is 600 000 (OWASP 2023+
// guidance for PBKDF2-HMAC-SHA256; ~80 ms native). The server accepts a
// 100 000..10 000 000 range (100k floor = anti-downgrade wall), so older
// 100k universes keep working and re-wraps can raise the cost in place.
export const KDF_ITERS = 600000;
export const KDF_ITERS_MIN = 100000; // must match worker/src/store.js §2
export const KDF_ITERS_MAX = 10000000;
export const WRAPPED_LEN = 60;

const hex = (b) => Buffer.from(b).toString('hex');

const B64_STRICT_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX_STRICT_RE = /^[0-9a-f]+$/;

/** Strict base64 decode (standard alphabet, padded, canonical) — mirrors the
 *  browser's b64ToBytes and the server's b64Decode (§5). Node's built-in
 *  Buffer.from(x,'base64') is LENIENT, so the mirror needs its own decoder. */
export function strictB64(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0 || !B64_STRICT_RE.test(s)) {
    throw new Error('bad_base64');
  }
  const pad = s.indexOf('=');
  if (pad !== -1 && pad < s.length - 2) throw new Error('bad_base64');
  const b = Buffer.from(s, 'base64');
  if (b.toString('base64') !== s) throw new Error('bad_base64'); // canonical only
  return b;
}

/** Strict lowercase-hex decode of exactly `len` bytes. */
export function strictHex(s, len) {
  if (typeof s !== 'string' || s.length !== len * 2 || !HEX_STRICT_RE.test(s)) {
    throw new Error('bad_hex');
  }
  return Buffer.from(s, 'hex');
}

/** HKDF-SHA256 subkey (§3): ikm=AES1, salt="" (explicit empty), info=domain. */
export function subkey(aes1, info) {
  return Buffer.from(hkdfSync('sha256', aes1, Buffer.alloc(0), Buffer.from(info, 'ascii'), 32));
}

/** Wrap AES1 under KEK(password, salt, iters): nonce(12) || ct(32) || tag(16) = 60B (WORKLOG D2). */
export function wrapAes1(aes1, password, salt, iters = KDF_ITERS) {
  const kek = pbkdf2Sync(Buffer.from(String(password), 'utf8'), salt, iters, 32, 'sha256');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, nonce);
  const ct = Buffer.concat([cipher.update(aes1), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrapped = Buffer.concat([nonce, ct, tag]);
  if (wrapped.length !== WRAPPED_LEN) throw new Error('wrapped_len');
  return wrapped;
}

/** Build all bootstrap material for a password. Returns Buffer/hex fields.
 *  `iters` is overridable so the local test suites keep their fast 100k
 *  material (inside the server-accepted range) while real universes get
 *  the 600k default. */
export function buildBootstrapMaterial(password, iters = KDF_ITERS) {
  const salt = randomBytes(16);
  const aes1 = randomBytes(32); // dummy master key for the PoC (user-designated)
  const wrapped = wrapAes1(aes1, password, salt, iters);
  return {
    saltHex: hex(salt),
    iters,
    wrappedB64: wrapped.toString('base64'),
    aes1,
    aes1Hex: hex(aes1),
    authUiHex: hex(subkey(aes1, 'clock-v4/AUTH_UI')),
    authClockHex: hex(subkey(aes1, 'clock-v4/AUTH_CLOCK')),
    kDataHex: hex(subkey(aes1, 'clock-v4/K_data')),
  };
}

/** §20 Type A rotation material: the SAME AES1 re-wrapped under a NEW
 *  password with a fresh salt. AES1 never changes; no rows are touched. */
export function buildRewrapMaterial(aes1, newPassword, iters = KDF_ITERS) {
  const salt = randomBytes(16);
  const wrapped = wrapAes1(aes1, newPassword, salt, iters);
  return { saltHex: hex(salt), wrappedB64: wrapped.toString('base64'), iters };
}

/** Node mirror of the browser unlock path (used by the test suite + verification). */
export function deriveClientKeys(password, saltHex, iters, wrappedB64) {
  const salt = strictHex(saltHex, 16);
  if (!Number.isInteger(iters) || iters < 1 || iters > 10000000) throw new Error('bad_config: iters');
  const wrapped = strictB64(wrappedB64);
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
  if (!Number.isInteger(ver) || ver < 1 || ver > 4294967295) throw new Error('bad_ver');
  // UTF-8 bytes of the id — byte-identical to the browser's TextEncoder.
  // (§6 says "ASCII(id)"; every spec-conformant id is pure ASCII where
  // UTF-8 == ASCII. UTF-8 keeps the two implementations identical for ANY id.)
  const idB = Buffer.from(String(id), 'utf8');
  const v = Buffer.alloc(4);
  v.writeUInt32BE(ver, 0);
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
  const nonce = strictB64(nonceB64);
  const ctAndTag = strictB64(ctB64);
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
    else if (a === '--new-password') out.newPassword = argv[++i];
    else if (a === '--material') out.material = argv[++i];
    else if (a === '--force') out.force = true;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--rewrap') out.rewrap = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown_arg: ' + a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (
    args.help ||
    !args.url ||
    !args.admin ||
    !args.password ||
    (args.rewrap && (!args.newPassword || !args.material))
  ) {
    console.log(
      'Usage:\n' +
        '  bootstrap:  node cli/bootstrap.mjs --url <https://worker...> --admin <hex64> --password <pw> [--force] [--out file.json]\n' +
        '  Type A:     node cli/bootstrap.mjs --rewrap --url <...> --admin <hex64> --password <OLD> --new-password <NEW> --material credentials.json [--out file.json]'
    );
    process.exit(args.help ? 0 : 2);
  }
  if (!/^[0-9a-f]{64}$/.test(args.admin)) {
    console.error('ERROR: --admin must be 64 lowercase hex chars');
    process.exit(2);
  }
  if (args.rewrap) return rewrapMain(args);

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

/** §20 Type A rotation via PUT /bootstrap/rewrap: the SAME AES1 is re-wrapped
 *  under the new password with a fresh salt. Rows, staged and the private
 *  column (AUTH tokens are HKDF(AES1) — unchanged) are untouched.
 *  Requires the credentials JSON produced by the original bootstrap. */
async function rewrapMain(args) {
  const fs = await import('node:fs');
  const stored = JSON.parse(fs.readFileSync(args.material, 'utf8'));
  const aes1 = strictHex(stored.aes1_hex, 32);

  // Verify the OLD password really unwraps the stored AES1 before rotating.
  const oldKeys = deriveClientKeys(
    args.password,
    stored.salt,
    stored.iters ?? KDF_ITERS,
    stored.wrapped_b64
  );
  if (!oldKeys.aes1.equals(aes1)) {
    console.error('ERROR: old password does not unwrap the AES1 in --material');
    process.exit(1);
  }

  const re = buildRewrapMaterial(aes1, args.newPassword, KDF_ITERS);
  const url = args.url.replace(/\/+$/, '');
  // sec-S7-F2: the rotation also carries the KDF cost (server range-checked)
  // so a Type-A rewrap can raise a 100k universe to 600k without a wipe.
  const res = await fetch(url + '/bootstrap/rewrap', {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + args.admin, 'content-type': 'application/json' },
    body: JSON.stringify({ wrapped: re.wrappedB64, salt: re.saltHex, iters: KDF_ITERS }),
  });
  const text = await res.text();
  if (res.status !== 200 || text !== '{}') {
    console.error(`ERROR: rewrap failed: HTTP ${res.status} ${text}`);
    process.exit(1);
  }

  // Verify: config reflects the new wrap, AUTH_UI (derived from the UNCHANGED
  // AES1) still authenticates, and the new password unwraps to the SAME AES1.
  const cfgRes = await fetch(url + '/config', {
    headers: { authorization: 'Bearer ' + stored.auth_ui_hex },
  });
  const cfg = await cfgRes.json().catch(() => null);
  if (cfgRes.status !== 200 || !cfg || cfg.wrapped !== re.wrappedB64 || cfg.salt !== re.saltHex || cfg.iters !== KDF_ITERS) {
    console.error('ERROR: post-rewrap verification failed (GET /config mismatch)');
    process.exit(1);
  }
  const newKeys = deriveClientKeys(args.newPassword, re.saltHex, KDF_ITERS, re.wrappedB64);
  if (!newKeys.aes1.equals(aes1)) {
    console.error('ERROR: invariant broken — AES1 changed across the rotation');
    process.exit(1);
  }

  const report = {
    server: url,
    note: 'Type A rotation complete: AES1 and AUTH tokens UNCHANGED; password + salt rotated.',
    salt: re.saltHex,
    iters: KDF_ITERS,
    wrapped_b64: re.wrappedB64,
    aes1_hex: stored.aes1_hex,
    k_data_hex: stored.k_data_hex,
    auth_ui_hex: stored.auth_ui_hex,
    auth_clock_hex: stored.auth_clock_hex,
    config_ver: cfg.ver,
  };
  const out = JSON.stringify(report, null, 2);
  if (args.out) {
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
