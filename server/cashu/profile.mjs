// Explicit operator profile and storage-key loading for Cashu recovery.
//
// Everything here is fail-closed. There is no seed, counter, output, blinding
// factor, token or key generation: the operator supplies an existing separate
// 0600 storage-key file and an explicit profile that names an HTTPS mint, one
// keyset, the `sat` unit and the keyset input fee. Unknown fields are rejected
// so a future misconfiguration cannot be ignored silently.

import {createHash} from 'node:crypto';
import {readPrivateFile} from './paths.mjs';

export class CashuProfileError extends Error {
  constructor(code, message = code, cause) {
    super(`${code}: ${message}`, cause ? {cause} : undefined);
    this.name = 'CashuProfileError';
    this.code = code;
  }
}

export const PROFILE_FORMAT = 'quiet-ledger-cashu-recovery-profile-v1';
export const SUPPORTED_UNIT = 'sat';
export const REPLAY_POLICIES = Object.freeze(['none', 'byte-identical-single-request']);
const PROFILE_KEYS = new Set([
  'format', 'journalPath', 'mint', 'unit', 'keyset', 'mintInfo', 'maxFee', 'swapReplayPolicy', 'restoreAttemptLimit',
]);
const KEYSET_KEYS = new Set(['id', 'keys', 'input_fee_ppk']);
const MAX_PROFILE_BYTES = 256 * 1024;
const MAX_MINT_INFO_BYTES = 128 * 1024;
const MAX_STORAGE_KEY_BYTES = 32;

const isObject = value => value != null && typeof value === 'object' && !Array.isArray(value);

function integerText(value, label, {allowZero = true, max = 2n ** 63n} = {}) {
  let text;
  if (typeof value === 'bigint') text = value.toString();
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new CashuProfileError('INVALID_PROFILE', `${label} must be a safe integer`);
    text = String(value);
  } else if (typeof value === 'string' && /^[0-9]+$/.test(value)) text = value;
  else throw new CashuProfileError('INVALID_PROFILE', `${label} must be a decimal integer`);
  const amount = BigInt(text);
  if ((!allowZero && amount === 0n) || amount < 0n || amount > max) {
    throw new CashuProfileError('INVALID_PROFILE', `${label} is outside the accepted range`);
  }
  return text;
}

function mintUrl(value) {
  if (typeof value !== 'string' || value.length < 9 || value.length > 512) {
    throw new CashuProfileError('INVALID_MINT', 'mint must be an HTTPS URL of at most 512 characters');
  }
  let url;
  try { url = new URL(value); } catch (error) { throw new CashuProfileError('INVALID_MINT', 'mint is not a URL', error); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new CashuProfileError('INVALID_MINT', 'mint must be HTTPS without credentials, query or fragment');
  }
  return url.toString().replace(/\/+$/, '');
}

function keysetConfig(value) {
  if (!isObject(value)) throw new CashuProfileError('INVALID_KEYSET', 'keyset must be an object');
  for (const key of Object.keys(value)) {
    if (!KEYSET_KEYS.has(key)) throw new CashuProfileError('INVALID_KEYSET', `unknown keyset field ${key}`);
  }
  const {id, keys, input_fee_ppk: fee} = value;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new CashuProfileError('INVALID_KEYSET', 'keyset id must be 1..128 URL-safe characters');
  }
  if (!isObject(keys) || !Object.keys(keys).length || Object.keys(keys).length > 64) {
    throw new CashuProfileError('INVALID_KEYSET', 'keyset keys must contain 1..64 public keys');
  }
  const normalized = {};
  for (const [amount, point] of Object.entries(keys)) {
    if (!/^[1-9][0-9]*$/.test(amount)) {
      throw new CashuProfileError('INVALID_KEYSET', 'keyset amounts must be positive decimal integers');
    }
    integerText(amount, 'keyset amount', {allowZero: false, max: 2n ** 32n});
    if (typeof point !== 'string' || !/^0[23][0-9a-fA-F]{64}$/.test(point)) {
      throw new CashuProfileError('INVALID_KEYSET', `keyset key for amount ${amount} is not a compressed point`);
    }
    normalized[amount] = point.toLowerCase();
  }
  return {id, keys: normalized, input_fee_ppk: Number(integerText(fee, 'keyset input_fee_ppk', {max: 2n ** 32n}))};
}

function mintInfo(value) {
  if (!isObject(value) || !isObject(value.nuts)) {
    throw new CashuProfileError('INVALID_MINT_INFO', 'explicit mintInfo with a NUT support object is required');
  }
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch (error) { throw new CashuProfileError('INVALID_MINT_INFO', 'mintInfo is not JSON-safe', error); }
  if (bytes > MAX_MINT_INFO_BYTES) throw new CashuProfileError('INVALID_MINT_INFO', 'mintInfo is too large');
  return value;
}

// Pure structural validation. The SDK later re-derives the keyset id and
// refuses a mismatch, so this function never needs to trust the operator.
export function validateProfile(value) {
  if (!isObject(value)) throw new CashuProfileError('INVALID_PROFILE', 'profile must be a JSON object');
  for (const key of Object.keys(value)) {
    if (!PROFILE_KEYS.has(key)) throw new CashuProfileError('INVALID_PROFILE', `unknown profile field ${key}`);
  }
  if (value.format != null && value.format !== PROFILE_FORMAT) {
    throw new CashuProfileError('INVALID_PROFILE', `format must be ${PROFILE_FORMAT}`);
  }
  if (typeof value.journalPath !== 'string' || !value.journalPath.startsWith('/')) {
    throw new CashuProfileError('INVALID_PROFILE', 'journalPath must be an absolute path');
  }
  if (value.unit !== SUPPORTED_UNIT) {
    throw new CashuProfileError('INVALID_UNIT', 'only the sat unit is supported; no currency conversion is implied');
  }
  const policy = value.swapReplayPolicy ?? 'none';
  if (!REPLAY_POLICIES.includes(policy)) {
    throw new CashuProfileError('INVALID_REPLAY_POLICY', `swapReplayPolicy must be one of ${REPLAY_POLICIES.join(', ')}`);
  }
  const restoreAttemptLimit = value.restoreAttemptLimit === undefined ? 3 : value.restoreAttemptLimit;
  if (!Number.isSafeInteger(restoreAttemptLimit) || restoreAttemptLimit < 1 || restoreAttemptLimit > 100) throw new CashuProfileError('INVALID_RESTORE_LIMIT', 'restoreAttemptLimit must be an integer from 1 to 100');
  const maxFee = value.maxFee == null ? null : integerText(value.maxFee, 'maxFee');
  const keyset = keysetConfig(value.keyset);
  return Object.freeze({
    format: PROFILE_FORMAT,
    journalPath: value.journalPath,
    mint: mintUrl(value.mint),
    unit: SUPPORTED_UNIT,
    keyset: Object.freeze({...keyset, keys: Object.freeze({...keyset.keys})}),
    mintInfo: mintInfo(value.mintInfo),
    maxFee,
    swapReplayPolicy: policy,
    restoreAttemptLimit,
  });
}

export function parseProfileJson(text) {
  let value;
  try { value = JSON.parse(text); }
  catch (error) { throw new CashuProfileError('INVALID_PROFILE_JSON', 'profile is not valid JSON', error); }
  return validateProfile(value);
}

export function readProfileFile(path) {
  const {bytes} = readPrivateFile(path, {maxBytes: MAX_PROFILE_BYTES, minBytes: 2, label: 'profile'});
  return parseProfileJson(bytes.toString('utf8'));
}

// Exactly 32 raw bytes. The key is never written, logged, exported or placed in
// a profile; the caller owns the returned Buffer and must zero it when done.
export function readStorageKeyFile(path) {
  const {bytes} = readPrivateFile(path, {
    maxBytes: MAX_STORAGE_KEY_BYTES, minBytes: MAX_STORAGE_KEY_BYTES, label: 'storage key',
  });
  return bytes;
}

// Allowlisted, redacted operator view. It contains no keyset points, no full
// mint URL, no storage-key bytes and no journal payload material.
export function redactedProfileMetadata(profile) {
  const url = new URL(profile.mint);
  const nuts = Object.keys(profile.mintInfo.nuts).sort((a, b) => Number(a) - Number(b));
  return Object.freeze({
    format: profile.format,
    journalPath: profile.journalPath,
    mintHost: url.host,
    mintScheme: url.protocol.slice(0, -1),
    mintUrlHash: createHash('sha256').update(profile.mint, 'utf8').digest('hex').slice(0, 16),
    unit: profile.unit,
    keysetId: profile.keyset.id,
    inputFeePpk: profile.keyset.input_fee_ppk,
    maxFee: profile.maxFee,
    swapReplayPolicy: profile.swapReplayPolicy,
    restoreAttemptLimit: profile.restoreAttemptLimit,
    mintInfoNuts: nuts,
  });
}
