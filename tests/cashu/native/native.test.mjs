// Saved-output NUT-09 restore, NUT-07 state handling and replay-policy tests.
//
// All material is published NUT-00/NUT-12 test data. The controlled mint is an
// in-memory honest/hostile stand-in; no network, wallet seed, funded mint or
// real ecash is involved.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CashuJournal } from '../../../server/cashu/cashu-journal.mjs';
import { CashuReceiveRecovery } from '../../../server/cashu/cashu-recovery.mjs';
import {
  sdk, mintUrl, invoiceId, PUBLISHED_VECTORS, makeKeyset, makePayerProof,
  makePayerProofs, makeOutputs, createRecovery, createControlledMint, verifyProofs,
} from '../fixtures.mjs';

const root = `${process.env.FIXTURE_RUN_DIR}/`;
let sequence = 0;
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

function open({ keyset = makeKeyset(), recoveryOptions = {}, restore = 'exact', replay = 'idempotent', check = 'exact' } = {}) {
  const path = `${root}native-${++sequence}.sqlite`;
  const storageKey = randomBytes(32); // storage-encryption fixture only
  const journal = new CashuJournal(path, storageKey, sdk);
  const mint = createControlledMint(keyset, { restore, replay, check });
  return {
    path, storageKey, journal, keyset, mint,
    recovery: createRecovery(journal, keyset, recoveryOptions),
  };
}

async function loseCommittedResponse(f, {
  operationId = 'fictional-native-op',
  amounts = [1, 2],
  outputAmounts = [2, 1],
  expectedAmount = '3',
} = {}) {
  const inputs = makePayerProofs(f.keyset, amounts);
  const outputs = makeOutputs(f.keyset, outputAmounts);
  await f.recovery.prepare({ operationId, invoiceId, inputs, outputs, expectedAmount });
  await assert.rejects(
    () => f.recovery.submit(operationId, async args => {
      f.mint.swap(args); // the mint commits and spends the inputs
      throw new Error('FICTIONAL_LOST_RESPONSE');
    }),
    /FICTIONAL_LOST_RESPONSE/,
  );
  assert.equal(f.journal.get(operationId).state, 'uncertain');
  assert.equal(f.journal.counts().results, 0);
  assert.equal(f.journal.counts().outbox, 0);
  return { operationId, inputs, outputs, requestJson: f.journal.requestOf(operationId) };
}

function expectNoValue(journal, operationId) {
  const operation = journal.get(operationId);
  assert.equal(operation.state, 'uncertain');
  assert.equal(journal.savedResult(operationId), null);
  assert.equal(journal.counts().results, 0);
  assert.equal(journal.counts().outbox, 0);
  assert.equal(journal.counts().merchantProofs, 0);
  assert.equal(journal.pending().length, 0);
}

test('NUT-09 restore unblinds persisted outputs, binds scope and commits exactly once', async () => {
  const f = open({ restore: 'reordered' });
  try {
    const { operationId, requestJson } = await loseCommittedResponse(f);
    const requestBefore = f.journal.requestOf(operationId);
    const hashBefore = f.journal.get(operationId).requestHash;
    const previewBefore = JSON.stringify(f.journal.get(operationId).preview);
    const expectedRestorePayload = JSON.stringify({ outputs: JSON.parse(requestJson).outputs });
    assert.notEqual(requestBefore, expectedRestorePayload);

    let calls = 0;
    const result = await f.recovery.restore(operationId, args => {
      calls++;
      assert.equal(args.method, 'POST');
      assert.equal(args.endpoint, `${mintUrl}/v1/restore`);
      // The restore payload is exactly the persisted original blinded outputs.
      assert.equal(JSON.stringify(args.requestBody), expectedRestorePayload);
      return f.mint.restore(args);
    });
    assert.equal(calls, 1);
    assert.equal(f.mint.swapCount(), 1, 'restore must not create another swap');
    assert.equal(result.settlement, 'restore');
    assert.equal(result.amount, '3');
    assert.equal(result.fee, '0');
    assert.equal(result.proofs.length, 2);
    assert.equal(result.proofs.reduce((sum, proof) => sum + BigInt(proof.amount), 0n), 3n);
    assert.equal((await verifyProofs(result.proofs, f.keyset)).valid.length, 2);
    assert.deepEqual(
      result.proofs.map(proof => proof.secret).sort(),
      [PUBLISHED_VECTORS.outputSecretAmount1, PUBLISHED_VECTORS.outputSecretAmount2].sort(),
    );

    // Commitments are untouched; the restore payload is tracked separately.
    assert.equal(f.journal.requestOf(operationId), requestBefore);
    assert.equal(f.journal.get(operationId).requestHash, hashBefore);
    assert.equal(JSON.stringify(f.journal.get(operationId).preview), previewBefore);
    const attempts = f.journal.restoreAttempts(operationId);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].payloadHash, sha256(expectedRestorePayload));
    assert.notEqual(attempts[0].payloadHash, hashBefore);

    assert.deepEqual(f.journal.counts(), {
      operations: 1, reservations: 2, merchantProofs: 2, results: 1, outbox: 1, observations: 0,
    });

    // One ledger credit, idempotent even when delivery is repeated.
    const ledger = new DatabaseSync(`${root}native-${sequence}-ledger.sqlite`);
    ledger.exec('CREATE TABLE credits(op_id TEXT PRIMARY KEY, amount TEXT NOT NULL)');
    const credit = async event => ledger.prepare('INSERT OR IGNORE INTO credits VALUES(?,?)')
      .run(event.operationId, event.amount);
    assert.deepEqual(await f.recovery.deliver({ credit }), { delivered: 1, pending: 0 });
    assert.deepEqual(await f.recovery.deliver({ credit }), { delivered: 0, pending: 0 });
    assert.equal(ledger.prepare('SELECT COUNT(*) AS n FROM credits').get().n, 1);
    ledger.close();

    // A finalized operation never triggers another remote request.
    let finalizedCalls = 0;
    const saved = await f.recovery.restore(operationId, () => { finalizedCalls++; throw new Error('must not call'); });
    assert.deepEqual(saved, result);
    assert.equal(finalizedCalls, 0);
    assert.equal(f.journal.restoreAttempts(operationId).length, 1);
  } finally { f.recovery.close(); }
});

test('swap replay defaults to disabled; unknown policy fails closed', async () => {
  const f = open();
  try {
    const { operationId } = await loseCommittedResponse(f);
    const strict = new CashuReceiveRecovery({
      journal: f.journal, sdk, mintUrl, unit: 'sat', keyset: f.keyset,
      mintInfo: { name: 'Controlled fictional fixture mint', nuts: {} },
    });
    let calls = 0;
    await assert.rejects(
      () => strict.recover(operationId, args => { calls++; return f.mint.swap(args); }),
      error => error.code === 'SWAP_REPLAY_DISABLED',
    );
    await assert.rejects(
      () => strict.submit(operationId, args => { calls++; return f.mint.swap(args); }),
      error => error.code === 'SWAP_REPLAY_DISABLED',
    );
    assert.equal(calls, 0);
    expectNoValue(f.journal, operationId);

    assert.throws(() => new CashuReceiveRecovery({
      journal: f.journal, sdk, mintUrl, unit: 'sat', keyset: f.keyset,
      mintInfo: { name: 'Controlled fictional fixture mint', nuts: {} },
      swapReplayPolicy: 'auto',
    }), error => error.code === 'INVALID_REPLAY_POLICY');
  } finally { f.recovery.close(); }
});

test('explicit replay policy reuses byte-identical original request bytes', async () => {
  const f = open();
  try {
    const { operationId, requestJson } = await loseCommittedResponse(f);
    let calls = 0, replay;
    const result = await f.recovery.recover(operationId, args => {
      calls++;
      replay = JSON.stringify(args.requestBody);
      return f.mint.swap(args);
    });
    assert.equal(calls, 1);
    assert.equal(replay, requestJson);
    assert.equal(result.settlement, 'swap');
    assert.equal(f.journal.restoreAttempts(operationId).length, 0);
    assert.equal(f.journal.counts().outbox, 1);
  } finally { f.recovery.close(); }
});

test('reconcile prefers restore and only replays when named explicitly', async () => {
  const f = open();
  try {
    const first = await loseCommittedResponse(f, { operationId: 'reconcile-restore' });
    const restored = await f.recovery.reconcile(first.operationId, args => f.mint.restore(args));
    assert.equal(restored.settlement, 'restore');
    await assert.rejects(
      () => f.recovery.reconcile('reconcile-restore', async () => { throw new Error('no'); }, { mode: 'guess' }),
      error => error.code === 'INVALID_RECONCILE_MODE',
    );
  } finally { f.recovery.close(); }

  const g = open();
  try {
    const second = await loseCommittedResponse(g, {
      operationId: 'reconcile-replay', amounts: [1], outputAmounts: [1], expectedAmount: '1',
    });
    const replayed = await g.recovery.reconcile(second.operationId, args => g.mint.swap(args), { mode: 'swap-replay' });
    assert.equal(replayed.settlement, 'swap');
  } finally { g.recovery.close(); }
});

test('incomplete, foreign, duplicate, tampered or amount-changed restores never credit', async () => {
  const variants = [
    'incomplete', 'duplicate', 'foreign-output', 'foreign-keyset',
    'missing-dleq', 'tampered-dleq', 'tampered-c', 'duplicate-signature',
    'changed-output-amount', 'changed-signature-amount', 'extra',
  ];
  for (const variant of variants) {
    const f = open({ restore: variant });
    try {
      const { operationId } = await loseCommittedResponse(f, { operationId: `restore-${variant}` });
      let calls = 0;
      await assert.rejects(
        () => f.recovery.restore(operationId, args => { calls++; return f.mint.restore(args); }),
        () => true,
        `${variant} must be rejected`,
      );
      assert.equal(calls, 1);
      expectNoValue(f.journal, operationId);
      assert.equal(f.journal.restoreAttempts(operationId).length, 1);
    } finally { f.recovery.close(); }
  }
});

test('restore refuses a different mint, unit or keyset before any remote effect', async () => {
  const f = open();
  try {
    const { operationId } = await loseCommittedResponse(f);
    let calls = 0;
    const otherMint = new CashuReceiveRecovery({
      journal: f.journal, sdk, mintUrl: 'https://other-quiet-ledger.invalid', unit: 'sat',
      keyset: f.keyset, mintInfo: { name: 'Controlled other fixture mint', nuts: {} },
      swapReplayPolicy: 'byte-identical-single-request',
    });
    await assert.rejects(
      () => otherMint.restore(operationId, args => { calls++; return f.mint.restore(args); }),
      error => error.code === 'OPERATION_SCOPE_MISMATCH',
    );
    const otherKeyset = makeKeyset({ inputFeePpk: 1000 });
    const otherKeysetRecovery = createRecovery(f.journal, otherKeyset);
    await assert.rejects(
      () => otherKeysetRecovery.restore(operationId, args => { calls++; return f.mint.restore(args); }),
      error => error.code === 'OPERATION_SCOPE_MISMATCH',
    );
    assert.equal(calls, 0);
    assert.equal(f.journal.restoreAttempts(operationId).length, 0);
    assert.equal(f.journal.requestOf(operationId).length > 0, true);
    expectNoValue(f.journal, operationId);
  } finally { f.recovery.close(); }
});

test('restore payloads are separate, append-only, bounded and cannot rewrite the request', async () => {
  const f = open();
  try {
    const { operationId, requestJson } = await loseCommittedResponse(f);
    const payload = JSON.stringify({ outputs: JSON.parse(requestJson).outputs });
    const otherPayload = JSON.stringify({ outputs: JSON.parse(requestJson).outputs.slice(0, 1) });
    const hashBefore = f.journal.get(operationId).requestHash;
    assert.equal(f.journal.beginRestoreAttempt(operationId, payload), true);
    assert.throws(() => f.journal.beginRestoreAttempt(operationId, otherPayload),
      error => error.code === 'RESTORE_PAYLOAD_MISMATCH');
    assert.equal(f.journal.beginRestoreAttempt(operationId, payload), true);
    assert.equal(f.journal.beginRestoreAttempt(operationId, payload), true);
    assert.throws(() => f.journal.beginRestoreAttempt(operationId, payload),
      error => error.code === 'RESTORE_ATTEMPTS_EXHAUSTED');
    assert.equal(f.journal.restoreAttempts(operationId).length, 3);
    assert.equal(f.journal.get(operationId).requestHash, hashBefore);
    assert.equal(f.journal.requestOf(operationId), requestJson);

    const raw = new DatabaseSync(f.journal.path);
    assert.throws(() => raw.prepare('UPDATE restore_attempts SET payload=? WHERE op_id=? AND seq=1')
      .run(Buffer.from('changed'), operationId), /PERMANENT_RESTORE_ATTEMPT/);
    assert.throws(() => raw.prepare('DELETE FROM restore_attempts WHERE op_id=?').run(operationId),
      /PERMANENT_RESTORE_ATTEMPT/);
    raw.close();
    expectNoValue(f.journal, operationId);
  } finally { f.recovery.close(); }
});

test('journal result completion enforces restored output, amount and fee binding', async () => {
  const keyset = makeKeyset({ inputFeePpk: 1000 });
  const f = open({ keyset });
  try {
    const { operationId, requestJson } = await loseCommittedResponse(f, {
      operationId: 'binding-op', amounts: [1, 2], outputAmounts: [1], expectedAmount: '1',
    });
    const payload = JSON.stringify({ outputs: JSON.parse(requestJson).outputs });
    assert.equal(f.journal.beginRestoreAttempt(operationId, payload), true);
    const correct = makePayerProof(keyset, { amount: 1, secret: PUBLISHED_VECTORS.outputSecretAmount1 });

    assert.throws(() => f.journal.completeRestored(operationId, [correct],
      JSON.stringify({ outputs: [] })), error => error.code === 'RESTORE_PAYLOAD_MISMATCH');

    const wrongSecret = makePayerProof(keyset, { amount: 1, secret: PUBLISHED_VECTORS.outputSecretAmount2 });
    assert.throws(() => f.journal.completeRestored(operationId, [wrongSecret], payload),
      error => error.code === 'RESTORE_BINDING_MISMATCH');

    const wrongAmount = makePayerProof(keyset, { amount: 2, secret: PUBLISHED_VECTORS.outputSecretAmount1 });
    assert.throws(() => f.journal.completeRestored(operationId, [wrongAmount], payload),
      error => error.code === 'AMOUNT_MISMATCH');

    expectNoValue(f.journal, operationId);
    const result = f.journal.completeRestored(operationId, [correct], payload);
    assert.equal(result.settlement, 'restore');
    assert.equal(result.fee, '2');
    assert.equal(f.journal.counts().results, 1);
  } finally { f.recovery.close(); }
});

test('NUT-07 reports every expected Y, preserves SPENT history and never creates value', async () => {
  const f = open();
  try {
    const { operationId, inputs } = await loseCommittedResponse(f);
    const Ys = inputs.map(proof => sdk.hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true));
    let calls = 0;
    const checked = await f.recovery.checkInputStates(operationId, args => {
      calls++;
      assert.equal(args.endpoint, `${mintUrl}/v1/checkstate`);
      assert.deepEqual(args.requestBody, { Ys });
      return f.mint.check(args);
    });
    assert.equal(calls, 1);
    assert.deepEqual(checked, { states: ['SPENT', 'SPENT'], unspent: 0, pending: 0, spent: 2 });
    assert.equal(f.journal.observations(operationId).length, 2);
    expectNoValue(f.journal, operationId);

    // A later UNSPENT view cannot erase the historical SPENT warning.
    f.mint.markUnspent(Ys[1]);
    const mixed = await f.recovery.checkInputStates(operationId, args => f.mint.check(args));
    assert.deepEqual(mixed, { states: ['SPENT', 'UNSPENT'], unspent: 1, pending: 0, spent: 1 });
    assert.deepEqual(f.journal.observations(operationId).map(item => item.outcome),
      ['SPENT', 'SPENT', 'SPENT', 'UNSPENT']);
    expectNoValue(f.journal, operationId);

    let replayCalls = 0;
    await assert.rejects(
      () => f.recovery.recover(operationId, args => { replayCalls++; return f.mint.swap(args); }),
      error => error.code === 'INPUT_SPENT',
    );
    assert.equal(replayCalls, 0);

    // A cryptographically valid restore may still reconcile the uncertain SPENT.
    const result = await f.recovery.restore(operationId, args => f.mint.restore(args));
    assert.equal(result.settlement, 'restore');
    assert.equal((await verifyProofs(result.proofs, f.keyset)).valid.length, 2);
    assert.equal(f.journal.counts().results, 1);
    assert.equal(f.journal.counts().outbox, 1);
    await assert.rejects(
      () => f.recovery.checkInputStates(operationId, async () => { throw new Error('no'); }),
      error => error.code === 'NOT_UNCERTAIN',
    );
  } finally { f.recovery.close(); }
});

test('NUT-07 rejects malformed, incomplete, duplicate, aliased or unknown Y states', async () => {
  const variants = ['incomplete', 'duplicate', 'unknown', 'uppercase', 'bad-state', 'extra'];
  for (const variant of variants) {
    const f = open({ check: variant });
    try {
      const { operationId } = await loseCommittedResponse(f, { operationId: `check-${variant}` });
      let calls = 0;
      await assert.rejects(
        () => f.recovery.checkInputStates(operationId, args => { calls++; return f.mint.check(args); }),
        () => true,
        `${variant} must be rejected`,
      );
      assert.equal(calls, 1);
      expectNoValue(f.journal, operationId);
    } finally { f.recovery.close(); }
  }

  const f = open();
  try {
    const { operationId } = await loseCommittedResponse(f, { operationId: 'pending-check' });
    f.mint.markUnspent(sdk.hashToCurve(new TextEncoder().encode(
      PUBLISHED_VECTORS.inputSecretAmount1)).toHex(true));
    const pendingMint = createControlledMint(f.keyset, { check: 'pending' });
    const result = await f.recovery.checkInputStates(operationId, args => pendingMint.check(args));
    assert.deepEqual(result, { states: ['PENDING', 'PENDING'], unspent: 0, pending: 2, spent: 0 });
    expectNoValue(f.journal, operationId);
  } finally { f.recovery.close(); }
});

test('overlapping restore attempts reject before a second remote request', async () => {
  const f = open();
  try {
    const { operationId } = await loseCommittedResponse(f);
    let release, entered;
    const ready = new Promise(resolve => entered = resolve);
    const barrier = new Promise(resolve => release = resolve);
    let calls = 0;
    const first = f.recovery.restore(operationId, async args => {
      calls++;
      entered();
      await barrier;
      return f.mint.restore(args);
    });
    await ready;
    try {
      await assert.rejects(
        () => f.recovery.restore(operationId, args => { calls++; return f.mint.restore(args); }),
        error => error.code === 'ATTEMPT_IN_PROGRESS',
      );
    } finally { release(); }
    const result = await first;
    assert.equal(calls, 1);
    assert.equal(result.settlement, 'restore');
    assert.equal(f.mint.swapCount(), 1);
    assert.equal(f.journal.restoreAttempts(operationId).length, 1);
    assert.equal(f.journal.counts().results, 1);
  } finally { f.recovery.close(); }
});

test('restore attempts and failed observations survive restart without value', async () => {
  const f = open({ restore: 'incomplete' });
  try {
    const { operationId, requestJson } = await loseCommittedResponse(f);
    await assert.rejects(
      () => f.recovery.restore(operationId, args => f.mint.restore(args)),
      error => error.code === 'INCOMPLETE_RESTORE',
    );
    const payloadHash = f.journal.restoreAttempts(operationId)[0].payloadHash;
    const observations = f.journal.observations(operationId).map(item => item.outcome);
    assert.deepEqual(observations, ['INVALID_RESPONSE']);
    f.journal.close();

    const reopened = new CashuJournal(f.path, f.storageKey, sdk);
    assert.equal(reopened.get(operationId).state, 'uncertain');
    assert.equal(reopened.restoreAttempts(operationId)[0].payloadHash, payloadHash);
    assert.equal(reopened.observations(operationId)[0].outcome, 'INVALID_RESPONSE');
    assert.equal(reopened.requestOf(operationId), requestJson);
    assert.equal(reopened.counts().results, 0);
    assert.equal(reopened.counts().outbox, 0);

    // The same persisted payload can be retried with an honest mint.
    const honest = createControlledMint(f.keyset, { restore: 'exact' });
    honest.load(f.mint.snapshot());
    const recovery = createRecovery(reopened, f.keyset);
    const result = await recovery.restore(operationId, args => honest.restore(args));
    assert.equal(result.settlement, 'restore');
    assert.equal(reopened.restoreAttempts(operationId).length, 2);
    assert.equal(reopened.counts().results, 1);

    for (const suffix of ['', '-wal', '-shm']) {
      const file = f.path + suffix;
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file);
      for (const value of [
        PUBLISHED_VECTORS.inputSecretAmount1, PUBLISHED_VECTORS.outputSecretAmount1, invoiceId, mintUrl,
      ]) {
        assert.equal(bytes.includes(Buffer.from(value)), false, `plaintext ${value} found in ${file}`);
      }
    }
    recovery.close();
  } finally {
    try { f.recovery.close(); } catch {}
  }
});
