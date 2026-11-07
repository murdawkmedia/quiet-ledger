import type {CashuJournal, CashuSdk, JournalOperation} from './cashu-journal.mjs';

export interface CashuKeysetConfig {
  id: string;
  keys: Record<string, string>;
  input_fee_ppk?: number;
}

export interface CashuRecoveryOptions {
  journal: CashuJournal;
  sdk: CashuSdk;
  mintUrl: string;
  unit: string;
  keyset: CashuKeysetConfig;
  maxFee?: string | number | bigint | null;
  requireInputDleq?: boolean;
  requireResponseDleq?: boolean;
  mintInfo: Record<string, unknown>;
  swapReplayPolicy?: 'none' | 'byte-identical-single-request';
}

export interface CashuTransportArgs {
  method: string;
  endpoint: string;
  requestBody?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export type CashuTransport = (args: CashuTransportArgs) => Promise<unknown>;

export interface CheckStates {
  unspent: number;
  pending: number;
  spent: number;
  states: Array<'UNSPENT' | 'PENDING' | 'SPENT'>;
}

export class CashuRecoveryError extends Error {
  constructor(code: string, message?: string, cause?: unknown);
  code: string;
}

export class CashuReceiveRecovery {
  constructor(options: CashuRecoveryOptions);
  readonly journal: CashuJournal;
  readonly sdk: CashuSdk;
  readonly mintUrl: string;
  readonly unit: string;
  readonly keyset: {id: string; keys: Record<string, string>; input_fee_ppk: number};
  readonly swapReplayPolicy: 'none' | 'byte-identical-single-request';
  prepare(input: {
    operationId: string;
    invoiceId: string;
    inputs: unknown[];
    outputs: unknown[];
    expectedAmount: string | number | bigint;
  }): Promise<JournalOperation>;
  submit(operationId: string, transport: CashuTransport, options?: {recovery?: boolean}): Promise<unknown>;
  recover(operationId: string, transport: CashuTransport): Promise<unknown>;
  restore(operationId: string, transport: CashuTransport): Promise<unknown>;
  checkInputStates(operationId: string, transport: CashuTransport): Promise<CheckStates>;
  reconcile(operationId: string, transport: CashuTransport, options?: {mode?: 'restore' | 'check' | 'swap-replay'}): Promise<unknown>;
  observe(operationId: string, outcome: string): {outcome: string; seq: number};
  deliver(ledger: {credit(event: unknown): Promise<unknown> | unknown}): Promise<{delivered: number; pending: number}>;
  close(): void;
}
