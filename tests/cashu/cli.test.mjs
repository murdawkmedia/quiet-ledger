import assert from 'node:assert/strict';
import {test} from 'node:test';
import {join} from 'node:path';
import {existsSync, readFileSync} from 'node:fs';
import {runCli} from '../../ops/cashu-recovery.mjs';
import {mintUrl} from './fixtures.mjs';
import {
  capture, newDir, storageKey, makeKeyset, profileObject, writeProfile, writeKey, prepareUncertain,
  assertSafePayload,
} from './helpers.mjs';

const PUBLISHED_INPUT_SECRETS = [
  '407915bc212be61a77e3e6d2aeb4c727980bda51cd06a6afc29e2861768a7837',
  'fe15109314e61d7756b0f8ee0f23a624acaa3f4e042f61433c728c7057b931be',
];

async function fixture(name) {
  const dir = newDir(name);
  const key = storageKey();
  const keyset = makeKeyset();
  const journalPath = join(dir, 'journal.sqlite');
  const prepared = await prepareUncertain({journalPath, key, keyset});
  const profile = profileObject({journalPath, keyset});
  const profilePath = writeProfile(dir, profile);
  const keyPath = writeKey(dir, key);
  return {dir, key, keyset, journalPath, mint: prepared.mint, profile, profilePath, keyPath};
}

async function cli(args, options = {}) {
  const output = capture();
  const status = await runCli(args, {stdout: output.stdout, ...options});
  return {status, output, json: output.json(), text: output.text()};
}

test('argument validation fails closed and never echoes input', async () => {
  for (const [args, expected] of [
    [[], 'PROFILE_REQUIRED'],
    [['unknown-command'], 'UNKNOWN_COMMAND'],
    [['status', '--profile', '/tmp/a', '--storage-key', '/tmp/b', '--bogus', 'x'], 'UNKNOWN_FLAG'],
    [['status', '--profile', '/tmp/a', '--profile', '/tmp/b'], 'DUPLICATE_FLAG'],
    [['status', '--profile'], 'MISSING_FLAG_VALUE'],
    [['status', 'extra'], 'UNEXPECTED_ARGUMENT'],
    [['help', 'extra', 'extra2'], 'UNEXPECTED_ARGUMENT'],
    [['inspect', '--profile', '/tmp/a', '--storage-key', '/tmp/b'], 'OPERATION_REQUIRED'],
    [['backup', '--profile', '/tmp/a', '--storage-key', '/tmp/b', '--out', '/tmp/c'], 'APPLY_REQUIRED'],
  ]) {
    const {status, json, text} = await cli(args);
    assert.equal(status, 1);
    assert.deepEqual(json, {ok: false, error: {code: expected}});
    assert.equal(text.includes('/tmp/a'), false);
  }
  const help = await cli(['help']);
  assert.equal(help.status, 0);
  assert.equal(help.json.ok, true);
  assert.equal(help.json.command, 'help');
  assert.equal(help.json.usage.length > 3, true);
});

test('read-only commands never construct a transport and expose only safe fields', async () => {
  const f = await fixture('cli-readonly');
  let factoryCalls = 0;
  const transportFactory = () => { factoryCalls++; throw new Error('must not be called'); };
  const status = await cli(['status', '--profile', f.profilePath, '--storage-key', f.keyPath], {transportFactory});
  assert.equal(status.status, 0);
  assert.equal(status.json.journal.counts.operations, 1);
  assert.equal(status.json.journal.integrity, 'ok');
  assertSafePayload(status.json, {secrets: PUBLISHED_INPUT_SECRETS, keys: [f.key.toString('hex')]});

  const inspect = await cli(['inspect', '--profile', f.profilePath, '--storage-key', f.keyPath,
    '--operation', 'fictional-recovery-op'], {transportFactory});
  assert.equal(inspect.status, 0);
  assert.equal(inspect.json.operation.state, 'uncertain');
  assertSafePayload(inspect.json, {secrets: PUBLISHED_INPUT_SECRETS, keys: [f.key.toString('hex')]});
  assert.equal(factoryCalls, 0);

  const profile = await cli(['profile', '--profile', f.profilePath]);
  assert.equal(profile.status, 0);
  assert.equal(profile.json.profile.mintHost, 'quiet-ledger.invalid');
  assertSafePayload(profile.json);

  const applyReadOnly = await cli(['profile', '--profile', f.profilePath, '--apply']);
  assert.deepEqual(applyReadOnly.json, {ok: false, error: {code: 'APPLY_NOT_SUPPORTED'}});
  const preflight = await cli(['restore', '--profile', f.profilePath, '--storage-key', f.keyPath,
    '--operation', 'fictional-recovery-op'], {transportFactory});
  assert.equal(preflight.status, 0);
  assert.equal(preflight.json.applied, false);
  assert.equal(preflight.json.preflight.eligible, true);
  assert.equal(factoryCalls, 0);
});

test('apply requires an exact mint confirmation and bounded options', async () => {
  const f = await fixture('cli-apply-gates');
  let factoryCalls = 0;
  const transportFactory = () => { factoryCalls++; return () => { throw new Error('no transport'); }; };
  let result = await cli(['restore', '--profile', f.profilePath, '--storage-key', f.keyPath,
    '--operation', 'fictional-recovery-op', '--apply'], {transportFactory});
  assert.deepEqual(result.json, {ok: false, error: {code: 'MINT_CONFIRMATION_REQUIRED'}});
  result = await cli(['restore', '--profile', f.profilePath, '--storage-key', f.keyPath,
    '--operation', 'fictional-recovery-op', '--apply', '--mint', 'https://other.invalid'], {transportFactory});
  assert.deepEqual(result.json, {ok: false, error: {code: 'MINT_CONFIRMATION_MISMATCH'}});
  result = await cli(['restore', '--profile', f.profilePath, '--storage-key', f.keyPath,
    '--operation', 'fictional-recovery-op', '--apply', '--mint', mintUrl, '--timeout-ms', '999999'], {transportFactory});
  assert.deepEqual(result.json, {ok: false, error: {code: 'INVALID_TRANSPORT_LIMIT'}});
  result = await cli(['restore', '--profile', f.profilePath, '--storage-key', f.keyPath,
    '--operation', 'fictional-recovery-op', '--apply', '--mint', mintUrl, '--max-response-bytes', '1048577'], {transportFactory});
  assert.deepEqual(result.json, {ok: false, error: {code: 'INVALID_TRANSPORT_LIMIT'}});
  assert.equal(factoryCalls, 0);
});

test('explicit apply restores once through an injected bounded transport', async () => {
  const f = await fixture('cli-restore');
  let factoryCalls = 0;
  const transportFactory = options => {
    factoryCalls++;
    assert.equal(options.mintUrl, mintUrl);
    assert.equal(options.timeoutMs, 1000);
    assert.equal(options.maxResponseBytes, 1024);
    return args => f.mint.restore(args);
  };
  const args = ['restore', '--profile', f.profilePath, '--storage-key', f.keyPath,
    '--operation', 'fictional-recovery-op', '--apply', '--mint', mintUrl,
    '--timeout-ms', '1000', '--max-response-bytes', '1024'];
  const first = await cli(args, {transportFactory});
  assert.equal(first.status, 0);
  assert.equal(first.json.applied, true);
  assert.equal(first.json.operation.settlement, 'restore');
  assert.equal(first.json.operation.proofCount, 2);
  assert.equal(first.json.outboxPending, 1);
  assertSafePayload(first.json, {secrets: PUBLISHED_INPUT_SECRETS, keys: [f.key.toString('hex')]});
  assert.equal(factoryCalls, 1);

  const second = await cli(args, {transportFactory});
  assert.equal(second.status, 0);
  assert.equal(second.json.applied, false);
  assert.equal(second.json.reason, 'ALREADY_FINALIZED');
  assert.equal(second.json.operation.settlement, 'restore');
  assert.equal(factoryCalls, 1);
});

test('check apply records states without creating value', async () => {
  const f = await fixture('cli-check');
  let factoryCalls = 0;
  const transportFactory = () => { factoryCalls++; return args => f.mint.check(args); };
  const result = await cli(['check', '--profile', f.profilePath, '--storage-key', f.keyPath,
    '--operation', 'fictional-recovery-op', '--apply', '--mint', mintUrl], {transportFactory});
  assert.equal(result.status, 0);
  assert.deepEqual(result.json.states, {unspent: 0, pending: 0, spent: 2});
  assert.equal(result.json.operation.state, 'uncertain');
  assert.equal(result.json.operation.observationCount, 2);
  assert.equal(factoryCalls, 1);
  const status = await cli(['status', '--profile', f.profilePath, '--storage-key', f.keyPath]);
  assert.equal(status.json.journal.counts.results, 0);
  assert.equal(status.json.journal.counts.outbox, 0);
});

test('backup and restore-backup are explicit, key-separated and non-overwriting', async () => {
  const f = await fixture('cli-backup');
  const out = join(f.dir, 'backup.sqlite');
  const noApply = await cli(['backup', '--profile', f.profilePath, '--storage-key', f.keyPath, '--out', out]);
  assert.deepEqual(noApply.json, {ok: false, error: {code: 'APPLY_REQUIRED'}});
  assert.equal(existsSync(out), false);

  const backup = await cli(['backup', '--profile', f.profilePath, '--storage-key', f.keyPath,
    '--out', out, '--apply']);
  assert.equal(backup.status, 0);
  assert.equal(backup.json.backup.bytes > 0, true);
  assertSafePayload(backup.json, {keys: [f.key.toString('hex')]});
  assert.equal(readFileSync(out + '.manifest.json', 'utf8').includes(f.key.toString('hex')), false);

  const destination = join(f.dir, 'restored.sqlite');
  const noRestoreApply=await cli(['restore-backup','--storage-key',f.keyPath,'--in',out,'--out',destination]);
  assert.deepEqual(noRestoreApply.json,{ok:false,error:{code:'APPLY_REQUIRED'}});
  assert.equal(existsSync(destination),false);
  const wrongKeyPath = writeKey(f.dir, storageKey(Buffer.alloc(32, 201)), 'wrong.key');
  const wrong = await cli(['restore-backup', '--storage-key', wrongKeyPath, '--in', out,
    '--out', destination, '--apply']);
  assert.deepEqual(wrong.json, {ok: false, error: {code: 'BACKUP_AUTH_FAILED'}});
  assert.equal(existsSync(destination), false);

  const restored = await cli(['restore-backup', '--storage-key', f.keyPath, '--in', out,
    '--out', destination, '--apply']);
  assert.equal(restored.status, 0);
  assert.equal(restored.json.restored.destination, destination);
  assert.equal(restored.json.restored.counts.operations, 1);
  assertSafePayload(restored.json, {keys: [f.key.toString('hex')]});

  const again = await cli(['restore-backup', '--storage-key', f.keyPath, '--in', out,
    '--out', destination, '--apply']);
  assert.deepEqual(again.json, {ok: false, error: {code: 'PATH_EXISTS'}});
});

test('wrong storage-key files, missing journals and prepared operations are safe failures', async () => {
  const f = await fixture('cli-errors');
  const shortKey = writeKey(f.dir, Buffer.alloc(31, 1), 'short.key');
  const short = await cli(['status', '--profile', f.profilePath, '--storage-key', shortKey]);
  assert.deepEqual(short.json, {ok: false, error: {code: 'UNSAFE_FILE'}});

  const wrong = await cli(['status', '--profile', f.profilePath, '--storage-key',
    writeKey(f.dir, storageKey(Buffer.alloc(32, 202)), 'other.key')]);
  assert.deepEqual(wrong.json, {ok: false, error: {code: 'WRONG_STORAGE_KEY'}});

  const missingProfile = join(f.dir, 'missing-profile.json');
  const missing = await cli(['status', '--profile', missingProfile, '--storage-key', f.keyPath]);
  assert.deepEqual(missing.json, {ok: false, error: {code: 'FILE_NOT_FOUND'}});
});
