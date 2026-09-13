import { createHash } from 'node:crypto';
import { AgnesVideoClient, AgnesProviderError, buildAgnesVideoCreateBody } from '../../../provider-agnes/src/index.js';
import type { AgnesSizeMapping, AgnesVideoTask } from '../../../provider-agnes/src/index.js';
import { checkedMediaUrl, readBoundedMedia } from '../../../provider-agnes/src/download.js';
import type { ProviderReportedFacts } from '../../../contracts/src/provider-media.js';
import { ProviderOperationError } from './port.js';
import type { GenerationProvider, ProviderContext, ProviderCreateRequest, ProviderCreateResult, ProviderPollResult, ProviderResultReference, ProviderDownloadedMedia, ProviderStatus, ProviderErrorCode } from './port.js';

export type AgnesExecutionKind = 'simulation' | 'authorized-real';
export interface AgnesProviderOptions { apiKey: string; fetchImpl: typeof fetch; timeoutMs?: number; maxResultBytes?: number; executionKind?: AgnesExecutionKind }
const errorCodes: Record<AgnesProviderError['kind'], ProviderErrorCode> = { invalid_request: 'PROVIDER_INVALID_REQUEST', unauthorized: 'PROVIDER_UNAUTHORIZED', not_found: 'PROVIDER_NOT_FOUND', rate_limited: 'PROVIDER_RATE_LIMITED', transient: 'PROVIDER_UNAVAILABLE', unknown: 'PROVIDER_OUTCOME_UNKNOWN' };
function safeError(error: unknown): ProviderOperationError {
  if (error instanceof ProviderOperationError) return error;
  if (error instanceof AgnesProviderError) return new ProviderOperationError(errorCodes[error.kind], error.kind, error.status !== undefined && [400, 401, 403, 404, 429].includes(error.status) ? 'rejected' : 'unknown');
  return new ProviderOperationError('PROVIDER_OUTCOME_UNKNOWN', 'unknown', 'unknown');
}
/** Callers must explicitly supply a transport; execution identity is selected by an explicit option. */
export class AgnesProvider implements GenerationProvider {
  readonly bindingId: 'agnes-simulated' | 'agnes-authorized-real';
  readonly #secret: string;
  readonly #transport: typeof fetch;
  readonly #client: AgnesVideoClient;
  readonly #timeoutMs: number;
  readonly #maximum: number;
  readonly #executionKind: AgnesExecutionKind;
  constructor(options: AgnesProviderOptions) {
    if (typeof options.fetchImpl !== 'function') throw new ProviderOperationError('REAL_PROVIDER_CREATE_DISABLED', 'invalid_request', 'not_submitted');
    if (!options.apiKey?.trim()) throw new ProviderOperationError('PROVIDER_UNAUTHORIZED', 'unauthorized', 'not_submitted');
    const executionKind = options.executionKind === undefined ? 'simulation' : options.executionKind;
    if (executionKind !== 'simulation' && executionKind !== 'authorized-real') throw new ProviderOperationError('PROVIDER_INVALID_REQUEST', 'invalid_request', 'not_submitted');
    this.#secret = options.apiKey.trim();
    this.#transport = options.fetchImpl;
    this.#executionKind = executionKind;
    this.bindingId = executionKind === 'authorized-real' ? 'agnes-authorized-real' : 'agnes-simulated';
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maximum = options.maxResultBytes ?? 128 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0 || !Number.isSafeInteger(this.#maximum) || this.#maximum <= 0 || this.#maximum > 128 * 1024 * 1024) throw new ProviderOperationError('PROVIDER_INVALID_REQUEST', 'invalid_request', 'not_submitted');
    this.#client = new AgnesVideoClient({ apiKey: this.#secret, fetchImpl: this.#transport, timeoutMs: this.#timeoutMs });
  }
  #status(task: AgnesVideoTask): ProviderStatus {
    if (task.providerStatus.includes(this.#secret)) return 'unknown';
    switch (task.status) { case 'succeeded': return 'result_ready'; case 'needs_reconciliation': return 'unknown'; default: return task.status; }
  }
  #validId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value) && !value.includes(this.#secret); }
  #reportedStatus(task: AgnesVideoTask): ProviderReportedFacts['status'] {
    if (typeof task.providerStatus !== 'string' || task.providerStatus.includes(this.#secret)) return 'unknown';
    switch (task.providerStatus) {
      case 'queued':
      case 'in_progress':
      case 'completed':
      case 'failed':
        return task.providerStatus;
      default:
        return 'unknown';
    }
  }
  #safeSize(value: unknown): string | undefined {
    if (typeof value !== 'string' || !/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(value) || value.includes(this.#secret)) return undefined;
    return value;
  }
  #safeMapping(value: AgnesSizeMapping | undefined): ProviderReportedFacts['sizeMapping'] {
    if (!value || typeof value !== 'object') return undefined;
    const mapping: NonNullable<ProviderReportedFacts['sizeMapping']> = {};
    if (typeof value.adjusted === 'boolean') mapping.adjusted = value.adjusted;
    for (const [source, target] of [['width', 'width'], ['height', 'height'], ['requestedWidth', 'requestedWidth'], ['requestedHeight', 'requestedHeight']] as const) {
      const candidate = value[source];
      if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0 && candidate <= 9999) mapping[target] = candidate;
    }
    if ((value.ratio === '16:9' || value.ratio === '9:16' || value.ratio === '1:1' || value.ratio === '4:3' || value.ratio === '3:4') && !value.ratio.includes(this.#secret)) mapping.ratio = value.ratio;
    if ((value.resolution === '480p' || value.resolution === '720p' || value.resolution === '1080p') && !value.resolution.includes(this.#secret)) mapping.resolution = value.resolution;
    return Object.keys(mapping).length ? mapping : undefined;
  }
  #reported(task: AgnesVideoTask): ProviderReportedFacts {
    const facts: ProviderReportedFacts = { status: this.#reportedStatus(task) };
    for (const [source, target] of [['videoId', 'videoId'], ['taskId', 'taskId'], ['id', 'id']] as const) {
      const value = task[source];
      if (this.#validId(value)) facts[target] = value;
    }
    if (typeof task.createdAt === 'number' && Number.isSafeInteger(task.createdAt) && task.createdAt >= 0) facts.createdAt = task.createdAt;
    if (typeof task.seconds === 'number' && Number.isFinite(task.seconds) && task.seconds > 0 && task.seconds <= 60) facts.seconds = task.seconds;
    const size = this.#safeSize(task.size);
    if (size) facts.size = size;
    const sizeMapping = this.#safeMapping(task.sizeMapping);
    if (sizeMapping) facts.sizeMapping = sizeMapping;
    return facts;
  }
  #reportedIfReal(task: AgnesVideoTask): Pick<ProviderCreateResult, 'reported'> {
    return this.#executionKind === 'authorized-real' ? { reported: this.#reported(task) } : {};
  }
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
      return { externalJobId: task.videoId, status: this.#status(task), ...this.#reportedIfReal(task) };
    } catch (error) { throw safeError(error); }
  }
  async get(externalJobId: string, _context: ProviderContext): Promise<ProviderPollResult> {
    void _context;
    if (!this.#validId(externalJobId)) throw new ProviderOperationError('PROVIDER_INVALID_REQUEST', 'invalid_request', 'not_submitted');
    try {
      const task = await this.#client.getVideo(externalJobId);
      const status = this.#status(task);
      const reported = this.#reportedIfReal(task);
      if (status !== 'result_ready' || !task.resultUrl || task.resultUrl.length > 8192 || task.resultUrl.includes(this.#secret)) return { status, ...reported };
      try { checkedMediaUrl(task.resultUrl); } catch { return { status, ...reported }; }
      const seconds = task.seconds;
      const size = task.size;
      return { status, ...reported, result: { kind: 'https', url: task.resultUrl,
        ...(typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 && seconds <= 60 ? { providerReportedSeconds: seconds } : {}),
        ...(size && /^\d{1,4}x\d{1,4}$/.test(size) && !size.includes(this.#secret) ? { providerReportedSize: size } : {}),
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
      return { kind: 'media', bytes, sha256: createHash('sha256').update(bytes).digest('hex'), mime: 'video/mp4', provenance: this.#executionKind === 'authorized-real' ? 'real_provider_output' : 'synthetic_provider_simulation' };
    } catch { throw new ProviderOperationError('PROVIDER_DOWNLOAD_FAILED', 'transient', 'unknown'); }
  }
}
