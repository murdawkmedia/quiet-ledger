// Explicit, non-networked-by-default recovery runtime for an existing Cashu
// receive journal.
//
// The caller injects the pinned SDK and supplies the merchant storage key. This
// factory never creates a wallet, seed, counter, output, secret, mint choice or
// invoice credit. It exposes read-only inspection plus the operator-gated
// restore/check paths. A future trusted receiving adapter may use the exposed
// `integration` object (prepare/submit/deliver), but it must authenticate the
// tenant and record a verified payment exactly once. The application invoice
// ledger is deliberately not imported or credited here.

import {lstatSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {dirname, resolve} from 'node:path';
import {CASHU_JOURNAL_TRIGGERS_SQL,CashuJournal, CashuJournalError} from './cashu-journal.mjs';
import {CashuReceiveRecovery, CashuRecoveryError} from './cashu-recovery.mjs';
import {privateDirectory} from './paths.mjs';
import {redactedProfileMetadata, validateProfile} from './profile.mjs';

export class CashuRuntimeError extends Error {
  constructor(code, message = code, cause) {
    super(`${code}: ${message}`, cause ? {cause} : undefined);
    this.name = 'CashuRuntimeError';
    this.code = code;
  }
}

const OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function safeErrorCode(error) {
  const code = error && typeof error === 'object' ? error.code : null;
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : 'UNEXPECTED_ERROR';
}

export function assertOperationId(value) {
  if (typeof value !== 'string' || !OPERATION_ID.test(value)) {
    throw new CashuRuntimeError('INVALID_OPERATION_ID', 'operation id must be 1..128 [A-Za-z0-9._:-] characters');
  }
  return value;
}

function mintMetadata(mint) {
  const url = new URL(mint);
  return {
    mintHost: url.host,
    mintUrlHash: createHash('sha256').update(mint, 'utf8').digest('hex').slice(0, 16),
  };
}

function safeOperationView(operation, journal) {
  const observations = journal.observations(operation.opId);
  return {
    operationId: operation.opId,
    invoiceId: operation.invoiceId,
    state: operation.state,
    revision: operation.revision,
    attempts: operation.attempts,
    expectedAmount: operation.expectedAmount,
    expectedFee: operation.expectedFee,
    unit: operation.unit,
    keysetId: operation.keysetId,
    ...mintMetadata(operation.mint),
    requestCommitted: typeof operation.requestHash === 'string',
    requestHash: operation.requestHash ?? null,
    inputCount: operation.inputs.length,
    storedOutputCount: Array.isArray(operation.preview?.keepOutputs) ? operation.preview.keepOutputs.length : 0,
    observationCount: observations.length,
    lastObservation: observations.length ? observations[observations.length - 1].outcome : null,
    observedStates: [...new Set(observations.map(observation => observation.outcome))].sort(),
    restoreAttemptCount: journal.restoreAttempts(operation.opId).length,
  };
}

function safeResultSummary(result) {
  if (!result || typeof result !== 'object') throw new CashuRuntimeError('INVALID_RESULT');
  return {
    operationId: result.operationId,
    invoiceId: result.invoiceId,
    settlement: result.settlement,
    amount: result.amount,
    fee: result.fee,
    unit: result.unit,
    keysetId: result.keysetId,
    ...mintMetadata(result.mint),
    proofCount: Array.isArray(result.proofs) ? result.proofs.length : 0,
  };
}

function safeOutboxEvent(event) {
  return {
    operationId: event.operationId,
    invoiceId: event.invoiceId,
    unit: event.unit,
    amount: event.amount,
    fee: event.fee,
    proofCount: event.proofCount,
    resultTag: event.resultTag,
    ...mintMetadata(event.mint),
  };
}

// Require a pre-existing format marker; the journal then authenticates its key.
export function assertExistingCashuJournalFormat(path) {
  let verification;
  try {
    verification = new DatabaseSync(path, {readOnly:true});
    const schema={
      journal_key_check:['id','payload'],
      operations:['op_id','scope_tag','invoice_tag','state','revision','attempts','prepared','request_json','request_hash'],
      reservations:['scope_tag','proof_tag','op_id'],
      merchant_proofs:['scope_tag','proof_tag','op_id','payload'],
      results:['op_id','payload'],outbox:['op_id','acked','payload'],
      observations:['op_id','seq','payload'],restore_attempts:['op_id','seq','payload','payload_hash'],
    };
    for (const [table,columns] of Object.entries(schema)) {
      const exists=verification.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      const actual=exists?verification.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name):[];
      if (columns.some(column=>!actual.includes(column))) throw new CashuRuntimeError('JOURNAL_NOT_INITIALIZED');
    }
    const normalized=value=>value.replace(/\s+/g,' ').trim().replace(/;$/,'');
    const triggers=[...CASHU_JOURNAL_TRIGGERS_SQL.matchAll(/CREATE TRIGGER IF NOT EXISTS (\w+)([\s\S]*?END);/g)];
    if(triggers.length!==16)throw new CashuRuntimeError('JOURNAL_NOT_INITIALIZED');
    for(const [,name,body] of triggers){
      const row=verification.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
      if(!row||normalized(row.sql)!==normalized(`CREATE TRIGGER ${name}${body}`))throw new CashuRuntimeError('JOURNAL_NOT_INITIALIZED');
    }
    if (!verification.prepare('SELECT 1 FROM journal_key_check WHERE id=1').get()) throw new CashuRuntimeError('JOURNAL_NOT_INITIALIZED');
  } catch (error) {
    if (error instanceof CashuRuntimeError) throw error;
    throw new CashuRuntimeError('JOURNAL_NOT_INITIALIZED', 'an existing initialized receive journal is required', error);
  } finally { verification?.close(); }

}

export function createCashuRecoveryRuntime({sdk, profile: rawProfile, storageKey} = {}) {
  const profile = validateProfile(rawProfile);
  if (!Buffer.isBuffer(storageKey) || storageKey.length !== 32) {
    throw new CashuRuntimeError('INVALID_STORAGE_KEY', 'storage key must be exactly 32 bytes');
  }
  if (profile.maxFee != null) {
    // Validated integer text; reject a configured ceiling the journal could not parse.
    if (!/^[0-9]+$/.test(String(profile.maxFee))) throw new CashuRuntimeError('INVALID_MAX_FEE');
  }
  const parent = privateDirectory(dirname(profile.journalPath), {label: 'journal directory'});
  let stat;
  try { stat = lstatSync(profile.journalPath); }
  catch (error) { throw new CashuRuntimeError('JOURNAL_NOT_FOUND', 'the configured journal does not exist', error); }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CashuRuntimeError('UNSAFE_JOURNAL', 'the journal must be an existing regular file');
  }
  if (profile.journalPath !== resolve(profile.journalPath) || parent !== dirname(profile.journalPath)) {
    throw new CashuRuntimeError('UNSAFE_JOURNAL', 'the journal path must be normalized and free of symlinks');
  }
  if (typeof sdk !== 'object' || sdk === null) throw new CashuRuntimeError('INVALID_SDK');

  assertExistingCashuJournalFormat(profile.journalPath);

  const key = Buffer.from(storageKey);
  let journal;
  try { journal = new CashuJournal(profile.journalPath, key, sdk, {restoreAttemptLimit:profile.restoreAttemptLimit}); }
  finally { key.fill(0); }
  let recovery;
  try {
    recovery = new CashuReceiveRecovery({
      journal,
      sdk,
      mintUrl: profile.mint,
      unit: profile.unit,
      keyset: profile.keyset,
      maxFee: profile.maxFee,
      mintInfo: profile.mintInfo,
      requireResponseDleq: true,
      swapReplayPolicy: profile.swapReplayPolicy,
    });
  } catch (error) {
    journal.close();
    throw error;
  }

  let closed = false;
  const open = () => {
    if (closed) throw new CashuRuntimeError('RUNTIME_CLOSED');
    return journal;
  };
  const scopeMatches = operation =>
    operation.mint === recovery.mintUrl && operation.unit === recovery.unit &&
    operation.keysetId === recovery.keyset.id;

  return Object.freeze({
    profile: redactedProfileMetadata(profile),

    counts() { return open().counts(); },

    integrity() { return open().integrityCheck(); },

    inspect(operationId) {
      assertOperationId(operationId);
      const operation = open().get(operationId);
      if (!operation) return {exists: false, operationId};
      return {exists: true, ...safeOperationView(operation, journal)};
    },

    preflight(operationId, mode = 'restore') {
      assertOperationId(operationId);
      if (mode !== 'restore' && mode !== 'check') throw new CashuRuntimeError('INVALID_MODE');
      const operation = open().get(operationId);
      if (!operation) return {eligible: false, reason: 'OPERATION_NOT_FOUND', operationId, mode};
      const view = safeOperationView(operation, journal);
      if (!scopeMatches(operation)) return {eligible: false, reason: 'OPERATION_SCOPE_MISMATCH', mode, operation: view};
      if (operation.state === 'finalized') return {eligible: false, reason: 'ALREADY_FINALIZED', mode, operation: view};
      if (operation.state !== 'uncertain') return {eligible: false, reason: 'ATTEMPT_NOT_STARTED', mode, operation: view};
      if (!operation.requestHash) return {eligible: false, reason: 'ORIGINAL_REQUEST_MISSING', mode, operation: view};
      if (mode === 'restore' && journal.restoreAttempts(operationId).length >= profile.restoreAttemptLimit) {
        return {eligible:false, reason:'RESTORE_ATTEMPTS_EXHAUSTED', mode, operation:view};
      }
      if (mode === 'check' && !operation.inputs.length) {
        return {eligible: false, reason: 'NO_INPUTS', mode, operation: view};
      }
      return {eligible: true, reason: null, mode, operation: view};
    },

    async restore(operationId, {apply = false, transport} = {}) {
      assertOperationId(operationId);
      const state = open().get(operationId);
      if (!state) throw new CashuRuntimeError('OPERATION_NOT_FOUND');
      if (state.state === 'finalized') {
        return {applied: false, reason: 'ALREADY_FINALIZED', operation: safeResultSummary(open().savedResult(operationId))};
      }
      if (apply !== true) throw new CashuRuntimeError('APPLY_REQUIRED', 'restore requires explicit apply');
      if (typeof transport !== 'function') throw new CashuRuntimeError('TRANSPORT_REQUIRED');
      const operation = await recovery.restore(operationId, transport);
      return {applied: true, operation: safeResultSummary(operation), pending: open().pending().length};
    },

    async check(operationId, {apply = false, transport} = {}) {
      assertOperationId(operationId);
      const state = open().get(operationId);
      if (!state) throw new CashuRuntimeError('OPERATION_NOT_FOUND');
      if (state.state === 'finalized') {
        return {applied: false, reason: 'ALREADY_FINALIZED', operation: safeResultSummary(open().savedResult(operationId))};
      }
      if (apply !== true) throw new CashuRuntimeError('APPLY_REQUIRED', 'check requires explicit apply');
      if (typeof transport !== 'function') throw new CashuRuntimeError('TRANSPORT_REQUIRED');
      const result = await recovery.checkInputStates(operationId, transport);
      return {
        applied: true,
        states: {unspent: result.unspent, pending: result.pending, spent: result.spent},
        operation: safeOperationView(open().get(operationId), journal),
      };
    },

    pending() { return open().pending().map(safeOutboxEvent); },

    // Trusted adapter seam. The adapter must authenticate the tenant and record
    // one verified payment per operation; it is never the invoice owner-credit
    // path and this module never imports the application invoice ledger.
    async deliver(adapter) {
      if (!adapter || typeof adapter.credit !== 'function') {
        throw new CashuRuntimeError('INVALID_LEDGER', 'delivery requires an idempotent credit(event) adapter');
      }
      return open().pending().length === 0
        ? {delivered: 0, pending: 0}
        : recovery.deliver(adapter);
    },

    // Explicit integration seam for a future receiving adapter. No route,
    // startup worker or native wallet enablement is created by exporting it.
    integration: Object.freeze({
      prepare: input => {
        open();
        return recovery.prepare(input);
      },
      submit: (operationId, transport) => {
        open();
        return recovery.submit(operationId, transport);
      },
    }),

    close() {
      if (closed) return;
      closed = true;
      journal.close();
    },
  });
}

export {CashuJournalError, CashuRecoveryError};
