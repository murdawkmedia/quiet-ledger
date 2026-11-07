#!/usr/bin/env node
// Offline Cashu receive-journal recovery CLI.
//
// Read-only by default: `status`, `inspect` and `profile` never contact a mint.
// `check` and `restore` are preflight-only unless the operator passes an
// explicit `--apply`, an exact mint confirmation and bounded transport limits.
// No command creates a seed, counter, output, wallet, invoice credit or
// background worker, and no command prints proofs, secrets, blinding factors,
// request bodies or key material.

import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {canonicalMintUrl} from '../server/cashu/cashu-journal.mjs';
import {createBoundedHttpsTransport} from '../server/cashu/transport.mjs';
import {
  redactedProfileMetadata, readProfileFile, readStorageKeyFile,
} from '../server/cashu/profile.mjs';
import {createCashuRecoveryRuntime, safeErrorCode} from '../server/cashu/runtime.mjs';
import {createJournalBackup, restoreJournalBackup} from '../server/cashu/backup.mjs';

const COMMANDS = new Set(['status', 'inspect', 'check', 'restore', 'backup', 'restore-backup', 'profile', 'help']);
const VALUE_FLAGS = new Set(['--profile', '--storage-key', '--operation', '--out', '--in', '--mint',
  '--timeout-ms', '--max-response-bytes']);
const BOOLEAN_FLAGS = new Set(['--apply', '--json']);
const SDK_EXPORTS = ['Mint', 'Wallet', 'KeyChain', 'deriveKeysetId', 'verifyMintSignatures',
  'hashToCurve', 'normalizeMintUrl', 'pointFromHex', 'serializeSwapPreview', 'deserializeSwapPreview'];

const USAGE = Object.freeze([
  'node ops/cashu-recovery.mjs <command> [options]',
  'commands: status (default), inspect, check, restore, profile, backup, restore-backup',
  'read-only: status, inspect, profile — never contact a mint; no apply flag',
  'preflight: check|restore --operation <id> without --apply prints local eligibility only',
  'apply: check|restore --operation <id> --apply --mint <exact https mint> [--timeout-ms N] [--max-response-bytes N]',
  'backup --out <file> --apply',
  'restore-backup --in <file> --out <file> --apply',
  'required: --profile <0600 profile.json> and --storage-key <0600 32-byte key> (except restore-backup/profile)',
]);

class CliError extends Error {
  constructor(code, message = code, cause) {
    super(`${code}: ${message}`, cause ? {cause} : undefined);
    this.name = 'CliError';
    this.code = code;
  }
}

function parse(argv) {
  const options = {apply: false};
  const values = new Map();
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (typeof token !== 'string' || !token.length) throw new CliError('INVALID_ARGUMENT');
    if (!token.startsWith('--')) { positionals.push(token); continue; }
    if (BOOLEAN_FLAGS.has(token)) {
      if (values.has(token)) throw new CliError('DUPLICATE_FLAG', token);
      values.set(token, true);
      if (token === '--apply') options.apply = true;
      continue;
    }
    if (!VALUE_FLAGS.has(token)) throw new CliError('UNKNOWN_FLAG', token);
    if (values.has(token)) throw new CliError('DUPLICATE_FLAG', token);
    const value = argv[++index];
    if (typeof value !== 'string' || !value.length || value.startsWith('--')) {
      throw new CliError('MISSING_FLAG_VALUE', token);
    }
    values.set(token, value);
  }
  if (positionals.length > 1) throw new CliError('UNEXPECTED_ARGUMENT');
  const command = positionals[0] ?? 'status';
  if (!COMMANDS.has(command)) throw new CliError('UNKNOWN_COMMAND');
  const value = name => values.get(name) ?? null;
  return {
    command,
    apply: options.apply,
    profile: value('--profile'),
    storageKey: value('--storage-key'),
    operation: value('--operation'),
    out: value('--out'),
    in: value('--in'),
    mint: value('--mint'),
    timeoutMs: value('--timeout-ms') == null ? undefined : Number(value('--timeout-ms')),
    maxResponseBytes: value('--max-response-bytes') == null ? undefined : Number(value('--max-response-bytes')),
  };
}

function requireFlag(value, code) {
  if (!value) throw new CliError(code);
  return value;
}

function boundedInteger(value, {label, min, max, fallback}) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new CliError('INVALID_TRANSPORT_LIMIT', `${label} must be ${min}..${max}`);
  }
  return value;
}

function validateShape(options) {
  const {command} = options;
  if (command === 'help') return;
  if (command === 'profile') {
    requireFlag(options.profile, 'PROFILE_REQUIRED');
    if (options.apply) throw new CliError('APPLY_NOT_SUPPORTED');
    return;
  }
  if (command === 'restore-backup') {
    if (!options.apply) throw new CliError('APPLY_REQUIRED');
    requireFlag(options.storageKey, 'STORAGE_KEY_REQUIRED');
    requireFlag(options.in, 'INPUT_REQUIRED');
    requireFlag(options.out, 'OUTPUT_REQUIRED');
    if (options.operation || options.mint || options.timeoutMs !== undefined || options.maxResponseBytes !== undefined) {
      throw new CliError('INVALID_OPTION_FOR_COMMAND');
    }
    return;
  }
  requireFlag(options.profile, 'PROFILE_REQUIRED');
  requireFlag(options.storageKey, 'STORAGE_KEY_REQUIRED');
  if (command === 'status') {
    if (options.apply || options.operation || options.out || options.in || options.mint) {
      throw new CliError('INVALID_OPTION_FOR_COMMAND');
    }
    return;
  }
  if (command === 'inspect') {
    requireFlag(options.operation, 'OPERATION_REQUIRED');
    if (options.apply || options.out || options.in || options.mint || options.timeoutMs !== undefined ||
        options.maxResponseBytes !== undefined) throw new CliError('INVALID_OPTION_FOR_COMMAND');
    return;
  }
  if (command === 'check' || command === 'restore') {
    requireFlag(options.operation, 'OPERATION_REQUIRED');
    if (options.out || options.in) throw new CliError('INVALID_OPTION_FOR_COMMAND');
    if (options.apply) requireFlag(options.mint, 'MINT_CONFIRMATION_REQUIRED');
    else if (options.mint || options.timeoutMs !== undefined || options.maxResponseBytes !== undefined) {
      throw new CliError('INVALID_OPTION_FOR_COMMAND');
    }
    return;
  }
  if (command === 'backup') {
    requireFlag(options.out, 'OUTPUT_REQUIRED');
    if (!options.apply) throw new CliError('APPLY_REQUIRED');
    if (options.operation || options.in || options.mint || options.timeoutMs !== undefined ||
        options.maxResponseBytes !== undefined) throw new CliError('INVALID_OPTION_FOR_COMMAND');
  }
}

async function loadSdk() {
  let module;
  try { module = await import('@cashu/cashu-ts'); }
  catch { throw new CliError('CASHU_SDK_UNAVAILABLE', 'the pinned @cashu/cashu-ts package is not installed'); }
  for (const name of SDK_EXPORTS) {
    if (typeof module[name] !== 'function') throw new CliError('CASHU_SDK_INCOMPLETE');
  }
  return module;
}

function readInputs(options, {needProfile = true} = {}) {
  const profile = needProfile ? readProfileFile(options.profile) : null;
  const key = readStorageKeyFile(options.storageKey);
  return {profile, key};
}

async function execute(options, {transportFactory, fetchImpl}) {
  if (options.command === 'help') return {ok: true, command: 'help', usage: [...USAGE]};
  validateShape(options);
  if (options.command === 'profile') {
    return {ok: true, command: 'profile', profile: redactedProfileMetadata(readProfileFile(options.profile))};
  }
  if (options.command === 'restore-backup') {
    const key = readStorageKeyFile(options.storageKey);
    try {
      const sdk = await loadSdk();
      const restored = restoreJournalBackup({sdk, backupPath: options.in, destination: options.out, storageKey: key});
      return {ok: true, command: 'restore-backup', applied: true, restored};
    } finally { key.fill(0); }
  }

  const {profile, key} = readInputs(options, {needProfile: options.command !== 'restore-backup'});
  let runtime = null;
  try {
    const sdk = await loadSdk();
    if (options.command === 'backup') {
      const backup = await createJournalBackup({sdk, profile, storageKey: key, out: options.out});
      return {ok: true, command: 'backup', applied: true, profile: redactedProfileMetadata(profile),
        backup: {file: backup.file, manifest: backup.manifest, sha256: backup.sha256, bytes: backup.bytes,
          counts: backup.counts, createdAt: backup.createdAt}};
    }
    runtime = createCashuRecoveryRuntime({sdk, profile, storageKey: key});
    const metadata = runtime.profile;
    if (options.command === 'status') {
      return {ok: true, command: 'status', profile: metadata,
        journal: {counts: runtime.counts(), integrity: runtime.integrity()}};
    }
    if (options.command === 'inspect') {
      return {ok: true, command: 'inspect', profile: metadata, operation: runtime.inspect(options.operation)};
    }
    const mode = options.command;
    const preflight = runtime.preflight(options.operation, mode);
    if (!options.apply) {
      return {ok: true, command: mode, applied: false, profile: metadata, preflight};
    }
    if (!preflight.eligible) {
      if (preflight.reason === 'ALREADY_FINALIZED') {
        const outcome = await runtime.restore(options.operation, {apply: false});
        return {ok: true, command: mode, applied: false, profile: metadata, reason: 'ALREADY_FINALIZED',
          operation: outcome.operation};
      }
      throw new CliError(preflight.reason);
    }
    const expected = canonicalMintUrl(sdk, options.mint);
    const configured = canonicalMintUrl(sdk, profile.mint);
    if (expected !== configured) throw new CliError('MINT_CONFIRMATION_MISMATCH');
    const timeoutMs = boundedInteger(options.timeoutMs, {label: 'timeout', min: 1000, max: 30000,
      fallback: 15000});
    const maxResponseBytes = boundedInteger(options.maxResponseBytes, {label: 'response size',
      min: 1024, max: 1048576, fallback: 262144});
    const factory = transportFactory ?? createBoundedHttpsTransport;
    const transport = factory({mintUrl: profile.mint, timeoutMs, maxResponseBytes, fetchImpl});
    if (typeof transport !== 'function') throw new CliError('INVALID_TRANSPORT');
    if (mode === 'restore') {
      const result = await runtime.restore(options.operation, {apply: true, transport});
      return {ok: true, command: 'restore', applied: true, profile: metadata,
        operation: result.operation, outboxPending: result.pending};
    }
    const result = await runtime.check(options.operation, {apply: true, transport});
    return {ok: true, command: 'check', applied: true, profile: metadata,
      states: result.states, operation: result.operation};
  } finally {
    runtime?.close();
    key.fill(0);
  }
}

export async function runCli(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const write = value => stdout.write(JSON.stringify(value) + '\n');
  try {
    const parsed = parse(Array.isArray(argv) ? argv : []);
    const result = await execute(parsed, {transportFactory: options.transportFactory, fetchImpl: options.fetchImpl});
    write(result);
    return 0;
  } catch (error) {
    write({ok: false, error: {code: safeErrorCode(error)}});
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
