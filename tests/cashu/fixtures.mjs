// Test-only controlled Cashu mint fixture.
//
// CRYPTOGRAPHIC PROVENANCE AND BOUNDARY
// - Mint private scalars 1 and 2 are explicitly published *test* material:
//   NUT-00 tests ("mint private key: 000...001") and NUT-12 tests ("a: 000...002").
//   They are public fixture constants, not wallet seeds and not production secrets.
// - Proof/output secrets and blinding scalars are published NUT-00 test vectors.
// - NUT-12 DLEQ proofs are produced by the pinned SDK's createDLEQProof.
// - The fake mint only exists so the pinned SDK can validate real curve math,
//   unblinding and DLEQ locally. No network, wallet seed, funded mint or real
//   ecash is involved.
//
// This file must never be imported by application runtime code.
//
// Public-source adaptation: the pinned SDK is imported by its standard package
// name and the production core is imported from server/cashu/. The numeric
// published vectors, controlled-mint behavior and provenance are unchanged from
// the frozen qualification fixture.

import * as sdk from '@cashu/cashu-ts';
import { createHash } from 'node:crypto';
import { CashuReceiveRecovery } from '../../server/cashu/cashu-recovery.mjs';

export { sdk };

export const mintUrl = 'https://quiet-ledger.invalid';
export const unit = 'sat';
export const invoiceId = 'fictional-invoice-2026-11-06';

// Exactly published fixture material. Not secrets in any production sense.
export const FIXTURE_MINT_PRIVATE_KEY = Object.freeze({
  1: '0000000000000000000000000000000000000000000000000000000000000001',
  2: '0000000000000000000000000000000000000000000000000000000000000002',
});

export const PUBLISHED_VECTORS = Object.freeze({
  // NUT-00 tests, TokenV3 proof secrets.
  inputSecretAmount1: '407915bc212be61a77e3e6d2aeb4c727980bda51cd06a6afc29e2861768a7837',
  inputSecretAmount2: 'fe15109314e61d7756b0f8ee0f23a624acaa3f4e042f61433c728c7057b931be',
  // NUT-00 tests, blinded messages: x/r pairs. The SDK derives B_ itself.
  outputSecretAmount1: 'd341ee4871f1f889041e63cf0d3823c713eea6aff01e80f1719f08f9e5be98f6',
  outputScalarAmount1: '99fce58439fc37412ab3468b73db0569322588f62fb3a49182d67e23d877824a',
  outputSecretAmount2: 'f1aaf16c2239746f369572c0784d9dd3d032d952c2d992175873fb58fae31a60',
  outputScalarAmount2: 'f78476ea7cc9ade20f9e05e58a804cf19533f03ea805ece5fee88c8e2874ba50',
  // NUT-12 tests: valid Proof DLEQ vector, A = 1*G.
  nut12ValidProof: Object.freeze({
    amount: 1,
    id: '00882760bfa2eb41',
    secret: 'daf4dd00a2b68a0858a80450f52c8a7d2ccf87d375e43e216e0c571f089f63e9',
    C: '024369d2d22a80ecf78f3937da9d5f30c1b9f74f0c32684d583cca0fa6a61cdcfc',
    dleq: Object.freeze({
      e: 'b31e58ac6527f34975ffab13e70a48b6d2b0d35abc4b03f0151f09ee1a9763d4',
      s: '8fbae004c59e754d71df67e392b6ae4e29293113ddc2ec86592a0431d16306d8',
      r: 'a6d13fcd7a18442e6076f5e1e7c887ad5de40a019824bdfa9fe740d302e8d861',
    }),
  }),
});

const encoder = new TextEncoder();
const hex = value => Buffer.from(value, 'hex');
const scalarText = value => BigInt(value).toString(16).padStart(64, '0');

export function publicKeyFor(amount) {
  const privateKey = FIXTURE_MINT_PRIVATE_KEY[amount];
  if (!privateKey) throw new Error(`no published fixture mint key for amount ${amount}`);
  return Buffer.from(sdk.getPubKeyFromPrivKey(hex(privateKey))).toString('hex');
}

export function makeKeyset({ inputFeePpk = 0 } = {}) {
  const keys = { 1: publicKeyFor(1), 2: publicKeyFor(2) };
  const id = sdk.deriveKeysetId(keys, { unit, input_fee_ppk: inputFeePpk });
  return { id, unit, active: true, input_fee_ppk: inputFeePpk, keys };
}

// A crypto-valid payer proof signed by the published fixture mint key. The
// deterministic fixture blinding factor is r=1, so B_ = Y + G and the NUT-12
// proof DLEQ verifies with the SDK's real verifier.
export function makePayerProof(keyset, { amount, secret }) {
  const privateKey = FIXTURE_MINT_PRIVATE_KEY[amount];
  if (!privateKey) throw new Error(`no published fixture mint key for amount ${amount}`);
  const a = BigInt(privateKey);
  const r = 1n;
  const G = sdk.pointFromHex(publicKeyFor(1));
  const Y = sdk.hashToCurve(encoder.encode(secret));
  const B_ = Y.add(G.multiply(r));
  const dleq = sdk.createDLEQProof(B_, hex(privateKey));
  const C = Y.multiply(a);
  return {
    id: keyset.id,
    amount: String(amount),
    secret,
    C: C.toHex(true),
    dleq: {
      e: Buffer.from(dleq.e).toString('hex'),
      s: Buffer.from(dleq.s).toString('hex'),
      r: scalarText(r),
    },
  };
}

export function makePayerProofs(keyset, amounts = [1, 2]) {
  const secrets = {
    1: PUBLISHED_VECTORS.inputSecretAmount1,
    2: PUBLISHED_VECTORS.inputSecretAmount2,
  };
  return amounts.map(amount => {
    const secret = secrets[amount];
    if (!secret) throw new Error(`no published fixture input secret for amount ${amount}`);
    return makePayerProof(keyset, { amount, secret });
  });
}

export function makeOutputData(keyset, { amount, secret, scalar }) {
  const secretBytes = encoder.encode(secret);
  const blind = sdk.blindMessage(secretBytes, BigInt(`0x${scalar}`));
  return new sdk.OutputData(
    { id: keyset.id, amount: sdk.Amount.from(amount), B_: blind.B_.toHex(true) },
    BigInt(`0x${scalar}`),
    secretBytes,
  );
}

export function makeOutputs(keyset, amounts = [1]) {
  const vectors = {
    1: [PUBLISHED_VECTORS.outputSecretAmount1, PUBLISHED_VECTORS.outputScalarAmount1],
    2: [PUBLISHED_VECTORS.outputSecretAmount2, PUBLISHED_VECTORS.outputScalarAmount2],
  };
  return amounts.map(amount => {
    const vector = vectors[amount];
    if (!vector) throw new Error(`no published fixture output vector for amount ${amount}`);
    return makeOutputData(keyset, { amount, secret: vector[0], scalar: vector[1] });
  });
}

export function signSwapRequest(args, keyset) {
  if (!args || args.endpoint !== `${mintUrl}/v1/swap` || args.method !== 'POST') {
    throw new Error(`fixture mint refused transport ${args?.method} ${args?.endpoint}`);
  }
  const outputs = args.requestBody?.outputs;
  if (!Array.isArray(outputs) || !outputs.length) throw new Error('fixture mint saw no outputs');
  return {
    signatures: outputs.map(output => {
      const amountText = String(output.amount);
      const privateKey = FIXTURE_MINT_PRIVATE_KEY[amountText];
      if (!privateKey) throw new Error(`fixture mint has no key for amount ${amountText}`);
      if (output.id !== keyset.id) throw new Error('fixture mint saw a foreign keyset');
      const B_ = sdk.pointFromHex(output.B_);
      const blindSignature = sdk.createBlindSignature(B_, hex(privateKey), keyset.id);
      const dleq = sdk.createDLEQProof(B_, hex(privateKey));
      return {
        id: keyset.id,
        amount: amountText,
        C_: blindSignature.C_.toHex(true),
        dleq: {
          e: Buffer.from(dleq.e).toString('hex'),
          s: Buffer.from(dleq.s).toString('hex'),
        },
      };
    }),
  };
}

export function createRecovery(journal, keyset, options = {}) {
  return new CashuReceiveRecovery({
    journal,
    sdk,
    mintUrl,
    unit,
    keyset,
    mintInfo: {name:'Controlled fictional fixture mint',version:'1',nuts:{}},
    requireInputDleq: true,
    requireResponseDleq: true,
    // Deliberately explicit: production default is 'none'.
    swapReplayPolicy: 'byte-identical-single-request',
    ...options,
  });
}

export function verifyProofs(proofs, keyset) {
  return sdk.verifyMintSignatures(proofs, id => {
    if (id !== keyset.id) throw new Error('unexpected keyset');
    return { id: keyset.id, keys: keyset.keys };
  }, { require: true });
}

// Test-only state machine standing in for an honest mint that has already
// committed a swap. It can return the committed signatures via NUT-09 restore
// and NUT-07 check states, and it can be configured to emit malformed or
// hostile responses. Everything is in-memory or caller-persisted JSON; it
// never performs network I/O and never generates wallet outputs.
const syntheticPoint = multiple =>
  sdk.pointFromHex(publicKeyFor(1)).multiply(BigInt(multiple)).toHex(true);
const hashJson = value => createHash('sha256').update(value, 'utf8').digest('hex');

export function createControlledMint(keyset, options = {}) {
  const config = {
    replay: options.replay ?? 'idempotent',
    restore: options.restore ?? 'exact',
    check: options.check ?? 'exact',
  };
  const committed = [];
  const byB = new Map();
  const spends = new Set();

  const requireEndpoint = (args, path) => {
    if (!args || args.method !== 'POST' || args.endpoint !== `${mintUrl}${path}`) {
      throw new Error(`fixture mint refused transport ${args?.method} ${args?.endpoint}`);
    }
    if (!args.requestBody || typeof args.requestBody !== 'object') {
      throw new Error('fixture mint saw no request body');
    }
    return args.requestBody;
  };

  function swap(args) {
    const body = requireEndpoint(args, '/v1/swap');
    const requestJson = JSON.stringify(body);
    const requestHash = hashJson(requestJson);
    const existing = committed.find(item => item.requestHash === requestHash);
    if (existing) {
      if (config.replay === 'idempotent') return existing.response;
      throw new Error('fixture mint refused a replayed swap');
    }
    const inputYs = body.inputs.map(proof => {
      if (typeof proof?.secret !== 'string') throw new Error('fixture mint saw an input without a secret');
      return sdk.hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true);
    });
    for (const Y of inputYs) {
      if (spends.has(Y)) throw new Error('fixture mint refused to double-spend an input');
    }
    const response = signSwapRequest(args, keyset);
    const outputs = body.outputs.map(output => ({
      id: output.id, amount: String(output.amount), B_: output.B_,
    }));
    committed.push({ requestJson, requestHash, response, outputs, inputYs });
    for (const Y of inputYs) spends.add(Y);
    for (let index = 0; index < outputs.length; index++) {
      byB.set(outputs[index].B_, { output: outputs[index], signature: response.signatures[index] });
    }
    return response;
  }

  function restore(args) {
    const body = requireEndpoint(args, '/v1/restore');
    if (!Array.isArray(body.outputs)) throw new Error('fixture mint saw no restore outputs');
    let pairs = [];
    for (const requested of body.outputs) {
      const found = byB.get(requested.B_);
      if (!found) continue;
      if (found.output.id !== requested.id || found.output.amount !== String(requested.amount)) continue;
      pairs.push({ output: { ...found.output }, signature: { ...found.signature } });
    }
    switch (config.restore) {
      case 'exact': break;
      case 'reordered': pairs = [...pairs].reverse(); break;
      case 'incomplete': pairs = pairs.slice(0, Math.max(0, pairs.length - 1)); break;
      case 'duplicate':
        if (pairs.length > 1) pairs[pairs.length - 1] = { ...pairs[0] };
        break;
      case 'foreign-output':
        if (pairs.length) pairs[0] = { ...pairs[0], output: { ...pairs[0].output, B_: syntheticPoint(11) } };
        break;
      case 'foreign-keyset':
        if (pairs.length) {
          pairs[0] = {
            output: { ...pairs[0].output, id: 'ffffffffffffffff' },
            signature: { ...pairs[0].signature, id: 'ffffffffffffffff' },
          };
        }
        break;
      case 'missing-dleq':
        if (pairs.length) {
          const signature = { ...pairs[0].signature };
          delete signature.dleq;
          pairs[0] = { ...pairs[0], signature };
        }
        break;
      case 'tampered-dleq':
        if (pairs.length) pairs[0] = {
          ...pairs[0],
          signature: { ...pairs[0].signature, dleq: { ...pairs[0].signature.dleq, e: '11'.repeat(32) } },
        };
        break;
      case 'tampered-c':
        if (pairs.length) pairs[0] = {
          ...pairs[0],
          signature: { ...pairs[0].signature, C_: syntheticPoint(13) },
        };
        break;
      case 'duplicate-signature':
        if (pairs.length > 1) pairs[1] = {
          ...pairs[1],
          signature: { ...pairs[1].signature, C_: pairs[0].signature.C_ },
        };
        break;
      case 'changed-output-amount':
        if (pairs.length) pairs[0] = {
          ...pairs[0],
          output: { ...pairs[0].output, amount: String(BigInt(pairs[0].output.amount) + 1n) },
        };
        break;
      case 'changed-signature-amount':
        if (pairs.length) pairs[0] = {
          ...pairs[0],
          signature: { ...pairs[0].signature, amount: String(BigInt(pairs[0].signature.amount) + 1n) },
        };
        break;
      case 'extra':
        if (pairs.length) pairs.push({
          output: { ...pairs[0].output, B_: syntheticPoint(17) },
          signature: { ...pairs[0].signature },
        });
        break;
      default: throw new Error(`unknown fixture restore variant ${config.restore}`);
    }
    return {
      outputs: pairs.map(pair => pair.output),
      signatures: pairs.map(pair => pair.signature),
    };
  }

  function check(args) {
    const body = requireEndpoint(args, '/v1/checkstate');
    if (!Array.isArray(body.Ys)) throw new Error('fixture mint saw no check Ys');
    let states = body.Ys.map(Y => ({
      Y, state: spends.has(Y) ? 'SPENT' : 'UNSPENT', witness: null,
    }));
    switch (config.check) {
      case 'exact': break;
      case 'reordered': states = [...states].reverse(); break;
      case 'incomplete': states = states.slice(0, Math.max(0, states.length - 1)); break;
      case 'duplicate':
        if (states.length > 1) states[states.length - 1] = { ...states[0] };
        break;
      case 'unknown':
        if (states.length) states[states.length - 1] = { ...states[0], Y: syntheticPoint(19) };
        break;
      case 'uppercase': states = states.map(state => ({ ...state, Y: state.Y.toUpperCase() })); break;
      case 'bad-state':
        if (states.length) states[0] = { ...states[0], state: 'BURNED' };
        break;
      case 'pending': states = states.map(state => ({ ...state, state: 'PENDING' })); break;
      case 'extra':
        if (states.length) states.push({ ...states[0] });
        break;
      default: throw new Error(`unknown fixture check variant ${config.check}`);
    }
    return { states };
  }

  return {
    swap,
    restore,
    check,
    markSpent(Y) { spends.add(Y); },
    markUnspent(Y) { spends.delete(Y); },
    swapCount() { return committed.length; },
    snapshot() {
      return {
        version: 1,
        config: { ...config },
        committed: committed.map(item => ({
          requestJson: item.requestJson,
          requestHash: item.requestHash,
          response: item.response,
          outputs: item.outputs,
          inputYs: item.inputYs,
        })),
        spends: [...spends],
      };
    },
    load(snapshot) {
      if (!snapshot || snapshot.version !== 1) throw new Error('unsupported fixture mint snapshot');
      committed.length = 0;
      byB.clear();
      spends.clear();
      for (const item of snapshot.committed ?? []) {
        committed.push(item);
        for (let index = 0; index < item.outputs.length; index++) {
          byB.set(item.outputs[index].B_, {
            output: item.outputs[index], signature: item.response.signatures[index],
          });
        }
      }
      for (const Y of snapshot.spends ?? []) spends.add(Y);
      Object.assign(config, snapshot.config ?? {}, options);
      return this;
    },
  };
}

export { sdk as cashuSdk };
