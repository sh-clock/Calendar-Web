#!/usr/bin/env node
/** S8: minimal universe bootstrap (replaces api-suite for probe runs; with retries). */
import { writeFileSync } from 'node:fs';
import { buildBootstrapMaterial } from '/home/z/my-project/calendar-web/cli/bootstrap.mjs';

const ADMIN = process.env.ADMIN_SECRET;
async function call(url, method, path, body, tok) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url + path, {
        method,
        headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, text };
    } catch (e) {
      console.log('retry ' + method + ' ' + path + ' (' + String(e && e.cause ? e.cause.code : e).slice(0, 40) + ')');
      await new Promise(res => setTimeout(res, 800));
    }
  }
  throw new Error('bootstrap call failed: ' + method + ' ' + path);
}

for (const [url, matOut] of [['http://127.0.0.1:8787', '/tmp/local-material.json'], ['http://127.0.0.1:8788', '/tmp/local-material-2.json']]) {
  const MAT = buildBootstrapMaterial('password', 100000);
  const b = await call(url, 'PUT', '/bootstrap', {
    salt: MAT.saltHex, iters: 100000, wrapped: MAT.wrappedB64,
    auth_ui: MAT.authUiHex, auth_clock: MAT.authClockHex, force: true,
  }, ADMIN);
  if (b.status !== 200) throw new Error('bootstrap failed ' + b.status + ' ' + b.text);
  writeFileSync(matOut, JSON.stringify({
    server: url, salt: MAT.saltHex, iters: 100000, wrapped_b64: MAT.wrappedB64,
    aes1_hex: MAT.aes1Hex, k_data_hex: MAT.kDataHex,
    auth_ui_hex: MAT.authUiHex, auth_clock_hex: MAT.authClockHex,
  }, null, 2) + '\n', { mode: 0o600 });
  console.log('bootstrapped ' + url + ' -> ' + matOut);
}
