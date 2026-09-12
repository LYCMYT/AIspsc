import { createHash } from 'node:crypto';
import { AgnesVideoClient, AgnesProviderError, buildAgnesVideoCreateBody } from '../../../provider-agnes/src/index.js';
import type { AgnesVideoTask } from '../../../provider-agnes/src/index.js';
import { checkedMediaUrl, readBoundedMedia } from '../../../provider-agnes/src/download.js';
import { ProviderOperationError } from './port.js';
import type { GenerationProvider, ProviderContext, ProviderCreateRequest, ProviderCreateResult, ProviderPollResult, ProviderResultReference, ProviderDownloadedMedia, ProviderStatus, ProviderErrorCode } from './port.js';

export interface AgnesProviderOptions { apiKey: string; fetchImpl: typeof fetch; timeoutMs?: number; maxResultBytes?: number }
const errorCodes: Record<AgnesProviderError['kind'], ProviderErrorCode> = { invalid_request: 'PROVIDER_INVALID_REQUEST', unauthorized: 'PROVIDER_UNAUTHORIZED', not_found: 'PROVIDER_NOT_FOUND', rate_limited: 'PROVIDER_RATE_LIMITED', transient: 'PROVIDER_UNAVAILABLE', unknown: 'PROVIDER_OUTCOME_UNKNOWN' };
function safeError(error: unknown): ProviderOperationError {
  if (error instanceof ProviderOperationError) return error;
  if (error instanceof AgnesProviderError) return new ProviderOperationError(errorCodes[error.kind], error.kind, error.status !== undefined && [400, 401, 403, 404, 429].includes(error.status) ? 'rejected' : 'unknown');
  return new ProviderOperationError('PROVIDER_OUTCOME_UNKNOWN', 'unknown', 'unknown');
}
/** Simulation-only: callers must explicitly supply a transport; never falls back to global fetch. */
export class AgnesProvider implements GenerationProvider {
  readonly bindingId = 'agnes-simulated';
  readonly #secret: string;
  readonly #transport: typeof fetch;
  readonly #client: AgnesVideoClient;
  readonly #timeoutMs: number;
  readonly #maximum: number;
  constructor(options: AgnesProviderOptions) {
    if (typeof options.fetchImpl !== 'function') throw new ProviderOperationError('REAL_PROVIDER_CREATE_DISABLED', 'invalid_request', 'not_submitted');
    if (!options.apiKey?.trim()) throw new ProviderOperationError('PROVIDER_UNAUTHORIZED', 'unauthorized', 'not_submitted');
    this.#secret = options.apiKey.trim();
    this.#transport = options.fetchImpl;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maximum = options.maxResultBytes ?? 128 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0 || !Number.isSafeInteger(this.#maximum) || this.#maximum <= 0 || this.#maximum > 128 * 1024 * 1024) throw new ProviderOperationError('PROVIDER_INVALID_REQUEST', 'invalid_request', 'not_submitted');
    this.#client = new AgnesVideoClient({ apiKey: this.#secret, fetchImpl: this.#transport, timeoutMs: this.#timeoutMs });
  }
  #status(task: AgnesVideoTask): ProviderStatus {
    if (task.providerStatus.includes(this.#secret)) return 'unknown';
    switch (task.status) { case 'succeeded': return 'result_ready'; case 'needs_reconciliation': return 'unknown'; default: return task.status; }
  }
  #validId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value) && !value.includes(this.#secret); }
  async create(input: ProviderCreateRequest, _context: ProviderContext): Promise<ProviderCreateResult> {
    void _context;
    const request = input.request;
    try {
      if (request.mode !== 'video' || request.references.length) throw Error('unsupported');
      buildAgnesVideoCreateBody({ prompt: request.prompt, ...request.video });
    } catch {
      throw new ProviderOperationError('PROVIDER_INVALID_REQUEST', 'invalid_request', 'not_submitted');
    }
    if (request.mode !== 'video') throw new ProviderOperationError('PROVIDER_INVALID_REQUEST', 'invalid_request', 'not_submitted');
    try {
      const task = await this.#client.createVideo({ prompt: request.prompt, ...request.video });
      if (!this.#validId(task.videoId)) throw new ProviderOperationError('PROVIDER_OUTCOME_UNKNOWN', 'unknown', 'unknown');
      return { externalJobId: task.videoId, status: this.#status(task) };
    } catch (error) { throw safeError(error); }
  }
  async get(externalJobId: string, _context: ProviderContext): Promise<ProviderPollResult> {
    void _context;
    if (!this.#validId(externalJobId)) throw new ProviderOperationError('PROVIDER_INVALID_REQUEST', 'invalid_request', 'not_submitted');
    try {
      const task = await this.#client.getVideo(externalJobId);
      const status = this.#status(task);
      if (status !== 'result_ready' || !task.resultUrl || task.resultUrl.length > 8192 || task.resultUrl.includes(this.#secret)) return { status };
      try { checkedMediaUrl(task.resultUrl); } catch { return { status }; }
      const seconds = task.seconds;
      const size = task.size;
      return { status, result: { kind: 'https', url: task.resultUrl,
        ...(typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 && seconds <= 3600 ? { providerReportedSeconds: seconds } : {}),
        ...(size && /^\d{1,5}x\d{1,5}$/.test(size) && !size.includes(this.#secret) ? { providerReportedSize: size } : {}),
      } };
    } catch (error) { throw safeError(error); }
  }
  async download(result: ProviderResultReference, _context: ProviderContext): Promise<ProviderDownloadedMedia> {
    void _context;
    try {
      if (result.kind !== 'https' || result.url.length > 8192 || result.url.includes(this.#secret)) throw Error('invalid');
      const url = checkedMediaUrl(result.url);
      const response = await this.#transport(url.href, { method: 'GET', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs) });
      if (response.redirected) throw Error('redirect');
      const bytes = await readBoundedMedia(response, this.#maximum);
      return { kind: 'media', bytes, sha256: createHash('sha256').update(bytes).digest('hex'), mime: 'video/mp4', provenance: 'synthetic_provider_simulation' };
    } catch { throw new ProviderOperationError('PROVIDER_DOWNLOAD_FAILED', 'transient', 'unknown'); }
  }
}
