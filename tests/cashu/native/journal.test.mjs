import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CashuJournal } from '../../../server/cashu/cashu-journal.mjs';
import {
  sdk, mintUrl, invoiceId, PUBLISHED_VECTORS, makeKeyset, makePayerProofs,
  makePayerProof, makeOutputs, signSwapRequest, createRecovery, verifyProofs,
} from '../fixtures.mjs';

const root = `${process.env.FIXTURE_RUN_DIR}/`;
let sequence = 0;

function open({ keyset = makeKeyset(), recoveryOptions = {} } = {}) {
  const path = `${root}test-${++sequence}.sqlite`;
  const storageKey = randomBytes(32); // Storage-encryption fixture only.
  const journal = new CashuJournal(path, storageKey, sdk);
  return {
    path, storageKey, journal, keyset,
    recovery: createRecovery(journal, keyset, recoveryOptions),
  };
}

function merchantProof(keyset, amount = 1) {
  return makePayerProof(keyset, {
    amount,
    secret: amount === 1
      ? PUBLISHED_VECTORS.outputSecretAmount1
      : PUBLISHED_VECTORS.outputSecretAmount2,
  });
}

function journalPrepare(journal, keyset, operationId, { inputs, expectedAmount = '1', expectedFee = '0' } = {}) {
  return journal.prepare({
    operationId,
    invoiceId,
    mint: mintUrl,
    unit: 'sat',
    keysetId: keyset.id,
    inputs: inputs ?? makePayerProofs(keyset, [1]),
    expectedAmount,
    expectedFee,
    preview: { fixture: 'serialized-preview', operationId },
  });
}

test('Node permission boundary denies network and subprocesses', {
  skip: !process.permission && 'requires the bounded runner (node --permission)',
}, () => {
  assert.equal(process.permission.has('net'), false);
  assert.equal(process.permission.has('child'), false);
});

test('official NUT-12 published proof verifies; tampered DLEQ is rejected', async () => {
  const nut12Keyset = { id: '00882760bfa2eb41', keys: { 1: makeKeyset().keys[1] } };
  const valid = await verifyProofs([PUBLISHED_VECTORS.nut12ValidProof], nut12Keyset);
  assert.equal(valid.valid.length, 1);
  assert.equal(valid.invalid.length, 0);
  const tampered = {
    ...PUBLISHED_VECTORS.nut12ValidProof,
    dleq: { ...PUBLISHED_VECTORS.nut12ValidProof.dleq, e: '00'.repeat(32) },
  };
  const invalid = await verifyProofs([tampered], nut12Keyset);
  assert.equal(invalid.valid.length, 0);
  assert.equal(invalid.invalid.length, 1);
  assert.match(invalid.invalid[0].error.message, /DLEQ/i);
});

test('fixture payer and merchant proofs pass real NUT-12 DLEQ verification', async () => {
  const keyset = makeKeyset();
  const inputs = makePayerProofs(keyset, [1, 2]);
  const inputVerification = await verifyProofs(inputs, keyset);
  assert.equal(inputVerification.valid.length, 2);
  const output = merchantProof(keyset, 1);
  const outputVerification = await verifyProofs([output], keyset);
  assert.equal(outputVerification.valid.length, 1);
  const tamperedC = { ...output, C: makePayerProof(keyset, { amount: 2, secret: PUBLISHED_VECTORS.outputSecretAmount2 }).C };
  assert.equal((await verifyProofs([tamperedC], keyset)).valid.length, 0);
  const tamperedDleq = { ...output, dleq: { ...output.dleq, s: '11'.repeat(32) } };
  assert.equal((await verifyProofs([tamperedDleq], keyset)).valid.length, 0);
});

test('encrypted preparation survives restart; plaintext, replacement, wrong key fail closed', () => {
  const { journal, path, storageKey, keyset } = open();
  const operation = journalPrepare(journal, keyset, 'restart-op');
  const replacement = {
    operationId: 'restart-op', invoiceId: 'other-invoice', mint: mintUrl, unit: 'sat',
    keysetId: keyset.id, inputs: operation.inputs, expectedAmount: '1', expectedFee: '0',
    preview: { changed: true },
  };
  assert.throws(() => journal.prepare(replacement), /OPERATION_CONFLICT/);

  const raw = new DatabaseSync(path);
  assert.throws(() => raw.prepare('UPDATE operations SET prepared=? WHERE op_id=?')
    .run(Buffer.from('replacement'), 'restart-op'), /IMMUTABLE_PREPARATION/);
  raw.close();
  journal.close();

  for (const file of readdirSync(root).filter(name => name.startsWith(`test-${sequence}.sqlite`))) {
    const bytes = readFileSync(root + file);
    for (const value of [
      PUBLISHED_VECTORS.inputSecretAmount1, PUBLISHED_VECTORS.outputSecretAmount1,
      'fictional-invoice-2026-11-06', 'quiet-ledger.invalid',
    ]) {
      assert.equal(bytes.includes(Buffer.from(value)), false, `plaintext found in ${file}`);
    }
  }

  assert.throws(() => new CashuJournal(path, randomBytes(32), sdk), /WRONG_STORAGE_KEY/);
  const reopened = new CashuJournal(path, storageKey, sdk);
  assert.equal(reopened.get('restart-op').state, 'prepared');
  assert.equal(reopened.get('restart-op').preview.fixture, 'serialized-preview');
  assert.equal(reopened.counts().operations, 1);
  reopened.close();
});

test('proof reservations span invoices and resist aliases, duplicates and overlap', () => {
  const { journal, keyset } = open();
  const first = journalPrepare(journal, keyset, 'invoice-a-op');
  assert.equal(first.state, 'prepared');

  const sameInputs = makePayerProofs(keyset, [1, 2]);
  assert.throws(() => journalPrepare(journal, keyset, 'invoice-b-op', {
    inputs: sameInputs, expectedAmount: '3',
  }), /PROOF_RESERVED/);
  assert.equal(journal.get('invoice-b-op'), null);

  const alias = {
    operationId: 'alias-op', invoiceId: 'alias-invoice', mint: `${mintUrl}/`, unit: 'sat',
    keysetId: keyset.id, inputs: sameInputs, expectedAmount: '3', expectedFee: '0',
    preview: { alias: true },
  };
  assert.throws(() => journal.prepare(alias), /PROOF_RESERVED/);

  const duplicate = {
    operationId: 'duplicate-op', invoiceId: 'duplicate-invoice', mint: mintUrl, unit: 'sat',
    keysetId: keyset.id, inputs: [sameInputs[0], sameInputs[0]], expectedAmount: '2', expectedFee: '0',
    preview: { duplicate: true },
  };
  assert.throws(() => journal.prepare(duplicate), /DUPLICATE_INPUT/);

  // A different mint and unit are independent scopes.
  const otherMint = {
    operationId: 'other-mint-op', invoiceId: 'other-mint-invoice',
    mint: 'https://other.invalid', unit: 'sat', keysetId: keyset.id,
    inputs: sameInputs, expectedAmount: '3', expectedFee: '0', preview: { other: 'mint' },
  };
  journal.prepare(otherMint);
  const otherUnit = {
    operationId: 'other-unit-op', invoiceId: 'other-unit-invoice',
    mint: mintUrl, unit: 'usd', keysetId: keyset.id,
    inputs: sameInputs, expectedAmount: '3', expectedFee: '0', preview: { other: 'unit' },
  };
  journal.prepare(otherUnit);
  assert.equal(journal.counts().reservations, 5);
  assert.equal(journal.counts().operations, 3);
  journal.close();
});

test('attempt commits the exact request before effect and rejects changed replay', () => {
  const { journal, keyset } = open();
  journalPrepare(journal, keyset, 'attempt-op');
  const request = '{"inputs":[],"outputs":[],"fixture":"original"}';
  assert.equal(journal.beginAttempt('attempt-op', request), true);
  assert.equal(journal.get('attempt-op').state, 'uncertain');
  assert.equal(journal.requestOf('attempt-op'), request);
  assert.equal(journal.get('attempt-op').requestHash,
    createHash('sha256').update(request).digest('hex'));
  assert.throws(() => journal.beginAttempt('attempt-op', '{"fixture":"changed"}'), /REQUEST_MISMATCH/);
  assert.equal(journal.beginAttempt('attempt-op', request), true);
  assert.equal(journal.get('attempt-op').attempts, 2);

  const raw = new DatabaseSync(journal.path);
  assert.throws(() => raw.prepare('UPDATE operations SET request_hash=? WHERE op_id=?')
    .run('00'.repeat(32), 'attempt-op'), /IMMUTABLE_REQUEST/);
  raw.close();

  const result = journal.complete('attempt-op', [merchantProof(keyset, 1)]);
  assert.equal(result.amount, '1');
  assert.equal(journal.beginAttempt('attempt-op', request), false);
  assert.deepEqual(journal.savedResult('attempt-op'), result);
  journal.close();
});

test('observations survive restart and no outcome creates a result or frees inputs', () => {
  const { journal, path, storageKey, keyset } = open();
  journalPrepare(journal, keyset, 'observe-op');
  journal.beginAttempt('observe-op', '{"fixture":"timeout"}');
  for (const outcome of ['UNSPENT', 'SPENT', 'PENDING', 'RESTORE_UNAVAILABLE', 'TIMEOUT']) {
    journal.observe('observe-op', outcome);
    assert.equal(journal.get('observe-op').state, 'uncertain');
    assert.equal(journal.pending().length, 0);
    assert.equal(journal.savedResult('observe-op'), null);
  }
  journal.close();

  const reopened = new CashuJournal(path, storageKey, sdk);
  assert.deepEqual(reopened.observations('observe-op').map(item => item.outcome),
    ['UNSPENT', 'SPENT', 'PENDING', 'RESTORE_UNAVAILABLE', 'TIMEOUT']);
  assert.equal(reopened.observation('observe-op').outcome, 'TIMEOUT');
  assert.throws(() => reopened.observe('observe-op', 'MADE_UP'), /INVALID_OBSERVATION/);
  assert.equal(reopened.counts().results, 0);
  assert.equal(reopened.counts().outbox, 0);
  assert.equal(reopened.counts().reservations, 1);
  reopened.close();
});

test('lost response stays uncertain; exact replay produces one crypto-valid result', async () => {
  const { journal, keyset, recovery } = open();
  const inputs = makePayerProofs(keyset, [1]);
  const outputs = makeOutputs(keyset, [1]);
  await recovery.prepare({ operationId: 'lost-response', invoiceId, inputs, outputs, expectedAmount: '1' });
  let firstCalls = 0;
  await assert.rejects(
    () => recovery.submit('lost-response', async () => {
      firstCalls++;
      throw new Error('FICTIONAL_LOST_RESPONSE');
    }),
    /FICTIONAL_LOST_RESPONSE/,
  );
  assert.equal(firstCalls, 1);
  assert.equal(journal.get('lost-response').state, 'uncertain');
  assert.equal(journal.counts().merchantProofs, 0);
  assert.equal(journal.counts().results, 0);
  assert.equal(journal.counts().outbox, 0);
  assert.equal(journal.pending().length, 0);
  const originalRequest = journal.requestOf('lost-response');

  let secondCalls = 0;
  let replayRequest;
  const result = await recovery.recover('lost-response', async args => {
    secondCalls++;
    replayRequest = JSON.stringify(args.requestBody);
    return signSwapRequest(args, keyset);
  });
  assert.equal(secondCalls, 1);
  assert.equal(replayRequest, originalRequest, 'recovery must replay the exact committed request bytes');
  assert.equal(result.amount, '1');
  assert.equal(result.proofs.length, 1);
  assert.equal((await verifyProofs(result.proofs, keyset)).valid.length, 1);
  assert.deepEqual(journal.counts(), {
    operations: 1, reservations: 1, merchantProofs: 1, results: 1, outbox: 1, observations: 0,
  });
  for (const suffix of ['', '-wal', '-shm']) {
    const file = journal.path + suffix;
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    for (const value of [PUBLISHED_VECTORS.inputSecretAmount1, PUBLISHED_VECTORS.outputSecretAmount1, invoiceId, mintUrl]) {
      assert.equal(bytes.includes(Buffer.from(value)), false, `plaintext ${value} found in ${file}`);
    }
  }

  let finalizedCalls = 0;
  const saved = await recovery.submit('lost-response', async () => { finalizedCalls++; throw new Error('must not submit'); });
  assert.deepEqual(saved, result);
  assert.equal(finalizedCalls, 0);

  const ledger = new DatabaseSync(`${root}test-${sequence}-ledger.sqlite`);
  ledger.exec('CREATE TABLE credits(op_id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, amount TEXT NOT NULL)');
  const credit = async event => ledger.prepare('INSERT OR IGNORE INTO credits VALUES(?,?,?)')
    .run(event.operationId, event.invoiceId, event.amount);
  assert.deepEqual(await recovery.deliver({ credit }), { delivered: 1, pending: 0 });
  // Event lost after ledger commit, before acknowledgement.
  const reopenedLedger = new DatabaseSync(`${root}test-${sequence}-ledger.sqlite`);
  journal.ack('lost-response');
  assert.equal(reopenedLedger.prepare('SELECT COUNT(*) AS n FROM credits').get().n, 1);
  assert.equal(journal.pending().length, 0);
  reopenedLedger.close(); ledger.close();
  assert.equal(journal.integrityCheck(), 'ok');
  journal.close();
});

test('nonzero input fee is validated and the outbox projects bookkeeping only', async () => {
  const keyset = makeKeyset({ inputFeePpk: 1000 });
  const { journal, recovery } = open({ keyset });
  const inputs = makePayerProofs(keyset, [1, 2]);
  const outputs = makeOutputs(keyset, [1]);
  const prepared = await recovery.prepare({
    operationId: 'fee-op', invoiceId, inputs, outputs, expectedAmount: '1',
  });
  assert.equal(prepared.expectedAmount, '1');
  assert.equal(prepared.expectedFee, '2');
  const result = await recovery.submit('fee-op', args => signSwapRequest(args, keyset));
  assert.equal(result.amount, '1');
  assert.equal(result.fee, '2');
  const [event] = journal.pending();
  assert.deepEqual(Object.keys(event).sort(), [
    'amount', 'fee', 'invoiceId', 'mint', 'operationId', 'proofCount', 'resultTag', 'unit',
  ]);
  assert.equal(event.amount, '1');
  assert.equal(event.fee, '2');
  assert.equal(event.proofCount, 1);
  const serialized = JSON.stringify(event);
  for (const secret of [PUBLISHED_VECTORS.inputSecretAmount1, PUBLISHED_VECTORS.outputSecretAmount1]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes('"proofs"'), false);
  journal.close();
});

async function expectRejectedResponse(label, mutate) {
  const { journal, keyset, recovery } = open();
  const inputs = makePayerProofs(keyset, [1]);
  const outputs = makeOutputs(keyset, [1]);
  await recovery.prepare({ operationId: label, invoiceId, inputs, outputs, expectedAmount: '1' });
  await assert.rejects(
    () => recovery.submit(label, async args => {
      const response = signSwapRequest(args, keyset);
      mutate(response, args);
      return response;
    }),
    () => true,
  );
  assert.equal(journal.get(label).state, 'uncertain', `${label} must remain uncertain`);
  assert.equal(journal.counts().merchantProofs, 0);
  assert.equal(journal.counts().results, 0);
  assert.equal(journal.counts().outbox, 0);
  assert.equal(journal.pending().length, 0);
  journal.close();
}

test('invalid payer DLEQ and a fee above policy reject before reserving or finalizing', async () => {
  const { journal, keyset, recovery } = open();
  const inputs = makePayerProofs(keyset, [1]);
  inputs[0].dleq.e = '11'.repeat(32);
  await assert.rejects(
    () => recovery.prepare({
      operationId: 'bad-input-dleq', invoiceId, inputs,
      outputs: makeOutputs(keyset, [1]), expectedAmount: '1',
    }),
    /DLEQ/i,
  );
  assert.equal(journal.counts().operations, 0);
  journal.close();

  const noAmount = open();
  await assert.rejects(
    () => noAmount.recovery.prepare({
      operationId: 'no-amount', invoiceId,
      inputs: makePayerProofs(noAmount.keyset, [1]),
      outputs: makeOutputs(noAmount.keyset, [1]),
    }),
    /EXPECTED_AMOUNT_REQUIRED/,
  );
  assert.equal(noAmount.journal.counts().operations, 0);
  noAmount.journal.close();

  const feeKeyset = makeKeyset({ inputFeePpk: 1000 });
  const { journal: feeJournal, recovery: feeRecovery } = open({
    keyset: feeKeyset, recoveryOptions: { maxFee: '1' },
  });
  await assert.rejects(
    () => feeRecovery.prepare({
      operationId: 'fee-policy', invoiceId,
      inputs: makePayerProofs(feeKeyset, [1, 2]),
      outputs: makeOutputs(feeKeyset, [1]), expectedAmount: '1',
    }),
    /FEE_EXCEEDS_POLICY/,
  );
  assert.equal(feeJournal.counts().operations, 0);
  feeJournal.close();
});

test('response validation rejects missing/tampered DLEQ, wrong amount and extra signature', async () => {
  await expectRejectedResponse('missing-dleq', response => { delete response.signatures[0].dleq; });
  await expectRejectedResponse('tampered-dleq', response => {
    response.signatures[0].dleq.e = '11'.repeat(32);
  });
  await expectRejectedResponse('wrong-amount', response => {
    response.signatures[0].amount = '2';
  });
  await expectRejectedResponse('extra-signature', response => {
    response.signatures.push({ ...response.signatures[0] });
  });
  await expectRejectedResponse('tampered-point', response => {
    response.signatures[0].C_ = merchantProof(makeKeyset(), 1).C;
  });
});

test('result and outbox commit atomically; replay is idempotent and one ledger credit lands', () => {
  const { journal, keyset } = open();
  journalPrepare(journal, keyset, 'atomic-op');
  journal.beginAttempt('atomic-op', '{"fixture":"atomic"}');
  // Deliberately use a direct SQLite handle only for fault injection, as a test.
  const db = new DatabaseSync(journal.path);
  db.exec("CREATE TRIGGER fixture_outbox_failure BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'FIXTURE_OUTBOX_FAILURE'); END");
  db.close();
  assert.throws(() => journal.complete('atomic-op', [merchantProof(keyset, 1)]), /FIXTURE_OUTBOX_FAILURE/);
  assert.equal(journal.get('atomic-op').state, 'uncertain');
  assert.deepEqual(journal.counts(), {
    operations: 1, reservations: 1, merchantProofs: 0, results: 0, outbox: 0, observations: 0,
  });

  const drop = new DatabaseSync(journal.path);
  drop.exec('DROP TRIGGER fixture_outbox_failure');
  drop.close();
  const result = journal.complete('atomic-op', [merchantProof(keyset, 1)]);
  assert.deepEqual(journal.complete('atomic-op', [merchantProof(keyset, 1)]), result);
  assert.throws(() => journal.complete('atomic-op', [merchantProof(keyset, 2)]), /AMOUNT_MISMATCH/);
  assert.equal(journal.counts().merchantProofs, 1);
  assert.equal(journal.counts().outbox, 1);

  const ledger = new DatabaseSync(':memory:');
  ledger.exec('CREATE TABLE credits(op_id TEXT PRIMARY KEY, amount TEXT NOT NULL)');
  const consume = () => {
    for (const event of journal.pending()) {
      ledger.prepare('INSERT OR IGNORE INTO credits VALUES(?,?)').run(event.operationId, event.amount);
    }
  };
  consume(); consume();
  assert.equal(ledger.prepare('SELECT COUNT(*) AS n FROM credits').get().n, 1);
  assert.equal(journal.pending().length, 1);
  journal.ack('atomic-op'); journal.ack('atomic-op');
  assert.equal(journal.pending().length, 0);
  ledger.close(); journal.close();
});

test('cooperating second writer and SQLite contention cannot produce partial writes', () => {
  const { journal, path, storageKey, keyset } = open();
  assert.throws(() => new CashuJournal(path, storageKey, sdk), /SINGLE_WRITER/);
  const contender = new DatabaseSync(path);
  contender.exec('BEGIN IMMEDIATE');
  assert.throws(() => journalPrepare(journal, keyset, 'contended-op'), /locked|busy/i);
  contender.exec('ROLLBACK'); contender.close();
  assert.equal(journal.get('contended-op'), null);
  journalPrepare(journal, keyset, 'after-contention');
  journal.close();
  const next = new CashuJournal(path, storageKey, sdk);
  assert.equal(next.counts().operations, 1);
  next.close();
});
