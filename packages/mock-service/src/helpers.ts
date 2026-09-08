import { DomainError, type DomainErrorCode, type DomainFailure, type Result } from '../../contracts/src/index';
import { storageError } from '../../media-store/src/index';

export function fail(code: DomainErrorCode, message: string = code): never { throw new DomainError(code, message); }
export function unwrap<T>(result: Result<T>): T { if (!result.ok) throw new DomainError(result.error.code, result.error.message, result.error.field); return result.value; }
export async function guarded<T>(work: () => Promise<T>): Promise<Result<T>> {
  try { return { ok: true, value: await work() }; }
  catch (error) {
    const failure: DomainFailure = error instanceof DomainError ? { code: error.code, message: error.message, field: error.field }
      : error instanceof Error && 'code' in error && typeof error.code === 'string' ? { code: error.code as DomainErrorCode, message: error.message } : storageError(error);
    return { ok: false, error: failure };
  }
}
export async function sha256(blob: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), x => x.toString(16).padStart(2, '0')).join('');
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
