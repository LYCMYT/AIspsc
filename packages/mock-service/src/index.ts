import type { Asset, AssetService, CreateGenerationRequest, DemoFixture, DemoManifest, DemoPlatform, DemoSnapshot, DemoSplitJob, DomainErrorCode, Evaluation, GenerationBatchSnapshot, GenerationItem, GenerationService, MediaFile, QuotaService, ReviewInput, ReviewService, ScenarioName, SplitService } from '../../contracts/src/index';
import { BrowserRepository, IndexedMediaStore, storageError } from '../../media-store/src/index';
import { validateGenerationRequest, classifyTask, selectBinding, deriveBatchStatus, decideReview, applyCreditAction, createQuotaState, planSequentialSplit, planAverageSplit, planSceneSplit, validateManualIntervals, transitionItemStatus } from '../../domain/src/index';
import { fail, guarded, sha256, stable, unwrap } from './helpers';
import { browserProbe, inspectFile, technicalPreflight, type MediaProbe } from './media';

interface Pending { itemId: string; dueAt: number; outcome: ScenarioName; downloadRetry?: boolean }
interface State extends DemoSnapshot { sequence: number; pending: Pending[]; reviewForms: Record<string, { form: ReviewInput; reason: string }>; bootstrap?: 'pending' | 'complete' }
export interface MockPlatformOptions {
  repository?: BrowserRepository<unknown>;
  clock?: () => number;
  fetcher?: typeof fetch;
  manifest?: DemoManifest;
  probe?: MediaProbe;
}
const ACTIVE = new Set(['queued', 'running', 'finalizing', 'cancel_requested', 'needs_reconciliation']);
const CANCEL_RACE_WINDOW_MS = 30000;
const CANCEL_RACE_SETTLEMENT_MS = 1200;
const SCENARIOS: ScenarioName[] = ['seed', 'empty', 'processing', 'success', 'failure', 'partial_success', 'missing_file', 'quota_insufficient', 'storage_failure', 'request_failure', 'unknown', 'download_failure', 'cancel_race'];

export class MockPlatform implements DemoPlatform {
  private repository: BrowserRepository<State>;
  private clock: () => number;
  private fetcher: typeof fetch;
  private manifest?: DemoManifest;
  private initialized?: Promise<void>;
  private probe: MediaProbe;
  readonly media: IndexedMediaStore;
  constructor(options: MockPlatformOptions = {}) {
    this.repository = (options.repository ?? new BrowserRepository()) as BrowserRepository<State>;
    this.clock = options.clock ?? Date.now;
    this.fetcher = options.fetcher ?? ((...args) => globalThis.fetch(...args));
    this.manifest = options.manifest;
    this.probe = options.probe ?? browserProbe;
    this.media = new IndexedMediaStore(this.repository);
  }
  private now() { return new Date(this.clock()).toISOString(); }
  private initial(scenario: ScenarioName): State {
    const quota = unwrap(applyCreditAction(createQuotaState(), { action: 'GRANT', referenceId: 'initial', units: 1286, createdAt: this.now(), reason: '重建测试样例初始演示额度' }));
    return { version: 1, epoch: crypto.randomUUID(), scenario, batches: [], items: [], evaluations: [], assets: [], mediaMetadata: [], credits: quota.snapshot, ledger: quota.ledger, attempts: [], reconciliations: [], splits: [], sequence: 0, pending: [], reviewForms: {}, bootstrap: scenario === 'empty' ? 'complete' : 'pending' };
  }
  ready(): Promise<void> {
    return this.initialized ??= (async () => {
      await this.repository.initialize(this.initial('seed'));
      if ((await this.repository.read())?.bootstrap === 'pending') await this.seedFixtures();
    })().catch(error => { this.initialized = undefined; throw error; });
  }
  async snapshot(): Promise<DemoSnapshot> {
    await this.ready();
    return this.repository.update(async (state, tx) => {
      for (const meta of state.mediaMetadata) {
        if (!await tx.objectStore('media').get(meta.id)) {
          meta.availability = 'missing';
          for (const asset of state.assets.filter(asset => asset.mediaFileId === meta.id)) asset.availability = 'missing';
          for (const item of state.items.filter(item => item.resultMediaId === meta.id)) item.resultAvailable = false;
        }
      }
      state.batches = state.batches.map(batch => this.batch(state, batch.id));
      return { version: state.version, epoch: state.epoch, scenario: state.scenario, batches: state.batches, items: state.items, evaluations: state.evaluations, assets: state.assets, mediaMetadata: state.mediaMetadata, credits: state.credits, ledger: state.ledger, attempts: state.attempts, reconciliations: state.reconciliations ?? [], splits: state.splits };
    });
  }
  private id(state: State, kind: string) { return `${kind}-${state.epoch.slice(0, 8)}-${++state.sequence}`; }
  private item(state: State, id: string) { return state.items.find(item => item.id === id) ?? fail('TASK_NOT_READY', '任务不存在'); }
  private batch(state: State, id: string): GenerationBatchSnapshot {
    const batch = state.batches.find(batch => batch.id === id) ?? fail('TASK_NOT_READY');
    const items = state.items.filter(item => item.batchId === id);
    return { ...batch, items, status: deriveBatchStatus(items) };
  }
  private settle(state: State, item: GenerationItem, action: 'COMMIT' | 'RELEASE') {
    const reservation = state.credits.reservations[item.id];
    if (!reservation || reservation.finalState !== 'reserved') return;
    const quota = unwrap(applyCreditAction({ snapshot: state.credits, ledger: state.ledger }, { action, referenceId: item.id, units: reservation.reservedUnits, createdAt: this.now() }));
    state.credits = quota.snapshot; state.ledger = quota.ledger;
  }
  private transition(item: GenerationItem, status: GenerationItem['status']) { Object.assign(item, unwrap(transitionItemStatus(item, status, item.version)), { updatedAt: this.now() }); }
  private createRequest(input: unknown, options: { idempotencyKey: string }, retryOfItemId?: string) {
    return guarded(async () => {
      await this.ready();
      if (!options.idempotencyKey.trim()) fail('INVALID_PARAMETERS');
      const epoch = (await this.repository.read())!.epoch;
      const canonical = typeof input === 'object' && input !== null && !Array.isArray(input)
        ? { ...input, ...('prompt' in input && typeof input.prompt === 'string' ? { prompt: input.prompt.trim() } : {}) } : input;
      const hash = await sha256(new Blob([stable(retryOfItemId ? { request: canonical, retryOfItemId } : canonical)]));
      return this.repository.update(async (state, tx) => {
        if (state.epoch !== epoch) fail('VERSION_CONFLICT');
        const existing = state.batches.find(batch => batch.idempotencyKey === options.idempotencyKey);
        if (existing) { if (existing.requestHash !== hash) fail('IDEMPOTENCY_CONFLICT'); return this.batch(state, existing.id); }
        if (retryOfItemId) {
          const prior = this.item(state, retryOfItemId);
          if (!['failed', 'cancelled'].includes(prior.status) && !(prior.status === 'succeeded' && prior.reviewState === 'rejected')) fail('ITEM_NOT_READY');
        }
        const assets = state.assets.map(asset => ({ ...asset, availability: asset.archivedAt || asset.reviewValidity === 'review_invalidated' ? 'unavailable' as const : asset.availability }));
        const request = unwrap(validateGenerationRequest(input, assets, 'demo'));
        for (const reference of request.references) {
          const asset = assets.find(asset => asset.id === reference.assetId)!;
          if (!asset.mediaFileId || !await tx.objectStore('media').get(asset.mediaFileId)) fail('MEDIA_UNAVAILABLE', '文件需重新选择');
        }
        const routing = unwrap(selectBinding(request, classifyTask(request)));
        if (state.scenario === 'request_failure') fail('NETWORK_ERROR', '模拟请求失败，请重试');
        if (state.scenario === 'quota_insufficient' || state.credits.available < request.count) fail('QUOTA_INSUFFICIENT', '演示额度不足');
        const batch: GenerationBatchSnapshot = { id: this.id(state, 'batch'), workspaceId: 'demo', requestSnapshot: structuredClone(request), requestedCount: request.count, idempotencyKey: options.idempotencyKey, requestHash: hash, createdAt: this.now(), status: 'queued', items: [] };
        state.batches.push(batch);
        for (let index = 0; index < request.count; index++) {
          const item: GenerationItem = { id: this.id(state, 'item'), batchId: batch.id, index, version: 0, status: 'queued', mode: request.mode, resultAvailable: false, retryOfItemId, routingSnapshot: routing, pricingSnapshot: { version: 'demo-pricing-v1', unitCost: 1, unitName: 'demo-credit' }, reviewState: 'pending', libraryState: 'not_saved', updatedAt: this.now() };
          state.items.push(item);
          state.pending.push({ itemId: item.id, dueAt: this.clock() + 1800 + index * 500, outcome: state.scenario });
          const quota = unwrap(applyCreditAction({ snapshot: state.credits, ledger: state.ledger }, { action: 'RESERVE', referenceId: item.id, units: 1, createdAt: this.now() }));
          state.credits = quota.snapshot; state.ledger = quota.ledger;
          state.attempts.push({ itemId: item.id, attemptNo: 1, providerBindingId: routing.bindingId, externalIdempotencyKey: item.id, submissionState: 'not_submitted', createdAt: this.now(), updatedAt: this.now() });
        }
        return this.batch(state, batch.id);
      });
    });
  }
  readonly generation: GenerationService = {
    create: (input, options) => this.createRequest(input, options),
    get: (id) => guarded(async () => { await this.ready(); return this.repository.update(state => this.batch(state, id)); }),
    cancel: (id, version) => guarded(async () => {
      await this.ready();
      return this.repository.update(state => {
        const item = this.item(state, id);
        if (version !== undefined && version !== item.version) fail('VERSION_CONFLICT');
        if (item.status === 'queued') { this.transition(item, 'cancelled'); this.settle(state, item, 'RELEASE'); }
        else if (item.status === 'running') {
          this.transition(item, 'cancel_requested');
          const pending = state.pending.find(pending => pending.itemId === id);
          if (pending?.outcome === 'cancel_race') pending.dueAt = Math.min(pending.dueAt, this.clock() + CANCEL_RACE_SETTLEMENT_MS);
        }
        return item;
      });
    }),
    retry: (id, options) => guarded(async () => {
      const state = await this.snapshot(); const item = state.items.find(item => item.id === id) ?? fail('TASK_NOT_READY');
      if (!['failed', 'cancelled'].includes(item.status) && !(item.status === 'succeeded' && item.reviewState === 'rejected')) fail('ITEM_NOT_READY', '结果未知或任务进行中，不能重新生成');
      const batch = state.batches.find(batch => batch.id === item.batchId)!;
      return unwrap(await this.createRequest({ ...batch.requestSnapshot, count: 1 }, options, id));
    }),
  };
  async pump(): Promise<void> {
    await this.ready();
    const candidates = await this.repository.update(state => {
      for (const item of state.items) {
        if (item.status === 'queued') { this.transition(item, 'running'); const attempt = state.attempts.find(a => a.itemId === item.id)!; attempt.submissionState = 'submitted'; attempt.externalJobId = `demo-${item.id}`; attempt.updatedAt = this.now(); }
      }
      return state.pending.filter(pending => pending.dueAt <= this.clock()).map(pending => ({ pending, item: this.item(state, pending.itemId), epoch: state.epoch, request: this.batch(state, this.item(state, pending.itemId).batchId).requestSnapshot }));
    });
    for (const candidate of candidates) {
      if (!['running', 'cancel_requested', 'finalizing'].includes(candidate.item.status)) continue;
      const { pending, request } = candidate;
      let output: { media: MediaFile; blob: Blob } | undefined;
      let errorCode: DomainErrorCode | undefined;
      const cancelled = candidate.item.status === 'cancel_requested' && pending.outcome !== 'cancel_race';
      const failure = pending.outcome === 'failure' || pending.outcome === 'partial_success' && candidate.item.index % 3 === 1;
      const unknown = pending.outcome === 'unknown';
      const deferred = (pending.outcome === 'download_failure' || pending.outcome === 'storage_failure') && !pending.downloadRetry;
      if (!cancelled && !failure && !unknown && !deferred && request.mode !== 'copy') {
        try { output = await this.fetchFixture(this.outputKey(request)); }
        catch (error) { errorCode = error && typeof error === 'object' && 'code' in error ? error.code as DomainErrorCode : 'FILE_FIXTURE_MISSING'; }
      }
      await this.repository.update(async (state, tx) => {
        if (state.epoch !== candidate.epoch) return;
        const item = this.item(state, candidate.item.id);
        if (item.version !== candidate.item.version || !['running', 'cancel_requested', 'finalizing'].includes(item.status)) return;
        const attempt = state.attempts.find(a => a.itemId === item.id)!;
        if (cancelled) { this.transition(item, 'cancelled'); this.settle(state, item, 'RELEASE'); attempt.submissionState = 'settled'; }
        else if (unknown) { this.transition(item, 'needs_reconciliation'); item.errorCode = 'PROVIDER_OUTCOME_UNKNOWN'; attempt.submissionState = 'outcome_unknown'; }
        else if (deferred || errorCode === 'NETWORK_ERROR') {
          if (item.status !== 'finalizing') this.transition(item, 'finalizing');
          item.errorCode = pending.outcome === 'storage_failure' ? 'STORAGE_QUOTA_EXCEEDED' : 'NETWORK_ERROR';
          const stored = state.pending.find(p => p.itemId === item.id)!;
          if (errorCode === 'NETWORK_ERROR') { stored.outcome = 'download_failure'; stored.downloadRetry = false; }
        }
        else if (failure || errorCode) { this.transition(item, 'failed'); item.errorCode = errorCode ?? 'NETWORK_ERROR'; this.settle(state, item, 'RELEASE'); attempt.submissionState = 'settled'; }
        else {
          if (item.status !== 'finalizing') this.transition(item, 'finalizing');
          if (output) { await tx.objectStore('media').put(output, output.media.id); state.mediaMetadata.push(output.media); item.resultMediaId = output.media.id; }
          else if (request.mode === 'copy') item.text = `【演示文案】根据您的提示：${request.prompt}`.slice(0, request.copy.maxCharacters);
          this.transition(item, 'succeeded'); item.resultAvailable = true; delete item.errorCode; this.settle(state, item, 'COMMIT'); attempt.submissionState = 'settled';
        }
        attempt.updatedAt = this.now();
      }).catch(async error => {
        const failure = storageError(error);
        await this.repository.update(state => {
          if (state.epoch !== candidate.epoch) return;
          const item = this.item(state, candidate.item.id);
          if (item.version !== candidate.item.version || !['running', 'cancel_requested', 'finalizing'].includes(item.status)) return;
          if (item.status !== 'finalizing') this.transition(item, 'finalizing');
          item.errorCode = failure.code;
          const pending = state.pending.find(p => p.itemId === item.id)!; pending.outcome = 'storage_failure'; pending.downloadRetry = false;
        });
      });
    }
  }
  private outputKey(request: Exclude<CreateGenerationRequest, { mode: 'copy' }>) {
    return request.mode === 'image' ? `image-${request.image.ratio.replace(':', 'x')}-${request.image.resolution}` : `video-${request.video.durationSeconds}-${request.video.ratio.replace(':', 'x')}-${request.video.resolution}-${request.video.audio ? 'audio' : 'silent'}`;
  }
  private async getManifest(): Promise<DemoManifest> {
    if (!this.manifest) {
      const response = await this.fetcher('/demo/MEDIA_MANIFEST.json');
      if (!response.ok) fail('FILE_FIXTURE_MISSING', '演示媒体清单不可用');
      this.manifest = await response.json() as DemoManifest;
    }
    return this.manifest;
  }
  private async fetchFixture(key: string): Promise<{ media: MediaFile; blob: Blob }> {
    const fixture = (await this.getManifest()).files.find(file => file.key === key) ?? fail('FILE_FIXTURE_MISSING', '缺少匹配参数的演示文件');
    const relativePath = fixture.path.startsWith('/demo/') ? fixture.path.slice(6) : fixture.path;
    if (!/^[a-zA-Z0-9_/-]+\.[a-zA-Z0-9]+$/.test(relativePath) || relativePath.startsWith('/') || relativePath.includes('..')) fail('FILE_FIXTURE_MISSING');
    let response: Response;
    try { response = await this.fetcher(`/demo/${relativePath}`); } catch { fail('NETWORK_ERROR', '演示文件下载失败，请重试下载'); }
    if (!response.ok) fail(response.status === 404 ? 'FILE_FIXTURE_MISSING' : 'NETWORK_ERROR');
    let blob: Blob;
    try { blob = await response.blob(); } catch { fail('NETWORK_ERROR', '演示文件读取中断，请重试下载'); }
    if (await sha256(blob) !== fixture.sha256) fail('FILE_FIXTURE_MISSING', '演示文件哈希校验失败');
    return { blob, media: this.fixtureMetadata(fixture, blob) };
  }
  private fixtureMetadata(fixture: DemoFixture, blob: Blob): MediaFile {
    const id = crypto.randomUUID();
    return { id, blobKey: id, workspaceId: 'demo', mediaType: fixture.mime.startsWith('video/') ? 'video' : 'image', mime: fixture.mime, byteSize: blob.size, width: fixture.width, height: fixture.height, durationMs: fixture.durationMs, hasAudio: fixture.hasAudio, sha256: fixture.sha256, availability: 'available', isDemo: true, fixtureKey: fixture.fixtureKey };
  }
  readonly quota: QuotaService = { get: () => guarded(async () => (await this.snapshot()).credits) };
  setScenario(name: ScenarioName) { return guarded(async () => { await this.ready(); if (!SCENARIOS.includes(name)) fail('INVALID_PARAMETERS'); await this.repository.update(state => { state.scenario = name; }); }); }
  resetScenario(name: ScenarioName, confirmed: boolean) { return guarded(async () => {
    if (!confirmed) fail('FORBIDDEN', '重置演示需要确认'); if (!SCENARIOS.includes(name)) fail('INVALID_PARAMETERS');
    await this.ready(); await this.repository.reset(this.initial(name));
    if (name === 'empty') return;
    await this.seedFixtures();
    if (name === 'missing_file') {
      const state = await this.repository.read(); const first = state?.assets[0]; if (first?.mediaFileId) unwrap(await this.media.remove(first.mediaFileId)); return;
    }
    if (['seed', 'quota_insufficient', 'request_failure'].includes(name)) return;
    const manifest = await this.getManifest();
    const count = name === 'partial_success' ? 3 : 1;
    const request: CreateGenerationRequest = manifest.files.some(file => file.key === 'video-10-9x16-720p-silent')
      ? { mode: 'video', prompt: '重建测试样例：几何商品包装展示', references: [], count, video: { durationSeconds: 10, ratio: '9:16', resolution: '720p', audio: false } }
      : { mode: 'copy', prompt: '重建测试样例：几何商品包装展示', references: [], count, copy: { language: 'zh-CN', maxCharacters: 100 } };
    unwrap(await this.generation.create(request, { idempotencyKey: `scenario-${crypto.randomUUID()}` }));
    if (name !== 'processing') await this.repository.update(state => {
      for (const pending of state.pending) pending.dueAt = name === 'cancel_race' ? this.clock() + CANCEL_RACE_WINDOW_MS : this.clock() - 1;
    });
    await this.pump();
  }); }
  private async seedFixtures(): Promise<void> {
    const state = await this.repository.read(); if (!state) return;
    const files = (await this.getManifest()).files.filter(file => ['image-9x16-1024', 'image-16x9-1024', 'image-1x1-1024', 'scene-source'].includes(file.key));
    for (const fixture of files) {
      const output = await this.fetchFixture(fixture.key);
      await this.repository.update(async (current, tx) => {
        if (current.epoch !== state.epoch || current.mediaMetadata.some(media => media.fixtureKey === fixture.fixtureKey)) return;
        await tx.objectStore('media').put(output, output.media.id); current.mediaMetadata.push(output.media);
        current.assets.push({ id: this.id(current, 'asset'), workspaceId: 'demo', mediaFileId: output.media.id, mediaType: output.media.mediaType, availability: 'available', source: 'fixture', title: fixture.key === 'scene-source' ? '演示视频 · 场景拆解样例' : `重建测试样例 · 几何图形 ${fixture.width}×${fixture.height}`, tags: ['重建测试样例', '几何图形'], createdAt: this.now(), isDemo: true });
      });
    }
    await this.repository.update(current => { if (current.epoch === state.epoch) current.bootstrap = 'complete'; });
  }
  loadFixture(key: string) { return guarded<Asset>(async () => {
    await this.ready(); const epoch = (await this.snapshot()).epoch; const output = await this.fetchFixture(key);
    return this.repository.update(async (state, tx) => {
      if (state.epoch !== epoch) fail('VERSION_CONFLICT');
      const existing = state.assets.find(asset => !asset.archivedAt && asset.source === 'fixture' && state.mediaMetadata.some(media => media.id === asset.mediaFileId && media.fixtureKey === output.media.fixtureKey));
      if (existing?.mediaFileId) {
        const meta = state.mediaMetadata.find(media => media.id === existing.mediaFileId)!;
        meta.availability = 'available'; existing.availability = 'available';
        await tx.objectStore('media').put({ media: meta, blob: output.blob }, meta.id); return existing;
      }
      await tx.objectStore('media').put(output, output.media.id); state.mediaMetadata.push(output.media);
      const asset: Asset = { id: this.id(state, 'asset'), workspaceId: 'demo', mediaFileId: output.media.id, mediaType: output.media.mediaType, availability: 'available', source: 'fixture', title: key === 'scene-source' ? '演示视频 · 场景拆解样例' : '重建测试样例 · 几何图形', tags: ['重建测试样例'], createdAt: this.now(), isDemo: true };
      state.assets.push(asset); return asset;
    });
  }); }
  resolveUnknown(id: string, outcome: 'success' | 'failure' | 'cancelled') { return guarded(async () => {
    await this.ready();
    return this.repository.update(state => {
      const item = this.item(state, id); if (item.status !== 'needs_reconciliation') fail('ITEM_NOT_READY');
      if (!['success', 'failure', 'cancelled'].includes(outcome)) fail('INVALID_PARAMETERS');
      state.reconciliations ??= [];
      state.reconciliations.push({ itemId: id, outcome, evidence: '重建测试样例：人工触发确定性模拟对账结果', createdAt: this.now() });
      const pending = state.pending.find(p => p.itemId === id)!;
      if (outcome === 'cancelled') { this.transition(item, 'cancelled'); this.settle(state, item, 'RELEASE'); }
      else { pending.outcome = outcome === 'success' ? 'success' : 'failure'; pending.dueAt = this.clock(); this.transition(item, 'running'); }
      const attempt = state.attempts.find(a => a.itemId === id)!; attempt.submissionState = outcome === 'cancelled' ? 'settled' : 'submitted'; attempt.updatedAt = this.now();
      return item;
    });
  }); }
  retryDownload(id: string) { return guarded(async () => { await this.ready(); return this.repository.update(state => { const item = this.item(state, id); if (item.status !== 'finalizing') fail('ITEM_NOT_READY'); const pending = state.pending.find(p => p.itemId === id)!; pending.downloadRetry = true; pending.dueAt = this.clock(); return item; }); }); }
  readonly review: ReviewService = { save: (id, rubric, form) => guarded(async () => { if (rubric !== form.rubricVersion) fail('INVALID_PARAMETERS'); return this.saveReview(id, form, ''); }) };
  saveReviewRevision(id: string, form: ReviewInput, reason: string) { return guarded(() => this.saveReview(id, form, reason)); }
  private async saveReview(id: string, form: ReviewInput, reason: string): Promise<Evaluation> {
    await this.ready(); return this.repository.update(async (state, tx) => {
      const item = this.item(state, id);
      const entry = item.resultMediaId ? await tx.objectStore('media').get(item.resultMediaId) : undefined;
      if (item.resultMediaId && !entry) fail('MEDIA_UNAVAILABLE');
      const request = this.batch(state, item.batchId).requestSnapshot;
      const technicalErrors = technicalPreflight(request, entry?.media);
      const checkedForm: ReviewInput = form.rubricVersion === 'rubric-v2-rebuild'
        ? { ...form, technicalErrors: [...new Set([...form.technicalErrors, ...technicalErrors])] }
        : { ...form, readable: form.readable && (request.mode === 'copy' ? !!item.text?.trim() && item.text.length <= request.copy.maxCharacters : technicalErrors.length === 0) };
      const existing = state.evaluations.filter(evaluation => evaluation.itemId === id).at(-1);
      if (existing) {
        if (stable(state.reviewForms[existing.id]?.form) === stable(form)) return existing;
        if (!reason.trim()) fail('INVALID_PARAMETERS', '改判必须填写原因');
      }
      const decision = unwrap(decideReview(item, checkedForm));
      const evaluation: Evaluation = { id: this.id(state, 'review'), itemId: id, revision: (existing?.revision ?? 0) + 1, rubricVersion: form.rubricVersion, score: 'score' in form ? form.score : undefined, applicability: 'applicability' in form ? form.applicability : undefined, issueTags: 'issueTags' in form ? form.issueTags : [], hardFailures: 'hardFailures' in form ? form.hardFailures : [], technicalErrors: checkedForm.rubricVersion === 'rubric-v2-rebuild' ? checkedForm.technicalErrors : technicalErrors, decision: decision.decision, reason: reason || decision.reason, reviewerId: 'demo-human', createdAt: this.now() };
      state.evaluations.push(evaluation); state.reviewForms[evaluation.id] = { form: structuredClone(form), reason };
      item.reviewState = evaluation.decision;
      if (evaluation.decision === 'rejected') for (const asset of state.assets.filter(asset => asset.originItemId === id)) asset.reviewValidity = 'review_invalidated';
      return evaluation;
    });
  }
  readonly asset: AssetService = { saveApprovedOutput: (id, evaluationId) => guarded(async () => {
    await this.ready(); return this.repository.update(async (state, tx) => {
      const item = this.item(state, id); const evaluation = state.evaluations.filter(e => e.itemId === id).at(-1);
      if (!evaluation || evaluation.id !== evaluationId) fail('REVIEW_REQUIRED');
      if (evaluation.decision !== 'approved') fail('REVIEW_REJECTED');
      if (item.status !== 'succeeded' || !item.resultAvailable) fail('ITEM_NOT_READY');
      if (item.resultMediaId && !await tx.objectStore('media').get(item.resultMediaId)) fail('MEDIA_UNAVAILABLE');
      const existing = state.assets.find(asset => asset.originItemId === id);
      if (existing) { existing.reviewId = evaluation.id; existing.reviewValidity = 'valid'; return existing; }
      const asset: Asset = { id: this.id(state, 'asset'), workspaceId: 'demo', mediaFileId: item.resultMediaId, text: item.text, mediaType: item.mode === 'copy' ? 'text' : item.mode, availability: 'available', source: 'generated', originItemId: id, reviewId: evaluation.id, reviewValidity: 'valid', title: this.batch(state, item.batchId).requestSnapshot.prompt.slice(0, 80), tags: [], createdAt: this.now(), isDemo: true };
      state.assets.push(asset); item.libraryState = 'saved'; return asset;
    });
  }) };
  updateAsset(id: string, input: { title: string; tags: string[] }) { return guarded(async () => { await this.ready(); return this.repository.update(state => { const asset = state.assets.find(a => a.id === id) ?? fail('ASSET_NOT_FOUND'); if (!input.title.trim() || input.title.length > 120 || input.tags.some(tag => !tag.trim() || tag.length > 40)) fail('INVALID_PARAMETERS'); asset.title = input.title.trim(); asset.tags = [...new Set(input.tags.map(tag => tag.trim()))]; return asset; }); }); }
  deleteAsset(id: string) { return guarded(async () => { await this.ready(); await this.repository.update(state => { const asset = state.assets.find(a => a.id === id) ?? fail('ASSET_NOT_FOUND'); if (state.items.some(item => ACTIVE.has(item.status) && this.batch(state, item.batchId).requestSnapshot.references.some(ref => ref.assetId === id))) fail('FORBIDDEN', '素材正被运行任务引用'); asset.archivedAt = this.now(); asset.availability = 'unavailable'; }); }); }
  upload(blob: Blob, filename: string) { return guarded<Asset>(async () => {
    await this.ready(); const epoch = (await this.snapshot()).epoch;
    const measured = await inspectFile(blob, this.probe);
    const fixture = (await this.getManifest()).files.find(file => file.sha256 === measured.sha256);
    return this.repository.update(async (state, tx) => {
      if (epoch !== state.epoch) fail('VERSION_CONFLICT');
      const id = this.id(state, 'media');
      const media: MediaFile = { ...measured, id, blobKey: id, isDemo: !!fixture, fixtureKey: fixture?.fixtureKey, hasAudio: fixture?.hasAudio ?? measured.hasAudio };
      await tx.objectStore('media').put({ media, blob }, id); state.mediaMetadata.push(media);
      const asset: Asset = { id: this.id(state, 'asset'), workspaceId: 'demo', mediaFileId: id, mediaType: media.mediaType, availability: 'available', source: 'upload', title: filename.slice(0, 120) || '上传素材', tags: [], createdAt: this.now(), isDemo: !!fixture };
      state.assets.push(asset); return asset;
    });
  }); }
  restore(assetId: string, blob: Blob) { return guarded<Asset>(async () => {
    await this.ready(); const state = await this.snapshot(); const asset = state.assets.find(a => a.id === assetId) ?? fail('ASSET_NOT_FOUND');
    const previous = state.mediaMetadata.find(media => media.id === asset.mediaFileId) ?? fail('MEDIA_UNAVAILABLE');
    const measured = await inspectFile(blob, this.probe);
    if (measured.sha256 !== previous.sha256) fail('INVALID_PARAMETERS', '请选择与原文件一致的素材');
    return this.repository.update(async (current, tx) => {
      if (current.epoch !== state.epoch) fail('VERSION_CONFLICT');
      const metadata = current.mediaMetadata.find(media => media.id === previous.id)!; metadata.availability = 'available';
      await tx.objectStore('media').put({ media: metadata, blob }, metadata.id);
      for (const matching of current.assets.filter(a => a.mediaFileId === metadata.id)) matching.availability = matching.archivedAt ? 'unavailable' : 'available';
      for (const item of current.items.filter(item => item.resultMediaId === metadata.id)) item.resultAvailable = true;
      return current.assets.find(a => a.id === assetId)!;
    });
  }); }
  readonly split: SplitService = {
    create: (input) => guarded(async () => {
      await this.ready(); const state = await this.snapshot(); const source = unwrap(await this.media.get(input.sourceMediaId));
      if (source.media.workspaceId !== 'demo' || source.media.mediaType !== 'video') fail('REFERENCE_TYPE_MISMATCH');
      const duration = source.media.durationMs ?? fail('MEDIA_UNAVAILABLE');
      const manifest = await this.getManifest(); const sourceFixture = manifest.files.find(file => file.sha256 === source.media.sha256);
      if (input.mode === 'scene' && !sourceFixture?.sceneCutMs) fail('SCENE_FIXTURE_REQUIRED', '未知素材不能使用固定场景检测样例');
      const scene = input.mode === 'scene' ? planSceneSplit(duration, sourceFixture!.sceneCutMs!) : undefined;
      const intervals = input.mode === 'sequential' ? planSequentialSplit(duration) : input.mode === 'average' ? planAverageSplit(duration) : input.mode === 'manual' ? validateManualIntervals(duration, input.manualIntervals ?? []) : scene?.intervals ?? fail('INVALID_PARAMETERS');
      const outputs = await Promise.all(intervals.map(async interval => {
        const fixture = manifest.files.find(file => file.sourceSha256 === source.media.sha256 && file.startMs === interval.startMs && file.endMs === interval.endMs);
        if (!fixture) return undefined;
        try { return await this.fetchFixture(fixture.key); } catch { return undefined; }
      }));
      return this.repository.update(async (current, tx) => {
        if (current.epoch !== state.epoch || !await tx.objectStore('media').get(source.media.id)) fail('MEDIA_UNAVAILABLE');
        const job: DemoSplitJob = { id: this.id(current, 'split'), sourceMediaId: source.media.id, sourceSha256: source.media.sha256, sourceDurationMs: duration, mode: input.mode, ruleVersion: 'split-v2-rebuild', sceneRanges: scene?.sceneRanges, expandedIntervals: scene?.expandedIntervals, status: 'succeeded', intervals: [] };
        for (const [index, interval] of intervals.entries()) {
          const output = outputs[index];
          if (output) { await tx.objectStore('media').put(output, output.media.id); current.mediaMetadata.push(output.media); }
          job.intervals.push({ ...interval, mediaFileId: output?.media.id, actualDurationMs: output?.media.durationMs });
        }
        current.splits.push(job); return job;
      });
    }),
    get: (id) => guarded(async () => (await this.snapshot()).splits.find(job => job.id === id) ?? fail('TASK_NOT_READY')),
  };
  saveClipAsset(splitId: string, index: number) { return guarded<Asset>(async () => {
    await this.ready(); return this.repository.update(async (state, tx) => {
      const job = state.splits.find(job => job.id === splitId) ?? fail('TASK_NOT_READY');
      const clip = job.intervals[index]; if (!clip?.mediaFileId) fail('MEDIA_UNAVAILABLE', '已规划区间，尚未生成切片');
      const entry = await tx.objectStore('media').get(clip.mediaFileId); if (!entry || entry.media.availability !== 'available') fail('MEDIA_UNAVAILABLE');
      const existing = state.assets.find(asset => asset.mediaFileId === entry.media.id); if (existing) return existing;
      const asset: Asset = { id: this.id(state, 'asset'), workspaceId: 'demo', mediaFileId: entry.media.id, mediaType: 'video', availability: 'available', source: 'fixture', title: `演示片段 ${index + 1} · ${clip.startMs / 1000}–${clip.endMs / 1000}秒`, tags: [], createdAt: this.now(), isDemo: true };
      state.assets.push(asset); return asset;
    });
  }); }
}
