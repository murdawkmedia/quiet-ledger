import type {CashuTransport} from './cashu-recovery.mjs';

export class CashuTransportError extends Error {
  constructor(code: string, message?: string, cause?: unknown);
  code: string;
}

export const RECOVERY_PATHS: readonly ['/v1/restore', '/v1/checkstate', '/v1/swap'];
export const DEFAULT_TIMEOUT_MS: number;
export const MIN_TIMEOUT_MS: number;
export const MAX_TIMEOUT_MS: number;
export const DEFAULT_MAX_RESPONSE_BYTES: number;
export const MIN_RESPONSE_BYTES: number;
export const MAX_RESPONSE_BYTES: number;

export function createBoundedHttpsTransport(options: {
  mintUrl: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}): CashuTransport;
