export const CASHU_JOURNAL_TRIGGERS_SQL:string;
export interface CashuSdk {
  hashToCurve(secret: Uint8Array): {toHex(compressed?: boolean): string};
  normalizeMintUrl(url: string): string;
  [key: string]: unknown;
}

export interface JournalCounts {
  operations: number;
  reservations: number;
  merchantProofs: number;
  results: number;
  outbox: number;
  observations: number;
}

export interface JournalOutputData {
  secret: string;
  blindedMessage: {id: string; amount: string | number | bigint; B_: string};
  [key: string]: unknown;
}

export interface JournalOperation {
  opId: string;
  state: 'prepared' | 'uncertain' | 'finalized';
  revision: number;
  attempts: number;
  requestHash: string | null;
  invoiceId: string;
  mint: string;
  unit: string;
  keysetId: string;
  inputs: Array<{id: string; amount: string; secret: string; C: string; dleq?: {e: string; s: string; r?: string}}>;
  expectedAmount: string;
  expectedFee: string;
  preview: {keepOutputs: JournalOutputData[]; [key: string]: unknown};
}

export interface CashuResult {
  operationId: string;
  invoiceId: string;
  mint: string;
  unit: string;
  keysetId: string;
  amount: string;
  fee: string;
  settlement: 'swap' | 'restore';
  proofs: Array<{id: string; amount: string; secret: string; C: string}>;
}

export interface OutboxEvent {
  operationId: string;
  invoiceId: string;
  mint: string;
  unit: string;
  amount: string;
  fee: string;
  proofCount: number;
  resultTag: string;
}

export class CashuJournalError extends Error {
  constructor(code: string, message?: string, cause?: unknown);
  code: string;
}

export class CashuJournal {
  constructor(path: string, storageKey: Buffer, sdk: CashuSdk, options?: {restoreAttemptLimit?:number});
  readonly restoreAttemptLimit:number;
  acquireAttempt(operationId:string):symbol;
  releaseAttempt(operationId:string,lease:symbol):void;
  readonly path: string;
  readonly sdk: CashuSdk;
  prepare(input: {
    operationId: string;
    invoiceId: string;
    mint: string;
    unit: string;
    keysetId: string;
    inputs: unknown[];
    expectedAmount: string | number | bigint;
    expectedFee: string | number | bigint;
    preview: unknown;
  }): JournalOperation;
  get(operationId: string): JournalOperation | null;
  requestOf(operationId: string): string | null;
  beginAttempt(operationId: string, requestJson: string): boolean;
  beginRestoreAttempt(operationId: string, payloadJson: string): boolean;
  restoreAttempts(operationId: string): Array<{seq: number; payloadHash: string}>;
  observe(operationId: string, outcome: string): {outcome: string; seq: number};
  observation(operationId: string): {seq: number; outcome: string} | null;
  observations(operationId: string): Array<{seq: number; outcome: string}>;
  savedResult(operationId: string): CashuResult | null;
  complete(operationId: string, proofs: unknown[]): CashuResult;
  completeRestored(operationId: string, proofs: unknown[], restorePayloadJson: string): CashuResult;
  pending(): OutboxEvent[];
  ack(operationId: string): void;
  verifyStoredPayloads(): void;
  counts(): JournalCounts;
  integrityCheck(): string;
  close(): void;
}

export function canonicalMintUrl(sdk: CashuSdk, value: string): string;
export function normalizeProof(proof: unknown): {id: string; amount: string; secret: string; C: string};
