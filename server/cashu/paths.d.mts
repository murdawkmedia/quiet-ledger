export class CashuPathError extends Error {
  constructor(code: string, message?: string, cause?: unknown);
  code: string;
}

export function absolutePath(value: unknown, label?: string): string;
export function privateDirectory(value: string, options?: {create?: boolean; label?: string}): string;
export function readPrivateFile(
  value: string,
  options?: {maxBytes?: number; minBytes?: number; label?: string},
): {path: string; bytes: Buffer};
export function exclusiveWrite(value: string, bytes: Buffer, options?: {label?: string}): {path: string; bytes: number};
export function removeFile(path: string): void;
export function fsyncDirectory(value: string): void;
