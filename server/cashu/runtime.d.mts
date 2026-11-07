import type {CashuSdk, JournalCounts} from './cashu-journal.mjs';
import type {CashuTransport} from './cashu-recovery.mjs';
import type {CashuProfile, RedactedCashuProfile} from './profile.mjs';

export interface SafeOperationView {
  operationId: string;
  invoiceId: string;
  state: 'prepared' | 'uncertain' | 'finalized';
  revision: number;
  attempts: number;
  expectedAmount: string;
  expectedFee: string;
  unit: string;
  keysetId: string;
  mintHost: string;
  mintUrlHash: string;
  requestCommitted: boolean;
  requestHash: string | null;
  inputCount: number;
  storedOutputCount: number;
  observationCount: number;
  lastObservation: string | null;
  observedStates: string[];
  restoreAttemptCount: number;
}

export interface SafeResultSummary {
  operationId: string;
  invoiceId: string;
  settlement: 'swap' | 'restore';
  amount: string;
  fee: string;
  unit: string;
  keysetId: string;
  mintHost: string;
  mintUrlHash: string;
  proofCount: number;
}

export interface SafeOutboxEvent {
  operationId: string;
  invoiceId: string;
  unit: string;
  amount: string;
  fee: string;
  proofCount: number;
  resultTag: string;
  mintHost: string;
  mintUrlHash: string;
}

export interface CashuPreflight {
  eligible: boolean;
  reason: string | null;
  operationId?: string;
  mode: 'restore' | 'check';
  operation?: SafeOperationView;
}

export interface CashuRecoveryRuntime {
  readonly profile: RedactedCashuProfile;
  counts(): JournalCounts;
  integrity(): string;
  inspect(operationId: string): {exists: false; operationId: string} | ({exists: true} & SafeOperationView);
  preflight(operationId: string, mode?: 'restore' | 'check'): CashuPreflight;
  restore(
    operationId: string,
    options?: {apply?: boolean; transport?: CashuTransport},
  ): Promise<{applied: boolean; reason?: string; operation?: SafeResultSummary; pending?: number}>;
  check(
    operationId: string,
    options?: {apply?: boolean; transport?: CashuTransport},
  ): Promise<{
    applied: boolean;
    reason?: string;
    operation?: SafeResultSummary;
    states?: {unspent: number; pending: number; spent: number};
  }>;
  pending(): SafeOutboxEvent[];
  deliver(adapter: {credit(event: unknown): Promise<unknown> | unknown}): Promise<{delivered: number; pending: number}>;
  readonly integration: {
    prepare(input: {
      operationId: string;
      invoiceId: string;
      inputs: unknown[];
      outputs: unknown[];
      expectedAmount: string | number | bigint;
    }): Promise<unknown>;
    submit(operationId: string, transport: CashuTransport): Promise<unknown>;
  };
  close(): void;
}

export class CashuRuntimeError extends Error {
  constructor(code: string, message?: string, cause?: unknown);
  code: string;
}

export function createCashuRecoveryRuntime(input: {
  sdk: CashuSdk;
  profile: CashuProfile;
  storageKey: Buffer;
}): CashuRecoveryRuntime;
export function assertOperationId(value: unknown): string;
export function safeErrorCode(error: unknown): string;

/** Read-only format guard. The journal constructor separately authenticates the storage key. */
export function assertExistingCashuJournalFormat(path:string):void;
