import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createJournalBackup, restoreJournalBackup, MANIFEST_SUFFIX} from '../../server/cashu/backup.mjs';
import {CashuJournal} from '../../server/cashu/cashu-journal.mjs';
import {sdk} from './fixtures.mjs';
import {authentication} from './backup-auth-fixture.mjs';
import {
  newDir, storageKey, makeKeyset, profileObject, prepareUncertain, randomBytes,
} from './helpers.mjs';

const code = async (promise, expected) => assert.rejects(promise, error => error.code === expected);

function modes(path) {
  const stat = statSync(path);
  return stat.mode & 0o777;
}

async function source(dir, key) {
  const keyset = makeKeyset();
  const journalPath = join(dir, 'journal.sqlite');
  await prepareUncertain({journalPath, key, keyset});
  return {keyset, journalPath, profile: profileObject({journalPath, keyset})};
}

test('a consistent snapshot and manifest are private, hashed and free of key material', async () => {
  const dir = newDir('backup-create');
  const key = storageKey();
  const {journalPath, profile} = await source(dir, key);
  const out = join(dir, 'journal-backup.sqlite');
  const result = await createJournalBackup({sdk, profile, storageKey: key, out, createdAt: '2026-11-06T00:00:00.000Z'});
  assert.equal(result.file, out);
  assert.equal(result.manifest, out + MANIFEST_SUFFIX);
  assert.equal(modes(out), 0o600);
  assert.equal(modes(result.manifest), 0o600);
  assert.equal(result.bytes, statSync(out).size);
  assert.equal(result.counts.operations, 1);
  assert.equal(result.counts.reservations, 2);
  assert.equal(result.counts.results, 0);
  const manifest = JSON.parse(readFileSync(result.manifest, 'utf8'));
  assert.deepEqual(manifest, {
    format: 'quiet-ledger-cashu-journal-backup-v1',
    createdAt: '2026-11-06T00:00:00.000Z',
    sha256: result.sha256,
    bytes: result.bytes,
    counts: result.counts,
    authentication:authentication(manifest,key),
  });
  const manifestText = readFileSync(result.manifest, 'utf8');
  const backupText = readFileSync(out).toString('latin1');
  assert.equal(manifestText.includes(key.toString('hex')), false);
  assert.equal(backupText.includes(key.toString('hex')), false);
  assert.equal('proofs' in manifest, false);
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('.part-')), []);
  assert.equal(existsSync(journalPath), true);
});

test('restore authenticates the key and publishes an equivalent private journal', async () => {
  const dir = newDir('backup-restore');
  const key = storageKey();
  const {journalPath, profile, keyset} = await source(dir, key);
  const out = join(dir, 'journal-backup.sqlite');
  await createJournalBackup({sdk, profile, storageKey: key, out});
  const destination = join(dir, 'restored.sqlite');
  const restored = restoreJournalBackup({sdk, backupPath: out, destination, storageKey: key});
  assert.equal(restored.destination, destination);
  assert.equal(modes(destination), 0o600);
  assert.equal(restored.counts.operations, 1);
  assert.equal(restored.counts.reservations, 2);
  const journal = new CashuJournal(destination, key, sdk);
  try {
    assert.equal(journal.counts().operations, 1);
    assert.equal(journal.integrityCheck(), 'ok');
    const operation = journal.get('fictional-recovery-op');
    assert.equal(operation.state, 'uncertain');
    assert.equal(operation.keysetId, keyset.id);
  } finally { journal.close(); }
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('.restore-')), []);
  assert.equal(existsSync(journalPath), true);
});

test('a wrong storage key never publishes a destination and leaves no candidate', async () => {
  const dir = newDir('backup-wrong-key');
  const key = storageKey();
  const {profile} = await source(dir, key);
  const out = join(dir, 'journal-backup.sqlite');
  await createJournalBackup({sdk, profile, storageKey: key, out});
  const destination = join(dir, 'wrong-key.sqlite');
  await code(Promise.resolve().then(() => restoreJournalBackup({
    sdk, backupPath: out, destination, storageKey: storageKey(Buffer.alloc(32, 255)),
  })), 'BACKUP_AUTH_FAILED');
  assert.equal(existsSync(destination), false);
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('.restore-')), []);
  // The key cannot authenticate a fresh backup attempt either, and it creates nothing.
  const wrongOut = join(dir, 'wrong-key-backup.sqlite');
  await code(createJournalBackup({sdk, profile, storageKey: storageKey(Buffer.alloc(32, 254)), out: wrongOut}), 'WRONG_STORAGE_KEY');
  assert.equal(existsSync(wrongOut), false);
  assert.equal(existsSync(wrongOut + MANIFEST_SUFFIX), false);
});

test('corruption, truncation and tampered manifests fail before publishing', async () => {
  const dir = newDir('backup-corrupt');
  const key = storageKey();
  const {profile} = await source(dir, key);
  const out = join(dir, 'journal-backup.sqlite');
  await createJournalBackup({sdk, profile, storageKey: key, out});
  const bytes = readFileSync(out);
  const manifest = readFileSync(out + MANIFEST_SUFFIX);

  const corrupt = join(dir, 'corrupt.sqlite');
  const flipped = Buffer.from(bytes);
  flipped[Math.floor(flipped.length / 2)] ^= 0xff;
  writeFileSync(corrupt, flipped, {mode: 0o600});
  writeFileSync(corrupt + MANIFEST_SUFFIX, manifest, {mode: 0o600});
  await code(Promise.resolve().then(() => restoreJournalBackup({
    sdk, backupPath: corrupt, destination: join(dir, 'corrupt-out.sqlite'), storageKey: key,
  })), 'BACKUP_HASH_MISMATCH');

  const truncated = join(dir, 'truncated.sqlite');
  writeFileSync(truncated, bytes.subarray(0, 128), {mode: 0o600});
  writeFileSync(truncated + MANIFEST_SUFFIX, manifest, {mode: 0o600});
  await code(Promise.resolve().then(() => restoreJournalBackup({
    sdk, backupPath: truncated, destination: join(dir, 'truncated-out.sqlite'), storageKey: key,
  })), 'BACKUP_SIZE_MISMATCH');

  const tampered = join(dir, 'tampered.sqlite');
  copyFileSync(out, tampered);
  chmodSync(tampered, 0o600);
  const changed = JSON.parse(manifest.toString('utf8'));
  changed.sha256 = '0'.repeat(64);
  writeFileSync(tampered + MANIFEST_SUFFIX, JSON.stringify(changed), {mode: 0o600});
  await code(Promise.resolve().then(() => restoreJournalBackup({
    sdk, backupPath: tampered, destination: join(dir, 'tampered-out.sqlite'), storageKey: key,
  })), 'BACKUP_HASH_MISMATCH');

  const missing = join(dir, 'missing-manifest.sqlite');
  copyFileSync(out, missing);
  chmodSync(missing, 0o600);
  await code(Promise.resolve().then(() => restoreJournalBackup({
    sdk, backupPath: missing, destination: join(dir, 'missing-out.sqlite'), storageKey: key,
  })), 'BACKUP_MANIFEST_MISSING');

  for (const name of ['corrupt-out.sqlite', 'truncated-out.sqlite', 'tampered-out.sqlite', 'missing-out.sqlite']) {
    assert.equal(existsSync(join(dir, name)), false);
  }
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('.restore-')), []);
});

test('backup and restore never overwrite an existing path', async () => {
  const dir = newDir('backup-no-overwrite');
  const key = storageKey();
  const {profile} = await source(dir, key);
  const out = join(dir, 'journal-backup.sqlite');
  await createJournalBackup({sdk, profile, storageKey: key, out});
  const before = readFileSync(out);
  await code(createJournalBackup({sdk, profile, storageKey: key, out}), 'PATH_EXISTS');
  assert.deepEqual(readFileSync(out), before);
  const destination = join(dir, 'existing.sqlite');
  writeFileSync(destination, 'fictional existing file', {mode: 0o600});
  await code(Promise.resolve().then(() => restoreJournalBackup({
    sdk, backupPath: out, destination, storageKey: key,
  })), 'PATH_EXISTS');
  assert.equal(readFileSync(destination, 'utf8'), 'fictional existing file');
});

test('a missing source journal and an unsafe backup directory fail closed', async () => {
  const dir = newDir('backup-missing-source');
  const key = storageKey();
  const keyset = makeKeyset();
  await code(createJournalBackup({
    sdk, profile: profileObject({journalPath: join(dir, 'absent.sqlite'), keyset}),
    storageKey: key, out: join(dir, 'backup.sqlite'),
  }), 'JOURNAL_NOT_FOUND');
  assert.equal(existsSync(join(dir, 'backup.sqlite')), false);
  assert.equal(existsSync(join(dir, 'backup.sqlite' + MANIFEST_SUFFIX)), false);

  const loose = join(dir, 'loose');
  mkdirSync(loose, {mode: 0o755});
  const {journalPath, profile} = await source(dir, key);
  await code(createJournalBackup({sdk, profile, storageKey: key, out: join(loose, 'backup.sqlite')}), 'UNSAFE_DIRECTORY');
  assert.equal(existsSync(join(loose, 'backup.sqlite')), false);
  assert.equal(existsSync(journalPath), true);
});

test('random fixture keys and journal bytes never appear in the manifest', async () => {
  const dir = newDir('backup-key-separation');
  const key = storageKey(randomBytes(32));
  const {profile} = await source(dir, key);
  const out = join(dir, 'journal-backup.sqlite');
  const result = await createJournalBackup({sdk, profile, storageKey: key, out});
  const manifest = readFileSync(result.manifest, 'utf8');
  for (const form of [key.toString('hex'), key.toString('base64'), key.toString('base64url')]) {
    assert.equal(manifest.includes(form), false);
  }
});
