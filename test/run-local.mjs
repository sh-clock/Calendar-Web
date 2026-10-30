#!/usr/bin/env node
/**
 * run-local.mjs — full local verification against REAL workerd (the actual
 * open-source Cloudflare Workers runtime, via `wrangler dev`):
 *
 *   1. port pre-flight (a stale workerd must never mask the suite)
 *   2. unit tests + crypto-parity suite + full API conformance suite
 *   3. §19 backup: wipe today's D1 snapshot -> trigger the /__scheduled cron
 *      -> POLL D1 -> verify exact row count, per-row byte fidelity (nonce/ct
 *      BLOBs vs the live GET envelopes), and config_backup content
 *   4. §19 retention prune of stale days
 *   5. §19 RESTORE DRILL: force-bootstrap FRESH material, PUT every D1
 *      snapshot envelope verbatim (ver preserved — D8), then decrypt with the
 *      ORIGINAL K_data to prove byte-level restorability
 *
 * Usage: node test/run-local.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBootstrapMaterial,
  deriveClientKeys,
  decryptRow,
} from '../cli/bootstrap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'worker');
const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const MATERIAL = '/tmp/calendar-poc-material.json';

let failures = 0;
function ok(name, cond, detail) {
  if (cond) {
    console.log('  ok  ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + String(detail) : ''));
  }
}

function parseDevVars() {
  const txt = fs.readFileSync(path.join(WORKER, '.dev.vars'), 'utf8');
  const out = {};
  for (const line of txt.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function wranglerBin() {
  const p = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (fs.existsSync(p)) return { cmd: process.execPath, args: [p] };
  return { cmd: 'npx', args: ['wrangler'] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function portAnswers() {
  try {
    await fetch(BASE + '/version', { method: 'GET' });
    return true;
  } catch {
    return false;
  }
}

async function waitReady(timeoutMs = 90000) {
  const t0 = Date.now();
  for (;;) {
    if (await portAnswers()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(500);
  }
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', ...opts });
}

function d1Query(sql) {
  const { cmd, args } = wranglerBin();
  const res = spawnSync(cmd, [...args, 'd1', 'execute', 'BACKUP', '--local', '--json', '--command', sql], {
    cwd: WORKER,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', WRANGLER_SEND_ANALYTICS: 'false' },
  });
  if (res.status !== 0) throw new Error('d1 execute failed: ' + res.stderr);
  const out = res.stdout;
  const i = out.indexOf('[');
  if (i < 0) throw new Error('no JSON array in d1 output: ' + out.slice(0, 300));
  const lines = out.slice(i).split('\n');
  for (let end = lines.length; end > 0; end--) {
    const cand = lines.slice(0, end).join('\n').trim();
    try {
      return JSON.parse(cand);
    } catch {}
  }
  throw new Error('cannot parse d1 JSON output');
}

/** Poll D1 until the predicate holds (replaces fixed sleeps). */
async function pollD1(sql, predicate, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    const rows = d1Query(sql);
    if (predicate(rows)) return rows;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(500);
  }
}

const b64 = (b) => Buffer.from(b).toString('base64');

function dayOffset(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

async function api(method, p, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}

async function main() {
  const dev = parseDevVars();
  if (!dev.ADMIN_SECRET || !dev.INTERNAL_TOKEN) throw new Error('.dev.vars missing secrets');

  // 0. Port pre-flight: a stale workerd on :8787 would let the suite run
  // against OLD code and pass vacuously. Kill it or die loudly.
  if (await portAnswers()) {
    console.log('== port :8787 busy — killing stale wrangler/workerd processes ==');
    try {
      run('pkill', ['-f', 'wrangler dev']);
      run('pkill', ['-f', 'workerd']);
    } catch {}
    await sleep(2500);
    if (await portAnswers()) throw new Error('port :8787 still busy after killing stale processes');
  }

  // Assert the cron trigger is wired in the config (§19).
  const wranglerCfg = fs.readFileSync(path.join(WORKER, 'wrangler.jsonc'), 'utf8');
  ok('cron trigger "0 3 * * *" present in wrangler.jsonc', wranglerCfg.includes('"0 3 * * *"'));

  console.log('== starting wrangler dev (workerd) on :' + PORT + ' ==');
  const { cmd, args } = wranglerBin();
  const child = spawn(cmd, [...args, 'dev', '--port', String(PORT), '--test-scheduled'], {
    cwd: WORKER,
    env: { ...process.env, CI: 'true', WRANGLER_SEND_ANALYTICS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logPath = '/tmp/wrangler-dev.log';
  const log = fs.createWriteStream(logPath, { flags: 'w' });
  child.stdout.pipe(log);
  child.stderr.pipe(log);

  try {
    const ready = await waitReady();
    if (!ready) throw new Error('wrangler dev did not become ready (see ' + logPath + ')');
    ok('workerd dev server became ready', child.exitCode === null);
    console.log('== workerd ready ==');

    console.log('\n== unit tests (calendar-core) ==');
    if (run(process.execPath, [path.join(ROOT, 'test/core-unit.mjs')]).status !== 0) failures++;

    console.log('\n== crypto-parity suite (browser module vs Node mirror vs KATs) ==');
    if (run(process.execPath, [path.join(ROOT, 'test/crypto-parity.mjs')]).status !== 0) failures++;

    console.log('\n== API conformance suite ==');
    const apiSuite = run(
      process.execPath,
      [path.join(ROOT, 'test/api-suite.mjs'), '--url', BASE, '--material-out', MATERIAL],
      {
        env: {
          ...process.env,
          BASE_URL: BASE,
          ADMIN_SECRET: dev.ADMIN_SECRET,
          INTERNAL_TOKEN: dev.INTERNAL_TOKEN,
        },
      }
    );
    if (apiSuite.status !== 0) failures++;

    const MAT = JSON.parse(fs.readFileSync(MATERIAL, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);

    console.log('\n== §19 backup: isolate, trigger cron, verify byte fidelity ==');
    // Isolation: wipe today's snapshot so only the cron run can re-create it.
    d1Query(`DELETE FROM backup WHERE day = '${today}'`);
    d1Query(`DELETE FROM config_backup WHERE day = '${today}'`);

    const sched = await fetch(`${BASE}/__scheduled?cron=0+3+*+*+*`);
    const schedText = await sched.text();
    ok('__scheduled trigger -> 200', sched.status === 200, sched.status + ' ' + schedText);

    const manifest = await api('GET', '/rows', { token: MAT.auth_ui_hex });
    const expectedRows = manifest.json.rows.length;
    console.log(`   manifest rows: ${expectedRows}`);

    const rows = await pollD1(
      `SELECT id, ver, hex(nonce) AS nonce_hex, hex(ct) AS ct_hex FROM backup WHERE day = '${today}'`,
      (r) => (r[0]?.results || []).length === expectedRows
    );
    const d1rows = rows ? rows[0].results : [];
    ok(`cron wrote exactly ${expectedRows} backup rows for today`, d1rows.length === expectedRows, d1rows.length);

    // Per-row byte fidelity: D1 BLOBs must equal the live GET envelopes.
    let fidelity = true;
    const details = [];
    for (const r of d1rows) {
      const g = await api('GET', '/rows/' + encodeURIComponent(r.id), { token: MAT.auth_ui_hex });
      const env = g.json;
      if (!env || env.ver !== r.ver) {
        fidelity = false;
        details.push(`${r.id}: ver ${env?.ver} != ${r.ver}`);
        continue;
      }
      if (Buffer.from(env.nonce, 'base64').toString('hex') !== r.nonce_hex.toLowerCase()) {
        fidelity = false;
        details.push(`${r.id}: nonce mismatch`);
      }
      if (Buffer.from(env.ct, 'base64').toString('hex') !== r.ct_hex.toLowerCase()) {
        fidelity = false;
        details.push(`${r.id}: ct mismatch`);
      }
    }
    ok('per-row D1 fidelity (ver + nonce/ct BLOBs byte-equal)', fidelity && d1rows.length > 0, details.join(' | '));

    const cfgBackup = d1Query(`SELECT salt, iters, hex(wrapped) AS wrapped_hex, auth_ui, auth_clock, ver FROM config_backup WHERE day = '${today}'`);
    const cb = (cfgBackup[0]?.results || [])[0];
    const liveCfg = (await api('GET', '/config', { token: MAT.auth_ui_hex })).json;
    ok(
      'config_backup content matches live config (clear params + private column)',
      !!cb &&
        cb.salt === liveCfg.salt &&
        cb.iters === liveCfg.iters &&
        cb.wrapped_hex.toLowerCase() === Buffer.from(liveCfg.wrapped, 'base64').toString('hex') &&
        cb.auth_ui === MAT.auth_ui_hex &&
        cb.auth_clock === MAT.auth_clock_hex &&
        cb.ver === liveCfg.ver,
      JSON.stringify(cb)
    );

    console.log('\n== §19 retention prune (7-day boundary) ==');
    // today-7 must be RETAINED (cutoff is exclusive); today-8 must be pruned.
    d1Query(`INSERT INTO backup (day, id, ver, nonce, ct) VALUES ('${dayOffset(7)}', 'boundary-keep', 1, x'00', x'00')`);
    d1Query(`INSERT INTO backup (day, id, ver, nonce, ct) VALUES ('${dayOffset(8)}', 'boundary-drop', 1, x'00', x'00')`);
    d1Query("INSERT INTO backup (day, id, ver, nonce, ct) VALUES ('2020-01-01', 'stale-row', 1, x'00', x'00')");
    const sched2 = await fetch(`${BASE}/__scheduled?cron=0+3+*+*+*`);
    const sched2Text = await sched2.text();
    ok('second __scheduled trigger -> 200', sched2.status === 200, sched2.status + ' ' + sched2Text);
    const boundary = await pollD1(
      "SELECT (SELECT COUNT(*) FROM backup WHERE id = 'boundary-drop') AS dropped, (SELECT COUNT(*) FROM backup WHERE id = 'boundary-keep') AS kept",
      (r) => {
        const row = (r[0]?.results || [])[0];
        return !!row && row.dropped === 0;
      }
    );
    const brow = boundary ? (boundary[0]?.results || [])[0] : null;
    ok(
      'retention boundary: today-8 pruned, today-7 retained, stale swept',
      !!brow && brow.dropped === 0 && brow.kept === 1,
      JSON.stringify(brow)
    );

    console.log('\n== §19 RESTORE DRILL (M6 exit criterion) ==');
    // Fresh universe: force-bootstrap NEW material (different AES1), then PUT
    // every snapshot envelope VERBATIM with preserved vers (D8).
    const snapshot = d1rows.map((r) => ({ id: r.id, ver: r.ver, nonce_hex: r.nonce_hex, ct_hex: r.ct_hex }));
    const freshMat = buildBootstrapMaterial('restore-drill-password');
    const rb = await api('PUT', '/bootstrap', {
      token: dev.ADMIN_SECRET,
      body: {
        salt: freshMat.saltHex,
        iters: 100000,
        wrapped: freshMat.wrappedB64,
        auth_ui: freshMat.authUiHex,
        auth_clock: freshMat.authClockHex,
        force: true,
      },
    });
    ok('restore drill: fresh force-bootstrap', rb.status === 200 && rb.json?.ver === 1, rb.text);

    let restoreOk = true;
    const restoreDetails = [];
    for (const row of snapshot) {
      const pr = await api('PUT', '/rows/' + encodeURIComponent(row.id), {
        token: freshMat.authUiHex,
        body: { ver: row.ver, nonce: b64(Buffer.from(row.nonce_hex, 'hex')), ct: b64(Buffer.from(row.ct_hex, 'hex')) },
      });
      if (pr.status !== 200 || pr.json?.ver !== row.ver) {
        restoreOk = false;
        restoreDetails.push(`${row.id}: ${pr.status} ${pr.text}`);
        continue;
      }
      // Byte-identical echo?
      if (pr.json.nonce !== b64(Buffer.from(row.nonce_hex, 'hex'))) {
        restoreOk = false;
        restoreDetails.push(`${row.id}: envelope echo mismatch`);
      }
    }
    ok(`restore drill: ${snapshot.length} envelopes PUT verbatim (ver preserved)`, restoreOk, restoreDetails.join(' | '));

    // Decrypt the restored rows with the ORIGINAL K_data — proof that the D1
    // snapshot carries restorable bytes (state, per §19).
    const origK = Buffer.from(MAT.k_data_hex, 'hex');
    let decryptOk = true;
    for (const row of snapshot) {
      const g = await api('GET', '/rows/' + encodeURIComponent(row.id), { token: freshMat.authUiHex });
      try {
        const payload = decryptRow(origK, row.id, g.json.ver, g.json.nonce, g.json.ct);
        if (!payload || typeof payload !== 'object' || !Array.isArray(payload.events)) {
          decryptOk = false;
        }
      } catch (e) {
        decryptOk = false;
        restoreDetails.push(`${row.id}: ${e.message}`);
      }
    }
    ok('restore drill: all restored rows decrypt under the ORIGINAL K_data', decryptOk && snapshot.length > 0, restoreDetails.join(' | '));

    // Restore the suite's universe so subsequent runs start from a sane state.
    const restoreBack = await api('PUT', '/bootstrap', {
      token: dev.ADMIN_SECRET,
      body: {
        salt: MAT.salt,
        iters: 100000,
        wrapped: MAT.wrapped_b64,
        auth_ui: MAT.auth_ui_hex,
        auth_clock: MAT.auth_clock_hex,
        force: true,
      },
    });
    ok('post-drill: re-bootstrapped back to the suite universe', restoreBack.status === 200, restoreBack.text);
    const backCfg = (await api('GET', '/config', { token: MAT.auth_ui_hex })).json;
    const backManifest = (await api('GET', '/rows', { token: MAT.auth_ui_hex })).json;
    ok(
      'post-drill: config + empty manifest verified',
      backCfg.salt === MAT.salt &&
        backCfg.wrapped === MAT.wrapped_b64 &&
        backCfg.ver === 1 &&
        Array.isArray(backManifest.rows) &&
        backManifest.rows.length === 0,
      JSON.stringify(backCfg)
    );
  } finally {
    // The material file carries test tokens — remove it after the run.
    try {
      fs.rmSync(MATERIAL, { force: true });
    } catch {}
    console.log('\n== stopping wrangler dev ==');
    child.kill('SIGTERM');
    await sleep(1500);
    try {
      if (child.exitCode === null) child.kill('SIGKILL');
    } catch {}
    try {
      run('pkill', ['-f', 'wrangler dev']);
      run('pkill', ['-f', 'workerd']);
    } catch {}
  }

  console.log(`\nrun-local: ${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'} (dev log: ${logPath})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL: ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
