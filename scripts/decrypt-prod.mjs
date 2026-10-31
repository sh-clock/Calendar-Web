// decrypt-prod.mjs — decrypt production row envelopes with the retained PoC
// dummy key (k_data). READ-ONLY diagnostics; never writes.
// Usage: node scripts/decrypt-prod.mjs [rowId ...]   (no args = all rows)
import { webcrypto } from 'node:crypto';

const BASE = 'https://calendar-poc.sh-clock.workers.dev';
const AUTH_UI = '*SCRUBBED*<=';
const K_DATA = Uint8Array.from(Buffer.from('*SCRUBBED*<=', 'hex'));

const subtle = webcrypto.subtle;
const b64ToBytes = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
const u32be = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
const rowAad = (id, ver) => { const idB = Buffer.from(id, 'utf8'); return Buffer.concat([idB, u32be(ver)]); };

const key = await subtle.importKey('raw', K_DATA, 'AES-GCM', false, ['decrypt']);

async function main() {
  const wanted = process.argv.slice(2);
  const res = await fetch(BASE + '/rows', { headers: { authorization: 'Bearer ' + AUTH_UI } });
  const manifest = await res.json();
  for (const r of manifest.rows) {
    if (wanted.length && !wanted.includes(r.id)) continue;
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
    console.log(out.length > 1200 ? out.slice(0, 1200) + ' …[truncated]' : out);
    console.log();
  }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
