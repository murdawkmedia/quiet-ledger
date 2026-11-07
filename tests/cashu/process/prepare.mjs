// Phase 1: a fictional receiving process persists the preparation and loses
// the mint response after the controlled mint committed the swap.
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {CashuJournal} from '../../../server/cashu/cashu-journal.mjs';
import {
  sdk, makeKeyset, makePayerProofs, makeOutputs, createControlledMint, createRecovery,
} from '../fixtures.mjs';
import {profileObject} from '../helpers.mjs';
import {journalDir, processDir, writeJson, writePrivate} from './common.mjs';

const dir = processDir();
const keyset = makeKeyset();
const key = Buffer.alloc(32, 77);
const journalPath = join(journalDir(), 'journal.sqlite');
writeJson(join(dir, 'profile.json'), profileObject({journalPath, keyset}));
writePrivate(join(dir, 'storage.key'), key);

const journal = new CashuJournal(journalPath, key, sdk);
const mint = createControlledMint(keyset, {restore: 'reordered'});
const recovery = createRecovery(journal, keyset, {swapReplayPolicy: 'none'});
await recovery.prepare({
  operationId: 'process-op', invoiceId: 'process-invoice',
  inputs: makePayerProofs(keyset, [1, 2]), outputs: makeOutputs(keyset, [2, 1]),
  expectedAmount: '3',
});
await assert.rejects(
  () => recovery.submit('process-op', async args => {
    mint.swap(args); // the controlled mint commits and spends the inputs
    throw new Error('FICTIONAL_LOST_RESPONSE');
  }),
  /FICTIONAL_LOST_RESPONSE/,
);
const operation = journal.get('process-op');
assert.equal(operation.state, 'uncertain');
assert.equal(journal.counts().results, 0);
assert.equal(journal.counts().outbox, 0);
writeJson(join(dir, 'mint.json'), mint.snapshot());
writeJson(join(dir, 'prepare.json'), {
  pid: process.pid,
  state: operation.state,
  requestHash: operation.requestHash,
  counts: journal.counts(),
});
journal.close();
console.log(JSON.stringify({ok: true, phase: 'prepare', pid: process.pid, state: operation.state}));
