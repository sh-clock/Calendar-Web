// decrypt-local.mjs — decrypt LOCAL dev worker rows (read-only diagnostics).
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8787';
const mat = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const AUTH_UI = mat.auth_ui_hex;
const K_DATA = Uint8Array.from(Buffer.from(mat.k_data_hex, 'hex'));

const subtle = webcrypto.subtle;
const b64ToBytes = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
const u32be = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
const rowAad = (id, ver) => Buffer.concat([Buffer.from(id, 'utf8'), u32be(ver)]);
const key = await subtle.importKey('raw', K_DATA, 'AES-GCM', false, ['decrypt']);

const res = await fetch(BASE + '/rows', { headers: { authorization: 'Bearer ' + AUTH_UI } });
const manifest = await res.json();
for (const r of manifest.rows) {
  if (r.id.startsWith('cal:')) continue; // buckets: skip unless asked
  const rr = await fetch(BASE + '/rows/' + encodeURIComponent(r.id), { headers: { authorization: 'Bearer ' + AUTH_UI } });
  const env = await rr.json();
  let out;
  try {
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(env.nonce), additionalData: rowAad(r.id, r.ver) },
      key, b64ToBytes(env.ct)
    );
    out = Buffer.from(pt).toString('utf8');
  } catch (e) {
    out = '<DECRYPT FAILED: ' + e.message + '>';
  }
  console.log('=== ' + r.id + ' (ver ' + r.ver + ') ===');
  console.log(out);
  console.log();
}
