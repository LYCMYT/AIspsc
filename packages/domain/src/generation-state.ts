import type { CreateGenerationRequest, DemoSnapshot, DomainErrorCode, GenerationBatchSnapshot, GenerationContext, GenerationItem, GenerationState, ItemVersionInput, Result } from '../../contracts/src/index.js';
import { canonicalJson } from '../../contracts/src/index.js';
import { applyCreditAction, createQuotaState, reserveCredits } from './quota.js';
import { classifyTask, DEMO_MODEL_REGISTRY, selectBinding } from './routing.js';
import { deriveBatchStatus } from './state.js';
import { validateGenerationRequest } from './validation.js';

export type { GenerationState, GenerationContext } from '../../contracts/src/index.js';
export function failure(code: DomainErrorCode, message: string): Result<never> { return { ok: false, error: { code, message } }; }
export function nextId(state: GenerationState, kind: string): string { state.sequence += 1; return `${state.epoch}-${kind}-${state.sequence}`; }
export function iso(now: number): string { return new Date(now).toISOString(); }
export function checkedItem(state: GenerationState, id: string, input: ItemVersionInput): Result<GenerationItem> {
  const item = state.items.find(row => row.id === id);
  if (!item) return failure('TASK_NOT_READY', '找不到生成子项');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) return failure('INVALID_PARAMETERS', '子项版本必须是非负安全整数');
  if (item.version !== input.expectedVersion) return failure('VERSION_CONFLICT', '子项版本已变化，请刷新后重试');
  return { ok: true, value: item };
}
export function syncBatch(state: GenerationState, item: GenerationItem): void {
  const batch = state.batches.find(row => row.id === item.batchId)!;
  batch.items = state.items.filter(row => row.batchId === batch.id).map(row => structuredClone(row));
  batch.status = deriveBatchStatus(batch.items);
}
export function publishItem(state: GenerationState, item: GenerationItem, previousVersion: number, now: number): Result<GenerationItem> {
  item.version = previousVersion + 1;
  item.updatedAt = iso(now);
  state.items[state.items.findIndex(row => row.id === item.id)] = item;
  syncBatch(state, item);
  return { ok: true, value: structuredClone(item) };
}
export function settleCredits(state: GenerationState, item: GenerationItem, action: 'COMMIT' | 'RELEASE', now: number): Result<void> {
  const applied = applyCreditAction({ snapshot: state.credits, ledger: state.ledger }, { action, referenceId: item.id, units: item.pricingSnapshot.unitCost, createdAt: iso(now) });
  if (!applied.ok) return applied;
  state.credits = applied.value.snapshot; state.ledger = applied.value.ledger;
  return { ok: true, value: undefined };
}
export function outputFixtureKey(request: CreateGenerationRequest): string | undefined {
  if (request.mode === 'copy') return undefined;
  if (request.mode === 'image') return `image-${request.image.ratio.replace(':', 'x')}-${request.image.resolution}`;
  const video = request.video;
  return `video-${video.durationSeconds}-${video.ratio.replace(':', 'x')}-${video.resolution}-${video.audio ? 'audio' : 'silent'}`;
}

export function createGenerationState(epoch: string, now: number): GenerationState {
  const granted = applyCreditAction(createQuotaState(), { action: 'GRANT', referenceId: `${epoch}-grant`, units: 1286, createdAt: iso(now), reason: '本地演示额度' });
  if (!granted.ok) throw new Error('Invalid initial quota');
  return { version: 1, epoch, scenario: 'seed', sequence: 0, batches: [], items: [], evaluations: [], assets: [], mediaMetadata: [], credits: granted.value.snapshot, ledger: granted.value.ledger, attempts: [], reconciliations: [], splits: [], pending: [], memo: {}, reviewForms: {} };
}

export function projectGenerationSnapshot(state: GenerationState): DemoSnapshot {
  return structuredClone({ version: state.version, epoch: state.epoch, scenario: state.scenario,
    batches: state.batches.map(batch => { const items = state.items.filter(item => item.batchId === batch.id); return { ...batch, items, status: deriveBatchStatus(items) }; }),
    items: state.items, evaluations: state.evaluations, assets: state.assets, mediaMetadata: state.mediaMetadata, credits: state.credits, ledger: state.ledger, attempts: state.attempts, reconciliations: state.reconciliations, splits: state.splits,
  });
}

/** Mutates only the transaction-owned clone; the store owns idempotent response memoization. */
export function createBatch(state: GenerationState, input: unknown, key: string, requestHash: string, context: GenerationContext, retryOfItemId?: string): Result<GenerationBatchSnapshot> {
  try { canonicalJson(input); } catch { return failure('INVALID_PARAMETERS', '生成参数必须是 JSON 数据'); }
  const assets = state.assets.map(asset => ({ ...asset, availability: asset.archivedAt || asset.reviewValidity === 'review_invalidated' ? 'unavailable' as const : asset.availability }));
  const validated = validateGenerationRequest(input, assets, 'demo');
  if (!validated.ok) return validated;
  const request = validated.value;
  const routing = selectBinding(request, classifyTask(request), DEMO_MODEL_REGISTRY, 'mock');
  if (!routing.ok) return routing;
  const fixtureKey = outputFixtureKey(request);
  if (fixtureKey && !context.manifest.files.some(file => file.key === fixtureKey)) return failure('NO_COMPATIBLE_MODEL', '没有支持当前参数组合的演示文件');
  if (state.scenario === 'request_failure') return failure('NETWORK_ERROR', '模拟请求失败');
  if (state.scenario === 'quota_insufficient' || state.credits.available < request.count) return failure('QUOTA_INSUFFICIENT', '整批可用演示额度不足');
  const createdAt = iso(context.now);
  const id = nextId(state, 'batch');
  const items: GenerationItem[] = Array.from({ length: request.count }, (_, index) => ({
    id: nextId(state, 'item'), batchId: id, index, version: 0, status: 'queued', mode: request.mode, resultAvailable: false,
    ...(retryOfItemId ? { retryOfItemId } : {}), routingSnapshot: structuredClone(routing.value), pricingSnapshot: { version: 'demo-pricing-v1', unitCost: 1, unitName: 'demo-credit' }, reviewState: 'pending', libraryState: 'not_saved', updatedAt: createdAt,
  }));
  const reserved = reserveCredits({ snapshot: state.credits, ledger: state.ledger }, items.map(item => item.id));
  if (!reserved.ok) return reserved;
  // reserveCredits uses an explicit epoch default; supply this transaction's injected time.
  state.ledger = reserved.value.ledger.map((entry, index) => index < state.ledger.length ? entry : { ...entry, createdAt });
  state.credits = reserved.value.snapshot;
  const batch: GenerationBatchSnapshot = { id, workspaceId: 'demo', requestSnapshot: request, requestedCount: request.count, idempotencyKey: key, requestHash, createdAt, status: 'queued', items: structuredClone(items) };
  state.batches.push(batch); state.items.push(...items);
  for (const item of items) {
    state.attempts.push({ itemId: item.id, attemptNo: 1, providerBindingId: item.routingSnapshot.bindingId, externalIdempotencyKey: `fake-${item.id}`, submissionState: 'not_submitted', createdAt, updatedAt: createdAt });
    state.pending.push({ itemId: item.id, dueAt: context.now + (state.scenario === 'processing' ? 5000 : 100), scenario: state.scenario, phase: 'submit', downloadRetry: false });
  }
  return { ok: true, value: structuredClone(batch) };
}
