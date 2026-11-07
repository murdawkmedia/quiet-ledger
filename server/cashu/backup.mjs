// Protected, consistent backup and restore of one Cashu receive journal.
//
// The journal already stores encrypted payloads inside SQLite; a backup is an
// online-SQLite consistent snapshot of that file, never a decryption or key
// export. The destination and manifest are created 0600 without overwriting
// anything. Restore authenticates the backup with the separate storage key,
// checks SQLite integrity and the recorded table counts, and only then
// publishes a new private journal file. A wrong key or corrupt snapshot leaves
// the destination absent.

import {DatabaseSync, backup} from 'node:sqlite';
import {createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual} from 'node:crypto';
import {chmodSync, existsSync, linkSync, lstatSync, readFileSync, unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
import {CashuJournal} from './cashu-journal.mjs';
import {validateProfile} from './profile.mjs';
import {assertExistingCashuJournalFormat} from './runtime.mjs';
import {
  absolutePath, exclusiveWrite, fsyncDirectory, privateDirectory, readPrivateFile, removeFile,
} from './paths.mjs';

export class CashuBackupError extends Error {
  constructor(code, message = code, cause) {
    super(`${code}: ${message}`, cause ? {cause} : undefined);
    this.name = 'CashuBackupError';
    this.code = code;
  }
}

export const BACKUP_MANIFEST_FORMAT = 'quiet-ledger-cashu-journal-backup-v1';
export const MANIFEST_SUFFIX = '.manifest.json';
const MAX_JOURNAL_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8192;
const COUNT_KEYS = ['operations', 'reservations', 'merchantProofs', 'results', 'outbox', 'observations'];
const SIDECARS = ['-wal', '-shm', '-journal', '.writer-lock', '.writer-lock-journal',
  '.writer-lock-wal', '.writer-lock-shm'];
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

function storageKey(value) {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw new CashuBackupError('INVALID_STORAGE_KEY', 'storage key must be exactly 32 bytes');
  }
  return Buffer.from(value);
}

function cleanupSidecars(base) {
  for (const suffix of SIDECARS) removeFile(base + suffix);
}

function cleanupCandidate(base) {
  cleanupSidecars(base);
  removeFile(base);
}

function wrap(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string' && SAFE_CODE.test(error.code)) {
    return error;
  }
  return new CashuBackupError('BACKUP_INVALID', 'journal backup validation failed', error);
}

function countsObject(value) {
  const counts = {};
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CashuBackupError('BACKUP_MANIFEST_INVALID', 'manifest counts are missing');
  }
  if (Object.keys(value).length !== COUNT_KEYS.length || COUNT_KEYS.some(key => !(key in value))) {
    throw new CashuBackupError('BACKUP_MANIFEST_INVALID', 'manifest counts do not match the journal schema');
  }
  for (const key of COUNT_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new CashuBackupError('BACKUP_MANIFEST_INVALID', 'manifest counts must be non-negative integers');
    }
    counts[key] = value[key];
  }
  return counts;
}

function parseManifest(bytes) {
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new CashuBackupError('BACKUP_MANIFEST_INVALID', 'manifest is not valid JSON', error); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new CashuBackupError('BACKUP_MANIFEST_INVALID');
  }
  const expected = new Set(['format', 'createdAt', 'sha256', 'bytes', 'counts', 'authentication']);
  for (const key of Object.keys(manifest)) {
    if (!expected.has(key)) throw new CashuBackupError('BACKUP_MANIFEST_INVALID', `unexpected manifest field ${key}`);
  }
  if (manifest.format !== BACKUP_MANIFEST_FORMAT) {
    throw new CashuBackupError('BACKUP_MANIFEST_INVALID', 'unsupported backup manifest format');
  }
  if (typeof manifest.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sha256)) {
    throw new CashuBackupError('BACKUP_MANIFEST_INVALID', 'manifest sha256 is invalid');
  }
  if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > MAX_JOURNAL_BYTES) {
    throw new CashuBackupError('BACKUP_MANIFEST_INVALID', 'manifest byte size is invalid');
  }
  if (typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new CashuBackupError('BACKUP_MANIFEST_INVALID', 'manifest createdAt is invalid');
  }
  if (typeof manifest.authentication !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.authentication)) {
    throw new CashuBackupError('BACKUP_MANIFEST_INVALID', 'manifest authentication is missing or invalid');
  }
  return {format: manifest.format, createdAt: manifest.createdAt, sha256: manifest.sha256,
    bytes: manifest.bytes, counts: countsObject(manifest.counts), authentication: manifest.authentication};
}

function authenticateManifest(manifest,key) {
  const derived=Buffer.from(hkdfSync('sha256',key,Buffer.alloc(0),'quiet-ledger-cashu-backup-auth-v1',32));
  try {
    return createHmac('sha256',derived).update(JSON.stringify([
      manifest.format,manifest.createdAt,manifest.sha256,manifest.bytes,
      ...COUNT_KEYS.map(name=>manifest.counts[name]),
    ])).digest();
  } finally { derived.fill(0); }
}

function validateSnapshot({path, sdk, storageKey: key, expectedCounts}) {
  let journal;
  try {
    assertExistingCashuJournalFormat(path);
    journal = new CashuJournal(path, key, sdk);
    if (journal.integrityCheck() !== 'ok') throw new CashuBackupError('BACKUP_CORRUPT', 'sqlite integrity check failed');
    journal.verifyStoredPayloads();
    const counts = journal.counts();
    if (expectedCounts && COUNT_KEYS.some(name => counts[name] !== expectedCounts[name])) {
      throw new CashuBackupError('BACKUP_COUNTS_MISMATCH', 'journal table counts differ from the manifest');
    }
    return counts;
  } finally { journal?.close(); }
}

export async function createJournalBackup({
  sdk, profile: rawProfile, storageKey: keyValue, out, createdAt = new Date().toISOString(),
} = {}) {
  const profile = validateProfile(rawProfile);
  const key = storageKey(keyValue);
  const outPath = absolutePath(out, 'backup destination');
  const manifestPath = outPath + MANIFEST_SUFFIX;
  privateDirectory(dirname(outPath), {label: 'backup directory'});
  if (outPath === profile.journalPath || manifestPath === profile.journalPath) {
    throw new CashuBackupError('INVALID_PATH', 'the backup destination cannot replace the journal');
  }
  if (existsSync(outPath) || existsSync(manifestPath)) {
    throw new CashuBackupError('PATH_EXISTS', 'backup destination or manifest already exists');
  }
  let sourceStat;
  try { sourceStat = lstatSync(profile.journalPath); }
  catch (error) { throw new CashuBackupError('JOURNAL_NOT_FOUND', 'the configured journal does not exist', error); }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new CashuBackupError('UNSAFE_JOURNAL', 'the journal must be an existing regular file');
  }
  let journal;
  let temp = null;
  let manifestWritten = false;
  let published = false;
  try {
    assertExistingCashuJournalFormat(profile.journalPath);
    journal = new CashuJournal(profile.journalPath, key, sdk);
    if (journal.integrityCheck() !== 'ok') throw new CashuBackupError('BACKUP_CORRUPT', 'source journal integrity check failed');
    journal.verifyStoredPayloads();
    const counts = journal.counts();
    temp = `${outPath}.part-${randomBytes(8).toString('hex')}`;
    const source = new DatabaseSync(profile.journalPath);
    try { await backup(source, temp); }
    finally { source.close(); }
    chmodSync(temp, 0o600);
    validateSnapshot({path: temp, sdk, storageKey: key, expectedCounts: counts});
    cleanupSidecars(temp);
    const bytes = readFileSync(temp);
    if (bytes.length > MAX_JOURNAL_BYTES) throw new CashuBackupError('BACKUP_TOO_LARGE');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const manifest = {
      format: BACKUP_MANIFEST_FORMAT,
      createdAt,
      sha256,
      bytes: bytes.length,
      counts,
    };
    manifest.authentication=authenticateManifest(manifest,key).toString('hex');
    exclusiveWrite(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), {label: 'backup manifest'});
    manifestWritten = true;
    linkSync(temp, outPath); // atomic publish, refuses an existing destination
    published = true;
    chmodSync(outPath, 0o600);
    unlinkSync(temp);
    fsyncDirectory(dirname(outPath));
    return {file: outPath, manifest: manifestPath, sha256, bytes: bytes.length, counts, createdAt};
  } catch (error) {
    if (temp) cleanupCandidate(temp);
    if (manifestWritten && !published) removeFile(manifestPath);
    throw wrap(error);
  } finally {
    journal?.close();
    key.fill(0);
  }
}

export function restoreJournalBackup({sdk, backupPath, destination, storageKey: keyValue} = {}) {
  const key = storageKey(keyValue);
  const sourcePath = absolutePath(backupPath, 'backup source');
  const manifestPath = sourcePath + MANIFEST_SUFFIX;
  const destinationPath = absolutePath(destination, 'restore destination');
  privateDirectory(dirname(destinationPath), {label: 'restore directory'});
  if (destinationPath === sourcePath) throw new CashuBackupError('INVALID_PATH', 'restore destination must differ from the backup');
  if (existsSync(destinationPath)) throw new CashuBackupError('PATH_EXISTS', 'restore destination already exists');
  let temp = null;
  let published = false;
  try {
    if (!existsSync(manifestPath)) throw new CashuBackupError('BACKUP_MANIFEST_MISSING');
    const manifest = parseManifest(readPrivateFile(manifestPath, {
      maxBytes: MAX_MANIFEST_BYTES, label: 'backup manifest',
    }).bytes);
    const {bytes} = readPrivateFile(sourcePath, {
      maxBytes: MAX_JOURNAL_BYTES, label: 'backup journal',
    });
    if (bytes.length !== manifest.bytes) throw new CashuBackupError('BACKUP_SIZE_MISMATCH');
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
      throw new CashuBackupError('BACKUP_HASH_MISMATCH');
    }
    if (!timingSafeEqual(authenticateManifest(manifest,key),Buffer.from(manifest.authentication,'hex'))) {
      throw new CashuBackupError('BACKUP_AUTH_FAILED', 'backup authentication failed');
    }
    temp = `${destinationPath}.restore-${randomBytes(8).toString('hex')}`;
    exclusiveWrite(temp, bytes, {label: 'restore candidate'});
    validateSnapshot({path: temp, sdk, storageKey: key, expectedCounts: manifest.counts});
    cleanupSidecars(temp);
    const verifiedBytes=readFileSync(temp);
    if(verifiedBytes.length!==manifest.bytes||createHash('sha256').update(verifiedBytes).digest('hex')!==manifest.sha256){
      throw new CashuBackupError('BACKUP_HASH_MISMATCH','snapshot changed during validation');
    }
    linkSync(temp, destinationPath);
    chmodSync(destinationPath, 0o600);
    unlinkSync(temp);
    published = true;
    fsyncDirectory(dirname(destinationPath));
    return {destination: destinationPath, sha256: manifest.sha256, bytes: manifest.bytes, counts: manifest.counts};
  } catch (error) {
    throw wrap(error);
  } finally {
    key.fill(0);
    if (!published && temp) cleanupCandidate(temp);
  }
}
