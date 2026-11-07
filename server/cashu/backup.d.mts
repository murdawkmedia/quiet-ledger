import type {CashuSdk, JournalCounts} from './cashu-journal.mjs';
import type {CashuProfile} from './profile.mjs';

export interface JournalBackupResult {
  file: string;
  manifest: string;
  sha256: string;
  bytes: number;
  counts: JournalCounts;
  createdAt: string;
}

export interface JournalRestoreResult {
  destination: string;
  sha256: string;
  bytes: number;
  counts: JournalCounts;
}

export class CashuBackupError extends Error {
  constructor(code: string, message?: string, cause?: unknown);
  code: string;
}

export const BACKUP_MANIFEST_FORMAT: string;
export const MANIFEST_SUFFIX: string;

export function createJournalBackup(input: {
  sdk: CashuSdk;
  profile: CashuProfile;
  storageKey: Buffer;
  out: string;
  createdAt?: string;
}): Promise<JournalBackupResult>;

export function restoreJournalBackup(input: {
  sdk: CashuSdk;
  backupPath: string;
  destination: string;
  storageKey: Buffer;
}): JournalRestoreResult;
