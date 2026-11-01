#!/usr/bin/env node
/** S8: raw CONNECT probes against local stack (8787). */
import { readFileSync } from 'node:fs';
import net from 'node:net';
const MAT = JSON.parse(readFileSync('/tmp/local-material.json', 'utf8'));
const UI = MAT.auth_ui_hex;
const raw = (port, payload, timeoutMs = 8000) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  const chunks = [];
  let done = false;
  const fin = () => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(Buffer.concat(chunks)); } };
  s.setTimeout(timeoutMs, fin);
  s.on('connect', () => s.write(payload));
  s.on('data', (d) => chunks.push(d));
  s.on('error', fin);
  s.on('close', fin);
});
const show = async (label, req) => {
  const r = await raw(8787, req);
  console.log('=== ' + label + ' ===');
  console.log(JSON.stringify(r.toString('latin1')));
};
await show('CONNECT /version valid token',
  'CONNECT /version HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ' + UI + '\r\nConnection: close\r\n\r\n');
await show('CONNECT /nope no token',
  'CONNECT /nope HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
await show('CONNECT host:443 form no token',
  'CONNECT calendar-poc.sh-clock.workers.dev:443 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
