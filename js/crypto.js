/**
 * crypto.js — client-side cryptography for PROTOCOL v4.1 (calendar scope).
 *
 * Key hierarchy (§3):
 *   PASSWORD --PBKDF2-HMAC-SHA256(salt, 100000)--> KEK
 *   KEK --AES-256-GCM unwrap--> AES1 (32B master, from config.wrapped, 60B:
 *        12B nonce || 32B ct || 16B tag — see WORKLOG D2)
 *   AES1 --HKDF-SHA256(salt="", info="clock-v4/<domain>")--> subkeys
 *
 * Rows (§6): AES-256-GCM under K_data with AAD = ASCII(id) || u32be(ver).
 *
 * Everything uses the native WebCrypto implementation (Commandment 15:
 * efficiency — no hand-rolled primitives). HKDF salt is an EXPLICIT empty
 * buffer per §3 ("salt = \"\"", zero-length), not the RFC 5869 default.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const HEX_RE = /^[0-9a-f]*$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/* ---------------- encoding helpers (chunk-safe) ---------------- */

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !HEX_RE.test(hex)) {
    throw new Error('bad_hex');
  }
  const u8 = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u8.length; i++) u8[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return u8;
}

export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** Strict base64 decode (standard alphabet, padded — §5). */
export function b64ToBytes(str) {
  if (typeof str !== 'string' || str.length === 0 || str.length % 4 !== 0 || !B64_RE.test(str)) {
    throw new Error('bad_base64');
  }
  const pad = str.indexOf('=');
  if (pad !== -1 && pad < str.length - 2) throw new Error('bad_base64');
  const bin = atob(str);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export function bytesToB64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
  }
  return btoa(s);
}

/** Big-endian u32 — used in the §6 AAD (ASCII(id) || u32be(ver)). */
export function u32be(n) {
  if (!Number.isInteger(n) || n < 0 || n > 4294967295) throw new Error('bad_u32');
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

/* ---------------- key hierarchy (§3) ---------------- */

/** HKDF-SHA256(ikm, salt="", info) -> 32 bytes. */
async function hkdf(ikm, info) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: textEncoder.encode(info) },
      key,
      256
    )
  );
}

/**
 * Full unlock derivation (§3): password -> KEK -> AES1 -> subkeys.
 * Throws Error('unlock_failed') on a wrong password (GCM tag mismatch).
 */
export async function deriveKeys(password, saltHex, iters, wrappedB64) {
  const salt = hexToBytes(saltHex);
  const wrapped = b64ToBytes(wrappedB64);
  if (wrapped.length !== 60) {
    throw new Error('bad_config: wrapped must be 60 bytes (WORKLOG D2)');
  }

  const pwKey = await crypto.subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const kekBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iters },
    pwKey,
    256
  );
  const kek = await crypto.subtle.importKey('raw', kekBits, 'AES-GCM', false, ['decrypt']);

  let aes1;
  try {
    aes1 = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: wrapped.slice(0, 12) }, kek, wrapped.slice(12))
    );
  } catch {
    throw new Error('unlock_failed');
  }
  if (aes1.length !== 32) throw new Error('bad_config: aes1 length');

  const kData = await hkdf(aes1, 'clock-v4/K_data');        // WORKLOG D3
  const authUi = await hkdf(aes1, 'clock-v4/AUTH_UI');      // §3
  return { aes1, kData, authUiHex: bytesToHex(authUi) };
}

/* ---------------- row envelope crypto (§6) ---------------- */

export async function importRowKey(kData) {
  return crypto.subtle.importKey('raw', kData, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** AAD = ASCII(id) || u32be(ver) — binds ciphertext to row identity AND version. */
export function rowAad(id, ver) {
  const idB = textEncoder.encode(id);
  const out = new Uint8Array(idB.length + 4);
  out.set(idB, 0);
  out.set(u32be(ver), idB.length);
  return out;
}

/** Encrypt a payload object; returns {nonce, ct} base64 (fresh 12B nonce). */
export async function encryptRow(rowKey, id, ver, payload) {
  const nonce = crypto.getRandomValues(new Uint8Array(12)); // fresh per write (§6)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: rowAad(id, ver) },
      rowKey,
      textEncoder.encode(JSON.stringify(payload))
    )
  );
  return { nonce: bytesToB64(nonce), ct: bytesToB64(ct) };
}

/** Decrypt a row envelope; throws on tamper / AAD mismatch (rollback defense §6). */
export async function decryptRow(rowKey, id, ver, nonceB64, ctB64) {
  const pt = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: b64ToBytes(nonceB64),
      additionalData: rowAad(id, ver),
    },
    rowKey,
    b64ToBytes(ctB64)
  );
  return JSON.parse(textDecoder.decode(pt));
}
