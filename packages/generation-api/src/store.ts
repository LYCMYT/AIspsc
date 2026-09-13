import { selectAuthorizedAgnesBinding } from '../../domain/src/authorized-agnes.js';
import { validateProviderAttempt } from '../../domain/src/provider-attempt.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { GenerationState, Result } from '../../contracts/src/index.js';
import { canonicalJson, validateHttpBody } from '../../contracts/src/index.js';
import { createGenerationState } from '../../domain/src/generation-state.js';
import { applyCreditAction, createQuotaState } from '../../domain/src/quota.js';
import { deriveBatchStatus } from '../../domain/src/state.js';
import { decideReview } from '../../domain/src/review.js';
import { classifyTask, DEMO_MODEL_REGISTRY, selectBinding } from '../../domain/src/routing.js';
import { validateGenerationRequest } from '../../domain/src/validation.js';
function invalid(): never {
    throw new Error('INVALID_STORE');
}
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function fields(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => ![...required, ...optional].includes(k)))
        invalid();
}
function unique<T>(rows: T[], key: (row: T) => string) {
    if (new Set(rows.map(key)).size !== rows.length)
        invalid();
}
function date(value: unknown) {
    if (!text(value) || !Number.isFinite(Date.parse(value)))
        invalid();
}
const statuses = ['queued', 'running', 'finalizing', 'cancel_requested', 'needs_reconciliation', 'succeeded', 'failed', 'cancelled'];
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
/** Fail closed on structural corruption and cross-aggregate/ledger inconsistencies. */
function validateState(value: unknown): asserts value is GenerationState {
    fields(value, ['version', 'epoch', 'scenario', 'sequence', 'batches', 'items', 'evaluations', 'assets', 'mediaMetadata', 'credits', 'ledger', 'attempts', 'reconciliations', 'splits', 'pending', 'memo', 'reviewForms'], ['schemaVersion']);
    if (value.schemaVersion !== undefined && value.schemaVersion !== 2) throw Error('UNSUPPORTED_STORE_SCHEMA');
    if (value.version !== 1 || !text(value.epoch) || !integer(value.sequence) || !validateHttpBody('scenario', {
        name: value.scenario
    }).ok)
        invalid();
    for (const key of ['batches', 'items', 'evaluations', 'assets', 'mediaMetadata', 'ledger', 'attempts', 'reconciliations', 'splits', 'pending'])
        if (!Array.isArray(value[key]))
            invalid();
    const s = value as unknown as GenerationState;
    fields(s.memo, [], Object.keys(s.memo));
    fields(s.reviewForms, [], Object.keys(s.reviewForms));
    if (s.splits.length)
        invalid(); // No HTTP split writer exists in this slice.
    for (const rows of [s.batches, s.items, s.evaluations, s.assets, s.mediaMetadata]) {
        for (const row of rows)
            if (!text(row?.id))
                invalid();
        unique<{
            id: string;
        }>(rows, row => row.id);
    }
    const ids = [...s.batches, ...s.items, ...s.evaluations, ...s.assets].map(row => row.id);
    if (new Set(ids).size !== ids.length)
        invalid();
    for (const id of ids) {
        const suffix = id.slice(s.epoch.length + 1);
        if (!id.startsWith(s.epoch + '-') || !/^(batch|item|evaluation|asset)-[1-9][0-9]*$/.test(suffix) || Number(suffix.split('-').at(-1)) > s.sequence)
            invalid();
    }
    unique(s.pending, p => p.itemId);
    unique(s.attempts, a => a.itemId);
    let quota = createQuotaState();
    const actions = new Set<string>();
    for (const entry of s.ledger) {
        fields(entry, ['referenceId', 'action', 'units', 'createdAt'], ['reason']);
        if (!['GRANT', 'RESERVE', 'COMMIT', 'RELEASE'].includes(entry.action) || !text(entry.referenceId) || !integer(entry.units) || entry.units === 0 || (entry.reason !== undefined && typeof entry.reason !== 'string'))
            invalid();
        date(entry.createdAt);
        const k = entry.referenceId + ':' + entry.action;
        if (actions.has(k))
            invalid();
        actions.add(k);
        if (entry.action !== 'GRANT' && !s.items.some(i => i.id === entry.referenceId))
            invalid();
        const next = applyCreditAction(quota, entry);
        if (!next.ok)
            invalid();
        else
            quota = next.value;
    }
    if (canonicalJson(quota.snapshot) !== canonicalJson(s.credits))
        invalid();
    for (const b of s.batches) {
        fields(b, ['id', 'workspaceId', 'requestSnapshot', 'requestedCount', 'idempotencyKey', 'requestHash', 'createdAt', 'status', 'items']);
        date(b.createdAt);
        if (b.workspaceId !== 'demo' || !hash(b.requestHash) || !text(b.idempotencyKey) || !Array.isArray(b.items))
            invalid();
        // Archived or invalidated references remain valid historical input snapshots.
        const input = validateGenerationRequest(b.requestSnapshot, s.assets.map(a => ({
            ...a, availability: 'available' as const
        })), 'demo');
        if (!input.ok || canonicalJson(input.value) !== canonicalJson(b.requestSnapshot))
            invalid();
        const children = s.items.filter(i => i.batchId === b.id);
        if (children.length !== b.requestedCount || b.requestedCount !== b.requestSnapshot.count || canonicalJson(children) !== canonicalJson(b.items) || b.status !== deriveBatchStatus(children))
            invalid();
        unique(children, i => String(i.index));
        if (children.some(i => i.index < 0 || i.index >= children.length || i.mode !== b.requestSnapshot.mode))
            invalid();
    }
    for (const i of s.items) {
        fields(i, ['id', 'batchId', 'index', 'version', 'status', 'mode', 'resultAvailable', 'routingSnapshot', 'pricingSnapshot', 'reviewState', 'libraryState', 'updatedAt'], ['resultMediaId', 'text', 'errorCode', 'retryOfItemId']);
        if (!integer(i.index) || !integer(i.version) || !statuses.includes(i.status) || !['copy', 'video', 'image'].includes(i.mode) || typeof i.resultAvailable !== 'boolean' || !['pending', 'approved', 'rejected'].includes(i.reviewState) || !['not_saved', 'saved'].includes(i.libraryState) || !s.batches.some(b => b.id === i.batchId))
            invalid();
        date(i.updatedAt);
        fields(i.pricingSnapshot, ['version', 'unitCost', 'unitName']);
        if (i.pricingSnapshot.unitCost !== 1 || i.pricingSnapshot.unitName !== 'demo-credit' || i.pricingSnapshot.version !== 'demo-pricing-v1')
            invalid();
        fields(i.routingSnapshot, ['modelKey', 'bindingId', 'ruleVersion', 'reason', 'capabilitySnapshot']);
        if (![i.routingSnapshot.modelKey, i.routingSnapshot.bindingId, i.routingSnapshot.ruleVersion, i.routingSnapshot.reason].every(text) || !i.routingSnapshot.capabilitySnapshot || typeof i.routingSnapshot.capabilitySnapshot !== 'object')
            invalid();
        const request = s.batches.find(b => b.id === i.batchId)!.requestSnapshot;
        const realAttempt = s.attempts.find(a => a.itemId === i.id && a.providerBindingId === 'agnes-authorized-real');
        const routing = realAttempt ? selectAuthorizedAgnesBinding(request) : selectBinding(request, classifyTask(request), DEMO_MODEL_REGISTRY, 'mock');
        if (!routing.ok || canonicalJson(routing.value) !== canonicalJson(i.routingSnapshot))
            invalid();
        if (i.retryOfItemId && (!s.items.some(item => item.id === i.retryOfItemId) || i.retryOfItemId === i.id))
            invalid();
        const reservation = s.credits.reservations[i.id];
        if (!reservation || reservation.reservedUnits !== 1 || reservation.finalState !== (i.status === 'succeeded' ? 'committed' : terminal.has(i.status) ? 'released' : 'reserved'))
            invalid();
        const pending = s.pending.find(p => p.itemId === i.id);
        const attempt = s.attempts.find(a => a.itemId === i.id);
        if (!attempt || (terminal.has(i.status) ? Boolean(pending) : !pending))
            invalid();
        if (i.resultAvailable !== (i.status === 'succeeded'))
            invalid();
        if (i.status === 'succeeded' && (i.mode === 'copy' ? !text(i.text) || i.resultMediaId !== undefined : !s.mediaMetadata.some(m => m.id === i.resultMediaId && m.mediaType === i.mode && m.availability === 'available')))
            invalid();
        if (i.status !== 'succeeded' && (i.text !== undefined || i.resultMediaId !== undefined))
            invalid();
        const reviews = s.evaluations.filter(e => e.itemId === i.id).sort((a, b) => a.revision - b.revision);
        const latest = reviews.at(-1);
        if (i.reviewState !== (latest?.decision ?? 'pending') || reviews.some((e, n) => e.revision !== n + 1))
            invalid();
        const saved = s.assets.filter(a => a.originItemId === i.id && a.reviewValidity === 'valid');
        if ((i.libraryState === 'saved') !== (saved.length === 1) || saved.length > 1)
            invalid();
    }
    unique(s.attempts.filter(a => a.lifecycleVersion === 1), a => a.attemptId!);
    for (const a of s.attempts) {
        if (a.lifecycleVersion !== undefined) {
            try { validateProviderAttempt(a); } catch { invalid(); }
            if (s.schemaVersion !== 2) invalid();
            const item = s.items.find(i => i.id === a.itemId);
            if (!item) invalid();
            if ((a.providerBindingId === 'agnes-authorized-real' || item.routingSnapshot.bindingId === 'agnes-authorized-real') && a.providerBindingId !== item.routingSnapshot.bindingId) invalid();
            const compatible: Record<string, string[]> = { not_submitted: ['queued'], submitting: ['running','cancel_requested'], submitted: ['running','cancel_requested'], polling: ['running','cancel_requested'], result_ready: ['finalizing','cancel_requested'], downloading: ['finalizing','cancel_requested'], needs_reconciliation: ['needs_reconciliation'], settled: ['succeeded','failed','cancelled'], failed: ['failed','cancelled'] };
            if (!compatible[a.submissionState]?.includes(item.status)) invalid();
            if ((a.rawMedia || a.derivativeEvidence) && item.mode !== 'video') invalid();
            const derivative = a.derivativeEvidence;
            if (derivative && item.status === 'succeeded') {
                const media = s.mediaMetadata.find(m => m.id === item.resultMediaId);
                if (!media || canonicalJson(media) !== canonicalJson(derivative.media)) invalid();
            }
            if (item.status === 'succeeded' && item.resultMediaId?.startsWith('provider-') && !derivative) invalid();
            continue;
        }
        fields(a, ['itemId', 'attemptNo', 'providerBindingId', 'externalIdempotencyKey', 'submissionState', 'createdAt', 'updatedAt'], ['externalJobId']);
        date(a.createdAt);
        date(a.updatedAt);
        const i = s.items.find(i => i.id === a.itemId);
        if (!i || a.attemptNo !== 1 || a.providerBindingId !== i.routingSnapshot.bindingId || a.externalIdempotencyKey !== `fake-${i.id}` || (a.externalJobId !== undefined && a.externalJobId !== `fake-job-${i.id}`))
            invalid();
        const p = s.pending.find(p => p.itemId === i.id);
        const expected = terminal.has(i.status) ? 'settled' : i.status === 'needs_reconciliation' ? 'outcome_unknown' : p?.phase === 'submit' ? 'not_submitted' : p?.phase === 'accept' ? 'submitting' : 'submitted';
        if (a.submissionState !== expected)
            invalid();
    }
    for (const p of s.pending) {
        fields(p, ['itemId', 'dueAt', 'scenario', 'phase', 'downloadRetry']);
        const i = s.items.find(i => i.id === p.itemId);
        if (!i || !integer(p.dueAt) || !validateHttpBody('scenario', {
            name: p.scenario
        }).ok || !['submit', 'accept', 'complete', 'download'].includes(p.phase) || typeof p.downloadRetry !== 'boolean')
            invalid();
        if ((p.phase === 'submit' && i.status !== 'queued') || (p.phase === 'accept' && !['running', 'cancel_requested'].includes(i.status)) || (p.phase === 'download' && i.status !== 'finalizing'))
            invalid();
        if (p.phase === 'complete' && !['running', 'cancel_requested', 'needs_reconciliation'].includes(i.status))
            invalid();
        if (i.status === 'needs_reconciliation' && (p.phase !== 'complete' || p.dueAt !== Number.MAX_SAFE_INTEGER))
            invalid();
        if (i.status === 'finalizing' && (p.phase !== 'download' || (p.dueAt === Number.MAX_SAFE_INTEGER && !i.errorCode)))
            invalid();
    }
    for (const m of s.mediaMetadata) {
        if (m.id.startsWith('provider-') && !s.attempts.some(a => a.derivativeEvidence?.media.id === m.id && s.items.some(i => i.id === a.itemId && i.resultMediaId === m.id && i.status === 'succeeded'))) invalid();
        const realMedia = s.attempts.some(a => a.providerBindingId === 'agnes-authorized-real' && a.rawMedia?.provenance === 'real_provider_output' && a.derivativeEvidence && canonicalJson(a.derivativeEvidence.media) === canonicalJson(m));
        fields(m, ['id', 'workspaceId', 'mediaType', 'mime', 'byteSize', 'sha256', 'availability', 'objectKey', 'width', 'height', 'hasAudio', 'isDemo', ...(realMedia ? [] : ['fixtureKey'])], ['durationMs']);
        if (m.workspaceId !== 'demo' || !['image', 'video'].includes(m.mediaType) || !hash(m.sha256) || !integer(m.byteSize) || !m.byteSize || !integer(m.width) || !m.width || !integer(m.height) || !m.height || typeof m.hasAudio !== 'boolean' || (realMedia ? m.isDemo !== false || Object.hasOwn(m,'fixtureKey') : m.isDemo !== true || !text(m.fixtureKey)) || !text(m.objectKey) || m.objectKey.includes('..') || /^[\\/]|:/.test(m.objectKey) || m.availability !== 'available' || (m.mediaType === 'image' ? m.mime !== 'image/png' : m.mime !== 'video/mp4') || (m.durationMs !== undefined && (!integer(m.durationMs) || !m.durationMs)))
            invalid();
    }
    for (const e of s.evaluations) {
        fields(e, ['id', 'itemId', 'revision', 'rubricVersion', 'issueTags', 'hardFailures', 'technicalErrors', 'decision', 'reason', 'reviewerId', 'createdAt'], ['score', 'applicability']);
        date(e.createdAt);
        const stored = s.reviewForms[e.id];
        if (!s.items.some(i => i.id === e.itemId && i.status === 'succeeded') || !integer(e.revision) || !e.revision || !['approved', 'rejected'].includes(e.decision) || !stored || !hash(stored.resultSha256) || !validateHttpBody('review', {
            expectedVersion: 0, form: stored.form, reason: stored.reason
        }).ok || stored.form.rubricVersion !== e.rubricVersion || !Array.isArray(e.issueTags) || !Array.isArray(e.hardFailures) || !Array.isArray(e.technicalErrors) || typeof e.reason !== 'string' || e.reviewerId !== 'local-operator')
            invalid();
        fields(stored, ['form', 'reason', 'resultSha256']);
        const item = s.items.find(i => i.id === e.itemId)!;
        const digest = item.mode === 'copy' ? createHash('sha256').update(item.text!).digest('hex') : s.mediaMetadata.find(m => m.id === item.resultMediaId)?.sha256;
        if (stored.resultSha256 !== digest)
            invalid();
        const decision = decideReview(item, stored.form);
        if (!decision.ok || decision.value.decision !== e.decision || e.reason !== (stored.reason.trim() || decision.value.reason))
            invalid();
        const form = stored.form;
        const expected = {
            issueTags: form.rubricVersion === 'rubric-v2-rebuild' ? form.issueTags : [], hardFailures: form.rubricVersion === 'rubric-v2-rebuild' ? form.hardFailures : [], technicalErrors: form.rubricVersion === 'rubric-v2-rebuild' ? form.technicalErrors : [], ...(form.rubricVersion === 'rubric-v2-rebuild' ? {
                score: form.score, applicability: form.applicability
            } : {})
        };
        const actual = {
            issueTags: e.issueTags, hardFailures: e.hardFailures, technicalErrors: e.technicalErrors, ...(e.score !== undefined ? {
                score: e.score
            } : {}), ...(e.applicability !== undefined ? {
                applicability: e.applicability
            } : {})
        };
        if (canonicalJson(actual) !== canonicalJson(expected))
            invalid();
    }
    if (Object.keys(s.reviewForms).some(id => !s.evaluations.some(e => e.id === id)))
        invalid();
    const origins = s.assets.filter(a => a.source === 'generated');
    unique(origins, a => a.originItemId!);
    for (const a of s.assets) {
        fields(a, ['id', 'workspaceId', 'mediaType', 'availability', 'source', 'title', 'tags', 'createdAt', 'isDemo'], ['mediaFileId', 'text', 'originItemId', 'reviewId', 'reviewValidity', 'archivedAt']);
        date(a.createdAt);
        if (a.workspaceId !== 'demo' || !['fixture', 'generated'].includes(a.source) || !text(a.title) || !Array.isArray(a.tags) || a.tags.some(t => typeof t !== 'string') || a.isDemo !== true || !['available', 'unavailable', 'missing', 'quarantined', 'processing'].includes(a.availability))
            invalid();
        if (a.mediaType === 'text' ? !text(a.text) || a.mediaFileId !== undefined : !s.mediaMetadata.some(m => m.id === a.mediaFileId && m.mediaType === a.mediaType))
            invalid();
        if (a.source === 'fixture' && (a.originItemId !== undefined || a.reviewId !== undefined || a.reviewValidity !== undefined))
            invalid();
        if (a.source === 'generated') {
            const i = s.items.find(i => i.id === a.originItemId);
            const e = s.evaluations.find(e => e.id === a.reviewId);
            if (!i || !e || e.itemId !== i.id || e.decision !== 'approved' || !['valid', 'review_invalidated'].includes(a.reviewValidity!) || (i.mode === 'copy' ? a.text !== i.text : a.mediaFileId !== i.resultMediaId))
                invalid();
            if (a.reviewValidity === 'valid' && (s.evaluations.filter(e => e.itemId === i.id).at(-1)?.id !== e.id || i.libraryState !== 'saved'))
                invalid();
        }
    }
    for (const r of s.reconciliations) {
        fields(r, ['itemId', 'outcome', 'evidence', 'createdAt']);
        date(r.createdAt);
        if (!s.items.some(i => i.id === r.itemId) || !['success', 'failure', 'cancelled'].includes(r.outcome) || !text(r.evidence))
            invalid();
    }
    for (const [key, m] of Object.entries(s.memo)) {
        fields(m, ['hash', 'value']);
        if (!text(key) || !hash(m.hash))
            invalid();
        const tuple: unknown = JSON.parse(key);
        if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== 'string' || typeof tuple[1] !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(tuple[1]) || canonicalJson(tuple) !== key)
            invalid();
        const [scope] = tuple as [
            string,
            string
        ];
        if (scope === 'scenario') {
            if (m.value !== null)
                invalid();
            continue;
        }
        const operation = scope.split('/')[0];
        if (!['create', 'retry', 'cancel', 'reconcile', 'retry-download', 'review', 'asset', 'fixture'].includes(operation!))
            invalid();
        const rawResponse = m.value;
        if (!rawResponse || typeof rawResponse !== 'object' || Array.isArray(rawResponse) || !('id' in rawResponse) || !text(rawResponse.id))
            invalid();
        const response = rawResponse as Record<string, unknown>;
        if (operation === 'create' || operation === 'retry') {
            const batch = s.batches.find(b => b.id === response.id);
            if (!batch)
                invalid();
            fields(response, ['id', 'workspaceId', 'requestSnapshot', 'requestedCount', 'idempotencyKey', 'requestHash', 'createdAt', 'status', 'items']);
            if (response.requestHash !== m.hash || response.idempotencyKey !== tuple[1] || response.status !== 'queued' || !Array.isArray(response.items) || response.items.length !== batch.requestedCount || canonicalJson(response.requestSnapshot) !== canonicalJson(batch.requestSnapshot))
                invalid();
            for (const item of response.items) {
                if (!item || typeof item !== 'object' || !batch.items.some(i => i.id === item.id) || item.status !== 'queued' || item.version !== 0 || item.resultAvailable !== false)
                    invalid();
            }
        }
        else if (operation === 'review') {
            const evaluation = s.evaluations.find(e => e.id === response.id);
            if (!evaluation || canonicalJson(response) !== canonicalJson(evaluation) || scope !== `review/${evaluation.itemId}`)
                invalid();
        }
        else if (operation === 'asset' || operation === 'fixture') {
            fields(response, ['id', 'workspaceId', 'mediaType', 'availability', 'source', 'title', 'tags', 'createdAt', 'isDemo'], ['mediaFileId', 'text', 'originItemId', 'reviewId', 'reviewValidity', 'archivedAt']);
            const asset = s.assets.find(a => a.id === response.id);
            if (!asset || response.source !== asset.source || response.workspaceId !== 'demo' || (operation === 'asset' && scope !== `asset/${asset.originItemId}`))
                invalid();
        }
        else {
            fields(response, ['id', 'batchId', 'index', 'version', 'status', 'mode', 'resultAvailable', 'routingSnapshot', 'pricingSnapshot', 'reviewState', 'libraryState', 'updatedAt'], ['resultMediaId', 'text', 'errorCode', 'retryOfItemId']);
            const item = s.items.find(i => i.id === response.id);
            if (!item || scope !== `${operation}/${item.id}` || !integer(response.version) || response.version > item.version || !statuses.includes(String(response.status)) || response.batchId !== item.batchId || response.mode !== item.mode)
                invalid();
        }
    }
}
export interface StoreFileSystem {
    rename(source: string, destination: string): Promise<void>;
}
export class GenerationStore {
    private queue: Promise<unknown> = Promise.resolve();
    private closing = false;
    private closeJob?: Promise<void>;
    private constructor(private readonly root: string, private readonly lock: FileHandle, private state: GenerationState, private readonly fs: StoreFileSystem) {
    }
    static async open(directory: string, fs: StoreFileSystem = {
        rename
    }): Promise<GenerationStore> {
        const root = resolve(directory);
        await mkdir(root, {
            recursive: true, mode: 0o700
        });
        // Reject symlink/junction ancestors, not only the final directory.
        for (let path = root;; path = dirname(path)) {
            if ((await lstat(path)).isSymbolicLink())
                throw new Error('INVALID_STORE_DIRECTORY');
            if (dirname(path) === path)
                break;
        }
        if (!(await lstat(root)).isDirectory() || resolve(await realpath(root)).toLowerCase() !== root.toLowerCase())
            throw new Error('INVALID_STORE_DIRECTORY');
        let lock: FileHandle;
        try {
            lock = await open(join(root, '.lock'), 'wx', 0o600);
        }
        catch {
            throw new Error('STORE_LOCKED');
        }
        try {
            await lock.writeFile(String(process.pid));
            await lock.sync();
            let state: GenerationState;
            let fresh = false;
            try {
                const path = join(root, 'state.json');
                const info = await lstat(path);
                if (info.isSymbolicLink() || !info.isFile())
                    invalid();
                const value: unknown = JSON.parse(await readFile(path, 'utf8'));
                validateState(value);
                state = value;
                if (state.schemaVersion === undefined) { state.schemaVersion = 2; fresh = true; }
                validateState(state);
            }
            catch (error) {
                if (error instanceof Error && error.message === 'UNSUPPORTED_STORE_SCHEMA') throw error;
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    invalid();
                state = { ...createGenerationState(randomUUID(), Date.now()), schemaVersion: 2 };
                fresh = true;
            }
            const store = new GenerationStore(root, lock, state, fs);
            if (fresh)
                await store.persist(state);
            return store;
        }
        catch (error) {
            await lock.close();
            await rm(join(root, '.lock'), {
                force: true
            });
            throw error;
        }
    }
    read(): GenerationState {
        return structuredClone(this.state);
    }
    transact<T>(work: (state: GenerationState) => Result<T>): Promise<Result<T>> {
        if (this.closing)
            return Promise.reject(new Error('STORAGE_UNAVAILABLE'));
        const run = async () => {
            const next = structuredClone(this.state);
            const result = work(next);
            if (!result.ok)
                return structuredClone(result);
            validateState(next);
            await this.persist(next);
            this.state = next;
            return structuredClone(result);
        };
        const job = this.queue.then(run);
        this.queue = job.catch(() => {
        });
        return job;
    }
    private async persist(state: GenerationState) {
        const temp = join(this.root, `state.${randomUUID()}.pending`);
        try {
            const handle = await open(temp, 'wx', 0o600);
            try {
                await handle.writeFile(JSON.stringify(state));
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            await this.fs.rename(temp, join(this.root, 'state.json'));
        }
        catch {
            throw new Error('STORAGE_UNAVAILABLE');
        }
        finally {
            await rm(temp, {
                force: true
            });
        }
    }
    close(): Promise<void> {
        if (!this.closeJob) {
            this.closing = true;
            this.closeJob = (async () => {
                await this.queue;
                await this.lock.close();
                await rm(join(this.root, '.lock'), {
                    force: true
                });
            })();
        }
        return this.closeJob;
    }
}
