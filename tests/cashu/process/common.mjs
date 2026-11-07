// Shared helper for the multi-process recovery phases. All state is fictional
// test data inside CASHU_PROCESS_DIR.
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

export function processDir() {
  const dir = process.env.CASHU_PROCESS_DIR;
  if (!dir) throw new Error('CASHU_PROCESS_DIR is required');
  return dir;
}

export function journalDir() {
  const dir = join(processDir(), 'journal');
  mkdirSync(dir, {recursive: true, mode: 0o700});
  return dir;
}

export function writePrivate(path, bytes) {
  writeFileSync(path, bytes, {mode: 0o600, flag: 'wx'});
  return path;
}

export function writeJson(path, value) {
  return writePrivate(path, Buffer.from(JSON.stringify(value, null, 2) + '\n'));
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
