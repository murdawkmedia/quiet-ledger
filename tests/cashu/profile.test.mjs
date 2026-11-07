import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chmodSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  CashuProfileError, parseProfileJson, readProfileFile, readStorageKeyFile, redactedProfileMetadata,
  validateProfile,
} from '../../server/cashu/profile.mjs';
import {
  newDir, profileObject, profileKeyset, storageKey, writeKey, writeProfile, makeKeyset, randomBytes,
  assertSafePayload, testRoot,
} from './helpers.mjs';

const code = (fn, expected) => assert.throws(fn, error => error.code === expected);

function validProfile(dir = newDir('profile')) {
  return profileObject({journalPath: join(dir, 'journal.sqlite')});
}

test('a fully explicit sat profile parses and its metadata is redacted', () => {
  const dir = newDir('profile-valid');
  const profile = validProfile(dir);
  const parsed = parseProfileJson(JSON.stringify(profile));
  assert.equal(parsed.unit, 'sat');
  assert.equal(parsed.swapReplayPolicy, 'none');
  assert.equal(parsed.keyset.input_fee_ppk, 0);
  const metadata = redactedProfileMetadata(parsed);
  assert.equal(metadata.mintHost, 'quiet-ledger.invalid');
  assert.equal(metadata.mintScheme, 'https');
  assert.equal(metadata.keysetId, profile.keyset.id);
  assert.deepEqual(metadata.mintInfoNuts, []);
  assert.equal('mint' in metadata, false);
  assert.equal('keys' in metadata, false);
  const text = JSON.stringify(metadata);
  assert.equal(text.includes(profile.mint), false);
  for (const point of Object.values(profile.keyset.keys)) assert.equal(text.includes(point), false);
  assertSafePayload(metadata);
});

test('profile validation fails closed on unknown fields, wrong network, unit, fee and keys', () => {
  const dir = newDir('profile-invalid');
  const base = validProfile(dir);
  const clone = () => JSON.parse(JSON.stringify(base));

  let value = clone(); value.extra = 1; code(() => validateProfile(value), 'INVALID_PROFILE');
  value = clone(); value.keyset.extra = 1; code(() => validateProfile(value), 'INVALID_KEYSET');
  value = clone(); value.mint = 'http://mint.example.test'; code(() => validateProfile(value), 'INVALID_MINT');
  value = clone(); value.mint = 'https://user:pass@mint.example.test'; code(() => validateProfile(value), 'INVALID_MINT');
  value = clone(); value.mint = 'https://mint.example.test/v1?x=1'; code(() => validateProfile(value), 'INVALID_MINT');
  value = clone(); value.mint = 'ftp://mint.example.test'; code(() => validateProfile(value), 'INVALID_MINT');
  value = clone(); value.unit = 'usd'; code(() => validateProfile(value), 'INVALID_UNIT');
  value = clone(); value.keyset.input_fee_ppk = -1; code(() => validateProfile(value), 'INVALID_PROFILE');
  value = clone(); value.keyset.input_fee_ppk = 1.5; code(() => validateProfile(value), 'INVALID_PROFILE');
  value = clone(); value.maxFee = '-1'; code(() => validateProfile(value), 'INVALID_PROFILE');
  value = clone(); value.keyset.id = 'bad id'; code(() => validateProfile(value), 'INVALID_KEYSET');
  value = clone(); value.keyset.keys = {}; code(() => validateProfile(value), 'INVALID_KEYSET');
  value = clone(); value.keyset.keys = {'1': '02' + 'zz'.repeat(32)}; code(() => validateProfile(value), 'INVALID_KEYSET');
  value = clone(); delete value.mintInfo; code(() => validateProfile(value), 'INVALID_MINT_INFO');
  value = clone(); value.mintInfo = {name: 'missing nuts'}; code(() => validateProfile(value), 'INVALID_MINT_INFO');
  value = clone(); value.swapReplayPolicy = 'automatic'; code(() => validateProfile(value), 'INVALID_REPLAY_POLICY');
  value = clone(); value.format = 'other'; code(() => validateProfile(value), 'INVALID_PROFILE');
  value = clone(); value.journalPath = 'relative/journal.sqlite'; code(() => validateProfile(value), 'INVALID_PROFILE');
  value = clone(); value.keyset.keys = {'01': Object.values(base.keyset.keys)[0]}; code(() => validateProfile(value), 'INVALID_KEYSET');
  value = clone(); value.keyset.keys = {'1': '02' + 'AA'.repeat(32)}; assert.equal(validateProfile(value).keyset.keys['1'], '02' + 'aa'.repeat(32));
  value = clone(); value.mint = 'https://mint.example.test:8443/base/'; assert.equal(validateProfile(value).mint, 'https://mint.example.test:8443/base');
  value = clone(); value.maxFee = '0'; assert.equal(validateProfile(value).maxFee, '0');
  value = clone(); value.format = undefined; assert.equal(validateProfile(value).format, 'quiet-ledger-cashu-recovery-profile-v1');
});

test('profile and storage-key files must be owned 0600 without links', () => {
  const dir = newDir('profile-files');
  const profile = validProfile(dir);
  const profilePath = writeProfile(dir, profile);
  assert.equal(readProfileFile(profilePath).keyset.id, profile.keyset.id);

  chmodSync(profilePath, 0o644);
  code(() => readProfileFile(profilePath), 'UNSAFE_FILE');
  chmodSync(profilePath, 0o600);

  // Symlink fixtures are created by the unrestricted orchestrator because
  // Node's permission model refuses fs.symlink even inside an allowed scope.
  const linked = join(testRoot(), 'fictional-linked.json');
  code(() => readProfileFile(linked), 'FILE_NOT_FOUND');

  const linkedKey = join(testRoot(), 'fictional-linked.key');
  const key = storageKey(Buffer.alloc(32, 3));
  const keyPath = writeKey(dir, key);
  assert.deepEqual(readStorageKeyFile(keyPath), key);
  code(() => readStorageKeyFile(linkedKey), 'FILE_NOT_FOUND');
  writeFileSync(join(dir, 'short.key'), Buffer.alloc(31, 1), {mode: 0o600});
  code(() => readStorageKeyFile(join(dir, 'short.key')), 'UNSAFE_FILE');
  writeFileSync(join(dir, 'long.key'), randomBytes(33), {mode: 0o600});
  code(() => readStorageKeyFile(join(dir, 'long.key')), 'UNSAFE_FILE');
  chmodSync(keyPath, 0o640);
  code(() => readStorageKeyFile(keyPath), 'UNSAFE_FILE');
});

test('profile JSON errors never echo operator material', () => {
  const dir = newDir('profile-json');
  const path = writeProfile(dir, {not: 'a profile', secret: 'fictional-secret-value'});
  assert.throws(() => readProfileFile(path), error => {
    assert.equal(error.code, 'INVALID_PROFILE');
    assert.equal(error.message.includes('fictional-secret-value'), false);
    return true;
  });
  assert.throws(() => parseProfileJson('{not json'), error => error.code === 'INVALID_PROFILE_JSON');
  assert.throws(() => validateProfile(null), error => error instanceof CashuProfileError);
});

test('profile keyset fee and metadata stay exact for a non-zero fee fixture', () => {
  const dir = newDir('profile-fee');
  mkdirSync(dir, {recursive: true});
  const keyset = makeKeyset({inputFeePpk: 100});
  const profile = validateProfile(profileObject({journalPath: join(dir, 'journal.sqlite'), keyset}));
  assert.equal(profile.keyset.input_fee_ppk, 100);
  assert.deepEqual(profileKeyset(keyset).keys, profile.keyset.keys);
  assert.equal(redactedProfileMetadata(profile).inputFeePpk, 100);
});
