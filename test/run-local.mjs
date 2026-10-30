#!/usr/bin/env node
/**
 * run-local.mjs — full local verification against REAL workerd (the actual
 * open-source Cloudflare Workers runtime, via `wrangler dev`), including the
 * DO (SQLite), local D1, the /__scheduled cron trigger, and D1 backup
 * retention (§19).
 *
 * Usage: node test/run-local.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'worker');
const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;

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

async function waitReady(timeoutMs = 90000) {
  const t0 = Date.now();
  for (;;) {
    try {
      await fetch(BASE + '/version', { method: 'GET' });
      return true; // any HTTP response (incl. 404) means workerd is up
    } catch {
      if (Date.now() - t0 > timeoutMs) return false;
      await sleep(500);
    }
  }
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', ...opts });
}

function d1Query(sql) { // synchronous by design (spawnSync); must NOT be async —
  // call sites rely on the returned array directly.
  const { cmd, args } = wranglerBin();
  const res = spawnSync(cmd, [...args, 'd1', 'execute', 'BACKUP', '--local', '--json', '--command', sql], {
    cwd: WORKER,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', WRANGLER_SEND_ANALYTICS: 'false' },
  });
  if (res.status !== 0) throw new Error('d1 execute failed: ' + res.stderr);
  // wrangler --json prints an array of {results, success, meta} objects,
  // possibly with log lines around it — parse defensively.
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

async function main() {
  const dev = parseDevVars();
  if (!dev.ADMIN_SECRET || !dev.INTERNAL_TOKEN) throw new Error('.dev.vars missing secrets');

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

  let failures = 0;
  try {
    const ready = await waitReady();
    if (!ready) throw new Error('wrangler dev did not become ready (see ' + logPath + ')');
    console.log('== workerd ready ==');

    console.log('\n== unit tests (calendar-core) ==');
    if (run(process.execPath, [path.join(ROOT, 'test/core-unit.mjs')]).status !== 0) failures++;

    console.log('\n== API conformance suite ==');
    const api = run(process.execPath, [path.join(ROOT, 'test/api-suite.mjs'), '--url', BASE], {
      env: {
        ...process.env,
        BASE_URL: BASE,
        ADMIN_SECRET: dev.ADMIN_SECRET,
        INTERNAL_TOKEN: dev.INTERNAL_TOKEN,
      },
    });
    if (api.status !== 0) failures++;

    console.log('\n== §19 backup: trigger scheduled handler (cron 0 3 * * *) ==');
    const sched = await fetch(`${BASE}/__scheduled?cron=0+3+*+*+*`);
    const schedText = await sched.text();
    console.log('   __scheduled ->', sched.status, schedText.slice(0, 120));
    await sleep(1500); // let the DO backup complete

    console.log('\n== D1 verification (local) ==');
    let rows = d1Query('SELECT day, COUNT(*) AS n FROM backup GROUP BY day');
    const today = new Date().toISOString().slice(0, 10);
    let backupToday = 0;
    for (const r of rows[0]?.results || []) if (r.day === today) backupToday = r.n;
    console.log('   backup rows for today:', backupToday);
    if (backupToday < 1) {
      console.error('   FAIL: no backup rows for today');
      failures++;
    }
    rows = d1Query('SELECT day FROM config_backup');
    const cfgDays = (rows[0]?.results || []).map((r) => r.day);
    console.log('   config_backup days:', cfgDays.join(','));
    if (!cfgDays.includes(today)) {
      console.error('   FAIL: config_backup missing today');
      failures++;
    }

    console.log('\n== D1 retention prune (§19: 7-day) ==');
    d1Query("INSERT INTO backup (day, id, ver, nonce, ct) VALUES ('2020-01-01', 'stale-row', 1, x'00', x'00')");
    const sched2 = await fetch(`${BASE}/__scheduled?cron=0+3+*+*+*`);
    await sched2.text();
    await sleep(1500);
    rows = d1Query("SELECT COUNT(*) AS n FROM backup WHERE day = '2020-01-01'");
    const stale = rows[0]?.results?.[0]?.n ?? -1;
    console.log('   stale day rows after sweep:', stale);
    if (stale !== 0) {
      console.error('   FAIL: retention prune did not remove the stale day');
      failures++;
    }
  } finally {
    console.log('\n== stopping wrangler dev ==');
    child.kill('SIGTERM');
    await sleep(1200);
    try {
      if (child.exitCode === null) child.kill('SIGKILL');
    } catch {}
  }

  console.log(`\nrun-local: ${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE GROUP(S)'} (dev log: ${logPath})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL: ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
