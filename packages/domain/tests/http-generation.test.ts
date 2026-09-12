import { describe, expect, it } from 'vitest';
import manifestSource from '../../../apps/web/public/demo/MEDIA_MANIFEST.json';
import type { CreateGenerationRequest, DemoManifest, GenerationState, ItemVersionInput, MediaFile, Result, ReviewInput, ScenarioName } from '../../contracts/src/index.js';
import { applyWorkerEvent, cancelItem, createBatch, createGenerationState, projectGenerationSnapshot, reconcileItem, retryItem, retryItemDownload, saveItemAsset, saveItemReview } from '../src/index.js';

const manifest = manifestSource as DemoManifest;
const context = { now: 1000, manifest };
const copyRequest: CreateGenerationRequest = { mode: 'copy', prompt: '  几何商品演示  ', references: [], count: 1, copy: { language: 'zh-CN', maxCharacters: 100 } };
const imageRequest: CreateGenerationRequest = { mode: 'image', prompt: '几何商品演示', references: [], count: 1, image: { ratio: '16:9', resolution: '1024' } };
const videoRequest: CreateGenerationRequest = { mode: 'video', prompt: '几何商品演示', references: [], count: 1, video: { ratio: '16:9', resolution: '720p', durationSeconds: 5, audio: false } };
const basicForm: ReviewInput = { rubricVersion: 'basic-media-review-v1', humanDecision: 'approved', readable: true, followsTask: true };
const videoForm: ReviewInput = { rubricVersion: 'rubric-v2-rebuild', score: 8, applicability: {
  Q01: { applicable: true }, Q02: { applicable: true }, Q03: { applicable: true }, Q04: { applicable: true }, Q05: { applicable: true }, Q06: { applicable: true }, Q07: { applicable: true }, Q08: { applicable: true }, Q09: { applicable: true }, Q10: { applicable: true }, Q11: { applicable: true },
}, issueTags: [], hardFailures: [], technicalErrors: [] };
function value<T>(result: Result<T>): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; }
function setup(scenario: ScenarioName = 'success', request = copyRequest) {
  const state = createGenerationState('test-epoch', 1000); state.scenario = scenario;
  const batch = value(createBatch(state, request, 'create-one', 'hash-one', context));
  return { state, id: batch.items[0]!.id, batch };
}
function current(state: GenerationState, id: string) { return state.items.find(item => item.id === id)!; }
function event(state: GenerationState, id: string, kind: 'submitting' | 'submitted' | 'complete' | 'download_failed', media?: MediaFile) {
  return applyWorkerEvent(state, { kind, itemId: id, expectedVersion: current(state, id).version, ...(kind === 'complete' && media ? { media } : {}) }, context);
}
function submitted(state: GenerationState, id: string) { value(event(state, id, 'submitting')); value(event(state, id, 'submitted')); }
function fixtureMedia(key: string): MediaFile {
  const fixture = manifest.files.find(file => file.key === key)!;
  return { id: `media-${key}`, workspaceId: 'demo', mediaType: fixture.mime.startsWith('video/') ? 'video' : 'image', mime: fixture.mime, byteSize: 100, width: fixture.width, height: fixture.height, ...(fixture.durationMs === undefined ? {} : { durationMs: fixture.durationMs }), objectKey: fixture.path, sha256: fixture.sha256, availability: 'available', hasAudio: fixture.hasAudio, isDemo: true, fixtureKey: fixture.fixtureKey };
}
function success(request = copyRequest) {
  const result = setup('success', request); submitted(result.state, result.id);
  value(event(result.state, result.id, 'complete', request.mode === 'video' ? fixtureMedia('video-5-16x9-720p-silent') : request.mode === 'image' ? fixtureMedia('image-16x9-1024') : undefined));
  return result;
}

describe('HTTP generation aggregate', () => {
  it('grants once and projects detached public state without private data', () => {
    const state = createGenerationState('test-epoch', 1000);
    expect(state.credits).toMatchObject({ granted: 1286, available: 1286, reserved: 0, spent: 0 });
    expect(state.ledger).toHaveLength(1);
    state.memo.private = { hash: 'secret', value: null };
    const snapshot = projectGenerationSnapshot(state);
    for (const key of ['sequence', 'pending', 'memo', 'reviewForms']) expect(snapshot).not.toHaveProperty(key);
    snapshot.credits.available = 0;
    expect(state.credits.available).toBe(1286);
  });
  it('validates prompt and exact output support before reservation', () => {
    const state = createGenerationState('test-epoch', 1000);
    expect(createBatch(state, { ...copyRequest, prompt: ' \n ' }, 'a', 'h', context)).toMatchObject({ ok: false, error: { code: 'PROMPT_REQUIRED' } });
    expect(createBatch(state, videoRequest, 'b', 'h', { now: 1000, manifest: { version: 1, files: [] } })).toMatchObject({ ok: false, error: { code: 'NO_COMPATIBLE_MODEL' } });
    expect(state.credits.available).toBe(1286); expect(state.items).toHaveLength(0);
  });
  it('rejects unavailable, archived and review-invalidated references before reserving', () => {
    for (const extra of [{ availability: 'missing' as const }, { archivedAt: '2026-01-01' }, { reviewValidity: 'review_invalidated' as const }]) {
      const state = createGenerationState('test-epoch', 1000);
      state.assets.push({ id: 'ref', workspaceId: 'demo', mediaType: 'image', availability: 'available', source: 'fixture', title: 'ref', tags: [], createdAt: '2026-01-01', isDemo: true, ...extra });
      expect(createBatch(state, { ...videoRequest, references: [{ assetId: 'ref', role: 'product' }] }, 'a', 'h', context)).toMatchObject({ ok: false, error: { code: 'ASSET_UNAVAILABLE' } });
      expect(state.credits.reserved).toBe(0);
    }
  });
  it('reserves the entire batch or rejects without publishing items', () => {
    const state = createGenerationState('test-epoch', 1000); state.credits.available = 1;
    expect(createBatch(state, { ...copyRequest, count: 2 }, 'a', 'h', context)).toMatchObject({ ok: false, error: { code: 'QUOTA_INSUFFICIENT' } });
    expect(state.items).toHaveLength(0);
  });
  it('creates normalized stable batches, attempt and durable pending work at version zero', () => {
    const { state, batch, id } = setup();
    expect(batch.requestSnapshot.prompt).toBe('几何商品演示');
    expect(current(state, id)).toMatchObject({ status: 'queued', version: 0 });
    expect(state.attempts).toMatchObject([{ itemId: id, submissionState: 'not_submitted', attemptNo: 1 }]);
    expect(state.pending).toMatchObject([{ itemId: id, scenario: 'success', phase: 'submit', downloadRetry: false }]);
    expect(state.credits).toMatchObject({ available: 1285, reserved: 1 });
    expect(setup().id).toBe(id);
  });
  it.each([copyRequest, imageRequest, videoRequest])('completes $mode through one increment per worker command and commits exactly once', request => {
    const { state, id, batch } = success(request);
    expect(current(state, id)).toMatchObject({ status: 'succeeded', resultAvailable: true, reviewState: 'pending', libraryState: 'not_saved', version: 3 });
    expect(state.credits).toMatchObject({ reserved: 0, spent: 1 });
    expect(projectGenerationSnapshot(state).batches.find(row => row.id === batch.id)?.status).toBe('succeeded');
    expect(state.pending).toHaveLength(0); expect(state.assets).toHaveLength(0);
    expect(state.attempts[0]).toMatchObject({ submissionState: 'settled' });
    const before = structuredClone(state);
    expect(event(state, id, 'complete').ok).toBe(false);
    expect(state).toEqual(before);
    if (request.mode === 'copy') expect(current(state, id).text).toContain('演示');
    else expect(state.mediaMetadata[0]).toMatchObject({ isDemo: true, fixtureKey: expect.any(String) });
  });
  it('refuses fabricated or mismatched media at successful completion', () => {
    const { state, id } = setup('success', videoRequest); submitted(state, id);
    const media = fixtureMedia('video-5-16x9-720p-silent');
    for (const candidate of [undefined, { ...media, sha256: 'wrong' }, { ...media, hasAudio: true }, { ...media, isDemo: false }, { ...media, width: 1 }]) {
      const detached = structuredClone(state);
      expect(event(detached, id, 'complete', candidate).ok).toBe(false);
    }
    expect(state.credits.reserved).toBe(1);
  });
  it('derives partial success and releases failed items without losing successful charges', () => {
    const { state, batch } = setup('partial_success', { ...copyRequest, count: 3 });
    for (const item of batch.items) { submitted(state, item.id); value(event(state, item.id, 'complete')); }
    expect(projectGenerationSnapshot(state).batches[0]?.status).toBe('partial_succeeded');
    expect(state.items.map(item => item.status)).toEqual(['succeeded', 'failed', 'succeeded']);
    expect(state.credits).toMatchObject({ available: 1284, spent: 2, reserved: 0 });
  });
  it('queued cancellation releases and blocks later worker acceptance', () => {
    const { state, id } = setup();
    expect(value(cancelItem(state, id, { expectedVersion: 0 }, 1100))).toMatchObject({ status: 'cancelled', version: 1 });
    expect(state.credits).toMatchObject({ available: 1286, reserved: 0 });
    expect(state.pending).toHaveLength(0); expect(event(state, id, 'submitting').ok).toBe(false);
  });
  it.each([['success', 'cancelled', 0], ['cancel_race', 'succeeded', 1]] as const)('handles running cancellation in %s', (scenario, status, spent) => {
    const { state, id } = setup(scenario); submitted(state, id);
    expect(value(cancelItem(state, id, { expectedVersion: 2 }, 1100))).toMatchObject({ status: 'cancel_requested', version: 3 });
    value(event(state, id, 'complete'));
    expect(current(state, id)).toMatchObject({ status, version: 4 }); expect(state.credits.spent).toBe(spent);
  });
  it.each(['success', 'failure', 'cancelled'] as const)('holds unknown quota, forbids blind retry and reconciles %s', outcome => {
    const { state, id } = setup('unknown'); submitted(state, id); value(event(state, id, 'complete'));
    expect(current(state, id).status).toBe('needs_reconciliation'); expect(state.credits.reserved).toBe(1);
    expect(retryItem(structuredClone(state), id, { expectedVersion: 3 }, 'retry', 'retry-hash', context)).toMatchObject({ ok: false, error: { code: 'PROVIDER_OUTCOME_UNKNOWN' } });
    const result = value(reconcileItem(state, id, { expectedVersion: 3, outcome }, 1200));
    expect(result.version).toBe(4);
    if (outcome === 'success') { expect(result.status).toBe('finalizing'); value(event(state, id, 'complete')); expect(state.credits.spent).toBe(1); }
    else { expect(result.status).toBe(outcome === 'failure' ? 'failed' : 'cancelled'); expect(state.credits.available).toBe(1286); }
    expect(state.reconciliations).toMatchObject([{ itemId: id, outcome, evidence: expect.stringContaining('模拟') }]);
    expect(state.attempts).toHaveLength(1);
  });
  it.each(['download_failure', 'storage_failure'] as const)('recovers %s without another generation attempt', scenario => {
    const { state, id } = setup(scenario); submitted(state, id); value(event(state, id, 'complete'));
    expect(current(state, id)).toMatchObject({ status: 'finalizing', version: 3, resultAvailable: false });
    expect(state.credits.reserved).toBe(1);
    value(retryItemDownload(state, id, { expectedVersion: 3 }, 1500));
    expect(current(state, id).version).toBe(4); expect(state.pending[0]).toMatchObject({ downloadRetry: true, phase: 'download', dueAt: 1500 });
    value(event(state, id, 'complete')); expect(current(state, id).status).toBe('succeeded'); expect(state.attempts).toHaveLength(1);
  });
  it('pauses a real fixture read failure until explicit recovery', () => {
    const { state, id } = setup('success', videoRequest); submitted(state, id);
    value(event(state, id, 'download_failed'));
    expect(current(state, id)).toMatchObject({ status: 'finalizing', errorCode: 'MEDIA_UNAVAILABLE', version: 3 });
    value(retryItemDownload(state, id, { expectedVersion: 3 }, 1500));
    value(event(state, id, 'complete', fixtureMedia('video-5-16x9-720p-silent')));
    expect(state.credits.spent).toBe(1);
  });
  it('cannot finalize a paused download through a fresh worker event before explicit retry', () => {
    const { state, id } = setup('success', videoRequest); submitted(state, id);
    value(event(state, id, 'download_failed'));
    const detached = structuredClone(state);
    expect(event(detached, id, 'complete', fixtureMedia('video-5-16x9-720p-silent'))).toMatchObject({ ok: false, error: { code: 'ITEM_NOT_READY' } });
    expect(detached).toEqual(state);
  });
  it('retry creates a single linked child and increments only its failed source once', () => {
    const { state, id } = setup('failure'); submitted(state, id); value(event(state, id, 'complete'));
    state.scenario = 'success';
    const retry = value(retryItem(state, id, { expectedVersion: 3 }, 'retry', 'retry-hash', context));
    expect(retry.items).toHaveLength(1); expect(retry.items[0]).toMatchObject({ retryOfItemId: id, version: 0, status: 'queued' });
    expect(current(state, id).version).toBe(4); expect(state.attempts).toHaveLength(2); expect(state.credits.reserved).toBe(1);
  });
});

describe('version and review guards', () => {
  const staleCommands: Array<[string, (state: GenerationState, id: string, input: ItemVersionInput) => Result<unknown>]> = [
    ['cancel', (s, id, v) => cancelItem(s, id, v, 2000)], ['retry', (s, id, v) => retryItem(s, id, v, 'retry', 'hash', context)],
    ['reconcile', (s, id, v) => reconcileItem(s, id, { ...v, outcome: 'success' }, 2000)], ['download', (s, id, v) => retryItemDownload(s, id, v, 2000)],
    ['worker', (s, id, v) => applyWorkerEvent(s, { ...v, itemId: id, kind: 'complete' }, context)],
    ['review', (s, id, v) => saveItemReview(s, id, { ...v, form: basicForm, reason: '' }, 'digest', 2000)],
    ['save', (s, id, v) => saveItemAsset(s, id, { ...v, evaluationId: 'review' }, 'digest', 2000)],
  ];
  it.each(staleCommands)('%s checks stale version before status or no-op logic', (_, command) => {
    const { state, id } = success(); const before = structuredClone(state);
    expect(command(state, id, { expectedVersion: 0 })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } }); expect(state).toEqual(before);
    expect(command(state, 'absent', { expectedVersion: 0 })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_READY' } });
  });
  it('rejects pending reviews and unreviewed saves', () => {
    const { state, id } = setup();
    expect(saveItemReview(state, id, { expectedVersion: 0, form: basicForm, reason: '' }, 'digest', 2000).ok).toBe(false);
    expect(saveItemAsset(state, id, { expectedVersion: 0, evaluationId: 'none' }, 'digest', 2000).ok).toBe(false);
  });
  it('keeps approval separate from manual save and invalidates assets even on approved revision', () => {
    const { state, id } = success();
    const first = value(saveItemReview(state, id, { expectedVersion: 3, form: basicForm, reason: '' }, 'digest', 2000));
    expect(first.revision).toBe(1); expect(current(state, id).version).toBe(4); expect(state.assets).toHaveLength(0);
    expect(saveItemAsset(structuredClone(state), id, { expectedVersion: 4, evaluationId: first.id }, 'changed', 2001).ok).toBe(false);
    const asset = value(saveItemAsset(state, id, { expectedVersion: 4, evaluationId: first.id }, 'digest', 2001));
    expect(asset).toMatchObject({ source: 'generated', originItemId: id, reviewId: first.id, reviewValidity: 'valid' }); expect(current(state, id).version).toBe(5);
    expect(saveItemReview(structuredClone(state), id, { expectedVersion: 5, form: basicForm, reason: ' ' }, 'digest', 2002).ok).toBe(false);
    const second = value(saveItemReview(state, id, { expectedVersion: 5, form: basicForm, reason: '重新检查' }, 'digest', 2002));
    expect(second.revision).toBe(2); expect(state.assets[0]?.reviewValidity).toBe('review_invalidated'); expect(current(state, id)).toMatchObject({ libraryState: 'not_saved', version: 6 });
    expect(saveItemAsset(structuredClone(state), id, { expectedVersion: 6, evaluationId: first.id }, 'digest', 2003).ok).toBe(false);
    value(saveItemAsset(state, id, { expectedVersion: 6, evaluationId: second.id }, 'digest', 2003));
    expect(state.assets).toHaveLength(1); expect(state.assets[0]).toMatchObject({ id: asset.id, reviewId: second.id, reviewValidity: 'valid' });
    expect(state.evaluations).toHaveLength(2); expect(state.reviewForms[first.id]?.reason).toBe('');
  });
  it('binds video review to actual digest and prevents hard-failure save', () => {
    const { state, id } = success(videoRequest); const digest = state.mediaMetadata[0]!.sha256;
    expect(saveItemReview(structuredClone(state), id, { expectedVersion: 3, form: videoForm, reason: '' }, 'wrong', 2000).ok).toBe(false);
    const review = value(saveItemReview(state, id, { expectedVersion: 3, form: { ...videoForm, hardFailures: ['H01'] }, reason: '' }, digest, 2000));
    expect(review.decision).toBe('rejected');
    expect(saveItemAsset(state, id, { expectedVersion: 4, evaluationId: review.id }, digest, 2001)).toMatchObject({ ok: false, error: { code: 'REVIEW_REJECTED' } });
  });
});
