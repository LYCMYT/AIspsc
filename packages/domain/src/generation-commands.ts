import type { GenerationBatchSnapshot, GenerationContext, GenerationItem, GenerationItemStatus, GenerationState, ItemReconcileInput, ItemVersionInput, MediaFile, Result, WorkerEvent } from '../../contracts/src/index.js';
import { checkedItem, createBatch, failure, iso, outputFixtureKey, publishItem, settleCredits } from './generation-state.js';
import { transitionItemStatus } from './state.js';

export type { ItemVersionInput, ItemReconcileInput, WorkerEvent } from '../../contracts/src/index.js';
const terminal = new Set<GenerationItemStatus>(['succeeded', 'failed', 'cancelled']);
const paused = Number.MAX_SAFE_INTEGER;
function move(item: GenerationItem, status: GenerationItemStatus): Result<GenerationItem> { return transitionItemStatus(item, status, item.version); }
function clearPending(state: GenerationState, id: string): void { state.pending = state.pending.filter(job => job.itemId !== id); }
function finish(state: GenerationState, item: GenerationItem, status: 'failed' | 'cancelled', now: number): Result<GenerationItem> {
  const transitioned = move(item, status); if (!transitioned.ok) return transitioned;
  const settled = settleCredits(state, item, 'RELEASE', now); if (!settled.ok) return settled;
  clearPending(state, item.id);
  const attempt = state.attempts.find(row => row.itemId === item.id)!; attempt.submissionState = 'settled'; attempt.updatedAt = iso(now);
  return { ok: true, value: { ...transitioned.value, errorCode: status === 'cancelled' ? 'CANCELLED' : 'NETWORK_ERROR' } };
}

export function cancelItem(state: GenerationState, id: string, input: ItemVersionInput, now: number): Result<GenerationItem> {
  const checked = checkedItem(state, id, input); if (!checked.ok) return checked;
  const item = checked.value;
  if (item.status === 'needs_reconciliation') return failure('PROVIDER_OUTCOME_UNKNOWN', '结果未知，必须先进行模拟对账');
  const changed = item.status === 'queued' ? finish(state, item, 'cancelled', now) : move(item, 'cancel_requested');
  if (!changed.ok) return changed;
  return publishItem(state, changed.value, input.expectedVersion, now);
}

export function retryItem(state: GenerationState, id: string, input: ItemVersionInput, key: string, requestHash: string, context: GenerationContext): Result<GenerationBatchSnapshot> {
  const checked = checkedItem(state, id, input); if (!checked.ok) return checked;
  const item = checked.value;
  if (item.status === 'needs_reconciliation') return failure('PROVIDER_OUTCOME_UNKNOWN', '结果未知，不能重复提交生成');
  if (item.status !== 'failed' && item.status !== 'cancelled') return failure('ITEM_NOT_READY', '只有失败或已取消的子项可以重试');
  const original = state.batches.find(batch => batch.id === item.batchId)!;
  const result = createBatch(state, { ...original.requestSnapshot, count: 1 }, key, requestHash, context, id);
  if (!result.ok) return result;
  publishItem(state, item, input.expectedVersion, context.now);
  return result;
}

export function reconcileItem(state: GenerationState, id: string, input: ItemReconcileInput, now: number): Result<GenerationItem> {
  const checked = checkedItem(state, id, input); if (!checked.ok) return checked;
  const item = checked.value;
  if (item.status !== 'needs_reconciliation') return failure('ITEM_NOT_READY', '只有结果未知的子项可以模拟对账');
  let changed: Result<GenerationItem>;
  if (input.outcome === 'success') {
    changed = move(item, 'finalizing');
    const pending = state.pending.find(job => job.itemId === id);
    if (!pending) return failure('TASK_NOT_READY', '缺少待恢复的生成任务');
    pending.phase = 'download'; pending.downloadRetry = true; pending.dueAt = now;
    const attempt = state.attempts.find(row => row.itemId === id)!; attempt.submissionState = 'submitted'; attempt.updatedAt = iso(now);
  } else changed = finish(state, item, input.outcome === 'failure' ? 'failed' : 'cancelled', now);
  if (!changed.ok) return changed;
  delete changed.value.errorCode;
  if (input.outcome !== 'success') changed.value.errorCode = input.outcome === 'failure' ? 'NETWORK_ERROR' : 'CANCELLED';
  state.reconciliations.push({ itemId: id, outcome: input.outcome, evidence: '操作员明确确认的模拟对账证据', createdAt: iso(now) });
  return publishItem(state, changed.value, input.expectedVersion, now);
}

export function retryItemDownload(state: GenerationState, id: string, input: ItemVersionInput, now: number): Result<GenerationItem> {
  const checked = checkedItem(state, id, input); if (!checked.ok) return checked;
  const item = checked.value;
  const pending = state.pending.find(job => job.itemId === id);
  if (item.status !== 'finalizing' || !item.errorCode || !pending || pending.dueAt !== paused) return failure('ITEM_NOT_READY', '子项当前不需要下载恢复');
  pending.phase = 'download'; pending.downloadRetry = true; pending.dueAt = now;
  delete item.errorCode;
  return publishItem(state, item, input.expectedVersion, now);
}

function validateOutput(state: GenerationState, item: GenerationItem, media: MediaFile | undefined, context: GenerationContext): Result<MediaFile> {
  const request = state.batches.find(batch => batch.id === item.batchId)!.requestSnapshot;
  const fixture = context.manifest.files.find(file => file.key === outputFixtureKey(request));
  if (!media || !fixture || media.workspaceId !== 'demo' || media.mediaType !== item.mode || media.availability !== 'available' || media.isDemo !== true ||
    media.fixtureKey !== fixture.fixtureKey || media.sha256 !== fixture.sha256 || media.objectKey !== fixture.path || media.mime !== fixture.mime || media.width !== fixture.width || media.height !== fixture.height || media.hasAudio !== fixture.hasAudio || media.durationMs !== fixture.durationMs || !Number.isSafeInteger(media.byteSize) || media.byteSize <= 0) {
    return failure('MEDIA_UNAVAILABLE', '演示结果元数据与已核验样例不一致');
  }
  const existing = state.mediaMetadata.find(row => row.id === media.id);
  if (existing && existing.sha256 !== media.sha256) return failure('MEDIA_UNAVAILABLE', '媒体标识对应的文件已变化');
  return { ok: true, value: structuredClone(media) };
}

export function applyWorkerEvent(state: GenerationState, event: WorkerEvent, context: GenerationContext): Result<GenerationItem> {
  const checked = checkedItem(state, event.itemId, event); if (!checked.ok) return checked;
  let item = checked.value;
  if (terminal.has(item.status)) return failure('ITEM_NOT_READY', '终态子项不能再次执行');
  const pending = state.pending.find(job => job.itemId === item.id);
  const attempt = state.attempts.find(row => row.itemId === item.id);
  if (!pending || !attempt) return failure('TASK_NOT_READY', '缺少待执行任务或执行记录');
  if (pending.dueAt === paused) return failure('ITEM_NOT_READY', '任务正在等待显式人工恢复');
  const now = context.now;
  if (event.kind === 'submitting') {
    if (pending.phase !== 'submit' || attempt.submissionState !== 'not_submitted') return failure('ITEM_NOT_READY', '任务已开始提交');
    const changed = move(item, 'running'); if (!changed.ok) return changed; item = changed.value;
    attempt.submissionState = 'submitting'; pending.phase = 'accept'; pending.dueAt = now + 100;
  } else if (event.kind === 'submitted') {
    if (pending.phase !== 'accept' || attempt.submissionState !== 'submitting') return failure('ITEM_NOT_READY', '任务不处于提交中');
    attempt.submissionState = 'submitted'; attempt.externalJobId = `fake-job-${item.id}`; pending.phase = 'complete'; pending.dueAt = now + 100;
  } else {
    if (!['complete', 'download'].includes(pending.phase) || attempt.submissionState !== 'submitted' || !['running', 'cancel_requested', 'finalizing'].includes(item.status)) return failure('ITEM_NOT_READY', '任务尚未受理或正在等待人工处理');
    if (item.status === 'cancel_requested' && pending.scenario !== 'cancel_race') {
      const changed = finish(state, item, 'cancelled', now); if (!changed.ok) return changed; item = changed.value;
    } else if (!pending.downloadRetry && (pending.scenario === 'failure' || (pending.scenario === 'partial_success' && item.index % 3 === 1))) {
      const changed = finish(state, item, 'failed', now); if (!changed.ok) return changed; item = changed.value;
    } else if (!pending.downloadRetry && pending.scenario === 'unknown') {
      const changed = move(item, 'needs_reconciliation'); if (!changed.ok) return changed; item = changed.value;
      item.errorCode = 'PROVIDER_OUTCOME_UNKNOWN'; attempt.submissionState = 'outcome_unknown'; pending.dueAt = paused;
    } else {
      if (item.status !== 'finalizing') { const changed = move(item, 'finalizing'); if (!changed.ok) return changed; item = changed.value; }
      const unavailable = event.kind === 'download_failed' || (!pending.downloadRetry && ['download_failure', 'storage_failure'].includes(pending.scenario));
      if (unavailable) {
        item.errorCode = pending.scenario === 'storage_failure' ? 'STORAGE_UNAVAILABLE' : 'MEDIA_UNAVAILABLE'; pending.phase = 'download'; pending.dueAt = paused;
      } else {
        if (item.mode === 'copy') {
          const request = state.batches.find(batch => batch.id === item.batchId)!.requestSnapshot;
          if (request.mode !== 'copy') return failure('INVALID_PARAMETERS', '子项类型与请求不一致');
          item.text = `演示文案：${request.prompt}`.slice(0, request.copy.maxCharacters);
        } else {
          const media = validateOutput(state, item, event.kind === 'complete' ? event.media : undefined, context); if (!media.ok) return media;
          if (!state.mediaMetadata.some(row => row.id === media.value.id)) state.mediaMetadata.push(media.value);
          item.resultMediaId = media.value.id;
        }
        const changed = move(item, 'succeeded'); if (!changed.ok) return changed; item = changed.value; item.resultAvailable = true; delete item.errorCode;
        const settled = settleCredits(state, item, 'COMMIT', now); if (!settled.ok) return settled;
        attempt.submissionState = 'settled'; clearPending(state, item.id);
      }
    }
  }
  attempt.updatedAt = iso(now);
  return publishItem(state, item, event.expectedVersion, now);
}
