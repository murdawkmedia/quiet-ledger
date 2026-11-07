// Phase 2: a separate process recovers the committed blinded outputs with the
// public CLI NUT-09 restore path through an injected controlled transport.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {CashuJournal} from '../../../server/cashu/cashu-journal.mjs';
import {createControlledMint, makeKeyset, mintUrl, sdk} from '../fixtures.mjs';
import {readJson, processDir, writeJson} from './common.mjs';
import {runCli} from '../../../ops/cashu-recovery.mjs';

const dir = processDir();
const profilePath = join(dir, 'profile.json');
const keyPath = join(dir, 'storage.key');
const profile = readJson(profilePath);
const key = readFileSync(keyPath);
assert.equal(key.length, 32);
const mint = createControlledMint(makeKeyset());
mint.load(readJson(join(dir, 'mint.json')));

const chunks = [];
const status = await runCli([
  'restore', '--profile', profilePath, '--storage-key', keyPath,
  '--operation', 'process-op', '--apply', '--mint', mintUrl,
], {
  stdout: {write(value) { chunks.push(String(value)); }},
  transportFactory: () => args => mint.restore(args),
});
const result = JSON.parse(chunks.join(''));
assert.equal(status, 0, JSON.stringify(result));
assert.equal(result.ok, true);
assert.equal(result.applied, true);
assert.equal(result.operation.settlement, 'restore');
assert.equal(result.operation.proofCount, 2);
assert.equal(result.outboxPending, 1);

const journal = new CashuJournal(profile.journalPath, key, sdk);
try {
  const operation = journal.get('process-op');
  const prepared = readJson(join(dir, 'prepare.json'));
  assert.equal(operation.state, 'finalized');
  assert.equal(operation.requestHash, prepared.requestHash);
  assert.equal(journal.counts().results, 1);
  assert.equal(journal.counts().outbox, 1);
  writeJson(join(dir, 'restore.json'), {
    pid: process.pid,
    state: operation.state,
    settlement: journal.savedResult('process-op').settlement,
    originalRequestUnchanged: operation.requestHash === prepared.requestHash,
    restoreAttempts: journal.restoreAttempts('process-op').length,
    counts: journal.counts(),
  });
} finally { journal.close(); }
console.log(JSON.stringify({ok: true, phase: 'restore', pid: process.pid, settlement: result.operation.settlement}));
