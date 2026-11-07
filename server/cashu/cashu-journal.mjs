// Durable Cashu receive journal. Framework-agnostic ESM; no network code.
//
// This module owns the local safety boundary for one merchant mint scope:
//   * encrypted preparation and exact original request (AES-256-GCM, row/domain AAD)
//   * permanent input reservations keyed by NUT-00 Y = hash_to_curve(secret)
//   * uncertainty committed before any transport effect
//   * atomic merchant proofs + result + projected outbox metadata
//   * separate append-only NUT-09 restore payloads bound to saved outputs
//   * one cooperative OS-released writer lock
//
// It deliberately does not generate wallet secrets, choose outputs, fetch keysets,
// speak HTTP, or decide invoice policy. `cashu-recovery.mjs` supplies orchestration
// and the caller supplies the merchant wallet custody and transport.
//
// Storage key: 32 random bytes supplied by the caller's key-management boundary.
// This is application-level payload encryption, not whole-database encryption.
// Operation ids, states, revisions, counts, HMAC tags and request hashes remain
// visible in the clear.

import { DatabaseSync } from 'node:sqlite';
import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes,
} from 'node:crypto';
import { mkdirSync, lstatSync, realpathSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';

// One source of truth for constructor and read-only recovery schema validation.
export const CASHU_JOURNAL_TRIGGERS_SQL = `        CREATE TRIGGER IF NOT EXISTS immutable_preparation
          BEFORE UPDATE OF op_id,scope_tag,invoice_tag,prepared ON operations
          BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PREPARATION'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_request
          BEFORE UPDATE OF request_json,request_hash ON operations
          WHEN OLD.request_hash IS NOT NULL AND
               (NEW.request_hash IS NOT OLD.request_hash OR NEW.request_json IS NOT OLD.request_json)
          BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REQUEST'); END;
        CREATE TRIGGER IF NOT EXISTS valid_state_transition
          BEFORE UPDATE OF state ON operations
          WHEN NOT (OLD.state = NEW.state OR
                    (OLD.state = 'prepared' AND NEW.state = 'uncertain') OR
                    (OLD.state = 'uncertain' AND NEW.state = 'finalized'))
          BEGIN SELECT RAISE(ABORT,'INVALID_STATE_TRANSITION'); END;
        CREATE TRIGGER IF NOT EXISTS permanent_reservations_delete BEFORE DELETE ON reservations
          BEGIN SELECT RAISE(ABORT,'PERMANENT_RESERVATION'); END;
        CREATE TRIGGER IF NOT EXISTS permanent_reservations_update BEFORE UPDATE ON reservations
          BEGIN SELECT RAISE(ABORT,'PERMANENT_RESERVATION'); END;
        CREATE TRIGGER IF NOT EXISTS permanent_merchant_proofs_delete BEFORE DELETE ON merchant_proofs
          BEGIN SELECT RAISE(ABORT,'PERMANENT_MERCHANT_PROOF'); END;
        CREATE TRIGGER IF NOT EXISTS permanent_merchant_proofs_update BEFORE UPDATE ON merchant_proofs
          BEGIN SELECT RAISE(ABORT,'PERMANENT_MERCHANT_PROOF'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_result_update BEFORE UPDATE ON results
          BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RESULT'); END;
        CREATE TRIGGER IF NOT EXISTS permanent_result_delete BEFORE DELETE ON results
          BEGIN SELECT RAISE(ABORT,'PERMANENT_RESULT'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_outbox_update BEFORE UPDATE OF payload ON outbox
          BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OUTBOX'); END;
        CREATE TRIGGER IF NOT EXISTS permanent_outbox_delete BEFORE DELETE ON outbox
          BEGIN SELECT RAISE(ABORT,'PERMANENT_OUTBOX'); END;
        CREATE TRIGGER IF NOT EXISTS monotonic_ack BEFORE UPDATE OF acked ON outbox
          WHEN OLD.acked = 1 AND NEW.acked = 0
          BEGIN SELECT RAISE(ABORT,'ACK_ALREADY_COMMITTED'); END;
        CREATE TRIGGER IF NOT EXISTS permanent_observation_delete BEFORE DELETE ON observations
          BEGIN SELECT RAISE(ABORT,'PERMANENT_OBSERVATION'); END;
        CREATE TRIGGER IF NOT EXISTS permanent_observation_update BEFORE UPDATE ON observations
          BEGIN SELECT RAISE(ABORT,'PERMANENT_OBSERVATION'); END;
        CREATE TRIGGER IF NOT EXISTS permanent_restore_attempt_delete BEFORE DELETE ON restore_attempts
          BEGIN SELECT RAISE(ABORT,'PERMANENT_RESTORE_ATTEMPT'); END;
        CREATE TRIGGER IF NOT EXISTS permanent_restore_attempt_update BEFORE UPDATE ON restore_attempts
          BEGIN SELECT RAISE(ABORT,'PERMANENT_RESTORE_ATTEMPT'); END;`;

const FORMAT = 'quiet-ledger-cashu-journal-v1';
const MAX_PREPARED_BYTES = 512 * 1024;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 512 * 1024;
const MAX_INPUTS = 64;
const MAX_PROOFS = 64;
const MAX_RESTORE_ATTEMPTS = 3;

// TIMEOUT and HTTP_ERROR are reserved observation labels for caller adapters;
// current SDK transport failures use NETWORK_ERROR or RESTORE_UNAVAILABLE.
const OBSERVATIONS = new Set([
  'UNSPENT', 'SPENT', 'PENDING', 'RESTORE_UNAVAILABLE', 'TIMEOUT',
  'NETWORK_ERROR', 'HTTP_ERROR', 'INVALID_RESPONSE',
]);

export class CashuJournalError extends Error {
  constructor(code, message = code, cause) {
    super(`${code}: ${message}`, cause ? { cause } : undefined);
    this.name = 'CashuJournalError';
    this.code = code;
  }
}

const encoder = new TextEncoder();
const json = value => JSON.stringify(value);

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return json(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${json(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function assertJsonSize(label, value, limit) {
  let encoded;
  try { encoded = json(value); } catch (error) {
    throw new CashuJournalError('INVALID_JSON', `${label} is not JSON-safe`, error);
  }
  if (Buffer.byteLength(encoded) > limit) {
    throw new CashuJournalError('TOO_LARGE', `${label} exceeds ${limit} bytes`);
  }
  return encoded;
}

function normalizeAmount(value, { allowZero = false, label = 'amount' } = {}) {
  let text;
  if (typeof value === 'bigint') text = value.toString();
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new CashuJournalError('INVALID_AMOUNT', `${label} is not a safe integer`);
    text = String(value);
  } else if (typeof value === 'string' && /^[0-9]+$/.test(value)) text = value;
  else if (value && typeof value.toString === 'function') text = String(value.toString());
  else throw new CashuJournalError('INVALID_AMOUNT', `${label} is not an integer`);
  if (!/^[0-9]+$/.test(text)) throw new CashuJournalError('INVALID_AMOUNT', `${label} is not a decimal integer`);
  const amount = BigInt(text);
  if (amount < 0n || (!allowZero && amount === 0n)) throw new CashuJournalError('INVALID_AMOUNT', `${label} out of range`);
  return amount.toString();
}

function hex32(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new CashuJournalError('INVALID_DLEQ', `${label} must be 32-byte hex`);
  }
  return value.toLowerCase();
}

function pointHex(value, label) {
  if (typeof value !== 'string' || !/^0[23][0-9a-fA-F]{64}$/.test(value)) {
    throw new CashuJournalError('INVALID_POINT', `${label} must be a compressed secp256k1 point`);
  }
  return value.toLowerCase();
}

export function normalizeProof(proof) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    throw new CashuJournalError('INVALID_PROOF', 'proof must be an object');
  }
  if (typeof proof.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(proof.id)) {
    throw new CashuJournalError('INVALID_PROOF', 'proof.id must be 1..128 URL-safe characters');
  }
  if (typeof proof.secret !== 'string' || proof.secret.length === 0 ||
      Buffer.byteLength(proof.secret, 'utf8') > 1024) {
    throw new CashuJournalError('INVALID_PROOF', 'proof.secret must be 1..1024 bytes');
  }
  const out = {
    id: proof.id,
    amount: normalizeAmount(proof.amount, { label: 'proof.amount' }),
    secret: proof.secret,
    C: pointHex(proof.C, 'proof.C'),
  };
  if (proof.dleq != null) {
    if (typeof proof.dleq !== 'object') throw new CashuJournalError('INVALID_DLEQ', 'dleq must be an object');
    out.dleq = { e: hex32(proof.dleq.e, 'dleq.e'), s: hex32(proof.dleq.s, 'dleq.s') };
    if (proof.dleq.r != null) out.dleq.r = hex32(proof.dleq.r, 'dleq.r');
  }
  if (proof.p2pk_e != null) out.p2pk_e = pointHex(proof.p2pk_e, 'proof.p2pk_e');
  if (proof.witness != null) {
    // Witnesses are public spending conditions, but keep them JSON-safe.
    assertJsonSize('proof.witness', proof.witness, 8192);
    out.witness = proof.witness;
  }
  return out;
}

function sumProofAmounts(proofs) {
  let total = 0n;
  for (const proof of proofs) total += BigInt(normalizeAmount(proof.amount, { label: 'proof.amount' }));
  return total;
}

function canonicalMint(sdk, value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new CashuJournalError('INVALID_MINT_SCOPE', 'mint URL is missing or too long');
  }
  let url;
  try { url = new URL(value); } catch (error) {
    throw new CashuJournalError('INVALID_MINT_SCOPE', 'mint URL is invalid', error);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new CashuJournalError('INVALID_MINT_SCOPE', 'mint must be https without credentials, query or fragment');
  }
  const normalized = sdk.normalizeMintUrl(url.toString());
  if (typeof normalized !== 'string' || !normalized) {
    throw new CashuJournalError('INVALID_MINT_SCOPE', 'mint URL did not normalize');
  }
  return normalized;
}

function assertId(label, value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new CashuJournalError('INVALID_ID', `${label} must be 1..128 [A-Za-z0-9._:-] characters`);
  }
  return value;
}

function assertUnit(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(value)) {
    throw new CashuJournalError('INVALID_UNIT', 'unit must be 1..16 lowercase alphanumeric characters starting with a letter');
  }
  return value;
}

export function canonicalMintUrl(sdk, value) {
  return canonicalMint(sdk, value);
}

function privateStoragePath(path) {
  const absolute = resolve(path), directory = dirname(absolute);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(directory) !== directory ||
      (parent.mode & 0o077) !== 0 || (process.getuid && parent.uid !== process.getuid())) {
    throw new CashuJournalError('UNSAFE_PATH', 'journal directory must be private, owned and free of symlinks');
  }
  // Reject linked or special database and SQLite sidecar files before opening.
  for (const file of [absolute, absolute+'-wal', absolute+'-shm', absolute+'-journal', absolute+'.writer-lock', absolute+'.writer-lock-journal', absolute+'.writer-lock-wal', absolute+'.writer-lock-shm']) {
    let stat;
    try { stat = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new CashuJournalError('UNSAFE_PATH', 'journal files must be owned regular files without links');
    }
  }
  for (const file of [absolute, absolute+'.writer-lock']) {
    const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new CashuJournalError('UNSAFE_PATH');
    } finally { closeSync(fd); }
  }
  return absolute;
}

export class CashuJournal {
  #db = null;
  #lock = null;
  #aeadKey;
  #identityKey;
  #inFlight = new Map();
  #restoreAttemptLimit;

  constructor(path, storageKey, sdk, { restoreAttemptLimit = MAX_RESTORE_ATTEMPTS } = {}) {
    if (!Number.isSafeInteger(restoreAttemptLimit) || restoreAttemptLimit < 1 || restoreAttemptLimit > 100) throw new CashuJournalError('INVALID_RESTORE_LIMIT', 'operator restore budget must be 1..100');
    this.#restoreAttemptLimit = restoreAttemptLimit;
    if (typeof path !== 'string' || !path.length) throw new CashuJournalError('INVALID_PATH');
    if (!Buffer.isBuffer(storageKey) || storageKey.length !== 32) {
      throw new CashuJournalError('INVALID_STORAGE_KEY', 'storage key must be 32 bytes');
    }
    if (!sdk || typeof sdk.hashToCurve !== 'function' || typeof sdk.normalizeMintUrl !== 'function') {
      throw new CashuJournalError('INVALID_SDK', 'sdk must expose hashToCurve and normalizeMintUrl');
    }
    path = privateStoragePath(path);
    this.sdk = sdk;
    this.path = path;
    this.#aeadKey = Buffer.from(hkdfSync('sha256', storageKey, Buffer.alloc(0), 'quiet-ledger-cashu-aead-v1', 32));
    this.#identityKey = Buffer.from(hkdfSync('sha256', storageKey, Buffer.alloc(0), 'quiet-ledger-cashu-identity-v1', 32));

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#lock = new DatabaseSync(`${path}.writer-lock`);
    try {
      this.#lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    } catch (error) {
      this.#lock.close();
      this.#aeadKey.fill(0); this.#identityKey.fill(0);
      throw new CashuJournalError('SINGLE_WRITER', 'another cooperating writer holds this journal', error);
    }

    try {
      this.#db = new DatabaseSync(path);
      this.#db.exec(`PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        PRAGMA foreign_keys=ON;
        PRAGMA busy_timeout=0;
        PRAGMA temp_store=MEMORY;
        PRAGMA max_page_count=8192;
        CREATE TABLE IF NOT EXISTS journal_key_check(
          id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS operations(
          op_id TEXT PRIMARY KEY,
          scope_tag TEXT NOT NULL,
          invoice_tag TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('prepared','uncertain','finalized')),
          revision INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          prepared BLOB NOT NULL,
          request_json BLOB,
          request_hash TEXT,
          CHECK ((request_json IS NULL) = (request_hash IS NULL)));
        CREATE TABLE IF NOT EXISTS reservations(
          scope_tag TEXT NOT NULL,
          proof_tag TEXT NOT NULL,
          op_id TEXT NOT NULL REFERENCES operations(op_id),
          PRIMARY KEY(scope_tag, proof_tag));
        CREATE TABLE IF NOT EXISTS merchant_proofs(
          scope_tag TEXT NOT NULL,
          proof_tag TEXT NOT NULL,
          op_id TEXT NOT NULL REFERENCES operations(op_id),
          payload BLOB NOT NULL,
          PRIMARY KEY(scope_tag, proof_tag));
        CREATE TABLE IF NOT EXISTS results(
          op_id TEXT PRIMARY KEY REFERENCES operations(op_id),
          payload BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS outbox(
          op_id TEXT PRIMARY KEY REFERENCES results(op_id),
          acked INTEGER NOT NULL DEFAULT 0 CHECK(acked IN(0,1)),
          payload BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS observations(
          op_id TEXT NOT NULL REFERENCES operations(op_id),
          seq INTEGER NOT NULL,
          payload BLOB NOT NULL,
          PRIMARY KEY(op_id, seq));
        CREATE TABLE IF NOT EXISTS restore_attempts(
          op_id TEXT NOT NULL REFERENCES operations(op_id),
          seq INTEGER NOT NULL,
          payload BLOB NOT NULL,
          payload_hash TEXT NOT NULL,
          PRIMARY KEY(op_id, seq));
${CASHU_JOURNAL_TRIGGERS_SQL}`);

      // Bind the encryption and identity keys to this database before admitting
      // any operation. A wrong key fails closed instead of minting fresh tags.
      this.#transaction(() => {
        const row = this.#db.prepare('SELECT payload FROM journal_key_check WHERE id=1').get();
        if (row) {
          let value;
          try { value = this.#unseal('key-check', 'singleton', row.payload); }
          catch (error) {
            throw new CashuJournalError('WRONG_STORAGE_KEY', 'storage key does not authenticate this journal', error);
          }
          if (value.format !== FORMAT) throw new CashuJournalError('INVALID_KEY_CHECK', 'unexpected journal format');
        } else {
          this.#db.prepare('INSERT INTO journal_key_check VALUES(1,?)')
            .run(this.#seal('key-check', 'singleton', { format: FORMAT }));
        }
      });
    } catch (error) {
      try { this.#db?.close(); } catch {}
      try { this.#lock.exec('ROLLBACK'); } catch {}
      try { this.#lock.close(); } catch {}
      this.#db = null; this.#lock = null;
      this.#aeadKey.fill(0); this.#identityKey.fill(0);
      throw error;
    }
  }

  #transaction(fn) {
    if (!this.#db) throw new CashuJournalError('WRITER_CLOSED');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  #tag(domain, value) {
    return createHmac('sha256', this.#identityKey)
      .update(`${domain}\0${canonicalJson(value)}`).digest('hex');
  }

  #seal(domain, aadId, value) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#aeadKey, nonce);
    cipher.setAAD(Buffer.from(`journal-v1\0${domain}\0${aadId}`, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(json(value), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  }

  #unseal(domain, aadId, value) {
    const bytes = Buffer.from(value);
    if (bytes.length < 29) throw new CashuJournalError('CORRUPT_JOURNAL', 'sealed value is too short');
    const decipher = createDecipheriv('aes-256-gcm', this.#aeadKey, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`journal-v1\0${domain}\0${aadId}`, 'utf8'));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  }

  #proofTag(proof) {
    // NUT-07 identity is Y = hash_to_curve(secret), not the proof JSON,
    // amount, signature or keyset label. Those cannot evade a reservation.
    if (typeof proof.secret !== 'string' || !proof.secret.length) {
      throw new CashuJournalError('INVALID_PROOF_IDENTITY', 'proof secret is missing');
    }
    let Y;
    try { Y = this.sdk.hashToCurve(encoder.encode(proof.secret)).toHex(true); }
    catch (error) { throw new CashuJournalError('INVALID_PROOF_IDENTITY', 'secret does not hash to a curve point', error); }
    return this.#tag('proof-Y', Y);
  }

  prepare({
    operationId, invoiceId, mint, unit, keysetId, inputs,
    expectedAmount, expectedFee, preview,
  }) {
    assertId('operationId', operationId);
    assertId('invoiceId', invoiceId);
    assertUnit(unit);
    const canonical = canonicalMint(this.sdk, mint);
    if (typeof keysetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(keysetId)) {
      throw new CashuJournalError('INVALID_KEYSET', 'keysetId must be 1..128 URL-safe characters');
    }
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_INPUTS) {
      throw new CashuJournalError('INVALID_PREPARATION', `inputs must contain 1..${MAX_INPUTS} proofs`);
    }
    const normalizedInputs = inputs.map(normalizeProof);
    for (const proof of normalizedInputs) {
      if (proof.id !== keysetId) throw new CashuJournalError('INVALID_KEYSET', 'every input must belong to the configured keyset');
    }
    const amount = normalizeAmount(expectedAmount, { label: 'expectedAmount' });
    const fee = normalizeAmount(expectedFee, { allowZero: true, label: 'expectedFee' });
    const inputTotal = sumProofAmounts(normalizedInputs);
    if (inputTotal !== BigInt(amount) + BigInt(fee)) {
      throw new CashuJournalError('PREVIEW_INCONSISTENT', 'input total must equal expected amount plus fee');
    }
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) {
      throw new CashuJournalError('INVALID_PREPARATION', 'preview must be a serialized swap preview object');
    }
    const payload = {
      invoiceId, mint: canonical, unit, keysetId,
      inputs: normalizedInputs, expectedAmount: amount, expectedFee: fee, preview,
    };
    assertJsonSize('prepared', payload, MAX_PREPARED_BYTES);
    const payloadJson = canonicalJson(payload);
    const tags = normalizedInputs.map(proof => this.#proofTag(proof));
    if (new Set(tags).size !== tags.length) throw new CashuJournalError('DUPLICATE_INPUT', 'input secrets repeat');
    const scope = this.#tag('mint-unit', [canonical, unit]);

    return this.#transaction(() => {
      const existing = this.get(operationId);
      if (existing) {
        const stored = {
          invoiceId: existing.invoiceId, mint: existing.mint, unit: existing.unit,
          keysetId: existing.keysetId, inputs: existing.inputs,
          expectedAmount: existing.expectedAmount, expectedFee: existing.expectedFee,
          preview: existing.preview,
        };
        if (canonicalJson(stored) !== payloadJson) {
          throw new CashuJournalError('OPERATION_CONFLICT', 'operation id already has a different preparation');
        }
        return existing;
      }
      this.#db.prepare(`INSERT INTO operations(op_id,scope_tag,invoice_tag,state,prepared)
        VALUES(?,?,?,'prepared',?)`)
        .run(operationId, scope, this.#tag('invoice', invoiceId),
          this.#seal('prepared', operationId, payload));
      for (const tag of tags) {
        try { this.#db.prepare('INSERT INTO reservations VALUES(?,?,?)').run(scope, tag, operationId); }
        catch (error) {
          if (String(error.message).includes('UNIQUE constraint failed')) {
            throw new CashuJournalError('PROOF_RESERVED', 'an input is already reserved by another operation', error);
          }
          throw error;
        }
      }
      return this.get(operationId);
    });
  }

  get(operationId) {
    const row = this.#db.prepare('SELECT * FROM operations WHERE op_id=?').get(operationId);
    if (!row) return null;
    const prepared = this.#unseal('prepared', operationId, row.prepared);
    return {
      opId: operationId,
      state: row.state,
      revision: row.revision,
      attempts: row.attempts,
      requestHash: row.request_hash,
      ...prepared,
    };
  }

  requestOf(operationId) {
    const row = this.#db.prepare('SELECT request_json FROM operations WHERE op_id=?').get(operationId);
    if (!row || !row.request_json) return null;
    return this.#unseal('request', operationId, row.request_json);
  }

  beginAttempt(operationId, requestJson) {
    if (typeof requestJson !== 'string' || !requestJson.length ||
        Buffer.byteLength(requestJson, 'utf8') > MAX_REQUEST_BYTES) {
      throw new CashuJournalError('INVALID_REQUEST', 'request must be a non-empty bounded JSON string');
    }
    try { JSON.parse(requestJson); } catch (error) {
      throw new CashuJournalError('INVALID_REQUEST', 'request is not valid JSON', error);
    }
    const hash = createHash('sha256').update(requestJson, 'utf8').digest('hex');
    return this.#transaction(() => {
      const row = this.#db.prepare(
        'SELECT state,request_json,request_hash FROM operations WHERE op_id=?').get(operationId);
      if (!row) throw new CashuJournalError('OPERATION_NOT_FOUND');
      if (row.state === 'finalized') return false;
      if (row.request_hash) {
        const stored = this.#unseal('request', operationId, row.request_json);
        if (row.request_hash !== hash || stored !== requestJson) {
          throw new CashuJournalError('REQUEST_MISMATCH', 'replayed request differs from the committed original');
        }
        this.#db.prepare('UPDATE operations SET attempts=attempts+1 WHERE op_id=?').run(operationId);
        return true;
      }
      // The request and the uncertain state must be durable before the caller
      // performs any remote effect. Crash here can only leave a resumable op.
      this.#db.prepare(`UPDATE operations
        SET state='uncertain', request_json=?, request_hash=?, attempts=attempts+1, revision=revision+1
        WHERE op_id=?`)
        .run(this.#seal('request', operationId, requestJson), hash, operationId);
      return true;
    });
  }

  // NUT-09 restore payloads are NOT the original swap request and never touch
  // request_json/request_hash. They are separately sealed, append-only, and
  // capped, so a restore can never rewrite the committed original commitment.
  get restoreAttemptLimit() { return this.#restoreAttemptLimit; }

  acquireAttempt(operationId) {
    if (!this.#db) throw new CashuJournalError('WRITER_CLOSED');
    if (this.#inFlight.has(operationId)) throw new CashuJournalError('ATTEMPT_IN_PROGRESS', 'another recovery object holds this operation');
    const lease = Symbol(operationId);
    this.#inFlight.set(operationId, lease);
    return lease;
  }

  releaseAttempt(operationId, lease) {
    if (this.#inFlight.get(operationId) !== lease) throw new CashuJournalError('INVALID_ATTEMPT_LEASE');
    this.#inFlight.delete(operationId);
  }

  beginRestoreAttempt(operationId, payloadJson) {
    if (typeof payloadJson !== 'string' || !payloadJson.length ||
        Buffer.byteLength(payloadJson, 'utf8') > MAX_REQUEST_BYTES) {
      throw new CashuJournalError('INVALID_RESTORE_REQUEST', 'restore payload must be a non-empty bounded JSON string');
    }
    let parsed;
    try { parsed = JSON.parse(payloadJson); } catch (error) {
      throw new CashuJournalError('INVALID_RESTORE_REQUEST', 'restore payload is not valid JSON', error);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        !Array.isArray(parsed.outputs) || parsed.outputs.length < 1 ||
        parsed.outputs.length > MAX_PROOFS) {
      throw new CashuJournalError('INVALID_RESTORE_REQUEST', 'restore payload must contain 1..64 outputs');
    }
    const hash = createHash('sha256').update(payloadJson, 'utf8').digest('hex');
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT state FROM operations WHERE op_id=?').get(operationId);
      if (!row) throw new CashuJournalError('OPERATION_NOT_FOUND');
      if (row.state === 'finalized') return false;
      if (row.state !== 'uncertain') {
        throw new CashuJournalError('ATTEMPT_NOT_STARTED', 'restore requires a committed uncertain attempt');
      }
      const previous = this.#db.prepare(
        'SELECT seq,payload,payload_hash FROM restore_attempts WHERE op_id=? ORDER BY seq').all(operationId);
      if (previous.length >= this.#restoreAttemptLimit) {
        throw new CashuJournalError('RESTORE_ATTEMPTS_EXHAUSTED',
          `at most ${this.#restoreAttemptLimit} bounded restore requests are allowed`);
      }
      if (previous.length) {
        const stored = this.#unseal('restore-attempt', `${operationId}:${previous[0].seq}`, previous[0].payload);
        if (previous[0].payload_hash !== hash || stored !== payloadJson) {
          throw new CashuJournalError('RESTORE_PAYLOAD_MISMATCH',
            'restore payload differs from the first recorded restore of this operation');
        }
      }
      const original = JSON.parse(this.requestOf(operationId) ?? 'null');
      if (!original || Object.keys(parsed).length !== 1 || JSON.stringify(parsed.outputs) !== JSON.stringify(original.outputs)) {
        throw new CashuJournalError('INVALID_RESTORE_REQUEST', 'restore must use exactly the committed blinded outputs');
      }
      const seq = previous.length + 1;
      this.#db.prepare('INSERT INTO restore_attempts VALUES(?,?,?,?)')
        .run(operationId, seq, this.#seal('restore-attempt', `${operationId}:${seq}`, payloadJson), hash);
      this.#db.prepare('UPDATE operations SET revision=revision+1 WHERE op_id=?').run(operationId);
      return true;
    });
  }

  restoreAttempts(operationId) {
    return this.#db.prepare('SELECT seq,payload_hash FROM restore_attempts WHERE op_id=? ORDER BY seq')
      .all(operationId)
      .map(row => ({ seq: row.seq, payloadHash: row.payload_hash }));
  }

  observe(operationId, outcome) {
    if (!OBSERVATIONS.has(outcome)) throw new CashuJournalError('INVALID_OBSERVATION');
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT state FROM operations WHERE op_id=?').get(operationId);
      if (!row) throw new CashuJournalError('OPERATION_NOT_FOUND');
      if (row.state !== 'uncertain') throw new CashuJournalError('NOT_UNCERTAIN');
      const seq = (this.#db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM observations WHERE op_id=?')
        .get(operationId).n);
      this.#db.prepare('INSERT INTO observations VALUES(?,?,?)')
        .run(operationId, seq, this.#seal('observation', `${operationId}:${seq}`, { outcome }));
      this.#db.prepare('UPDATE operations SET revision=revision+1 WHERE op_id=?').run(operationId);
      return { outcome, seq };
    });
  }

  observation(operationId) {
    const row = this.#db.prepare(
      'SELECT seq,payload FROM observations WHERE op_id=? ORDER BY seq DESC LIMIT 1').get(operationId);
    if (!row) return null;
    return { seq: row.seq, ...this.#unseal('observation', `${operationId}:${row.seq}`, row.payload) };
  }

  observations(operationId) {
    return this.#db.prepare('SELECT seq,payload FROM observations WHERE op_id=? ORDER BY seq')
      .all(operationId)
      .map(row => ({ seq: row.seq, ...this.#unseal('observation', `${operationId}:${row.seq}`, row.payload) }));
  }

  savedResult(operationId) {
    const row = this.#db.prepare('SELECT payload FROM results WHERE op_id=?').get(operationId);
    return row ? this.#unseal('result', operationId, row.payload) : null;
  }

  #normalizeMerchantProofs(proofs) {
    if (!Array.isArray(proofs) || proofs.length < 1 || proofs.length > MAX_PROOFS) {
      throw new CashuJournalError('INVALID_MERCHANT_RESULT', `proofs must contain 1..${MAX_PROOFS} entries`);
    }
    return proofs.map(normalizeProof);
  }

  // Caller must hold the surrounding write transaction.
  #applyResult(operationId, normalizedProofs, settlement) {
    const received = sumProofAmounts(normalizedProofs);
    const op = this.get(operationId);
    if (!op) throw new CashuJournalError('OPERATION_NOT_FOUND');
    const expected = BigInt(op.expectedAmount);
    const fee = BigInt(op.expectedFee);
    const inputTotal = sumProofAmounts(op.inputs);
    if (received !== expected) {
      throw new CashuJournalError('AMOUNT_MISMATCH',
        `received ${received} does not equal expected ${expected}`);
    }
    if (inputTotal !== received + fee) {
      throw new CashuJournalError('FEE_MISMATCH', 'input total, received amount and fee disagree');
    }
    for (const proof of normalizedProofs) {
      if (proof.id !== op.keysetId) {
        throw new CashuJournalError('UNKNOWN_KEYSET', 'merchant proof is not from the prepared keyset');
      }
    }
    const result = {
      operationId,
      invoiceId: op.invoiceId,
      mint: op.mint,
      unit: op.unit,
      keysetId: op.keysetId,
      amount: op.expectedAmount,
      fee: op.expectedFee,
      settlement,
      proofs: normalizedProofs,
    };
    assertJsonSize('result', result, MAX_RESULT_BYTES);
    if (op.state === 'finalized') {
      const saved = this.savedResult(operationId);
      if (canonicalJson(saved) !== canonicalJson(result)) {
        throw new CashuJournalError('RESULT_CONFLICT', 'finalized result cannot be replaced');
      }
      return saved;
    }
    if (op.state !== 'uncertain') throw new CashuJournalError('ATTEMPT_NOT_STARTED');
    if (!op.requestHash) throw new CashuJournalError('ATTEMPT_NOT_STARTED', 'no exact request was committed');

    const scope = this.#tag('mint-unit', [op.mint, op.unit]);
    const seen = new Set();
    const inputTags = new Set(op.inputs.map(proof => this.#proofTag(proof)));
    for (const proof of normalizedProofs) {
      const tag = this.#proofTag(proof);
      if (inputTags.has(tag)) throw new CashuJournalError('ECHOED_INPUT_PROOF', 'merchant outputs cannot reuse payer input secrets');
      if (seen.has(tag)) throw new CashuJournalError('DUPLICATE_MERCHANT_PROOF', 'result repeats a proof');
      seen.add(tag);
      try {
        this.#db.prepare('INSERT INTO merchant_proofs VALUES(?,?,?,?)')
          .run(scope, tag, operationId, this.#seal('merchant-proof', `${scope}:${tag}`, proof));
      } catch (error) {
        if (String(error.message).includes('UNIQUE constraint failed')) {
          throw new CashuJournalError('MERCHANT_PROOF_REUSED', 'merchant proof already belongs to another operation', error);
        }
        throw error;
      }
    }
    this.#db.prepare('INSERT INTO results VALUES(?,?)')
      .run(operationId, this.#seal('result', operationId, result));
    const event = {
      operationId,
      invoiceId: op.invoiceId,
      mint: op.mint,
      unit: op.unit,
      amount: op.expectedAmount,
      fee: op.expectedFee,
      proofCount: normalizedProofs.length,
      resultTag: this.#tag('result', result),
    };
    this.#db.prepare('INSERT INTO outbox VALUES(?,0,?)')
      .run(operationId, this.#seal('outbox', operationId, event));
    this.#db.prepare(`UPDATE operations
      SET state='finalized', revision=revision+1 WHERE op_id=?`).run(operationId);
    return result;
  }

  complete(operationId, proofs) {
    const normalizedProofs = this.#normalizeMerchantProofs(proofs);
    return this.#transaction(() => this.#applyResult(operationId, normalizedProofs, 'swap'));
  }

  // Completes from a cryptographically validated NUT-09 restore. The restored
  // proofs must be exactly the unblinded form of the persisted receive outputs;
  // this binds the result to the saved output set (and the recorded restore
  // payload), never to a fresh output/counter/secret.
  completeRestored(operationId, proofs, restorePayloadJson) {
    const normalizedProofs = this.#normalizeMerchantProofs(proofs);
    if (typeof restorePayloadJson !== 'string' || !restorePayloadJson.length ||
        Buffer.byteLength(restorePayloadJson, 'utf8') > MAX_REQUEST_BYTES) {
      throw new CashuJournalError('INVALID_RESTORE_REQUEST');
    }
    const hash = createHash('sha256').update(restorePayloadJson, 'utf8').digest('hex');
    return this.#transaction(() => {
      const op = this.get(operationId);
      if (!op) throw new CashuJournalError('OPERATION_NOT_FOUND');
      if (op.state === 'finalized') return this.savedResult(operationId);
      if (op.state !== 'uncertain') {
        throw new CashuJournalError('ATTEMPT_NOT_STARTED', 'restore requires a committed uncertain attempt');
      }
      const attempts = this.#db.prepare(
        'SELECT seq,payload,payload_hash FROM restore_attempts WHERE op_id=? ORDER BY seq').all(operationId);
      if (!attempts.length) throw new CashuJournalError('RESTORE_NOT_ATTEMPTED');
      const latest = attempts[attempts.length - 1];
      const stored = this.#unseal('restore-attempt', `${operationId}:${latest.seq}`, latest.payload);
      if (latest.payload_hash !== hash || stored !== restorePayloadJson) {
        throw new CashuJournalError('RESTORE_PAYLOAD_MISMATCH', 'result is not bound to the recorded restore payload');
      }
      const outputs = op.preview?.keepOutputs;
      if (!Array.isArray(outputs) || outputs.length < 1 || outputs.length > MAX_PROOFS) {
        throw new CashuJournalError('SAVED_OUTPUTS_MISSING', 'preparation has no persisted receive outputs');
      }
      if (outputs.length !== normalizedProofs.length) {
        throw new CashuJournalError('RESTORE_OUTPUT_COUNT_MISMATCH',
          'restored proof count does not equal the persisted output count');
      }
      const secrets = new Set();
      let outputTotal = 0n;
      for (const output of outputs) {
        const blinded = output?.blindedMessage;
        if (!blinded || typeof blinded.id !== 'string' || typeof blinded.B_ !== 'string' ||
            typeof output.secret !== 'string' || !/^([0-9a-fA-F]{2})+$/.test(output.secret)) {
          throw new CashuJournalError('SAVED_OUTPUTS_INVALID', 'persisted output is malformed');
        }
        outputTotal += BigInt(normalizeAmount(blinded.amount, { label: 'saved output amount' }));
        const secret = Buffer.from(output.secret, 'hex').toString('utf8');
        if (!secret.length || secrets.has(secret)) {
          throw new CashuJournalError('SAVED_OUTPUTS_INVALID', 'persisted output secrets are empty or repeated');
        }
        secrets.add(secret);
      }
      if (outputTotal !== BigInt(op.expectedAmount)) {
        throw new CashuJournalError('SAVED_OUTPUT_AMOUNT_MISMATCH',
          'persisted output total does not equal the expected amount');
      }
      const proofSecrets = new Set();
      for (const proof of normalizedProofs) {
        if (!secrets.has(proof.secret)) {
          throw new CashuJournalError('RESTORE_BINDING_MISMATCH',
            'restored proof does not belong to a persisted receive output');
        }
        if (proofSecrets.has(proof.secret)) {
          throw new CashuJournalError('DUPLICATE_MERCHANT_PROOF', 'restored output repeats');
        }
        proofSecrets.add(proof.secret);
      }
      return this.#applyResult(operationId, normalizedProofs, 'restore');
    });
  }

  pending() {
    return this.#db.prepare('SELECT op_id,payload FROM outbox WHERE acked=0 ORDER BY op_id').all()
      .map(row => this.#unseal('outbox', row.op_id, row.payload));
  }

  ack(operationId) {
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT acked FROM outbox WHERE op_id=?').get(operationId);
      if (!row) throw new CashuJournalError('RESULT_NOT_SAVED');
      if (!row.acked) this.#db.prepare('UPDATE outbox SET acked=1 WHERE op_id=?').run(operationId);
    });
  }

  verifyStoredPayloads() {
    // Authenticate every sealed record, including acknowledged outbox entries
    // and historical attempts. Never return decrypted records to the caller.
    for (const row of this.#db.prepare('SELECT op_id,prepared,request_json,request_hash FROM operations').iterate()) {
      this.#unseal('prepared',row.op_id,row.prepared);
      if (row.request_json !== null) {
        const request=this.#unseal('request',row.op_id,row.request_json);
        if (typeof request !== 'string' || createHash('sha256').update(request).digest('hex') !== row.request_hash) {
          throw new CashuJournalError('CORRUPT_JOURNAL','committed request hash mismatch');
        }
      }
    }
    for (const row of this.#db.prepare('SELECT scope_tag,proof_tag,payload FROM merchant_proofs').iterate()) {
      this.#unseal('merchant-proof',`${row.scope_tag}:${row.proof_tag}`,row.payload);
    }
    for (const [table,domain] of [['results','result'],['outbox','outbox'],['observations','observation'],['restore_attempts','restore-attempt']]) {
      const historical=table==='observations'||table==='restore_attempts';
      for (const row of this.#db.prepare(`SELECT op_id,payload${historical?',seq':''} FROM ${table}`).iterate()) {
        this.#unseal(domain,historical?`${row.op_id}:${row.seq}`:row.op_id,row.payload);
      }
    }
  }

  counts() {
    const count = table => this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return {
      operations: count('operations'),
      reservations: count('reservations'),
      merchantProofs: count('merchant_proofs'),
      results: count('results'),
      outbox: count('outbox'),
      observations: count('observations'),
    };
  }

  integrityCheck() {
    return this.#db.prepare('PRAGMA integrity_check').get().integrity_check;
  }

  close() {
    if (!this.#db) return;
    this.#db.close(); this.#db = null;
    try { this.#lock.exec('ROLLBACK'); } catch {}
    this.#lock.close(); this.#lock = null;
    this.#aeadKey.fill(0); this.#identityKey.fill(0);
  }
}
