import { selectAuthorizedAgnesBinding } from './authorized-agnes.js';
import type { GenerationState, GenerationItem, GenerationContext, ProviderAttempt, MediaFile, Result, ItemVersionInput, ItemReconcileInput } from '../../contracts/src/index.js';
import type { RawProviderMedia, ProviderDerivativeEvidence, ProviderReportedFacts } from '../../contracts/src/provider-media.js';
import { cancelItem, reconcileItem, retryItemDownload, validateOutput } from './generation-commands.js';
import { checkedItem, failure, iso, publishItem, settleCredits } from './generation-state.js';
import { normalizeProviderAttempt, transitionAttempt, mergeProviderReportedFacts } from './provider-attempt.js';
export const PROVIDER_PAUSED = Number.MAX_SAFE_INTEGER;
type Category = NonNullable<ProviderAttempt['errorCategory']>;
export type ProviderEvent = ({
    kind: 'claim';
    bindingId: string;
} | {
    kind: 'accepted';
    externalJobId: string;
    status: NonNullable<ProviderAttempt['providerStatus']>;
} | {
    kind: 'unknown';
    category?: Category;
} | {
    kind: 'failed';
    cancelled?: boolean;
    category?: Category;
} | {
    kind: 'poll';
    status: 'queued' | 'running';
    category?: Category;
} | {
    kind: 'downloading';
} | {
    kind: 'raw';
    raw: RawProviderMedia;
} | {
    kind: 'download_failed';
    storage?: boolean;
} | {
    kind: 'success';
    media?: MediaFile;
    text?: string;
    derivative?: ProviderDerivativeEvidence;
}) & { reported?: ProviderReportedFacts };
/** Pure transaction orchestration: persisted identities, terminal quota, and private lifecycle. */
export function applyProviderEvent(state: GenerationState, id: string, event: ProviderEvent, context: GenerationContext, identity?: string, expectedVersion?: number): Result<GenerationItem> {
    const item = state.items.find(i => i.id === id);
    const pending = state.pending.find(p => p.itemId === id);
    let attempt = state.attempts.find(a => a.itemId === id);
    if (!item || !pending || !attempt || ['succeeded', 'failed', 'cancelled'].includes(item.status))
        return failure('ITEM_NOT_READY', '子项当前不可执行');
    if (expectedVersion !== undefined && item.version !== expectedVersion)
        return failure('VERSION_CONFLICT', '子项版本已变化');
    if (identity && attempt.attemptId !== identity)
        return failure('ITEM_NOT_READY', '执行记录已变化');
    const now = context.now;
    const previous = item.version;
    const saveAttempt = (a: ProviderAttempt) => { attempt = a; state.attempts[state.attempts.findIndex(r => r.itemId === id)] = a; };
    if (event.kind === 'claim') {
        if (attempt.submissionState !== 'not_submitted' || pending.dueAt > now)
            return failure('ITEM_NOT_READY', '任务已开始提交');
        if (event.bindingId === 'agnes-authorized-real') {
            const routing = selectAuthorizedAgnesBinding(state.batches.find(b => b.id === item.batchId)!.requestSnapshot);
            if (!routing.ok) return routing;
            item.routingSnapshot = routing.value;
        }
        saveAttempt(normalizeProviderAttempt(attempt, event.bindingId));
        state.schemaVersion = 2;
        saveAttempt(transitionAttempt(attempt, 'submitting', now, { submittedAt: iso(now) }));
        item.status = 'running';
        pending.phase = 'accept';
        pending.dueAt = now;
    }
    else {
        if (attempt.lifecycleVersion !== 1)
            return failure('ITEM_NOT_READY', '缺少执行生命周期');
        if (event.reported !== undefined) saveAttempt({ ...attempt, reported: mergeProviderReportedFacts(attempt.reported, event.reported) });
        if (event.kind === 'accepted') {
            saveAttempt(transitionAttempt(attempt, 'submitted', now, { externalJobId: event.externalJobId, submittedAt: attempt.submittedAt ?? iso(now), providerStatus: event.status, nextPollAt: iso(now + 100) }));
            pending.phase = 'complete';
            pending.dueAt = now + 100;
            // Acceptance, observed terminal status and settlement share one durable transaction.
            if (event.status === 'failed' || event.status === 'cancelled') {
                saveAttempt(transitionAttempt(attempt, 'failed', now));
                item.status = event.status;
                item.errorCode = event.status === 'cancelled' ? 'CANCELLED' : 'NETWORK_ERROR';
                const settled = settleCredits(state, item, 'RELEASE', now);
                if (!settled.ok)
                    return settled;
                state.pending = state.pending.filter(p => p.itemId !== id);
            }
            else if (event.status === 'unknown') {
                saveAttempt(transitionAttempt(attempt, 'needs_reconciliation', now, { errorCategory: 'unknown' }));
                item.status = 'needs_reconciliation';
                item.errorCode = 'PROVIDER_OUTCOME_UNKNOWN';
                pending.dueAt = PROVIDER_PAUSED;
            }
        }
        else if (event.kind === 'unknown') {
            saveAttempt(transitionAttempt(attempt, 'needs_reconciliation', now, { providerStatus: 'unknown', errorCategory: event.category ?? 'unknown' }));
            item.status = 'needs_reconciliation';
            item.errorCode = 'PROVIDER_OUTCOME_UNKNOWN';
            pending.phase = 'complete';
            pending.dueAt = PROVIDER_PAUSED;
        }
        else if (event.kind === 'failed') {
            saveAttempt(transitionAttempt(attempt, 'failed', now, { providerStatus: event.cancelled ? 'cancelled' : 'failed', ...(event.category ? { errorCategory: event.category } : {}) }));
            item.status = event.cancelled ? 'cancelled' : 'failed';
            item.errorCode = event.cancelled ? 'CANCELLED' : 'NETWORK_ERROR';
            const settle = settleCredits(state, item, 'RELEASE', now);
            if (!settle.ok)
                return settle;
            state.pending = state.pending.filter(p => p.itemId !== id);
        }
        else if (event.kind === 'poll') {
            saveAttempt(transitionAttempt(attempt, 'polling', now, { providerStatus: event.status, lastPolledAt: iso(now), nextPollAt: iso(now + 100), ...(event.category ? { errorCategory: event.category } : {}) }));
            pending.phase = 'complete';
            pending.dueAt = now + 100;
        }
        else {
            if (attempt.submissionState === 'submitted' || attempt.submissionState === 'needs_reconciliation')
                saveAttempt(transitionAttempt(attempt, 'polling', now));
            if (attempt.submissionState === 'polling')
                saveAttempt(transitionAttempt(attempt, 'result_ready', now, { providerStatus: 'result_ready', lastPolledAt: iso(now), nextPollAt: iso(now) }));
            if (attempt.submissionState === 'result_ready')
                saveAttempt(transitionAttempt(attempt, 'downloading', now));
            if (attempt.submissionState !== 'downloading')
                return failure('ITEM_NOT_READY', '子项尚未就绪');
            item.status = 'finalizing';
            pending.phase = 'download';
            pending.dueAt = now;
            if (event.kind === 'raw')
                saveAttempt(transitionAttempt(attempt, 'downloading', now, { rawMedia: event.raw }));
            if (event.kind === 'download_failed') {
                item.errorCode = event.storage ? 'STORAGE_UNAVAILABLE' : 'MEDIA_UNAVAILABLE';
                pending.dueAt = PROVIDER_PAUSED;
            }
            if (event.kind === 'success') {
                if (item.mode === 'copy') {
                    const request = state.batches.find(b => b.id === item.batchId)!.requestSnapshot;
                    if (request.mode !== 'copy' || typeof event.text !== 'string' || !event.text.trim() || event.text.length > request.copy.maxCharacters)
                        return failure('MEDIA_UNAVAILABLE', '文案结果无效');
                    item.text = event.text;
                }
                else {
                    if (!event.media || event.media.mediaType !== item.mode)
                        return failure('MEDIA_UNAVAILABLE', '媒体结果无效');
                    if (event.derivative) {
                        if (event.derivative.media.id !== event.media.id || event.derivative.sourceSha256 !== attempt.rawMedia?.rawSha256)
                            return failure('MEDIA_UNAVAILABLE', '衍生结果缺少源证据');
                    }
                    else {
                        const verified = validateOutput(state, item, event.media, context);
                        if (!verified.ok)
                            return verified;
                    }
                    if (!state.mediaMetadata.some(m => m.id === event.media!.id))
                        state.mediaMetadata.push(structuredClone(event.media));
                    item.resultMediaId = event.media.id;
                }
                saveAttempt(transitionAttempt(attempt, 'settled', now, event.derivative ? { derivativeEvidence: event.derivative } : {}));
                item.status = 'succeeded';
                item.resultAvailable = true;
                delete item.errorCode;
                const settle = settleCredits(state, item, 'COMMIT', now);
                if (!settle.ok)
                    return settle;
                state.pending = state.pending.filter(p => p.itemId !== id);
            }
        }
    }
    return publishItem(state, item, previous, now);
}
export function adoptProviderAttempt(state: GenerationState, id: string, bindingId: string, now: number): Result<GenerationItem> {
    const item = state.items.find(i => i.id === id)!;
    const at = state.attempts.findIndex(a => a.itemId === id);
    const old = state.attempts[at]!;
    if (old.lifecycleVersion === 1)
        return { ok: true, value: item };
    const attempt = normalizeProviderAttempt(old, bindingId);
    state.attempts[at] = attempt;
    state.schemaVersion = 2;
    const p = state.pending.find(p => p.itemId === id);
    if (attempt.submissionState === 'needs_reconciliation' && p) {
        item.status = 'needs_reconciliation';
        item.errorCode = 'PROVIDER_OUTCOME_UNKNOWN';
        p.phase = 'complete';
        p.dueAt = PROVIDER_PAUSED;
    }
    // Legacy download work is already accepted and may safely re-query the original ID.
    if (item.status === 'finalizing' && attempt.submissionState === 'submitted')
        state.attempts[at] = transitionAttempt(transitionAttempt(transitionAttempt(attempt, 'polling', now), 'result_ready', now), 'downloading', now);
    return publishItem(state, item, item.version, now);
}
export function cancelProviderItem(state: GenerationState, id: string, input: ItemVersionInput, now: number): Result<GenerationItem> { return cancelItem(state, id, input, now); }
export function reconcileProviderItem(state: GenerationState, id: string, input: ItemReconcileInput, now: number): Result<GenerationItem> {
    const attempt = state.attempts.find(a => a.itemId === id);
    if (attempt?.lifecycleVersion !== 1)
        return reconcileItem(state, id, input, now);
    const checked = checkedItem(state, id, input);
    if (!checked.ok)
        return checked;
    const item = checked.value;
    if (item.status !== 'needs_reconciliation')
        return failure('ITEM_NOT_READY', '子项当前不需要对账');
    if (!attempt.externalJobId)
        return failure('PROVIDER_OUTCOME_UNKNOWN', '提交结果未知，需人工调查');
    const pending = state.pending.find(p => p.itemId === id)!;
    if (attempt.providerBindingId === 'fake-local' && input.outcome !== 'success') {
        const next = transitionAttempt(attempt, 'failed', now, { providerStatus: input.outcome === 'failure' ? 'failed' : 'cancelled' });
        Object.assign(attempt, next);
        item.status = input.outcome === 'failure' ? 'failed' : 'cancelled';
        item.errorCode = input.outcome === 'failure' ? 'NETWORK_ERROR' : 'CANCELLED';
        const settled = settleCredits(state, item, 'RELEASE', now);
        if (!settled.ok)
            return settled;
        state.pending = state.pending.filter(p => p.itemId !== id);
    }
    else {
        Object.assign(attempt, transitionAttempt(attempt, 'polling', now, { nextPollAt: iso(now) }));
        item.status = 'running';
        pending.phase = 'complete';
        pending.dueAt = now;
        pending.downloadRetry = true;
        delete item.errorCode;
        if (attempt.providerBindingId === 'fake-local') {
            Object.assign(attempt, transitionAttempt(transitionAttempt(attempt, 'result_ready', now), 'downloading', now));
            item.status = 'finalizing';
            pending.phase = 'download';
        }
    }
    if (attempt.providerBindingId === 'fake-local')
        state.reconciliations.push({ itemId: id, outcome: input.outcome, evidence: '操作员明确确认的模拟对账证据', createdAt: iso(now) });
    return publishItem(state, item, input.expectedVersion, now);
}
export function retryProviderDownload(state: GenerationState, id: string, input: ItemVersionInput, now: number): Result<GenerationItem> {
    const result = retryItemDownload(state, id, input, now);
    if (!result.ok)
        return result;
    const attempt = state.attempts.find(a => a.itemId === id)!;
    if (attempt.lifecycleVersion === 1) {
        attempt.nextPollAt = iso(now);
        attempt.updatedAt = iso(now);
    }
    return result;
}
