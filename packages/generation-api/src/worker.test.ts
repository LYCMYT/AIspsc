import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { GenerationStore } from './store.js';
import { FixtureCatalog } from './fixtures.js';
import { GenerationApiService } from './service.js';
import { FakeWorker } from './worker.js';
import type { CreateGenerationRequest, Result } from '../../contracts/src/index.js';
const copy: CreateGenerationRequest = {
    mode: 'copy', prompt: '几何商品演示', references: [], count: 1, copy: {
        language: 'zh-CN', maxCharacters: 200
    }
};
const image: CreateGenerationRequest = {
    mode: 'image', prompt: '几何商品演示', references: [], count: 1, image: {
        ratio: '16:9', resolution: '1024'
    }
};
const video: CreateGenerationRequest = {
    mode: 'video', prompt: '几何商品演示', references: [], count: 1, video: {
        durationSeconds: 5, ratio: '16:9', resolution: '720p', audio: false
    }
};
function value<T>(r: Result<T>): T {
    if (!r.ok)
        throw Error(r.error.code);
    return r.value;
}
const basic = {
    rubricVersion: 'basic-media-review-v1' as const, humanDecision: 'approved' as const, readable: true, followsTask: true
};
let dir: string, store: GenerationStore, fixtures: FixtureCatalog, service: GenerationApiService, worker: FakeWorker, now: number;
beforeEach(async () => {
    const root = resolve('.cache/generation-tests');
    await mkdir(root, {
        recursive: true
    });
    dir = await mkdtemp(join(root, 'worker-'));
    store = await GenerationStore.open(join(dir, 'state'));
    fixtures = await FixtureCatalog.open(resolve('apps/web/public/demo'));
    now = 1000;
    service = new GenerationApiService(store, fixtures, () => now);
    worker = new FakeWorker(store, fixtures, () => now);
});
afterEach(async () => {
    await worker.stop();
    await store.close();
    const rel = relative(resolve('.cache/generation-tests'), dir);
    if (rel.startsWith('..') || !rel)
        throw Error('cleanup containment');
    await rm(dir, {
        recursive: true, force: true
    });
});
async function finish() {
    for (let i = 0; i < 3; i++) {
        now += 101;
        await worker.tick();
    }
}
async function restart() {
    await worker.stop();
    await store.close();
    store = await GenerationStore.open(join(dir, 'state'));
    service = new GenerationApiService(store, fixtures, () => now);
    worker = new FakeWorker(store, fixtures, () => now);
}
describe('durable service and autonomous fake worker', () => {
    it('serially replays canonical concurrent create with its original queued response', async () => {
        const [first, replay] = await Promise.all([service.create(copy, 'same-key'), service.create({
                copy: {
                    maxCharacters: 200, language: 'zh-CN'
                }, count: 1, references: [], prompt: '  几何商品演示  ', mode: 'copy'
            }, 'same-key')]);
        expect(first).toEqual(replay);
        expect(value(first).status).toBe('queued');
        await finish();
        expect(await service.create(copy, 'same-key')).toEqual(first);
        expect(store.read().batches).toHaveLength(1);
        expect(store.read().ledger.filter(l => l.action === 'RESERVE')).toHaveLength(1);
        expect(await service.create({
            ...copy, prompt: '不同'
        }, 'same-key')).toMatchObject({
            ok: false, error: {
                code: 'IDEMPOTENCY_CONFLICT'
            }
        });
        expect(service.snapshot()).not.toHaveProperty('memo');
        expect(service.snapshot().assets).toHaveLength(0);
    });
    it('finishes using only a timer, without browser GET or pump', async () => {
        worker = new FakeWorker(store, fixtures, () => Date.now());
        service = new GenerationApiService(store, fixtures, () => Date.now());
        await service.create(copy, 'auto');
        worker.start(5);
        await vi.waitFor(() => expect(store.read().items[0]?.status).toBe('succeeded'), {
            timeout: 2000
        });
        await worker.stop();
        expect(store.read().credits.spent).toBe(1);
    });
    it.each([image, video])('verifies actual $mode fixture bytes before success', async (request) => {
        value(await service.create(request, 'media'));
        await finish();
        const item = store.read().items[0]!;
        expect(item.status).toBe('succeeded');
        const media = store.read().mediaMetadata.find(m => m.id === item.resultMediaId)!;
        const actual = await fixtures.readMedia(media);
        expect(createHash('sha256').update(actual.bytes).digest('hex')).toBe(media.sha256);
        expect(actual.bytes.length).toBe(media.byteSize);
        expect(media.isDemo).toBe(true);
    });
    it('captures partial failure and creates a new single retry item', async () => {
        value(await service.setScenario({
            name: 'partial_success'
        }, 'scenario'));
        value(await service.create({
            ...copy, count: 3
        }, 'partial'));
        await service.setScenario({
            name: 'success'
        }, 'future');
        await finish();
        expect(store.read().batches[0]?.status).toBe('partial_succeeded');
        const failed = store.read().items.find(i => i.status === 'failed')!;
        const retry = value(await service.retry(failed.id, {
            expectedVersion: failed.version
        }, 'retry'));
        expect(retry.items[0]?.retryOfItemId).toBe(failed.id);
        expect(retry.items[0]?.id).not.toBe(failed.id);
        expect(await service.retry(failed.id, {
            expectedVersion: failed.version
        }, 'retry')).toEqual({
            ok: true, value: retry
        });
        expect(await service.retry(failed.id, {
            expectedVersion: failed.version
        }, 'stale')).toMatchObject({
            ok: false, error: {
                code: 'VERSION_CONFLICT'
            }
        });
    });
    it('cancels queued work, settles once, and preserves cancel-race success', async () => {
        const batch = value(await service.create(copy, 'cancel'));
        const id = batch.items[0]!.id;
        const accepted = await service.cancel(id, {
            expectedVersion: 0
        }, 'cancel');
        await finish();
        expect(store.read().items[0]?.status).toBe('cancelled');
        expect(await service.cancel(id, {
            expectedVersion: 0
        }, 'cancel')).toEqual(accepted);
        expect(await service.cancel(id, {
            expectedVersion: 0
        }, 'fresh')).toMatchObject({
            ok: false, error: {
                code: 'VERSION_CONFLICT'
            }
        });
        value(await service.setScenario({
            name: 'cancel_race'
        }, 'race'));
        const race = value(await service.create(copy, 'race')).items[0]!;
        now += 101;
        await worker.tick();
        now += 101;
        await worker.tick();
        const item = store.read().items.find(i => i.id === race.id)!;
        value(await service.cancel(item.id, {
            expectedVersion: item.version
        }, 'race'));
        now += 101;
        await worker.tick();
        expect(store.read().items.find(i => i.id === race.id)?.status).toBe('succeeded');
        expect(store.read().credits).toMatchObject({
            reserved: 0, spent: 1
        });
    });
    it('pauses unknown across restart until explicit reconcile, then downloads same attempt', async () => {
        await service.setScenario({
            name: 'unknown'
        }, 'unknown');
        const id = value(await service.create(video, 'unknown')).items[0]!.id;
        await finish();
        expect(store.read().items[0]?.status).toBe('needs_reconciliation');
        expect(store.read().credits.reserved).toBe(1);
        const attempts = store.read().attempts;
        await restart();
        await finish();
        expect(store.read().attempts).toEqual(attempts);
        const item = store.read().items[0]!;
        const input = {
            expectedVersion: item.version, outcome: 'success' as const
        };
        const accepted = await service.reconcile(id, input, 'resolve');
        expect(value(accepted).status).toBe('finalizing');
        await worker.tick();
        expect(store.read().items[0]?.status).toBe('succeeded');
        expect(store.read().attempts).toHaveLength(1);
        expect(await service.reconcile(id, input, 'resolve')).toEqual(accepted);
        expect(await service.reconcile(id, input, 'stale')).toMatchObject({
            ok: false, error: {
                code: 'VERSION_CONFLICT'
            }
        });
    });
    it('restarts queued/submitting/submitted and paused finalizing without new attempts', async () => {
        await service.setScenario({
            name: 'download_failure'
        }, 'failure');
        const id = value(await service.create(video, 'download')).items[0]!.id;
        await restart();
        now += 101;
        await worker.tick();
        await restart();
        now += 101;
        await worker.tick();
        await restart();
        now += 101;
        await worker.tick();
        expect(store.read().items[0]?.status).toBe('finalizing');
        await restart();
        await finish();
        const before = store.read().items[0]!;
        const attempts = store.read().attempts;
        const input = {
            expectedVersion: before.version
        };
        const accepted = await service.retryDownload(id, input, 'recover');
        await worker.tick();
        expect(store.read().items[0]?.status).toBe('succeeded');
        expect(store.read().attempts[0]?.externalJobId).toBe(attempts[0]?.externalJobId);
        expect(await service.retryDownload(id, input, 'recover')).toEqual(accepted);
        expect(await service.retryDownload(id, input, 'stale')).toMatchObject({
            ok: false, error: {
                code: 'VERSION_CONFLICT'
            }
        });
        expect(store.read().credits).toMatchObject({
            reserved: 0, spent: 1
        });
    });
    it('requires explicit manual save and invalidates on every review revision', async () => {
        const id = value(await service.create(copy, 'review')).items[0]!.id;
        await finish();
        const input = {
            expectedVersion: store.read().items[0]!.version, form: basic, reason: ''
        };
        const approved = await service.review(id, input, 'review');
        expect(store.read().assets).toHaveLength(0);
        const save = {
            expectedVersion: store.read().items[0]!.version, evaluationId: value(approved).id
        };
        const saved = await service.saveAsset(id, save, 'save');
        expect(value(saved).source).toBe('generated');
        expect(await service.review(id, input, 'review')).toEqual(approved);
        expect(await service.review(id, input, 'stale')).toMatchObject({
            ok: false, error: {
                code: 'VERSION_CONFLICT'
            }
        });
        expect(await service.saveAsset(id, save, 'save')).toEqual(saved);
        expect(await service.saveAsset(id, save, 'stale')).toMatchObject({
            ok: false, error: {
                code: 'VERSION_CONFLICT'
            }
        });
        await service.review(id, {
            expectedVersion: store.read().items[0]!.version, form: basic, reason: '重新确认'
        }, 'revision');
        expect(store.read().assets[0]?.reviewValidity).toBe('review_invalidated');
        expect(store.read().items[0]?.libraryState).toBe('not_saved');
        await restart();
    });
    it('rejects altered fixture bytes before create, review, save, or read', async () => {
        const copied = join(dir, 'fixtures');
        await cp(resolve('apps/web/public/demo'), copied, {
            recursive: true
        });
        fixtures = await FixtureCatalog.open(copied);
        service = new GenerationApiService(store, fixtures, () => now);
        worker = new FakeWorker(store, fixtures, () => now);
        const id = value(await service.create(image, 'image')).items[0]!.id;
        await finish();
        const approved = value(await service.review(id, {
            expectedVersion: store.read().items[0]!.version, form: basic, reason: ''
        }, 'approved'));
        const m = store.read().mediaMetadata[0]!;
        await writeFile(join(copied, m.objectKey!), Buffer.from('tampered'));
        await expect(fixtures.readMedia(m)).rejects.toThrow('MEDIA_UNAVAILABLE');
        expect(await service.review(id, {
            expectedVersion: store.read().items[0]!.version, form: basic, reason: 'again'
        }, 'new')).toMatchObject({
            ok: false, error: {
                code: 'MEDIA_UNAVAILABLE'
            }
        });
        expect(await service.saveAsset(id, {
            expectedVersion: store.read().items[0]!.version, evaluationId: approved.id
        }, 'save')).toMatchObject({
            ok: false, error: {
                code: 'MEDIA_UNAVAILABLE'
            }
        });
        const before = store.read();
        expect(await service.create(image, 'tamper')).toMatchObject({
            ok: false, error: {
                code: 'MEDIA_UNAVAILABLE'
            }
        });
        expect(store.read()).toEqual(before);
    });
    it('keeps fixture provenance and rejects forged metadata and traversal', async () => {
        const asset = value(await service.loadFixture({
            key: 'image-16x9-1024'
        }, 'source'));
        expect(asset.source).toBe('fixture');
        expect(asset).not.toHaveProperty('reviewId');
        const media = store.read().mediaMetadata[0]!;
        await expect(fixtures.readMedia({
            ...media, sha256: '0'.repeat(64)
        })).rejects.toThrow('MEDIA_UNAVAILABLE');
        await expect(fixtures.readFixture('../state.json')).rejects.toThrow('MEDIA_UNAVAILABLE');
        const bad = join(dir, 'bad');
        await mkdir(bad);
        await writeFile(join(bad, 'MEDIA_MANIFEST.json'), JSON.stringify({
            version: 1, files: [{
                    ...fixtures.manifest.files[0], path: '../escape.png'
                }]
        }));
        await expect(FixtureCatalog.open(bad)).rejects.toThrow('INVALID_FIXTURE_CATALOG');
    });
    it('stops autonomous scheduling on storage failure and exposes only a safe status', async () => {
        await worker.stop();
        await store.close();
        let fail = false;
        store = await GenerationStore.open(join(dir, 'state'), {
            rename: async (a, b) => {
                if (fail)
                    throw Error('secret-path');
                await rename(a, b);
            }
        });
        service = new GenerationApiService(store, fixtures, () => now);
        worker = new FakeWorker(store, fixtures, () => now);
        await service.create(copy, 'error');
        now += 101;
        fail = true;
        worker.start(5);
        await vi.waitFor(() => expect(worker.status()).toEqual({
            running: false, errorCode: 'STORAGE_UNAVAILABLE'
        }));
        expect(store.read().items[0]?.status).toBe('queued');
        await expect(worker.tick()).rejects.toThrow('STORAGE_UNAVAILABLE');
    });
    it('preserves persisted files rather than embedding bytes', async () => {
        await service.create(video, 'safe');
        await finish();
        const raw = await readFile(join(dir, 'state', 'state.json'), 'utf8');
        expect(raw).not.toMatch(/data:|base64|https?:/);
    });
});
describe('reload semantic integrity and IO races', () => {
    it.each(['review-digest', 'review-decision', 'review-fields', 'memo-shape', 'pending-status', 'routing'])('rejects %s corruption without resetting data', async (kind) => {
        const id = value(await service.create(copy, 'create')).items[0]!.id;
        if (kind !== 'pending-status') {
            await finish();
            await service.review(id, {
                expectedVersion: store.read().items[0]!.version, form: basic, reason: ''
            }, 'review');
        }
        const state = store.read();
        await store.close();
        if (kind === 'pending-status') {
            state.pending[0]!.phase = 'complete';
            state.attempts[0]!.submissionState = 'submitted';
        }
        if (kind === 'review-digest')
            state.reviewForms[state.evaluations[0]!.id]!.resultSha256 = 'a'.repeat(64);
        if (kind === 'review-decision') {
            state.evaluations[0]!.decision = 'rejected';
            state.items[0]!.reviewState = 'rejected';
            state.batches[0]!.items[0]!.reviewState = 'rejected';
        }
        if (kind === 'review-fields')
            state.evaluations[0]!.issueTags = ['invented'];
        if (kind === 'memo-shape')
            Object.values(state.memo)[0]!.value = {
                arbitrary: true
            };
        if (kind === 'routing') {
            state.items[0]!.routingSnapshot.capabilitySnapshot = {
                taskTypes: [], maxReferences: -1
            };
            state.batches[0]!.items = structuredClone(state.items);
        }
        await writeFile(join(dir, 'state', 'state.json'), JSON.stringify(state));
        await expect(GenerationStore.open(join(dir, 'state'))).rejects.toThrow('INVALID_STORE');
    });
    it('rejects source byte tampering before reserve, including retries', async () => {
        const copied = join(dir, 'fixtures');
        await cp(resolve('apps/web/public/demo'), copied, {
            recursive: true
        });
        fixtures = await FixtureCatalog.open(copied);
        service = new GenerationApiService(store, fixtures, () => now);
        worker = new FakeWorker(store, fixtures, () => now);
        const asset = value(await service.loadFixture({
            key: 'image-16x9-1024'
        }, 'source'));
        const request = {
            ...video, references: [{
                    assetId: asset.id, role: 'product' as const
                }]
        };
        await service.setScenario({
            name: 'failure'
        }, 'failure');
        const id = value(await service.create(request, 'first')).items[0]!.id;
        await finish();
        const source = store.read().mediaMetadata.find(m => m.id === asset.mediaFileId)!;
        await writeFile(join(copied, source.objectKey!), 'altered');
        const before = store.read();
        expect(await service.create(request, 'changed')).toMatchObject({
            ok: false, error: {
                code: 'MEDIA_UNAVAILABLE'
            }
        });
        expect(await service.retry(id, {
            expectedVersion: before.items[0]!.version
        }, 'retry')).toMatchObject({
            ok: false, error: {
                code: 'MEDIA_UNAVAILABLE'
            }
        });
        expect(store.read()).toEqual(before);
    });
    it('discards worker output when cancellation wins during fixture IO', async () => {
        const id = value(await service.create(video, 'race-io')).items[0]!.id;
        now += 101;
        await worker.tick();
        now += 101;
        await worker.tick();
        now += 101;
        const original = fixtures.readFixture.bind(fixtures);
        let release!: () => void;
        let arrived!: () => void;
        const waiting = new Promise<void>(r => {
            arrived = r;
        });
        const gate = new Promise<void>(r => {
            release = r;
        });
        const spy = vi.spyOn(fixtures, 'readFixture').mockImplementation(async (key) => {
            const read = await original(key);
            arrived();
            await gate;
            return read;
        });
        const running = worker.tick();
        await waiting;
        const current = store.read().items[0]!;
        value(await service.cancel(id, {
            expectedVersion: current.version
        }, 'cancel-io'));
        release();
        await running;
        expect(store.read().items[0]?.status).toBe('cancel_requested');
        spy.mockRestore();
        await worker.tick();
        expect(store.read().items[0]?.status).toBe('cancelled');
        expect(store.read().credits).toMatchObject({
            reserved: 0, spent: 0
        });
    });
    it('rejects references invalidated while create is verifying bytes', async () => {
        const id = value(await service.create(image, 'origin')).items[0]!.id;
        await finish();
        const review = value(await service.review(id, {
            expectedVersion: store.read().items[0]!.version, form: basic, reason: ''
        }, 'approved'));
        const asset = value(await service.saveAsset(id, {
            expectedVersion: store.read().items[0]!.version, evaluationId: review.id
        }, 'saved'));
        const original = fixtures.readMedia.bind(fixtures);
        let release!: () => void;
        let arrived!: () => void;
        const waiting = new Promise<void>(r => {
            arrived = r;
        });
        const gate = new Promise<void>(r => {
            release = r;
        });
        const spy = vi.spyOn(fixtures, 'readMedia').mockImplementationOnce(async (media) => {
            const read = await original(media);
            arrived();
            await gate;
            return read;
        });
        const creating = service.create({
            ...video, references: [{
                    assetId: asset.id, role: 'product'
                }]
        }, 'reference-race');
        await waiting;
        await service.review(id, {
            expectedVersion: store.read().items[0]!.version, form: basic, reason: '修订'
        }, 'revision');
        release();
        expect(await creating).toMatchObject({
            ok: false, error: {
                code: 'ASSET_UNAVAILABLE'
            }
        });
        expect(store.read().batches).toHaveLength(1);
        spy.mockRestore();
    });
});
