// Bounded offline test orchestrator for the public Cashu recovery tooling.
//
// Test processes run under Node's permission model with network and subprocess
// access denied. Only this orchestrator spawns children, and it writes only
// inside one fresh 0700 run directory. No SDK, mint, provider, wallet, account,
// seed, fund or service action is performed. Caps: 1 GiB run data, 8 MiB logs,
// 120 s per command, 512 MiB V8 heap and a 50 GiB free-space floor.

import {spawnSync} from 'node:child_process';
import {chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, statfsSync, symlinkSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir, tmpdir} from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CAP_BYTES = 1024 ** 3;
const LOG_CAP = 8 * 1024 ** 2;
const FREE_FLOOR = 50 * 1024 ** 3;
const WALL_MS = 120000;

function fail(code, detail) {
  console.log(JSON.stringify({ok: false, error: {code}, ...(detail ? {detail} : {})}));
  process.exit(1);
}

let sdkEntry;
try { sdkEntry = realpathSync(fileURLToPath(import.meta.resolve('@cashu/cashu-ts'))); }
catch { fail('CASHU_SDK_UNAVAILABLE', 'install the pinned @cashu/cashu-ts package before running test:cashu'); }

const segments = sdkEntry.split(sep);
const modulesIndex = segments.lastIndexOf('node_modules');
if (modulesIndex < 0) fail('CASHU_SDK_UNAVAILABLE', 'the SDK was not resolved from node_modules');

function testParent() {
  const candidates = [process.env.CASHU_TEST_PARENT, join(homedir(), '.cache'), tmpdir()].filter(Boolean);
  for (const candidate of candidates) {
    mkdirSync(candidate, {recursive: true, mode: 0o700});
    const stat = statfsSync(candidate);
    if (Number(stat.bavail) * Number(stat.bsize) >= FREE_FLOOR) return candidate;
  }
  fail('FREE_SPACE_FLOOR', 'no candidate test volume has 50 GiB free');
}

const runDir = mkdtempSync(join(testParent(), 'quiet-ledger-cashu-tests-'));
chmodSync(runDir, 0o700);
const keep = process.argv.includes('--keep');

function directoryBytes(directory) {
  let total = 0;
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(path);
    else if (entry.isFile()) total += statSync(path).size;
  }
  return total;
}

function freeBytes() {
  const stat = statfsSync(runDir);
  return Number(stat.bavail) * Number(stat.bsize);
}

function enforceCaps() {
  if (freeBytes() < FREE_FLOOR) throw new Error('free-space floor violated');
  if (directoryBytes(runDir) > CAP_BYTES) throw new Error('run directory byte cap exceeded');
}

const permission = [
  '--permission',
  `--allow-fs-read=${ROOT}`,
  `--allow-fs-read=${segments.slice(0, modulesIndex + 1).join(sep)}`,
  `--allow-fs-read=${runDir}`,
  `--allow-fs-write=${runDir}`,
];
const baseEnv = {
  PATH: process.env.PATH,
  LANG: 'C.UTF-8',
  TZ: 'UTC',
  TMPDIR: runDir,
  NODE_OPTIONS: '--max-old-space-size=512',
  CI: '1',
};

function run(name, args, env = {}) {
  enforceCaps();
  const started = Date.now();
  const result = spawnSync(process.execPath, [...permission, ...args], {
    cwd: ROOT,
    env: {...baseEnv, ...env},
    timeout: WALL_MS,
    killSignal: 'SIGKILL',
    maxBuffer: LOG_CAP,
    encoding: 'utf8',
  });
  const elapsed = Date.now() - started;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const phase = {
    name,
    exitCode: result.status,
    signal: result.signal,
    elapsedMs: elapsed,
    outputBytes: Buffer.byteLength(output, 'utf8'),
    outputTail: output.slice(-4000),
  };
  if (result.error) phase.error = result.error.code ?? String(result.error);
  enforceCaps();
  if (phase.outputBytes > LOG_CAP) throw new Error(`${name}: output cap exceeded`);
  mkdirSync(join(runDir, 'logs'), {recursive: true, mode: 0o700});
  writeFileSync(join(runDir, 'logs', `${name}.log`), output, {mode: 0o600});
  console.log(JSON.stringify(phase));
  if (result.status !== 0) {
    console.log(output);
    throw new Error(`${name} failed`);
  }
  return output;
}

function tapCounts(output) {
  const pass = output.match(/^# pass (\d+)$/m) ?? output.match(/ℹ pass (\d+)/);
  const fail = output.match(/^# fail (\d+)$/m) ?? output.match(/ℹ fail (\d+)/);
  return {pass: pass ? Number(pass[1]) : null, fail: fail ? Number(fail[1]) : null};
}

function jsonTail(output) {
  const lines = output.trim().split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  throw new Error('phase did not print a JSON receipt');
}

const phases = [];
try {
  const cryptoDir = join(runDir, 'crypto');
  const appDir = join(runDir, 'app');
  const processDir = join(runDir, 'process');
  for (const dir of [cryptoDir, appDir, processDir]) mkdirSync(dir, {mode: 0o700});
  // Retained symlink regression fixture from the frozen qualification runner.
  writeFileSync(join(cryptoDir, 'fictional-target.txt'), 'fictional file preserved', {mode: 0o600});
  symlinkSync(join(cryptoDir, 'fictional-target.txt'), join(cryptoDir, 'fictional-linked.sqlite'));
  // Same reason: symlink creation needs unrestricted fs access, so the
  // orchestrator prepares these app-suite fixtures before the restricted run.
  writeFileSync(join(appDir, 'fictional-target.json'), '{"fictional":"target"}', {mode: 0o600});
  symlinkSync(join(appDir, 'fictional-target.json'), join(appDir, 'fictional-linked.json'));
  symlinkSync(join(appDir, 'fictional-target.json'), join(appDir, 'fictional-linked.key'));

  const crypto = run('crypto-native', [
    '--test', '--test-isolation=none',
    'tests/cashu/native/native.test.mjs',
    'tests/cashu/native/journal.test.mjs',
    'tests/cashu/native/adversarial.test.mjs',
    'tests/cashu/native/review-findings.test.mjs',
  ], {FIXTURE_RUN_DIR: cryptoDir});
  const cryptoCounts = tapCounts(crypto);
  if (cryptoCounts.fail !== 0 || cryptoCounts.pass !== 41) {
    throw new Error(`expected the 41 retained crypto and review checks to pass, got ${JSON.stringify(cryptoCounts)}`);
  }
  phases.push({name: 'crypto-native', ...cryptoCounts, outputBytes: Buffer.byteLength(crypto, 'utf8')});

  const app = run('recovery-app', [
    '--test', '--test-isolation=none',
    'tests/cashu/profile.test.mjs',
    'tests/cashu/transport.test.mjs',
    'tests/cashu/backup.test.mjs',
    'tests/cashu/backup-review.test.mjs',
    'tests/cashu/runtime.test.mjs',
    'tests/cashu/cli.test.mjs',
    'tests/cashu/review-integration.test.mjs',
  ], {CASHU_TEST_DIR: appDir, FIXTURE_RUN_DIR: appDir});
  const appCounts = tapCounts(app);
  if (appCounts.fail !== 0 || appCounts.pass !== 52) {
    throw new Error(`recovery app checks failed: ${JSON.stringify(appCounts)}`);
  }
  phases.push({name: 'recovery-app', ...appCounts, outputBytes: Buffer.byteLength(app, 'utf8')});

  const denied = jsonTail(run('network-child-denied', ['tests/cashu/network-denied.mjs'],
    {CASHU_TEST_DIR: appDir, FIXTURE_RUN_DIR: appDir}));
  if (denied.ok !== true || denied.childDenied !== true || denied.networkCode !== 'NETWORK_ERROR') {
    throw new Error(`permission probe did not deny network and child processes: ${JSON.stringify(denied)}`);
  }
  phases.push({name: 'network-child-denied', ...denied});

  const processEnv = {CASHU_PROCESS_DIR: processDir};
  run('process-prepare', ['tests/cashu/process/prepare.mjs'], processEnv);
  run('process-restore', ['tests/cashu/process/restore.mjs'], processEnv);
  run('process-verify', ['tests/cashu/process/verify.mjs'], processEnv);
  const prepare = JSON.parse(readFileSync(join(processDir, 'prepare.json'), 'utf8'));
  const restore = JSON.parse(readFileSync(join(processDir, 'restore.json'), 'utf8'));
  const verify = JSON.parse(readFileSync(join(processDir, 'verify.json'), 'utf8'));
  if (prepare.state !== 'uncertain' || prepare.counts.results !== 0) throw new Error('prepare receipt is wrong');
  if (restore.state !== 'finalized' || restore.settlement !== 'restore' ||
      restore.originalRequestUnchanged !== true || restore.restoreAttempts !== 1 ||
      restore.counts.results !== 1 || restore.counts.outbox !== 1) throw new Error('restore receipt is wrong');
  if (verify.finalized !== true || verify.settlement !== 'restore' || verify.ledgerCredits !== 1 ||
      verify.redeliveredIdempotently !== true || verify.pendingAfterAck !== 0 ||
      verify.ackSurvivedAnotherProcess !== true || verify.sqliteIntegrity !== 'ok') {
    throw new Error('verify receipt is wrong');
  }
  phases.push({name: 'process-recovery', pids: [prepare.pid, restore.pid, verify.pid],
    settlement: verify.settlement, ledgerCredits: verify.ledgerCredits});

  const summary = {
    ok: true,
    sdk: '@cashu/cashu-ts@4.13.0',
    node: process.version,
    sdkEntry,
    permissions: 'Node permission model: network and child-process access denied in every test process',
    runDir,
    phases,
    observed: {
      bytes: directoryBytes(runDir),
      freeBytes: freeBytes(),
      maxOutputBytes: Math.max(...phases.map(phase => phase.outputBytes ?? 0), 0),
    },
    caps: {bytes: CAP_BYTES, logBytes: LOG_CAP, freeFloorBytes: FREE_FLOOR, wallMs: WALL_MS,
      heapBytes: 512 * 1024 ** 2},
  };
  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', {mode: 0o600});
  console.log(JSON.stringify(summary));
} catch (error) {
  process.exitCode = 1;
  console.log(JSON.stringify({ok: false, error: {code: 'TEST_PHASE_FAILED'}, message: String(error.message),
    runDir}));
} finally {
  if (!keep && process.exitCode !== 1) {
    try { rmSync(runDir, {recursive: true, force: true}); } catch {}
  } else if (process.exitCode === 1) {
    console.log(JSON.stringify({retainedRunDir: runDir}));
  }
}
