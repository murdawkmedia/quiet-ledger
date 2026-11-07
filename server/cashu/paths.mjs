// Private filesystem primitives for the Cashu recovery tooling.
//
// Local operator files are deliberately stricter than ordinary application
// storage: absolute paths, owner-only modes, no symlinks, no hard links and a
// bounded read. Nothing here generates key material; callers supply the
// existing storage-key file.

import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync,
  realpathSync, rmSync, writeSync,
} from 'node:fs';
import {dirname, isAbsolute, resolve} from 'node:path';

export class CashuPathError extends Error {
  constructor(code, message = code, cause) {
    super(`${code}: ${message}`, cause ? {cause} : undefined);
    this.name = 'CashuPathError';
    this.code = code;
  }
}

const owner = stat => !process.getuid || stat.uid === process.getuid();

export function absolutePath(value, label = 'path') {
  if (typeof value !== 'string' || !value.length || value.includes('\0')) {
    throw new CashuPathError('INVALID_PATH', `${label} must be a non-empty path without NUL bytes`);
  }
  if (!isAbsolute(value)) throw new CashuPathError('INVALID_PATH', `${label} must be absolute`);
  return resolve(value);
}

// A private directory belongs to this user, is mode 0700, and is reached
// without a symlink component. Creation is explicit so a typo cannot silently
// create an unconfigured storage tree during inspection.
export function privateDirectory(value, {create = false, label = 'directory'} = {}) {
  const path = absolutePath(value, label);
  if (create) {
    try { mkdirSync(path, {mode: 0o700}); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
  }
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { throw new CashuPathError('DIRECTORY_NOT_FOUND', `${label} does not exist`, error); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owner(stat) || (stat.mode & 0o077) !== 0 ||
      realpathSync(path) !== path) {
    throw new CashuPathError('UNSAFE_DIRECTORY', `${label} must be an owned, non-linked 0700 directory`);
  }
  return path;
}

// Read one owned 0600 regular file with no links. The stat is re-checked after
// the read so a replacement during the read cannot change what was accepted.
export function readPrivateFile(value, {maxBytes = 65536, minBytes = 1, label = 'file'} = {}) {
  const path = absolutePath(value, label);
  privateDirectory(dirname(path), {label: `${label} parent`});
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { throw new CashuPathError('FILE_NOT_FOUND', `${label} cannot be opened`, error); }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !owner(before) ||
        (before.mode & 0o777) !== 0o600 || before.size < minBytes || before.size > maxBytes) {
      throw new CashuPathError('UNSAFE_FILE', `${label} must be an owned 0600 regular file of ${minBytes}..${maxBytes} bytes`);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!read) throw new CashuPathError('SHORT_READ', `${label} ended before its recorded size`);
      offset += read;
    }
    const after = fstatSync(fd);
    if (after.size !== before.size || after.nlink !== 1 || (after.mode & 0o777) !== 0o600 ||
        after.dev !== before.dev || after.ino !== before.ino) {
      throw new CashuPathError('UNSAFE_FILE', `${label} changed while being read`);
    }
    return {path, bytes};
  } finally { closeSync(fd); }
}

// Create an owner-0600 file without ever replacing an existing path.
export function exclusiveWrite(value, bytes, {label = 'file'} = {}) {
  const path = absolutePath(value, label);
  privateDirectory(dirname(path), {label: `${label} parent`});
  if (!Buffer.isBuffer(bytes)) throw new CashuPathError('INVALID_BYTES', `${label} must be bytes`);
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new CashuPathError('PATH_EXISTS', `${label} already exists`);
    throw new CashuPathError('FILE_WRITE_FAILED', `${label} cannot be created`, error);
  }
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    try { fsyncSync(fd); }
    catch (error) {
      // The Node permission model disables fsync; the bounded write is still
      // complete, so durability is best-effort only in that test environment.
      if (error?.code !== 'ERR_ACCESS_DENIED') throw error;
    }
  } catch (error) {
    closeSync(fd); fd = null;
    try { rmSync(path, {force: true}); } catch {}
    throw new CashuPathError('FILE_WRITE_FAILED', `${label} could not be written completely`, error);
  } finally { if (fd != null) closeSync(fd); }
  return {path, bytes: bytes.length};
}

export function removeFile(path) {
  try { rmSync(path, {force: true}); } catch {}
}

export function fsyncDirectory(value) {
  let fd;
  try { fd = openSync(absolutePath(value, 'directory'), constants.O_RDONLY); fsyncSync(fd); }
  catch { /* durability hint only */ }
  finally { if (fd != null) try { closeSync(fd); } catch {} }
}
