import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCashuRecoveryRuntime} from '../../server/cashu/runtime.mjs';
import {CashuJournal} from '../../server/cashu/cashu-journal.mjs';
import {sdk, mintUrl} from './fixtures.mjs';
import {
  newDir, storageKey, makeKeyset, profileObject, prepareUncertain, runtimeFor, assertSafePayload,
} from './helpers.mjs';

const code = async (promise, expected) => assert.rejects(promise, error => error.code === expected);

async function uncertainFixture(name, mintOptions = {}) {
  const dir = newDir(name);
  const key = storageKey();
  const keyset = makeKeyset();
  const journalPath = join(dir, 'journal.sqlite');
  const fixture = await prepareUncertain({journalPath, key, keyset, mintOptions});
  return {dir, key, keyset, journalPath, mint: fixture.mint};
}

test('a lost mint response is recovered by NUT-09 restore with exactly one outbox event', async () => {
  const f = await uncertainFixture('runtime-restore', {restore: 'reordered'});
  const runtime = runtimeFor(f);
  try {
    const before = runtime.inspect('fictional-recovery-op');
    assert.equal(before.state, 'uncertain');
    assert.equal(before.restoreAttemptCount, 0);
    assertSafePayload(before, {secrets: ['407915bc212be61a77e3e6d2aeb4c727980bda51cd06a6afc29e2861768a7837']});

    let calls = 0;
    const result = await runtime.restore('fictional-recovery-op', {
      apply: true,
      transport: args => { calls++; return f.mint.restore(args); },
    });
    assert.equal(calls, 1);
    assert.equal(result.applied, true);
    assert.equal(result.operation.settlement, 'restore');
    assert.equal(result.operation.amount, '3');
    assert.equal(result.operation.proofCount, 2);
    assert.equal(result.pending, 1);
    assertSafePayload(result);

    const after = runtime.inspect('fictional-recovery-op');
    assert.equal(after.state, 'finalized');
    assert.equal(after.restoreAttemptCount, 1);
    assertSafePayload(after);

    const pending = runtime.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].operationId, 'fictional-recovery-op');
    assertSafePayload(pending, {secrets: ['fe15109314e61d7756b0f8ee0f23a624acaa3f4e042f61433c728c7057b931be']});

    const credits = [];
    const adapter = {async credit(event) { credits.push(event); }};
    assert.deepEqual(await runtime.deliver(adapter), {delivered: 1, pending: 0});
    assert.deepEqual(await runtime.deliver(adapter), {delivered: 0, pending: 0});
    assert.equal(credits.length, 1);
    assert.equal(credits[0].operationId, 'fictional-recovery-op');
    assert.equal(credits[0].amount, '3');
    assertSafePayload(credits[0]);

    const again = await runtime.restore('fictional-recovery-op', {apply: false});
    assert.equal(again.applied, false);
    assert.equal(again.reason, 'ALREADY_FINALIZED');
    assert.equal(runtime.counts().outbox, 1);
    assert.equal(runtime.counts().merchantProofs, 2);
  } finally { runtime.close(); }
});

test('NUT-07 SPENT observations never create value and restore still works once', async () => {
  const f = await uncertainFixture('runtime-check');
  const runtime = runtimeFor(f);
  try {
    let restoreCalls = 0;
    const checked = await runtime.check('fictional-recovery-op', {
      apply: true,
      transport: args => f.mint.check(args),
    });
    assert.equal(checked.applied, true);
    assert.deepEqual(checked.states, {unspent: 0, pending: 0, spent: 2});
    assert.equal(runtime.counts().results, 0);
    assert.equal(runtime.counts().outbox, 0);
    assert.equal(runtime.counts().merchantProofs, 0);
    const view = runtime.inspect('fictional-recovery-op');
    assert.equal(view.state, 'uncertain');
    assert.deepEqual(view.observedStates, ['SPENT']);
    assert.equal(view.observationCount, 2);

    const restored = await runtime.restore('fictional-recovery-op', {
      apply: true,
      transport: args => { restoreCalls++; return f.mint.restore(args); },
    });
    assert.equal(restoreCalls, 1);
    assert.equal(restored.applied, true);
    assert.equal(runtime.counts().results, 1);
    assert.equal(runtime.counts().outbox, 1);
  } finally { runtime.close(); }
});

test('incomplete restore output leaves the operation uncertain with no credit', async () => {
  const f = await uncertainFixture('runtime-incomplete', {restore: 'incomplete'});
  const runtime = runtimeFor(f);
  try {
    await code(runtime.restore('fictional-recovery-op', {apply: true, transport: args => f.mint.restore(args)}),
      'INCOMPLETE_RESTORE');
    const view = runtime.inspect('fictional-recovery-op');
    assert.equal(view.state, 'uncertain');
    assert.equal(view.restoreAttemptCount, 1);
    assert.equal(view.observedStates.includes('INVALID_RESPONSE'), true);
    assert.equal(runtime.counts().results, 0);
    assert.equal(runtime.counts().outbox, 0);
    assert.equal(runtime.counts().merchantProofs, 0);
  } finally { runtime.close(); }
});

test('apply, transport and scope are required before any transport effect', async () => {
  const f = await uncertainFixture('runtime-gates');
  const otherKeyset = makeKeyset({inputFeePpk: 100});
  const scoped = runtimeFor({journalPath: f.journalPath, key: f.key, keyset: otherKeyset});
  try {
    assert.equal(scoped.preflight('fictional-recovery-op', 'restore').reason, 'OPERATION_SCOPE_MISMATCH');
    let scopedCalls = 0;
    await code(scoped.restore('fictional-recovery-op', {
      apply: true, transport: () => { scopedCalls++; return {}; },
    }), 'OPERATION_SCOPE_MISMATCH');
    assert.equal(scopedCalls, 0);
  } finally { scoped.close(); }
  const runtime = runtimeFor(f);
  try {
    await code(runtime.restore('fictional-recovery-op', {apply: false}), 'APPLY_REQUIRED');
    await code(runtime.restore('fictional-recovery-op', {apply: true}), 'TRANSPORT_REQUIRED');
    await code(runtime.check('fictional-recovery-op', {apply: false}), 'APPLY_REQUIRED');
    assert.equal(runtime.counts().results, 0);
  } finally { runtime.close(); }
});

test('missing journals, wrong keys and malformed operations fail closed', async () => {
  const f = await uncertainFixture('runtime-errors');
  await code(Promise.resolve().then(() => createCashuRecoveryRuntime({
    sdk,
    profile: profileObject({journalPath: join(f.dir, 'absent.sqlite'), keyset: f.keyset}),
    storageKey: f.key,
  })), 'JOURNAL_NOT_FOUND');
  await code(Promise.resolve().then(() => createCashuRecoveryRuntime({
    sdk,
    profile: profileObject({journalPath: f.journalPath, keyset: f.keyset}),
    storageKey: storageKey(Buffer.alloc(32, 200)),
  })), 'WRONG_STORAGE_KEY');
  const runtime = runtimeFor(f);
  try {
    assert.deepEqual(runtime.inspect('unknown-operation'), {exists: false, operationId: 'unknown-operation'});
    assert.equal(runtime.preflight('unknown-operation').reason, 'OPERATION_NOT_FOUND');
    await code(runtime.restore('bad id', {apply: true, transport: () => {}}), 'INVALID_OPERATION_ID');
    await code(runtime.deliver({}), 'INVALID_LEDGER');
  } finally { runtime.close(); }
});

test('prepared but unsubmitted operations are not restorable', async () => {
  const dir = newDir('runtime-prepared');
  const key = storageKey();
  const keyset = makeKeyset();
  const journalPath = join(dir, 'journal.sqlite');
  const journal = new CashuJournal(journalPath, key, sdk);
  const {createRecovery, makePayerProofs, makeOutputs} = await import('./fixtures.mjs');
  const recovery = createRecovery(journal, keyset, {swapReplayPolicy: 'none'});
  await recovery.prepare({
    operationId: 'prepared-op', invoiceId: 'prepared-invoice',
    inputs: makePayerProofs(keyset, [1]), outputs: makeOutputs(keyset, [1]), expectedAmount: '1',
  });
  journal.close();
  const runtime = runtimeFor({journalPath, key, keyset});
  try {
    assert.equal(runtime.preflight('prepared-op', 'restore').reason, 'ATTEMPT_NOT_STARTED');
    let calls = 0;
    await code(runtime.restore('prepared-op', {apply: true, transport: () => { calls++; return {}; }}),
      'NOT_UNCERTAIN');
    assert.equal(calls, 0);
  } finally { runtime.close(); }
});

test('recovery modules contain no invoice-ledger credit wiring', () => {
  const directory = join(dirname(fileURLToPath(import.meta.url)), '../../server/cashu');
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.mjs')) continue;
    const text = readFileSync(join(directory, name), 'utf8');
    assert.equal(text.includes('invoice-ledger'), false, `${name} imports the invoice ledger`);
    assert.equal(text.includes('InvoiceLedger'), false, `${name} references InvoiceLedger`);
    assert.equal(text.includes('creditInvoice'), false, `${name} references invoice credit`);
  }
  assert.equal(typeof mintUrl, 'string');
});
