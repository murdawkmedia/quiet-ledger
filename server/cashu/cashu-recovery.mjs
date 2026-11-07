// Cashu receive recovery orchestration over CashuJournal.
//
// The caller owns:
//   * merchant wallet custody, seed/key storage and output (blinding) generation
//   * the actual HTTP transport and its timeouts/allowlist
//   * the ledger adapter, which must be idempotent on operationId
//
// This module owns:
//   * preview normalization and exact-request replay through the pinned SDK
//   * NUT-09 restore of the persisted original blinded outputs (preferred)
//   * NUT-07 checkstate observation of every committed input Y
//   * fee/amount/keyset checks
//   * response shape, point, amount and DLEQ validation
//   * durable uncertainty before the transport call
//   * fail-closed recovery for spent/timeout/unknown outcomes
//   * projection of one bookkeeping-only outbox event per operation
//
// Recovery policy: NUT-09 restore is the default. Automatic swap replay is
// disabled unless the caller explicitly configures
// `swapReplayPolicy: 'byte-identical-single-request'`; the journal then only
// reuses the exact committed original request bytes, one request per phase.

import { CashuJournalError, canonicalMintUrl } from './cashu-journal.mjs';

export class CashuRecoveryError extends Error {
  constructor(code, message = code, cause) {
    super(`${code}: ${message}`, cause ? { cause } : undefined);
    this.name = 'CashuRecoveryError';
    this.code = code;
  }
}

const REPLAY_POLICIES = new Set(['none', 'byte-identical-single-request']);
const CHECK_STATES = new Set(['UNSPENT', 'PENDING', 'SPENT']);
const MAX_OUTPUTS = 64;
const MAX_INPUTS = 64;

function amountText(value, label = 'amount') {
  let text;
  if (typeof value === 'bigint') text = value.toString();
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new CashuRecoveryError('INVALID_AMOUNT', `${label} is not safe`);
    text = String(value);
  } else if (typeof value === 'string' && /^[0-9]+$/.test(value)) text = value;
  else if (value && typeof value.toString === 'function') text = String(value.toString());
  else throw new CashuRecoveryError('INVALID_AMOUNT', `${label} is not an integer`);
  if (!/^[0-9]+$/.test(text)) throw new CashuRecoveryError('INVALID_AMOUNT', `${label} is not decimal`);
  return BigInt(text).toString();
}

function sumProofs(proofs) {
  let total = 0n;
  for (const proof of proofs) total += BigInt(amountText(proof.amount));
  return total;
}

function isHex32(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

function isPoint(value) {
  return typeof value === 'string' && /^0[23][0-9a-fA-F]{64}$/.test(value);
}

export class CashuReceiveRecovery {
  #transport = null;
  #attemptInProgress = false;

  constructor({
    journal, sdk, mintUrl, unit, keyset, maxFee = null,
    requireInputDleq = false, requireResponseDleq = true,
    mintInfo, swapReplayPolicy = 'none',
  }) {
    if (!mintInfo || typeof mintInfo !== 'object' || Array.isArray(mintInfo) || !mintInfo.nuts || typeof mintInfo.nuts !== 'object' || Array.isArray(mintInfo.nuts)) {
      throw new CashuRecoveryError('INVALID_MINT_INFO', 'explicit mint metadata is required');
    }
    if (!journal || typeof journal.prepare !== 'function') {
      throw new CashuRecoveryError('INVALID_JOURNAL');
    }
    if (!sdk || typeof sdk.Mint !== 'function' || typeof sdk.Wallet !== 'function' ||
        typeof sdk.KeyChain?.mintToCacheDTO !== 'function' ||
        typeof sdk.deriveKeysetId !== 'function' || typeof sdk.verifyMintSignatures !== 'function') {
      throw new CashuRecoveryError('INVALID_SDK');
    }
    if (!keyset || typeof keyset !== 'object' || !keyset.id || !keyset.keys ||
        typeof keyset.keys !== 'object') {
      throw new CashuRecoveryError('INVALID_KEYSET_CONFIG');
    }
    if (!REPLAY_POLICIES.has(swapReplayPolicy)) {
      throw new CashuRecoveryError('INVALID_REPLAY_POLICY',
        `swap replay policy must be one of ${[...REPLAY_POLICIES].join(', ')}`);
    }
    const inputFeePpk = keyset.input_fee_ppk ?? 0;
    if (!Number.isSafeInteger(inputFeePpk) || inputFeePpk < 0) {
      throw new CashuRecoveryError('INVALID_KEYSET_CONFIG', 'input_fee_ppk must be a non-negative safe integer');
    }
    const derived = sdk.deriveKeysetId(keyset.keys, { unit, input_fee_ppk: inputFeePpk });
    if (derived !== keyset.id) {
      throw new CashuRecoveryError('KEYSET_ID_MISMATCH',
        'configured keyset id does not derive from its public keys, unit and fee');
    }
    this.journal = journal;
    this.sdk = sdk;
    this.unit = unit;
    this.keyset = {
      id: keyset.id,
      keys: { ...keyset.keys },
      input_fee_ppk: inputFeePpk,
    };
    this.maxFee = maxFee == null ? null : BigInt(amountText(maxFee, 'maxFee'));
    this.requireResponseDleq = requireResponseDleq;
    this.requireInputDleq = requireInputDleq;
    this.swapReplayPolicy = swapReplayPolicy;
    this.mintUrl = canonicalMintUrl(sdk, mintUrl);

    const mint = new sdk.Mint(this.mintUrl, { customRequest: args => this.#dispatch(args) });
    const wallet = new sdk.Wallet(mint, { unit });
    wallet.loadMintFromCache(
      mintInfo,
      sdk.KeyChain.mintToCacheDTO(
        this.mintUrl,
        [{ id: this.keyset.id, unit, active: true, input_fee_ppk: inputFeePpk }],
        [{ id: this.keyset.id, unit, keys: this.keyset.keys }],
      ),
    );
    if (!wallet.keyChain.getKeyset(this.keyset.id).hasKeys) {
      throw new CashuRecoveryError('KEYSET_NOT_LOADED',
        'pinned SDK dropped the configured keyset; check keyset id, unit and fee');
    }
    this.mint = mint;
    this.wallet = wallet;
  }

  #dispatch(args) {
    if (!this.#transport) {
      throw new CashuRecoveryError('NO_ACTIVE_ATTEMPT',
        'wallet transport was called outside a journaled attempt');
    }
    return this.#transport(args);
  }

  #getKeyset(id) {
    if (id !== this.keyset.id) throw new CashuRecoveryError('UNKNOWN_KEYSET', 'proof uses an unconfigured keyset');
    return { id: this.keyset.id, keys: this.keyset.keys };
  }

  #assertSwapRequest(args) {
    if (!args || args.method !== 'POST') {
      throw new CashuRecoveryError('UNEXPECTED_TRANSPORT', 'only POST is allowed');
    }
    if (args.endpoint !== `${this.mintUrl}/v1/swap`) {
      throw new CashuRecoveryError('UNEXPECTED_ENDPOINT', `only ${this.mintUrl}/v1/swap is allowed`);
    }
    const body = args.requestBody;
    if (!body || typeof body !== 'object' || !Array.isArray(body.inputs) ||
        !Array.isArray(body.outputs) || body.inputs.length < 1 || body.outputs.length < 1) {
      throw new CashuRecoveryError('INVALID_SWAP_REQUEST', 'request must contain inputs and outputs');
    }
    for (const entry of [...body.inputs, ...body.outputs]) {
      if (entry.id !== this.keyset.id) {
        throw new CashuRecoveryError('UNKNOWN_KEYSET', 'swap request uses an unconfigured keyset');
      }
    }
  }

  #assertSwapResponse(args, response) {
    if (!response || typeof response !== 'object' || !Array.isArray(response.signatures)) {
      throw new CashuRecoveryError('INVALID_MINT_RESPONSE', 'response has no signatures array');
    }
    const outputs = args.requestBody.outputs;
    if (response.signatures.length !== outputs.length) {
      throw new CashuRecoveryError('RESPONSE_COUNT_MISMATCH',
        'response signature count does not match blinded output count');
    }
    const seen = new Set();
    for (let index = 0; index < outputs.length; index++) {
      const output = outputs[index];
      const signature = response.signatures[index];
      if (!signature || typeof signature !== 'object') {
        throw new CashuRecoveryError('INVALID_MINT_RESPONSE', 'signature entry is not an object');
      }
      if (signature.id !== this.keyset.id || output.id !== this.keyset.id) {
        throw new CashuRecoveryError('RESPONSE_KEYSET_MISMATCH', 'response uses an unconfigured keyset');
      }
      if (String(signature.amount) !== String(output.amount)) {
        throw new CashuRecoveryError('RESPONSE_AMOUNT_MISMATCH',
          'response amount does not match the blinded output amount');
      }
      if (!isPoint(signature.C_)) {
        throw new CashuRecoveryError('RESPONSE_SIGNATURE_INVALID', 'C_ is not a compressed secp256k1 point');
      }
      try { this.sdk.pointFromHex(signature.C_); }
      catch (error) {
        throw new CashuRecoveryError('RESPONSE_SIGNATURE_INVALID', 'C_ is not on secp256k1', error);
      }
      if (seen.has(signature.C_)) {
        throw new CashuRecoveryError('RESPONSE_DUPLICATE_SIGNATURE', 'response repeats a signature point');
      }
      seen.add(signature.C_);
      if (this.requireResponseDleq) {
        if (!signature.dleq || !isHex32(signature.dleq.e) || !isHex32(signature.dleq.s)) {
          throw new CashuRecoveryError('RESPONSE_DLEQ_MISSING', 'response omitted a NUT-12 DLEQ proof');
        }
      }
    }
  }

  #assertRestoreRequest(args, payload) {
    if (!args || args.method !== 'POST') {
      throw new CashuRecoveryError('UNEXPECTED_TRANSPORT', 'restore must be a POST');
    }
    if (args.endpoint !== `${this.mintUrl}/v1/restore`) {
      throw new CashuRecoveryError('UNEXPECTED_ENDPOINT', `only ${this.mintUrl}/v1/restore is allowed`);
    }
    if (!args.requestBody || typeof args.requestBody !== 'object' ||
        JSON.stringify(args.requestBody) !== JSON.stringify(payload)) {
      throw new CashuRecoveryError('RESTORE_PAYLOAD_CHANGED',
        'SDK restore payload differs from the persisted original blinded outputs');
    }
  }

  #assertCheckRequest(args, Ys) {
    if (!args || args.method !== 'POST') {
      throw new CashuRecoveryError('UNEXPECTED_TRANSPORT', 'checkstate must be a POST');
    }
    if (args.endpoint !== `${this.mintUrl}/v1/checkstate`) {
      throw new CashuRecoveryError('UNEXPECTED_ENDPOINT', `only ${this.mintUrl}/v1/checkstate is allowed`);
    }
    const body = args.requestBody;
    if (!body || typeof body !== 'object' || !Array.isArray(body.Ys) ||
        body.Ys.length !== Ys.length || body.Ys.some((Y, index) => Y !== Ys[index])) {
      throw new CashuRecoveryError('CHECK_PAYLOAD_CHANGED', 'SDK check payload differs from the expected Y set');
    }
  }

  #outputKey(output) {
    if (!output || typeof output !== 'object') {
      throw new CashuRecoveryError('INVALID_OUTPUT', 'blinded output is missing');
    }
    if (output.id !== this.keyset.id) {
      throw new CashuRecoveryError('UNKNOWN_KEYSET', 'blinded output uses an unconfigured keyset');
    }
    const amount = amountText(output.amount, 'output.amount');
    if (BigInt(amount) <= 0n) throw new CashuRecoveryError('INVALID_AMOUNT', 'output amount must be positive');
    if (!isPoint(output.B_)) {
      throw new CashuRecoveryError('INVALID_OUTPUT', 'output B_ is not a compressed secp256k1 point');
    }
    return `${output.id}\u0000${amount}\u0000${output.B_.toLowerCase()}`;
  }

  // Restore is bound to the blinded outputs already persisted with the
  // preparation and byte-committed in the original swap request. No new
  // outputs, blinding factors, secrets or counters are generated here.
  #savedReceiveOutputs(operation) {
    if (!this.journal.requestOf || typeof this.journal.requestOf !== 'function') {
      throw new CashuRecoveryError('INVALID_JOURNAL');
    }
    const originalRequest = this.journal.requestOf(operation.opId);
    if (!operation.requestHash || !originalRequest) {
      throw new CashuRecoveryError('ORIGINAL_REQUEST_MISSING', 'no committed swap request exists to restore');
    }
    let body;
    try { body = JSON.parse(originalRequest); } catch (error) {
      throw new CashuRecoveryError('ORIGINAL_REQUEST_INVALID', 'committed swap request is not JSON', error);
    }
    if (!body || typeof body !== 'object' || !Array.isArray(body.outputs) ||
        body.outputs.length < 1 || body.outputs.length > MAX_OUTPUTS) {
      throw new CashuRecoveryError('ORIGINAL_REQUEST_INVALID', 'committed swap request has no bounded outputs');
    }
    let preview;
    try { preview = this.sdk.deserializeSwapPreview(operation.preview); } catch (error) {
      throw new CashuRecoveryError('SAVED_OUTPUTS_INVALID', 'stored swap preview cannot be deserialized', error);
    }
    const outputData = preview?.keepOutputs;
    if (!Array.isArray(outputData) || outputData.length !== body.outputs.length) {
      throw new CashuRecoveryError('SAVED_OUTPUT_MISMATCH',
        'stored receive outputs do not match the committed swap request count');
    }
    if (JSON.stringify(this.sdk.serializeSwapPreview(preview)) !== JSON.stringify(operation.preview)) {
      throw new CashuRecoveryError('SAVED_OUTPUT_MISMATCH', 'stored swap preview is not byte-stable');
    }
    const byKey = new Map();
    let outputTotal = 0n;
    for (const output of outputData) {
      const key = this.#outputKey(output?.blindedMessage);
      if (byKey.has(key)) throw new CashuRecoveryError('DUPLICATE_OUTPUT', 'stored receive outputs repeat');
      byKey.set(key, output);
      outputTotal += BigInt(amountText(output.blindedMessage.amount));
    }
    if (outputTotal !== BigInt(operation.expectedAmount)) {
      throw new CashuRecoveryError('SAVED_OUTPUT_AMOUNT_MISMATCH',
        'stored receive output total does not equal the invoice amount');
    }
    const matched = new Set();
    for (const output of body.outputs) {
      const key = this.#outputKey(output);
      if (!byKey.has(key)) {
        throw new CashuRecoveryError('SAVED_OUTPUT_MISMATCH',
          'committed request contains an output that is not in the stored preview');
      }
      matched.add(key);
    }
    if (matched.size !== outputData.length) {
      throw new CashuRecoveryError('SAVED_OUTPUT_MISMATCH', 'committed request does not cover every stored output');
    }
    return {
      outputData,
      payload: { outputs: body.outputs.map(output => ({ ...output })) },
    };
  }

  #assertRestoreResponse(payload, response, outputData) {
    if (!response || typeof response !== 'object') {
      throw new CashuRecoveryError('INVALID_RESTORE_RESPONSE', 'restore response is not an object');
    }
    const outputs = response.outputs, signatures = response.signatures;
    if (!Array.isArray(outputs) || !Array.isArray(signatures) || outputs.length !== signatures.length) {
      throw new CashuRecoveryError('INVALID_RESTORE_RESPONSE', 'restore response arrays are missing or unequal');
    }
    if (outputs.length !== outputData.length) {
      throw new CashuRecoveryError('INCOMPLETE_RESTORE',
        `restore returned ${outputs.length} of ${outputData.length} persisted outputs`);
    }
    const expected = new Map();
    for (let index = 0; index < outputData.length; index++) {
      expected.set(this.#outputKey(outputData[index].blindedMessage), index);
    }
    const pairs = new Array(outputData.length);
    const seen = new Set();
    for (let index = 0; index < outputs.length; index++) {
      const output = outputs[index], signature = signatures[index];
      let key;
      try { key = this.#outputKey(output); } catch (error) {
        throw new CashuRecoveryError('RESTORE_OUTPUT_FOREIGN', 'restore output is not a valid configured output', error);
      }
      const match = expected.get(key);
      if (match == null) {
        throw new CashuRecoveryError('RESTORE_OUTPUT_FOREIGN', 'restore output was not in the original request');
      }
      if (seen.has(key)) throw new CashuRecoveryError('RESTORE_OUTPUT_DUPLICATE', 'restore repeats an output');
      seen.add(key);
      if (!signature || typeof signature !== 'object') {
        throw new CashuRecoveryError('INVALID_MINT_RESPONSE', 'restore signature entry is not an object');
      }
      if (signature.id !== this.keyset.id) {
        throw new CashuRecoveryError('RESPONSE_KEYSET_MISMATCH', 'restore signature uses an unconfigured keyset');
      }
      const outputAmount = amountText(outputData[match].blindedMessage.amount);
      if (String(signature.amount) !== outputAmount) {
        throw new CashuRecoveryError('RESPONSE_AMOUNT_MISMATCH',
          'restore signature amount does not match the persisted output amount');
      }
      if (!isPoint(signature.C_)) {
        throw new CashuRecoveryError('RESPONSE_SIGNATURE_INVALID', 'restore C_ is not a compressed secp256k1 point');
      }
      try { this.sdk.pointFromHex(signature.C_); } catch (error) {
        throw new CashuRecoveryError('RESPONSE_SIGNATURE_INVALID', 'restore C_ is not on secp256k1', error);
      }
      if (this.requireResponseDleq) {
        if (!signature.dleq || !isHex32(signature.dleq.e) || !isHex32(signature.dleq.s)) {
          throw new CashuRecoveryError('RESPONSE_DLEQ_MISSING', 'restore omitted a NUT-12 DLEQ proof');
        }
      }
      const duplicatePoint = pairs.find(pair => pair?.signature.C_ === signature.C_);
      if (duplicatePoint) {
        throw new CashuRecoveryError('RESPONSE_DUPLICATE_SIGNATURE', 'restore repeats a signature point');
      }
      pairs[match] = { outputData: outputData[match], signature };
    }
    if (seen.size !== outputData.length) {
      throw new CashuRecoveryError('INCOMPLETE_RESTORE', 'restore did not cover every persisted output');
    }
    if (pairs.some(pair => !pair)) {
      throw new CashuRecoveryError('INCOMPLETE_RESTORE', 'restore did not map every persisted output');
    }
    if (payload.outputs.length !== outputData.length) {
      throw new CashuRecoveryError('INVALID_RESTORE_REQUEST');
    }
    return pairs;
  }

  async #unblindRestored(operation, pairs) {
    const proofs = [];
    const secrets = new Set();
    for (const { outputData, signature } of pairs) {
      let proof;
      try {
        proof = outputData.toProof(signature, { id: this.keyset.id, keys: this.keyset.keys });
      } catch (error) {
        throw new CashuRecoveryError('RESTORE_UNBLIND_FAILED',
          'stored output could not be unblinded with the restored signature', error);
      }
      if (!proof || typeof proof.secret !== 'string' || !proof.secret.length) {
        throw new CashuRecoveryError('INVALID_PROOF', 'unblinded proof has no secret');
      }
      if (secrets.has(proof.secret)) throw new CashuRecoveryError('DUPLICATE_PROOF', 'restored proofs repeat');
      secrets.add(proof.secret);
      proofs.push(proof);
    }
    await this.#assertReceivedProofs(operation, proofs);
    return proofs;
  }

  #observeFailure(operationId, outcome) {
    try {
      const operation = this.journal.get(operationId);
      if (operation?.state === 'uncertain') this.journal.observe(operationId, outcome);
    } catch { /* failure observation is best-effort; the primary error wins */ }
  }

  async #assertReceivedProofs(operation, proofs) {
    if (!Array.isArray(proofs) || proofs.length < 1) {
      throw new CashuRecoveryError('EMPTY_RESULT', 'the mint returned no merchant proofs');
    }
    const secrets = new Set();
    const points = new Set();
    for (const proof of proofs) {
      if (!proof || proof.id !== this.keyset.id) {
        throw new CashuRecoveryError('UNKNOWN_KEYSET', 'merchant proof is not from the configured keyset');
      }
      const amount = amountText(proof.amount);
      if (BigInt(amount) <= 0n) throw new CashuRecoveryError('INVALID_AMOUNT', 'merchant proof amount must be positive');
      if (typeof proof.secret !== 'string' || !proof.secret.length) {
        throw new CashuRecoveryError('INVALID_PROOF', 'merchant proof secret is missing');
      }
      if (secrets.has(proof.secret)) throw new CashuRecoveryError('DUPLICATE_PROOF', 'merchant proof secret repeats');
      secrets.add(proof.secret);
      if (typeof proof.C !== 'string' || !isPoint(proof.C)) {
        throw new CashuRecoveryError('INVALID_PROOF', 'merchant proof C is not a compressed point');
      }
      if (points.has(proof.C)) throw new CashuRecoveryError('DUPLICATE_PROOF', 'merchant proof point repeats');
      points.add(proof.C);
    }
    const received = sumProofs(proofs);
    const expected = BigInt(operation.expectedAmount);
    if (received !== expected) {
      throw new CashuRecoveryError('AMOUNT_MISMATCH', `received ${received} but invoice requires ${expected}`);
    }
    const inputTotal = sumProofs(operation.inputs);
    const fee = BigInt(operation.expectedFee);
    if (inputTotal !== received + fee) {
      throw new CashuRecoveryError('FEE_MISMATCH', 'input total, received amount and fee disagree');
    }
    let verification;
    try {
      verification = await this.sdk.verifyMintSignatures(proofs, id => this.#getKeyset(id), { require: true });
    } catch (error) {
      throw new CashuRecoveryError('SIGNATURE_VERIFICATION_FAILED', 'mint signature verification failed', error);
    }
    if (verification.invalid.length > 0 || verification.valid.length !== proofs.length) {
      const reason = verification.invalid[0]?.error?.message || 'unknown verification failure';
      throw new CashuRecoveryError('INVALID_MINT_SIGNATURE',
        `merchant proofs did not pass NUT-12 signature/DLEQ verification: ${reason}`);
    }
  }

  async prepare({ operationId, invoiceId, inputs, outputs, expectedAmount }) {
    if (expectedAmount == null) {
      throw new CashuRecoveryError('EXPECTED_AMOUNT_REQUIRED',
        'invoice net amount is required so an underpayment cannot be credited');
    }
    if (!Array.isArray(outputs) || outputs.length < 1 || outputs.length > 64) {
      throw new CashuRecoveryError('INVALID_OUTPUTS', 'outputs must contain 1..64 blinded outputs');
    }
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 64) {
      throw new CashuRecoveryError('INVALID_INPUTS', 'inputs must contain 1..64 proofs');
    }
    const preview = await this.wallet.prepareSwapToReceive(
      inputs,
      { requireDleq: this.requireInputDleq },
      { type: 'custom', data: outputs },
    );
    if (!preview || preview.keysetId !== this.keyset.id) {
      throw new CashuRecoveryError('PREVIEW_KEYSET_MISMATCH', 'preview did not use the configured keyset');
    }
    if (preview.inputs.length !== inputs.length) {
      throw new CashuRecoveryError('PREVIEW_INPUT_MISMATCH', 'preview changed the input count');
    }
    for (const output of preview.keepOutputs ?? []) {
      if (output?.blindedMessage?.id !== this.keyset.id) {
        throw new CashuRecoveryError('PREVIEW_KEYSET_MISMATCH', 'preview output uses an unconfigured keyset');
      }
    }
    const amount = amountText(preview.amount);
    const fee = amountText(preview.fees);
    const inputTotal = sumProofs(preview.inputs);
    if (inputTotal !== BigInt(amount) + BigInt(fee)) {
      throw new CashuRecoveryError('PREVIEW_INCONSISTENT', 'preview inputs do not equal amount plus fee');
    }
    const sdkFee = this.wallet.getFeesForProofs(preview.inputs);
    if (amountText(sdkFee) !== fee) {
      throw new CashuRecoveryError('FEE_MISMATCH', 'preview fee disagrees with the SDK keyset fee');
    }
    if (this.maxFee != null && BigInt(fee) > this.maxFee) {
      throw new CashuRecoveryError('FEE_EXCEEDS_POLICY', `fee ${fee} exceeds configured maximum ${this.maxFee}`);
    }
    if (expectedAmount != null && BigInt(amountText(expectedAmount, 'expectedAmount')) !== BigInt(amount)) {
      throw new CashuRecoveryError('AMOUNT_MISMATCH', 'preview net amount does not equal the invoice amount');
    }

    const serialized = this.sdk.serializeSwapPreview(preview);
    const normalized = this.sdk.deserializeSwapPreview(serialized);
    const reserialized = this.sdk.serializeSwapPreview(normalized);
    if (JSON.stringify(serialized) !== JSON.stringify(reserialized)) {
      throw new CashuRecoveryError('PREVIEW_NOT_STABLE', 'SDK preview did not reserialize byte-stably');
    }

    return this.journal.prepare({
      operationId,
      invoiceId,
      mint: this.mintUrl,
      unit: this.unit,
      keysetId: this.keyset.id,
      inputs: preview.inputs,
      expectedAmount: amount,
      expectedFee: fee,
      preview: serialized,
    });
  }

  async submit(operationId, transport, { recovery = false } = {}) {
    if (typeof transport !== 'function') {
      throw new CashuRecoveryError('INVALID_TRANSPORT', 'transport must be a function');
    }
    if (recovery && this.swapReplayPolicy !== 'byte-identical-single-request') {
      throw new CashuRecoveryError('SWAP_REPLAY_DISABLED',
        'automatic swap replay requires the explicitly configured byte-identical-single-request policy; use NUT-09 restore');
    }
    const operation = this.journal.get(operationId);
    if (!operation) throw new CashuRecoveryError('OPERATION_NOT_FOUND');
    if (operation.mint !== this.mintUrl || operation.unit !== this.unit || operation.keysetId !== this.keyset.id) {
      throw new CashuRecoveryError('OPERATION_SCOPE_MISMATCH', 'operation belongs to a different mint, unit or keyset');
    }
    if (operation.state === 'finalized') return this.journal.savedResult(operationId);
    if (operation.state === 'uncertain' && this.swapReplayPolicy !== 'byte-identical-single-request') {
      throw new CashuRecoveryError('SWAP_REPLAY_DISABLED',
        'a committed attempt may not be resubmitted without the explicit byte-identical-single-request policy; use NUT-09 restore');
    }
    if (recovery && operation.state !== 'uncertain') {
      throw new CashuRecoveryError('NOT_UNCERTAIN', 'recovery requires a committed but unresolved attempt');
    }
    if (this.journal.observations(operationId).some(observation => observation.outcome === 'SPENT')) {
      throw new CashuRecoveryError('INPUT_SPENT',
        'inputs are marked spent without a merchant result; fail closed for manual reconciliation');
    }

    if (this.#attemptInProgress) throw new CashuRecoveryError('ATTEMPT_IN_PROGRESS', 'another attempt is still resolving');
    const lease = this.journal.acquireAttempt(operationId);
    this.#attemptInProgress = true;
    try {
      let requests = 0;
      this.#transport = async args => {
        this.#assertSwapRequest(args);
        if (requests >= 1) throw new CashuRecoveryError('UNEXPECTED_TRANSPORT_REPLAY', 'one SDK attempt may submit only one swap');
        requests++;
        const requestJson = JSON.stringify(args.requestBody);
        // Durable original request and uncertainty precede the transport effect.
        this.journal.beginAttempt(operationId, requestJson);
        const response = await transport(args);
        this.#assertSwapResponse(args, response);
        return response;
      };
      let completed;
      try {
        const preview = this.sdk.deserializeSwapPreview(operation.preview);
        completed = await this.wallet.completeSwap(preview);
      } finally {
        this.#transport = null;
      }
      if (!completed || !Array.isArray(completed.keep)) {
        throw new CashuRecoveryError('INVALID_SWAP_RESULT', 'SDK returned no keep proofs');
      }
      if (completed.send?.length) {
        throw new CashuRecoveryError('UNEXPECTED_SEND_PROOFS', 'receive unexpectedly produced send proofs');
      }
      if (requests === 0) {
        throw new CashuRecoveryError('TRANSPORT_NOT_CALLED', 'SDK did not submit the swap request');
      }
      await this.#assertReceivedProofs(operation, completed.keep);
      return this.journal.complete(operationId, completed.keep);
    } finally { this.#transport = null; this.#attemptInProgress = false; this.journal.releaseAttempt(operationId, lease); }
  }

  #assertScope(operation) {
    if (operation.mint !== this.mintUrl || operation.unit !== this.unit ||
        operation.keysetId !== this.keyset.id) {
      throw new CashuRecoveryError('OPERATION_SCOPE_MISMATCH',
        'operation belongs to a different mint, unit or keyset');
    }
  }

  async recover(operationId, transport) {
    return this.submit(operationId, transport, { recovery: true });
  }

  // NUT-09: ask the mint to return the signatures for the blinded outputs it
  // already signed. This is read-only at the mint and creates no outputs,
  // secrets, counters or swaps. A complete, cryptographically valid response
  // binds to the persisted outputs and may reconcile an uncertain (even SPENT)
  // operation; states alone never can.
  async restore(operationId, transport) {
    if (typeof transport !== 'function') {
      throw new CashuRecoveryError('INVALID_TRANSPORT', 'transport must be a function');
    }
    const operation = this.journal.get(operationId);
    if (!operation) throw new CashuRecoveryError('OPERATION_NOT_FOUND');
    this.#assertScope(operation);
    if (operation.state === 'finalized') return this.journal.savedResult(operationId);
    if (operation.state !== 'uncertain') {
      throw new CashuRecoveryError('NOT_UNCERTAIN', 'restore requires a committed but unresolved attempt');
    }
    if (this.#attemptInProgress) {
      throw new CashuRecoveryError('ATTEMPT_IN_PROGRESS', 'another attempt is still resolving');
    }
    const lease = this.journal.acquireAttempt(operationId);
    this.#attemptInProgress = true;
    try {
      const { outputData, payload } = this.#savedReceiveOutputs(operation);
      const payloadJson = JSON.stringify(payload);
      if (this.journal.beginRestoreAttempt(operationId, payloadJson) === false) {
        return this.journal.savedResult(operationId);
      }
      let requests = 0, responseReceived = false;
      this.#transport = async args => {
        this.#assertRestoreRequest(args, payload);
        if (requests >= 1) {
          throw new CashuRecoveryError('UNEXPECTED_TRANSPORT_REPLAY', 'one restore phase may send one request');
        }
        requests++;
        const response = await transport(args);
        responseReceived = true;
        return response;
      };
      let response;
      try {
        response = await this.mint.restore(payload);
      } catch (error) {
        if (!(error instanceof CashuRecoveryError)) this.#observeFailure(operationId, responseReceived ? 'INVALID_RESPONSE' : 'RESTORE_UNAVAILABLE');
        throw error;
      } finally {
        this.#transport = null;
      }
      if (requests === 0) {
        throw new CashuRecoveryError('TRANSPORT_NOT_CALLED', 'SDK did not submit the restore request');
      }
      let proofs;
      try {
        const pairs = this.#assertRestoreResponse(payload, response, outputData);
        proofs = await this.#unblindRestored(operation, pairs);
      } catch (error) {
        this.#observeFailure(operationId, 'INVALID_RESPONSE');
        throw error;
      }
      return this.journal.completeRestored(operationId, proofs, payloadJson);
    } finally {
      this.#transport = null;
      this.#attemptInProgress = false; this.journal.releaseAttempt(operationId, lease);
    }
  }

  // NUT-07: observe the state of every committed input Y exactly once per
  // phase. Observations are append-only audit data: any historical SPENT stays
  // SPENT and no state can create a result, outbox event or ledger credit.
  async checkInputStates(operationId, transport) {
    if (typeof transport !== 'function') {
      throw new CashuRecoveryError('INVALID_TRANSPORT', 'transport must be a function');
    }
    const operation = this.journal.get(operationId);
    if (!operation) throw new CashuRecoveryError('OPERATION_NOT_FOUND');
    this.#assertScope(operation);
    if (operation.state !== 'uncertain') {
      throw new CashuRecoveryError('NOT_UNCERTAIN', 'check requires a committed but unresolved attempt');
    }
    const Ys = [];
    for (const proof of operation.inputs) {
      if (typeof proof.secret !== 'string' || !proof.secret.length) {
        throw new CashuRecoveryError('INVALID_PROOF', 'input secret is missing');
      }
      const Y = this.sdk.hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true);
      if (!isPoint(Y)) throw new CashuRecoveryError('INVALID_CHECK_POINT', 'input Y is not a curve point');
      Ys.push(Y);
    }
    if (Ys.length < 1 || Ys.length > MAX_INPUTS || new Set(Ys).size !== Ys.length) {
      throw new CashuRecoveryError('DUPLICATE_Y', 'input Y set is empty, too large or repeats');
    }
    if (this.#attemptInProgress) {
      throw new CashuRecoveryError('ATTEMPT_IN_PROGRESS', 'another attempt is still resolving');
    }
    const lease = this.journal.acquireAttempt(operationId);
    this.#attemptInProgress = true;
    try {
      let requests = 0, responseReceived = false;
      this.#transport = async args => {
        this.#assertCheckRequest(args, Ys);
        if (requests >= 1) {
          throw new CashuRecoveryError('UNEXPECTED_TRANSPORT_REPLAY', 'one check phase may send one request');
        }
        requests++;
        const response = await transport(args);
        responseReceived = true;
        return response;
      };
      let response;
      try {
        response = await this.mint.check({ Ys });
      } catch (error) {
        if (!(error instanceof CashuRecoveryError)) this.#observeFailure(operationId, responseReceived ? 'INVALID_RESPONSE' : 'NETWORK_ERROR');
        throw error;
      } finally {
        this.#transport = null;
      }
      if (requests === 0) {
        throw new CashuRecoveryError('TRANSPORT_NOT_CALLED', 'SDK did not submit the check request');
      }
      if (!response || typeof response !== 'object' || !Array.isArray(response.states) ||
          response.states.length !== Ys.length) {
        this.#observeFailure(operationId, 'INVALID_RESPONSE');
        throw new CashuRecoveryError('INVALID_CHECK_RESPONSE',
          'check response must report exactly one state for every expected Y');
      }
      const expected = new Map(Ys.map((Y, index) => [Y, index]));
      const byY = new Map();
      for (const entry of response.states) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          this.#observeFailure(operationId, 'INVALID_RESPONSE');
          throw new CashuRecoveryError('INVALID_CHECK_RESPONSE', 'check state entry is not an object');
        }
        if (typeof entry.Y !== 'string' || entry.Y !== entry.Y.toLowerCase() || !isPoint(entry.Y)) {
          this.#observeFailure(operationId, 'INVALID_RESPONSE');
          throw new CashuRecoveryError('INVALID_CHECK_RESPONSE', 'check state Y is not canonical compressed-point hex');
        }
        if (!expected.has(entry.Y)) {
          this.#observeFailure(operationId, 'INVALID_RESPONSE');
          throw new CashuRecoveryError('CHECK_UNKNOWN_Y', 'check response contains an unknown Y');
        }
        if (byY.has(entry.Y)) {
          this.#observeFailure(operationId, 'INVALID_RESPONSE');
          throw new CashuRecoveryError('CHECK_DUPLICATE_Y', 'check response repeats a Y');
        }
        if (!CHECK_STATES.has(entry.state)) {
          this.#observeFailure(operationId, 'INVALID_RESPONSE');
          throw new CashuRecoveryError('INVALID_CHECK_STATE', 'check response contains an unsupported state');
        }
        if (entry.witness != null && (typeof entry.witness !== 'string' || Buffer.byteLength(entry.witness, 'utf8') > 8192)) {
          this.#observeFailure(operationId, 'INVALID_RESPONSE');
          throw new CashuRecoveryError('INVALID_CHECK_RESPONSE', 'check witness is malformed');
        }
        byY.set(entry.Y, entry.state);
      }
      if (byY.size !== Ys.length) {
        this.#observeFailure(operationId, 'INVALID_RESPONSE');
        throw new CashuRecoveryError('INCOMPLETE_CHECK', 'check response omitted an expected Y');
      }
      const states = Ys.map(Y => byY.get(Y));
      for (const state of states) this.journal.observe(operationId, state);
      const count = state => states.filter(value => value === state).length;
      return {
        states,
        unspent: count('UNSPENT'),
        pending: count('PENDING'),
        spent: count('SPENT'),
      };
    } finally {
      this.#transport = null;
      this.#attemptInProgress = false; this.journal.releaseAttempt(operationId, lease);
    }
  }

  // Recovery entrypoint. Restore is the default and preferred path; swap
  // replay must be named explicitly and requires the configured policy.
  async reconcile(operationId, transport, { mode = 'restore' } = {}) {
    if (mode === 'restore') return this.restore(operationId, transport);
    if (mode === 'check') return this.checkInputStates(operationId, transport);
    if (mode === 'swap-replay') return this.recover(operationId, transport);
    throw new CashuRecoveryError('INVALID_RECONCILE_MODE', 'mode must be restore, check or swap-replay');
  }

  observe(operationId, outcome) {
    return this.journal.observe(operationId, outcome);
  }

  async deliver(ledger) {
    if (!ledger || typeof ledger.credit !== 'function') {
      throw new CashuRecoveryError('INVALID_LEDGER', 'ledger must expose an idempotent credit(event)');
    }
    let delivered = 0;
    for (const event of this.journal.pending()) {
      await ledger.credit(event);
      this.journal.ack(event.operationId);
      delivered++;
    }
    return { delivered, pending: this.journal.pending().length };
  }

  close() {
    this.journal.close();
  }
}

export { CashuJournalError };
