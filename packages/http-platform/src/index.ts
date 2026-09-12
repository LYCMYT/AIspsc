import type { DemoPlatform, DemoSnapshot, ScenarioName } from '../../contracts/src/demo.js';
import type { Asset, CreditSnapshot, DomainErrorCode, Evaluation, GenerationBatchSnapshot, GenerationItem, MediaFile, Result, ReviewInput } from '../../contracts/src/generation.js';

type Check = (value: unknown) => boolean;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const string: Check = value => typeof value === 'string';
const identifier: Check = value => typeof value === 'string' && value.trim().length > 0;
const boolean: Check = value => typeof value === 'boolean';
const number: Check = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer: Check = value => number(value) && Number.isSafeInteger(value);
const oneOf = (...values: unknown[]): Check => value => values.includes(value);
const array = (check: Check): Check => value => Array.isArray(value) && value.every(check);
const dictionary = (check: Check): Check => value => record(value) && Object.values(value).every(check);
const object = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => value => {
  if (!record(value)) return false;
  return Object.entries(required).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]))
    && Object.entries(optional).every(([key, check]) => !Object.hasOwn(value, key) || check(value[key]));
};
const strings = array(string);
const mode = oneOf('video', 'image', 'copy');
const ratio = oneOf('9:16', '16:9', '1:1');
const resolution = oneOf('720p', '1080p');
const role = oneOf('product', 'person', 'background', 'reference_video');
const taskType = oneOf('COPY_GENERATION', 'IMAGE_GENERATION', 'MULTI_REFERENCE_VIDEO', 'REFERENCE_VIDEO_GEN', 'IMAGE_GUIDED_VIDEO', 'TEXT_TO_VIDEO');
const itemStatus = oneOf('queued', 'running', 'finalizing', 'cancel_requested', 'needs_reconciliation', 'succeeded', 'failed', 'cancelled');
const availability = oneOf('processing', 'available', 'missing', 'quarantined', 'unavailable');
const rubric = oneOf('rubric-v2-rebuild', 'basic-media-review-v1');
const scenario = oneOf('seed', 'empty', 'processing', 'success', 'failure', 'partial_success', 'missing_file', 'quota_insufficient', 'storage_failure', 'request_failure', 'unknown', 'download_failure', 'cancel_race');
const codes: DomainErrorCode[] = ['PROMPT_REQUIRED', 'INVALID_PARAMETERS', 'ASSET_NOT_FOUND', 'ASSET_FORBIDDEN', 'ASSET_UNAVAILABLE', 'REFERENCE_ROLE_DUPLICATE', 'REFERENCE_TYPE_MISMATCH', 'MEDIA_UNAVAILABLE', 'MEDIA_TOO_SHORT', 'MEDIA_TOO_LARGE', 'UNSUPPORTED_MEDIA', 'NO_COMPATIBLE_MODEL', 'INVALID_SCENE_CUTS', 'SCENE_FIXTURE_REQUIRED', 'INVALID_INTERVAL', 'QUOTA_INSUFFICIENT', 'IDEMPOTENCY_CONFLICT', 'INVALID_LEDGER_TRANSITION', 'REVIEW_REQUIRED', 'REVIEW_REJECTED', 'ITEM_NOT_READY', 'TASK_NOT_READY', 'FORBIDDEN', 'PROVIDER_OUTCOME_UNKNOWN', 'VERSION_CONFLICT', 'FILE_FIXTURE_MISSING', 'STORAGE_QUOTA_EXCEEDED', 'STORAGE_UNAVAILABLE', 'NETWORK_ERROR', 'CANCELLED'];
const errorCode = oneOf(...codes);
const capability = object({ taskTypes: array(taskType), maxReferences: integer }, {
  referenceRoleLimits: value => record(value) && Object.entries(value).every(([key, limit]) => role(key) && integer(limit)),
  video: object({ durationSeconds: array(integer), ratios: array(ratio), resolutions: array(resolution), audio: array(boolean) }, {
    combinations: array(object({ durationSeconds: integer, ratio, resolution, audio: boolean }, { maxReferences: integer })),
  }),
  image: object({ ratios: array(ratio), resolutions: strings }),
  copy: object({ languages: array(oneOf('zh-CN')), maxCharacters: integer }),
});
const generationRequest: Check = value => {
  if (!object({ mode, prompt: identifier, references: array(object({ assetId: identifier, role })), count: integer })(value) || !record(value)) return false;
  if (value.mode === 'video') return object({ video: object({ durationSeconds: integer, ratio, resolution, audio: boolean }) })(value) && !('image' in value) && !('copy' in value);
  if (value.mode === 'image') return object({ image: object({ ratio, resolution: string }) })(value) && !('video' in value) && !('copy' in value);
  return object({ copy: object({ language: oneOf('zh-CN'), maxCharacters: integer }) })(value) && !('video' in value) && !('image' in value);
};
const itemShape = object({
  id: identifier, batchId: identifier, index: integer, version: integer, status: itemStatus, mode, resultAvailable: boolean,
  routingSnapshot: object({ modelKey: identifier, bindingId: identifier, ruleVersion: identifier, reason: string, capabilitySnapshot: capability }),
  pricingSnapshot: object({ version: identifier, unitCost: number, unitName: oneOf('demo-credit') }),
  reviewState: oneOf('pending', 'approved', 'rejected'), libraryState: oneOf('not_saved', 'saved'), updatedAt: string,
}, { resultMediaId: identifier, text: string, errorCode, retryOfItemId: identifier });
const batchShape = object({
  id: identifier, workspaceId: identifier, requestSnapshot: generationRequest, requestedCount: integer, idempotencyKey: identifier,
  requestHash: identifier, createdAt: string, status: oneOf('queued', 'running', 'needs_reconciliation', 'succeeded', 'partial_succeeded', 'failed', 'cancelled'), items: array(itemShape),
});
const assetShape = object({
  id: identifier, workspaceId: identifier, mediaType: oneOf('image', 'video', 'audio', 'text'), availability,
  source: oneOf('upload', 'generated', 'fixture'), title: string, tags: strings, createdAt: string, isDemo: boolean,
}, { mediaFileId: identifier, text: string, originItemId: identifier, reviewId: identifier, reviewValidity: oneOf('valid', 'review_invalidated'), archivedAt: string });
const applicability = object(Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`Q${String(index + 1).padStart(2, '0')}`, object({ applicable: boolean }, { reason: string })])));
const evaluationShape = object({
  id: identifier, itemId: identifier, revision: integer, rubricVersion: rubric, issueTags: strings,
  hardFailures: array(oneOf('H01', 'H02', 'H03')), technicalErrors: array(oneOf('TECH_CORRUPT', 'TECH_DURATION', 'TECH_RESOLUTION', 'TECH_AUDIO')),
  decision: oneOf('approved', 'rejected'), reason: string, reviewerId: identifier, createdAt: string,
}, { score: number, applicability });
const mediaShape = object({
  id: identifier, workspaceId: identifier, mediaType: oneOf('image', 'video', 'audio'), mime: identifier, byteSize: integer,
  sha256: value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), availability,
}, { width: integer, height: integer, durationMs: number, objectKey: string, blobKey: string, hasAudio: boolean, isDemo: boolean, fixtureKey: identifier });
const quotaShape = object({
  granted: number, available: number, reserved: number, spent: number,
  reservations: dictionary(object({ itemId: identifier, reservedUnits: number, finalState: oneOf('reserved', 'committed', 'released') })), appliedActions: strings,
});
const interval = object({ startMs: number, endMs: number });
const snapshotShape = object({
  version: oneOf(1), epoch: identifier, scenario, batches: array(batchShape), items: array(itemShape), evaluations: array(evaluationShape), assets: array(assetShape), mediaMetadata: array(mediaShape), credits: quotaShape,
  ledger: array(object({ referenceId: identifier, action: oneOf('GRANT', 'RESERVE', 'COMMIT', 'RELEASE'), units: number, createdAt: string }, { reason: string })),
  attempts: array(object({ itemId: identifier, attemptNo: integer, providerBindingId: identifier, externalIdempotencyKey: identifier, submissionState: oneOf('not_submitted', 'submitting', 'submitted', 'outcome_unknown', 'settled'), createdAt: string, updatedAt: string }, { externalJobId: string })),
  reconciliations: array(object({ itemId: identifier, outcome: oneOf('success', 'failure', 'cancelled'), evidence: string, createdAt: string })),
  splits: array(object({ id: identifier, sourceMediaId: identifier, mode: oneOf('sequential', 'average', 'scene', 'manual'), sourceDurationMs: number, ruleVersion: oneOf('split-v2-rebuild'), status: itemStatus, sourceSha256: string, intervals: array(object({ startMs: number, endMs: number }, { actualDurationMs: number, mediaFileId: identifier })) }, { sceneRanges: array(interval), expandedIntervals: array(interval) })),
});
const nullShape: Check = value => value === null;

function networkFailure<T>(): Result<T> {
  return { ok: false, error: { code: 'NETWORK_ERROR', message: '本地演示服务响应无效或连接中断，请重试' } };
}
function forbidden<T>(): Promise<Result<T>> {
  return Promise.resolve({ ok: false, error: { code: 'FORBIDDEN', message: '当前 HTTP 演示阶段不支持此操作' } });
}
function safeError(): Error & { code: 'NETWORK_ERROR' } {
  return Object.assign(new Error('本地演示服务响应无效或连接中断'), { code: 'NETWORK_ERROR' as const });
}
function errorStatus(code: DomainErrorCode, status: number): boolean {
  if (code === 'FORBIDDEN') return status === 401 || status === 403;
  if (code === 'INVALID_PARAMETERS') return status === 400 || status === 413;
  if (code === 'STORAGE_UNAVAILABLE') return status === 503;
  if (code === 'NO_COMPATIBLE_MODEL') return status === 422;
  if (['TASK_NOT_READY', 'MEDIA_UNAVAILABLE', 'ASSET_NOT_FOUND'].includes(code)) return status === 404;
  if (code === 'ASSET_FORBIDDEN') return status === 403;
  if (['PROMPT_REQUIRED', 'REFERENCE_ROLE_DUPLICATE', 'REFERENCE_TYPE_MISMATCH'].includes(code)) return status === 400;
  return status === 409;
}
// Inputs must be JSON data. Avoid toJSON/accessors and preserve caller input instead of normalizing it.
function encode(value: unknown): string {
  const active = new Set<object>();
  function visit(entry: unknown): unknown {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (typeof entry !== 'object' || entry === null || active.has(entry)) throw safeError();
    const isArray = Array.isArray(entry);
    if (Object.getPrototypeOf(entry) !== (isArray ? Array.prototype : Object.prototype)) throw safeError();
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (Reflect.ownKeys(entry).some(key => typeof key !== 'string')) throw safeError();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (isArray && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor)) throw safeError();
    }
    active.add(entry);
    let result: unknown;
    if (isArray) {
      if (Object.keys(entry).length !== entry.length) throw safeError();
      result = Array.from({ length: entry.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor) throw safeError();
        return visit(descriptor.value);
      });
    } else {
      result = Object.fromEntries(Object.keys(descriptors).sort().map(key => [key, visit(descriptors[key]!.value)]));
    }
    active.delete(entry);
    return result;
  }
  return JSON.stringify(visit(value));
}
interface Command { body: string; key: string }
interface TransportResult<T> { result: Result<T>; definite: boolean }

export class HttpPlatform implements DemoPlatform {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly versions = new Map<string, number>();
  private readonly outstanding = new Map<string, Promise<Command | Result<never>>>();
  private snapshotSequence = 0;
  private acceptedSnapshotSequence = 0;
  private latestSnapshot?: DemoSnapshot;

  constructor(options: { baseUrl?: string; fetcher?: typeof fetch } = {}) {
    this.base = (options.baseUrl ?? '/api').replace(/\/+$/, '');
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  private async transport<T>(path: string, shape: Check, status = 200, command?: Command): Promise<TransportResult<T>> {
    try {
      const response = await this.fetcher(this.base + '/v1' + path, {
        method: command ? 'POST' : 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: command ? { 'Content-Type': 'application/json', 'Idempotency-Key': command.key } : { Accept: 'application/json' },
        ...(command ? { body: command.body } : {}),
      });
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) throw safeError();
      const envelope: unknown = await response.json();
      if (!record(envelope)) throw safeError();
      if (envelope.ok === true && response.status === status && !('error' in envelope) && shape(envelope.value)) {
        return { result: { ok: true, value: envelope.value as T }, definite: true };
      }
      if (envelope.ok === false && !('value' in envelope) && record(envelope.error)) {
        const error = envelope.error;
        if (!errorCode(error.code) || !string(error.message) || ('field' in error && !string(error.field))) throw safeError();
        const code = error.code as DomainErrorCode;
        if (!errorStatus(code, response.status)) throw safeError();
        const field = typeof error.field === 'string' && /^[A-Za-z][A-Za-z0-9_.[\]]{0,99}$/.test(error.field) ? error.field : undefined;
        return { result: { ok: false, error: { code, message: '本地演示请求无法完成', ...(field ? { field } : {}) } }, definite: true };
      }
    } catch { /* Never expose transport exceptions, paths or response text. */ }
    return { result: networkFailure(), definite: false };
  }

  private observeItem(item: GenerationItem): void {
    this.versions.set(item.id, Math.max(this.versions.get(item.id) ?? 0, item.version));
  }
  private observe(value: unknown): void {
    if (itemShape(value)) this.observeItem(value as GenerationItem);
    else if (batchShape(value)) for (const item of (value as GenerationBatchSnapshot).items) this.observeItem(item);
  }
  private async read<T>(path: string, shape: Check): Promise<Result<T>> {
    const { result } = await this.transport<T>(path, shape);
    if (result.ok) this.observe(result.value);
    return result;
  }
  async ready(): Promise<void> { await this.snapshot(); }
  async pump(): Promise<void> { /* The independent server worker owns execution. */ }
  async snapshot(): Promise<DemoSnapshot> {
    const sequence = ++this.snapshotSequence;
    const { result } = await this.transport<DemoSnapshot>('/snapshot', snapshotShape);
    if (!result.ok) throw safeError();
    if (sequence > this.acceptedSnapshotSequence) {
      this.acceptedSnapshotSequence = sequence;
      this.latestSnapshot = result.value;
      for (const item of result.value.items) this.observeItem(item);
      for (const batch of result.value.batches) for (const item of batch.items) this.observeItem(item);
    }
    return structuredClone(this.latestSnapshot!);
  }

  private async prepare(body: RecordValue, itemId?: string, explicitVersion?: number, key?: string): Promise<Command | Result<never>> {
    if (itemId !== undefined) {
      let version = explicitVersion ?? this.versions.get(itemId);
      if (version === undefined) {
        const result = await this.read<GenerationItem>(`/generation-items/${encodeURIComponent(itemId)}`, itemShape);
        if (!result.ok) return result;
        version = this.versions.get(itemId)!;
      }
      body = { ...body, expectedVersion: version };
    }
    return { body: encode(body), key: key ?? crypto.randomUUID() };
  }

  private async command<T>(path: string, input: unknown, shape: Check, options: { status?: number; itemId?: string; version?: number; key?: string; refresh?: boolean } = {}): Promise<Result<T>> {
    let signature: string;
    let prepared: Promise<Command | Result<never>>;
    try {
      const serialized = encode(input);
      signature = encode([path, serialized, options.key ?? null, options.version ?? null]);
      prepared = this.outstanding.get(signature) ?? (options.itemId === undefined
        ? Promise.resolve({ body: serialized, key: options.key ?? crypto.randomUUID() })
        : this.prepare(JSON.parse(serialized) as RecordValue, options.itemId, options.version, options.key));
      this.outstanding.set(signature, prepared);
      const command = await prepared;
      if ('ok' in command) {
        if (this.outstanding.get(signature) === prepared) this.outstanding.delete(signature);
        return command;
      }
      const { result, definite } = await this.transport<T>(path, shape, options.status ?? 200, command);
      if (definite && this.outstanding.get(signature) === prepared) this.outstanding.delete(signature);
      if (result.ok) {
        this.observe(result.value);
        if (options.refresh) {
          try { await this.snapshot(); } catch { /* The acknowledged write remains successful. */ }
        }
      }
      return result;
    } catch { return networkFailure(); }
  }
  private itemCommand<T>(id: string, action: string, body: RecordValue, shape: Check, options: { status?: number; version?: number; key?: string; refresh?: boolean } = {}): Promise<Result<T>> {
    return this.command(`/generation-items/${encodeURIComponent(id)}/${action}`, body, shape, { ...options, itemId: id });
  }

  readonly generation: DemoPlatform['generation'] = {
    create: (input, options) => this.command<GenerationBatchSnapshot>('/generation-batches', input, batchShape, { key: options.idempotencyKey, status: 202 }),
    get: id => this.read<GenerationBatchSnapshot>(`/generation-batches/${encodeURIComponent(id)}`, batchShape),
    cancel: (id, version) => this.itemCommand<GenerationItem>(id, 'cancel', {}, itemShape, { version }),
    retry: (id, options) => this.itemCommand<GenerationBatchSnapshot>(id, 'retry', {}, batchShape, { key: options.idempotencyKey, status: 202 }),
  };
  readonly review: DemoPlatform['review'] = {
    save: (id, rubricVersion, form) => {
      if (rubricVersion !== form.rubricVersion) return Promise.resolve({ ok: false, error: { code: 'INVALID_PARAMETERS', message: '审核版本与表单不一致', field: 'rubricVersion' } });
      return this.saveReviewRevision(id, form, '');
    },
  };
  readonly asset: DemoPlatform['asset'] = {
    saveApprovedOutput: (id, evaluationId) => this.itemCommand<Asset>(id, 'assets', { evaluationId }, assetShape, { refresh: true }),
  };
  readonly quota: DemoPlatform['quota'] = { get: () => this.read<CreditSnapshot>('/quota', quotaShape) };
  readonly split: DemoPlatform['split'] = { create: () => forbidden(), get: () => forbidden() };
  readonly media: DemoPlatform['media'] = { put: () => forbidden(), remove: () => forbidden(), get: id => this.getMedia(id) };
  readonly upload: DemoPlatform['upload'] = () => forbidden();
  readonly restore: DemoPlatform['restore'] = () => forbidden();
  readonly updateAsset: DemoPlatform['updateAsset'] = () => forbidden();
  readonly deleteAsset: DemoPlatform['deleteAsset'] = () => forbidden();
  readonly resetScenario: DemoPlatform['resetScenario'] = () => forbidden();
  readonly saveClipAsset: DemoPlatform['saveClipAsset'] = () => forbidden();
  async setScenario(name: ScenarioName): Promise<Result<void>> {
    const result = await this.command<null>('/scenario', { name }, nullShape);
    return result.ok ? { ok: true, value: undefined } : result;
  }
  loadFixture(key: string): Promise<Result<Asset>> { return this.command('/fixtures', { key }, assetShape); }
  resolveUnknown(id: string, outcome: 'success' | 'failure' | 'cancelled'): Promise<Result<GenerationItem>> {
    return this.itemCommand(id, 'reconcile', { outcome }, itemShape);
  }
  retryDownload(id: string): Promise<Result<GenerationItem>> { return this.itemCommand(id, 'retry-download', {}, itemShape, { status: 202 }); }
  saveReviewRevision(id: string, form: ReviewInput, reason: string): Promise<Result<Evaluation>> {
    return this.itemCommand(id, 'reviews', { form, reason }, evaluationShape, { refresh: true });
  }
  private async getMedia(id: string): Promise<Result<{ media: MediaFile; blob: Blob }>> {
    const path = `/media/${encodeURIComponent(id)}`;
    const metadata = await this.read<MediaFile>(path, mediaShape);
    if (!metadata.ok) return metadata;
    try {
      const media = metadata.value;
      if (media.id !== id) return networkFailure();
      const response = await this.fetcher(this.base + '/v1' + path + '/file', { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store' });
      if (response.status !== 200) return networkFailure();
      const blob = await response.blob();
      if (blob.type !== media.mime || blob.size !== media.byteSize) return networkFailure();
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      if (sha256 !== media.sha256) return networkFailure();
      return { ok: true, value: { media, blob } };
    } catch { return networkFailure(); }
  }
}
