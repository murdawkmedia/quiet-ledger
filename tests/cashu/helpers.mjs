// Shared fictional fixtures for the public Cashu recovery tooling tests.
//
// Every key, proof and mint here is published NUT-00/NUT-12 test material or a
// caller-random storage-encryption fixture. There is no wallet seed, funded
// mint, real network or customer data.

import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {CashuJournal} from '../../server/cashu/cashu-journal.mjs';
import {createCashuRecoveryRuntime} from '../../server/cashu/runtime.mjs';
import {
  sdk, mintUrl, makeKeyset, makePayerProofs, makeOutputs, createControlledMint, createRecovery,
} from './fixtures.mjs';

let sequence = 0;

export function testRoot() {
  const root = process.env.CASHU_TEST_DIR || process.env.FIXTURE_RUN_DIR;
  if (!root) throw new Error('CASHU_TEST_DIR or FIXTURE_RUN_DIR is required');
  return root;
}

export function newDir(name) {
  const path = join(testRoot(), `${name}-${process.pid}-${++sequence}`);
  mkdirSync(path, {mode: 0o700});
  return path;
}

export function writePrivate(path, bytes) {
  writeFileSync(path, bytes, {mode: 0o600, flag: 'wx'});
  return path;
}

export function storageKey(seed = randomBytes(32)) {
  return Buffer.from(seed);
}

export function profileKeyset(keyset = makeKeyset()) {
  return {id: keyset.id, keys: {...keyset.keys}, input_fee_ppk: keyset.input_fee_ppk ?? 0};
}

export function profileObject({
  journalPath, keyset = makeKeyset(), mint = mintUrl, maxFee = null, swapReplayPolicy = 'none',
} = {}) {
  return {
    format: 'quiet-ledger-cashu-recovery-profile-v1',
    journalPath,
    mint,
    unit: 'sat',
    keyset: profileKeyset(keyset),
    mintInfo: {name: 'Controlled fictional fixture mint', version: '1', nuts: {}},
    maxFee,
    swapReplayPolicy,
  };
}

export function writeProfile(dir, profile, name = 'profile.json') {
  return writePrivate(join(dir, name), Buffer.from(JSON.stringify(profile)));
}

export function writeKey(dir, key, name = 'storage.key') {
  return writePrivate(join(dir, name), key);
}

export function openJournal(path, key, {sdk: injected = sdk} = {}) {
  return new CashuJournal(path, key, injected);
}

export function createMint(keyset, options = {}) {
  return createControlledMint(keyset, options);
}

// A previous receiving process persisted the preparation and lost the mint
// response after the controlled mint committed the swap. The journal must keep
// the operation uncertain with no result or outbox value.
export async function prepareUncertain({
  journalPath, key, keyset = makeKeyset(), operationId = 'fictional-recovery-op',
  invoiceId = 'fictional-recovery-invoice', amounts = [1, 2], outputAmounts = [2, 1],
  expectedAmount = '3', mintOptions = {},
}) {
  const journal = openJournal(journalPath, key);
  const mint = createMint(keyset, mintOptions);
  const recovery = createRecovery(journal, keyset, {swapReplayPolicy: 'none'});
  try {
    await recovery.prepare({
      operationId, invoiceId,
      inputs: makePayerProofs(keyset, amounts),
      outputs: makeOutputs(keyset, outputAmounts),
      expectedAmount,
    });
    await assert.rejects(
      () => recovery.submit(operationId, async args => {
        mint.swap(args);
        throw new Error('FICTIONAL_LOST_RESPONSE');
      }),
      /FICTIONAL_LOST_RESPONSE/,
    );
    assert.equal(journal.get(operationId).state, 'uncertain');
    assert.equal(journal.counts().results, 0);
    assert.equal(journal.counts().outbox, 0);
    return {journal, keyset, mint, journalPath};
  } finally { journal.close(); }
}

export function runtimeFor({journalPath, key, keyset = makeKeyset(), mintUrl: configuredMint = mintUrl, maxFee = null}) {
  const profile = profileObject({journalPath, keyset, mint: configuredMint, maxFee});
  return createCashuRecoveryRuntime({sdk, profile, storageKey: key});
}

export function capture() {
  const chunks = [];
  return {
    stdout: {write(value) { chunks.push(String(value)); }},
    text() { return chunks.join(''); },
    json() { return JSON.parse(chunks.join('')); },
  };
}

const FORBIDDEN_FIELDS = new Set([
  'proofs', 'secret', 'secrets', 'blinding', 'blindingFactor', 'preview', 'keepOutputs',
  'requestBody', 'requestJson', 'request_json', 'storageKey', 'storage_key', 'keys', 'key',
  'dleq', 'C', 'C_', 'B_', 'witness', 'p2pk_e',
]);

function visit(value, callback) {
  if (Array.isArray(value)) { for (const item of value) visit(item, callback); return; }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      callback(key, child);
      visit(child, callback);
    }
  }
}

// Assert that a JSON-safe operator payload carries no proof, blinding,
// request-body or key material. Values are searched too, because a field could
// be renamed while still leaking the original secret.
export function assertSafePayload(payload, {secrets = [], keys = [], raw = []} = {}) {
  const text = JSON.stringify(payload);
  for (const needle of [...secrets, ...keys, ...raw]) {
    if (typeof needle === 'string' && needle.length) {
      assert.equal(text.includes(needle), false, 'safe payload leaked fixture material');
    }
  }
  visit(payload, (key, child) => {
    assert.equal(FORBIDDEN_FIELDS.has(key), false, `safe payload exposed field ${key}`);
    if (typeof child === 'string') {
      assert.equal(/^cashu[AB]/i.test(child), false, 'safe payload exposed a bearer token');
      assert.equal(/^[0-9a-fA-F]{64}$/.test(child) && secrets.includes(child.toLowerCase()), false);
    }
  });
}

export function journalBytes(path) {
  return readFileSync(path);
}

export {existsSync, join, sdk, mintUrl, makeKeyset, makePayerProofs, makeOutputs, randomBytes};
