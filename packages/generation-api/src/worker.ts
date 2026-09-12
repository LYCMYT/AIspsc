import type { MediaFile, WorkerEvent } from '../../contracts/src/index.js';
import { applyWorkerEvent } from '../../domain/src/generation-commands.js';
import { outputFixtureKey } from '../../domain/src/generation-state.js';
import { FixtureCatalog } from './fixtures.js';
import { GenerationStore } from './store.js';
export class FakeWorker {
    private timer?: ReturnType<typeof setInterval>;
    private active?: Promise<void>;
    private storageFailed = false;
    constructor(private readonly store: GenerationStore, private readonly fixtures: FixtureCatalog, private readonly clock: () => number = Date.now) {
    }
    status(): {
        running: boolean;
        errorCode?: 'STORAGE_UNAVAILABLE';
    } {
        return {
            running: this.timer !== undefined, ...(this.storageFailed ? {
                errorCode: 'STORAGE_UNAVAILABLE' as const
            } : {})
        };
    }
    start(intervalMs = 50): void {
        if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
            throw new Error('INVALID_WORKER_INTERVAL');
        if (this.storageFailed)
            throw new Error('STORAGE_UNAVAILABLE');
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            void this.tick().catch(() => {
            });
        }, intervalMs);
    }
    tick(): Promise<void> {
        if (this.storageFailed)
            return Promise.reject(new Error('STORAGE_UNAVAILABLE'));
        if (this.active)
            return this.active;
        this.active = this.run().catch(() => {
            this.storageFailed = true;
            if (this.timer)
                clearInterval(this.timer);
            this.timer = undefined;
            throw new Error('STORAGE_UNAVAILABLE');
        }).finally(() => {
            this.active = undefined;
        });
        return this.active;
    }
    private async run(): Promise<void> {
        const snapshot = this.store.read();
        const now = this.clock();
        for (const pending of snapshot.pending.filter(p => p.dueAt !== Number.MAX_SAFE_INTEGER && p.dueAt <= now)) {
            const item = snapshot.items.find(i => i.id === pending.itemId)!;
            const base = {
                itemId: item.id, expectedVersion: item.version
            };
            let event: WorkerEvent;
            if (pending.phase === 'submit')
                event = {
                    ...base, kind: 'submitting'
                };
            else if (pending.phase === 'accept')
                event = {
                    ...base, kind: 'submitted'
                };
            else {
                let media: MediaFile | undefined;
                let unavailable = false;
                const knownNonSuccess = !pending.downloadRetry && (pending.scenario === 'failure' || pending.scenario === 'unknown' || (pending.scenario === 'partial_success' && item.index % 3 === 1));
                const cancelled = item.status === 'cancel_requested' && pending.scenario !== 'cancel_race';
                if (item.mode !== 'copy' && !knownNonSuccess && !cancelled) {
                    try {
                        const batch = snapshot.batches.find(b => b.id === item.batchId)!;
                        media = (await this.fixtures.readFixture(outputFixtureKey(batch.requestSnapshot)!)).media;
                    }
                    catch {
                        unavailable = true;
                    }
                }
                event = unavailable ? {
                    ...base, kind: 'download_failed'
                } : {
                    ...base, kind: 'complete', ...(media ? {
                        media
                    } : {})
                };
            }
            const result = await this.store.transact(state => applyWorkerEvent(state, event, {
                now: this.clock(), manifest: this.fixtures.manifest
            }));
            // Version/state conflicts mean a command won the race. Any other invariant failure halts.
            if (!result.ok && !['VERSION_CONFLICT', 'ITEM_NOT_READY'].includes(result.error.code))
                throw new Error('STORAGE_UNAVAILABLE');
        }
    }
    async stop(): Promise<void> {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        if (this.active)
            await this.active.catch(() => {
            });
    }
}
