export interface CashuProfile {
  format: string;
  journalPath: string;
  mint: string;
  unit: 'sat';
  keyset: {id: string; keys: Record<string, string>; input_fee_ppk: number};
  mintInfo: {nuts: Record<string, unknown>; [key: string]: unknown};
  maxFee: string | null;
  swapReplayPolicy: 'none' | 'byte-identical-single-request';
  restoreAttemptLimit:number;
}

export interface RedactedCashuProfile {
  format: string;
  journalPath: string;
  mintHost: string;
  mintScheme: string;
  mintUrlHash: string;
  unit: string;
  keysetId: string;
  inputFeePpk: number;
  maxFee: string | null;
  swapReplayPolicy: string;
  restoreAttemptLimit:number;
  mintInfoNuts: string[];
}

export class CashuProfileError extends Error {
  constructor(code: string, message?: string, cause?: unknown);
  code: string;
}

export const PROFILE_FORMAT: string;
export const SUPPORTED_UNIT: 'sat';
export const REPLAY_POLICIES: readonly ['none', 'byte-identical-single-request'];

export function validateProfile(value: unknown): CashuProfile;
export function parseProfileJson(text: string): CashuProfile;
export function readProfileFile(path: string): CashuProfile;
export function readStorageKeyFile(path: string): Buffer;
export function redactedProfileMetadata(profile: CashuProfile): RedactedCashuProfile;
