import { validateProviderReportedFacts } from '../../domain/src/provider-attempt.js';
import { createHash } from 'node:crypto';
import type { GenerationState, GenerationItem, Result } from '../../contracts/src/index.js';
import { applyProviderEvent, adoptProviderAttempt, type ProviderEvent, PROVIDER_PAUSED } from '../../domain/src/provider-commands.js';
import { FixtureCatalog } from './fixtures.js';
import { GenerationStore } from './store.js';
import { GenerationMediaRepository } from './media-repository.js';
import { DeterministicFakeProvider } from './provider/fake-provider.js';
import { readProviderOperationError, type GenerationProvider, type ProviderContext, type ProviderPollResult, type ProviderDownloadedMedia } from './provider/port.js';
const activeStores = new WeakMap<GenerationStore, Promise<void>>();
/** One durable orchestration algorithm for every injected provider. */
export class GenerationWorker {
    private timer?: ReturnType<typeof setInterval>;
    private active?: Promise<void>;
    private storageFailed = false;
    constructor(private readonly store: GenerationStore, private readonly provider: GenerationProvider, private readonly fixtures: FixtureCatalog, private readonly mediaRepo?: GenerationMediaRepository, private readonly clock: () => number = Date.now) { }
    status(): {
        running: boolean;
        errorCode?: 'STORAGE_UNAVAILABLE';
    } { return { running: this.timer !== undefined, ...(this.storageFailed ? { errorCode: 'STORAGE_UNAVAILABLE' as const } : {}) }; }
    start(intervalMs = 50): void {
        if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
            throw Error('INVALID_WORKER_INTERVAL');
        if (this.storageFailed)
            throw Error('STORAGE_UNAVAILABLE');
        if (this.timer)
            return;
        this.timer = setInterval(() => { void this.tick().catch(() => { }); }, intervalMs);
    }
    tick(): Promise<void> {
        if (this.storageFailed)
            return Promise.reject(Error('STORAGE_UNAVAILABLE'));
        if (this.active)
            return this.active;
        const shared = activeStores.get(this.store);
        if (shared)
            return shared;
        this.active = this.run().catch(() => {
            this.storageFailed = true;
            if (this.timer)
                clearInterval(this.timer);
            this.timer = undefined;
            throw Error('STORAGE_UNAVAILABLE');
        }).finally(() => { activeStores.delete(this.store); this.active = undefined; });
        activeStores.set(this.store, this.active);
        return this.active;
    }
    async stop(): Promise<void> {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        await (this.active ?? activeStores.get(this.store))?.catch(() => { });
    }
    private context(state: GenerationState, id: string): ProviderContext {
        const item = state.items.find(i => i.id === id)!;
        const a = state.attempts.find(a => a.itemId === id)!;
        const p = state.pending.find(p => p.itemId === id)!;
        return { request: state.batches.find(b => b.id === item.batchId)!.requestSnapshot, itemId: id, itemIndex: item.index, attemptId: a.attemptId!, externalIdempotencyKey: a.externalIdempotencyKey, submittedAt: a.submittedAt ?? a.createdAt, now: this.clock(), scenario: p.scenario, ...(a.lastPolledAt ? { lastPolledAt: a.lastPolledAt } : {}), cancelRequested: item.status === 'cancel_requested', recovery: p.downloadRetry };
    }
    private async event(id: string, event: ProviderEvent, identity?: string, expectedVersion?: number): Promise<Result<GenerationItem>> {
        const result = await this.store.transact(s => applyProviderEvent(s, id, event, { now: this.clock(), manifest: this.fixtures.manifest }, identity, expectedVersion));
        if (!result.ok && !['VERSION_CONFLICT', 'ITEM_NOT_READY'].includes(result.error.code))
            throw Error('STORAGE_UNAVAILABLE');
        return result;
    }
    private async run(): Promise<void> {
        const now = this.clock();
        for (const initial of this.store.read().pending.filter(p => p.dueAt !== PROVIDER_PAUSED && p.dueAt <= now)) {
            const id = initial.itemId;
            let state = this.store.read();
            let a = state.attempts.find(a => a.itemId === id)!;
            if (a.lifecycleVersion !== 1 && a.submissionState !== 'not_submitted') {
                const adopted = await this.store.transact(s => adoptProviderAttempt(s, id, this.provider.bindingId, this.clock()));
                if (!adopted.ok)
                    throw Error('STORAGE_UNAVAILABLE');
                state = this.store.read();
                a = state.attempts.find(a => a.itemId === id)!;
            }
            if (a.lifecycleVersion === 1 && a.providerBindingId !== this.provider.bindingId)
                continue;
            if (a.submissionState === 'not_submitted') {
                const claim = await this.event(id, { kind: 'claim', bindingId: this.provider.bindingId });
                if (!claim.ok)
                    continue;
                const context = this.context(this.store.read(), id);
                let accepted;
                try {
                    accepted = await this.provider.create({ request: context.request, itemId: id, itemIndex: context.itemIndex }, context);
                }
                catch (error) {
                    const diagnostic = readProviderOperationError(error);
                    await this.event(id, diagnostic && diagnostic.submissionCertainty !== 'unknown' ? { kind: 'failed', category: diagnostic.category } : { kind: 'unknown', category: diagnostic?.category ?? 'unknown' }, context.attemptId);
                    continue;
                }
                // Never serialize arbitrary provider IDs or error content. Lost acceptance is ambiguous.
                if (!/^[A-Za-z0-9_-]{1,200}$/.test(accepted.externalJobId) || !['queued', 'running', 'result_ready', 'failed', 'cancelled', 'unknown'].includes(accepted.status)) {
                    await this.event(id, { kind: 'unknown' }, context.attemptId);
                    continue;
                }
                try { if (accepted.reported !== undefined) validateProviderReportedFacts(accepted.reported); } catch {
                    await this.event(id, { kind: 'accepted', externalJobId: accepted.externalJobId, status: 'unknown' }, context.attemptId); continue;
                }
                await this.event(id, { kind: 'accepted', externalJobId: accepted.externalJobId, status: accepted.status, ...(accepted.reported ? { reported: accepted.reported } : {}) }, context.attemptId);
                continue;
            }
            if (a.submissionState === 'submitting') {
                await this.event(id, { kind: 'unknown' }, a.attemptId);
                continue;
            }
            if (['settled', 'failed', 'needs_reconciliation'].includes(a.submissionState))
                continue;
            if (a.nextPollAt && Date.parse(a.nextPollAt) > now)
                continue;
            const context = this.context(state, id);
            if (a.rawMedia && this.mediaRepo) {
                let valid = true;
                try {
                    await this.mediaRepo.verifyRaw(a.rawMedia);
                }
                catch {
                    valid = false;
                }
                if (valid) {
                    await this.finalize(id, context);
                    continue;
                }
            }
            let poll: ProviderPollResult;
            try {
                poll = await this.provider.get(a.externalJobId!, context);
            }
            catch (error) {
                // Poll transport failures never prove terminal failure and never authorize another create.
                if (['downloading', 'result_ready'].includes(a.submissionState))
                    await this.event(id, { kind: 'download_failed' }, a.attemptId);
                else
                    await this.event(id, { kind: 'poll', status: 'running', category: readProviderOperationError(error)?.category ?? 'transient' }, a.attemptId);
                continue;
            }
            try { if (poll.reported !== undefined) validateProviderReportedFacts(poll.reported); } catch {
                await this.event(id, { kind: 'unknown' }, a.attemptId); continue;
            }
            const reported = poll.reported ? { reported: poll.reported } : {};
            if (poll.status === 'unknown') {
                await this.event(id, { kind: 'unknown', ...reported }, a.attemptId);
                continue;
            }
            if (poll.status === 'failed' || poll.status === 'cancelled') {
                await this.event(id, { kind: 'failed', cancelled: poll.status === 'cancelled', ...reported }, a.attemptId);
                continue;
            }
            if (poll.status === 'queued' || poll.status === 'running') {
                if (['downloading', 'result_ready'].includes(a.submissionState))
                    await this.event(id, { kind: 'download_failed', ...reported }, a.attemptId);
                else
                    await this.event(id, { kind: 'poll', status: poll.status, ...reported }, a.attemptId);
                continue;
            }
            if (poll.status !== 'result_ready') {
                await this.event(id, { kind: 'unknown' }, a.attemptId);
                continue;
            }
            if (!poll.result) {
                await this.event(id, { kind: 'download_failed', ...reported }, a.attemptId);
                continue;
            }
            const expectedVersion = state.items.find(i => i.id === id)!.version;
            const durableMedia = poll.result.kind === 'https';
            if (durableMedia) {
                const started = await this.event(id, { kind: 'downloading', ...reported }, a.attemptId);
                if (!started.ok)
                    continue;
            }
            let downloaded: ProviderDownloadedMedia;
            try {
                downloaded = await this.provider.download(poll.result, context);
            }
            catch (error) {
                await this.event(id, { kind: 'download_failed', storage: readProviderOperationError(error)?.code === 'PROVIDER_STORAGE_FAILED' }, a.attemptId, durableMedia ? undefined : expectedVersion);
                continue;
            }
            const real = a.providerBindingId === 'agnes-authorized-real';
            if ((real && (poll.result.kind !== 'https' || downloaded.kind !== 'media' || downloaded.fixtureMedia !== undefined)) ||
                (downloaded.kind === 'media' && downloaded.provenance !== (real ? 'real_provider_output' : 'synthetic_provider_simulation'))) {
                await this.event(id, { kind: 'download_failed' }, a.attemptId); continue;
            }
            if (downloaded.kind === 'text') {
                await this.event(id, { kind: 'success', text: downloaded.text }, a.attemptId, expectedVersion);
                continue;
            }
            if (downloaded.fixtureMedia) {
                // Verify independently of the adapter; catalog-looking metadata cannot bless arbitrary bytes.
                try {
                    const actual = await this.fixtures.readMedia(downloaded.fixtureMedia);
                    if (downloaded.sha256 !== actual.media.sha256 || downloaded.bytes.length !== actual.media.byteSize || createHash('sha256').update(downloaded.bytes).digest('hex') !== actual.media.sha256)
                        throw Error('MEDIA_UNAVAILABLE');
                }
                catch {
                    await this.event(id, { kind: 'download_failed' }, a.attemptId, expectedVersion);
                    continue;
                }
                await this.event(id, { kind: 'success', media: downloaded.fixtureMedia }, a.attemptId, expectedVersion);
                continue;
            }
            if (poll.result.kind !== 'https' || !this.mediaRepo) {
                await this.event(id, { kind: 'download_failed' }, a.attemptId);
                continue;
            }
            let raw;
            try {
                raw = await this.mediaRepo.captureRaw(downloaded, poll.result, a.providerBindingId, a.externalJobId!, this.clock());
            }
            catch {
                await this.event(id, { kind: 'download_failed' }, a.attemptId);
                continue;
            }
            const persisted = await this.event(id, { kind: 'raw', raw }, a.attemptId);
            if (persisted.ok)
                await this.finalize(id, context);
        }
    }
    private async finalize(id: string, context: ProviderContext): Promise<void> {
        const attempt = this.store.read().attempts.find(a => a.itemId === id)!;
        if (!attempt.rawMedia || !this.mediaRepo || context.request.mode !== 'video') {
            await this.event(id, { kind: 'download_failed' }, context.attemptId);
            return;
        }
        let derivative;
        try {
            derivative = await this.mediaRepo.finalize(attempt.rawMedia, context.request.video);
        }
        catch {
            await this.event(id, { kind: 'download_failed' }, context.attemptId);
            return;
        }
        await this.event(id, { kind: 'success', media: derivative.media, derivative }, context.attemptId);
    }
}
/** Constructor compatibility only; all business orchestration is inherited. */
export class FakeWorker extends GenerationWorker {
    constructor(store: GenerationStore, fixtures: FixtureCatalog, clock: () => number = Date.now) { super(store, new DeterministicFakeProvider(fixtures), fixtures, undefined, clock); }
}
