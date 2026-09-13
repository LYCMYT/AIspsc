import type { Asset, CreateGenerationRequest, DemoSnapshot, Evaluation, FixtureLoadInput, GenerationBatchSnapshot, GenerationItem, GenerationState, ItemReconcileInput, ItemReviewInput, ItemSaveInput, ItemVersionInput, Result, ScenarioInput } from '../../contracts/src/index.js';
import { canonicalJson, validateHttpBody } from '../../contracts/src/index.js';
import { checkedItem, createBatch, failure, iso, nextId, outputFixtureKey, projectGenerationSnapshot } from '../../domain/src/generation-state.js';
import { retryItem } from '../../domain/src/generation-commands.js';
import { cancelProviderItem, reconcileProviderItem, retryProviderDownload } from '../../domain/src/provider-commands.js';
import { saveItemAsset, saveItemReview } from '../../domain/src/generation-review.js';
import { validateGenerationRequest } from '../../domain/src/validation.js';
import { FixtureCatalog, sha256 } from './fixtures.js';
import { GenerationStore } from './store.js';
import type { ControlledServicePolicy } from './provider/authorized-session.js';
type Work<T> = (state: GenerationState) => Result<T>;
export class GenerationApiService {
    constructor(private readonly store: GenerationStore, private readonly fixtures: FixtureCatalog, private readonly clock: () => number = Date.now, private readonly mediaReader: Pick<FixtureCatalog, 'readMedia'> = fixtures, private readonly controlledPolicy?: ControlledServicePolicy) {
    }
    snapshot(): DemoSnapshot {
        return projectGenerationSnapshot(this.store.read());
    }
    private async command<T>(scope: string, key: string, input: unknown, prepare: (state: GenerationState, hash: string) => Promise<Result<Work<T>>>): Promise<Result<T>> {
        if (this.controlledPolicy && !this.controlledPolicy.command(scope)) return failure('FORBIDDEN', '本次受控执行不允许此操作');
        if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(key))
            return failure('INVALID_PARAMETERS', '必须提供有效幂等标识');
        let hash: string;
        try {
            hash = sha256(canonicalJson(input));
        }
        catch {
            return failure('INVALID_PARAMETERS', '请求必须是 JSON 数据');
        }
        const memoKey = canonicalJson([scope, key]);
        const replay = (state: GenerationState): Result<T> | undefined => {
            const prior = state.memo[memoKey];
            return prior ? prior.hash === hash ? {
                ok: true, value: structuredClone(prior.value) as T
            } : failure('IDEMPOTENCY_CONFLICT', '相同幂等标识的请求参数不同') : undefined;
        };
        try {
            const state = this.store.read();
            const prior = replay(state);
            if (prior)
                return prior;
            const prepared = await prepare(state, hash);
            if (!prepared.ok)
                return prepared;
            return await this.store.transact(current => {
                if (this.controlledPolicy && !this.controlledPolicy.command(scope)) return failure('FORBIDDEN', '本次受控执行不允许此操作');
                const prior = replay(current);
                if (prior)
                    return prior;
                const result = prepared.value(current);
                if (result.ok)
                    current.memo[memoKey] = {
                        hash, value: structuredClone(result.value)
                    };
                return result;
            });
        }
        catch (error) {
            return (error as Error).message === 'MEDIA_UNAVAILABLE' ? failure('MEDIA_UNAVAILABLE', '演示文件不可用或摘要校验失败') : failure('STORAGE_UNAVAILABLE', '本地存储不可用');
        }
    }
    private async verifyInput(state: GenerationState, input: unknown): Promise<Result<{
        request: CreateGenerationRequest;
        check: (state: GenerationState) => Result<null>;
    }>> {
        const validated = validateGenerationRequest(input, state.assets.map(a => ({
            ...a, availability: a.archivedAt || a.reviewValidity === 'review_invalidated' ? 'unavailable' as const : a.availability
        })), 'demo');
        if (!validated.ok)
            return validated;
        const request = validated.value;
        const key = outputFixtureKey(request);
        if (key) {
            if (!this.fixtures.manifest.files.some(f => f.key === key))
                return failure('NO_COMPATIBLE_MODEL', '没有支持当前参数组合的演示文件');
            await this.fixtures.readFixture(key);
        }
        const checked: Array<{
            assetId: string;
            asset: string;
            media?: string;
        }> = [];
        for (const reference of request.references) {
            const asset = state.assets.find(a => a.id === reference.assetId)!;
            if (asset.mediaFileId) {
                const media = state.mediaMetadata.find(m => m.id === asset.mediaFileId);
                if (!media)
                    return failure('MEDIA_UNAVAILABLE', '引用文件不可用');
                await this.mediaReader.readMedia(media);
                checked.push({
                    assetId: asset.id, asset: canonicalJson(asset), media: canonicalJson(media)
                });
            }
            else
                checked.push({
                    assetId: asset.id, asset: canonicalJson(asset)
                });
            if (asset.source === 'generated') {
                const evaluation = state.evaluations.find(e => e.id === asset.reviewId);
                const recorded = state.reviewForms[asset.reviewId ?? ''];
                const digest = asset.mediaFileId ? state.mediaMetadata.find(m => m.id === asset.mediaFileId)?.sha256 : sha256(asset.text ?? '');
                if (!evaluation || evaluation.decision !== 'approved' || !recorded || recorded.resultSha256 !== digest)
                    return failure('ASSET_UNAVAILABLE', '引用资产审核摘要无效');
            }
        }
        return {
            ok: true, value: {
                request, check: current => {
                    for (const c of checked) {
                        const asset = current.assets.find(a => a.id === c.assetId);
                        if (!asset || canonicalJson(asset) !== c.asset)
                            return failure('ASSET_UNAVAILABLE', '引用资产已变化');
                        if (c.media) {
                            const media = current.mediaMetadata.find(m => m.id === asset.mediaFileId);
                            if (!media || canonicalJson(media) !== c.media)
                                return failure('MEDIA_UNAVAILABLE', '引用文件已变化');
                        }
                    }
                    return {
                        ok: true, value: null
                    };
                }
            }
        };
    }
    create(input: unknown, key: string): Promise<Result<GenerationBatchSnapshot>> {
        let normalized: unknown;
        try {
            canonicalJson(input);
            normalized = structuredClone(input);
            if (normalized && typeof normalized === 'object' && 'prompt' in normalized && typeof normalized.prompt === 'string')
                normalized.prompt = normalized.prompt.trim();
        }
        catch {
            return Promise.resolve(failure('INVALID_PARAMETERS', '请求必须是 JSON 数据'));
        }
        return this.command('create', key, normalized, async (state, hash) => {
            const verified = await this.verifyInput(state, normalized);
            if (!verified.ok)
                return verified;
            return {
                ok: true, value: current => {
                    if (this.controlledPolicy && !this.controlledPolicy.create(current, input, key)) return failure('FORBIDDEN', '本次受控执行仅允许原始请求');
                    const checked = verified.value.check(current);
                    if (!checked.ok)
                        return checked;
                    return createBatch(current, verified.value.request, key, hash, {
                        now: this.clock(), manifest: this.fixtures.manifest
                    });
                }
            };
        });
    }
    cancel(id: string, input: ItemVersionInput, key: string): Promise<Result<GenerationItem>> {
        return this.command(`cancel/${id}`, key, input, async () => {
            const v = validateHttpBody('version', input);
            return v.ok ? {
                ok: true, value: s => cancelProviderItem(s, id, v.value, this.clock())
            } : v;
        });
    }
    retry(id: string, input: ItemVersionInput, key: string): Promise<Result<GenerationBatchSnapshot>> {
        return this.command(`retry/${id}`, key, {
            id, ...input
        }, async (state, hash) => {
            const v = validateHttpBody('version', input);
            if (!v.ok)
                return v;
            const item = checkedItem(state, id, input);
            if (!item.ok)
                return item;
            const batch = state.batches.find(b => b.id === item.value.batchId)!;
            const verified = await this.verifyInput(state, {
                ...batch.requestSnapshot, count: 1
            });
            if (!verified.ok)
                return verified;
            return {
                ok: true, value: current => {
                    const checked = verified.value.check(current);
                    if (!checked.ok)
                        return checked;
                    return retryItem(current, id, input, key, hash, {
                        now: this.clock(), manifest: this.fixtures.manifest
                    });
                }
            };
        });
    }
    reconcile(id: string, input: ItemReconcileInput, key: string): Promise<Result<GenerationItem>> {
        return this.command(`reconcile/${id}`, key, input, async () => {
            const v = validateHttpBody('reconcile', input);
            return v.ok ? {
                ok: true, value: s => reconcileProviderItem(s, id, v.value, this.clock())
            } : v;
        });
    }
    retryDownload(id: string, input: ItemVersionInput, key: string): Promise<Result<GenerationItem>> {
        return this.command(`retry-download/${id}`, key, input, async () => {
            const v = validateHttpBody('version', input);
            return v.ok ? {
                ok: true, value: s => retryProviderDownload(s, id, v.value, this.clock())
            } : v;
        });
    }
    private async resultDigest(state: GenerationState, id: string, input: ItemVersionInput): Promise<Result<{
        digest: string;
        check: (s: GenerationState) => Result<null>;
    }>> {
        const checked = checkedItem(state, id, input);
        if (!checked.ok)
            return checked;
        const item = checked.value;
        if (item.status !== 'succeeded' || !item.resultAvailable)
            return failure('ITEM_NOT_READY', '当前产物不可用');
        let digest: string;
        let metadata: string | undefined;
        if (item.mode === 'copy')
            digest = sha256(item.text!);
        else {
            const media = state.mediaMetadata.find(m => m.id === item.resultMediaId);
            if (!media)
                return failure('MEDIA_UNAVAILABLE', '演示产物不可用');
            const verified = await this.mediaReader.readMedia(media);
            digest = verified.media.sha256;
            metadata = canonicalJson(media);
        }
        return {
            ok: true, value: {
                digest, check: current => {
                    const latest = checkedItem(current, id, input);
                    if (!latest.ok)
                        return latest;
                    if (item.mode === 'copy') {
                        if (sha256(latest.value.text ?? '') !== digest)
                            return failure('MEDIA_UNAVAILABLE', '产物已变化');
                    }
                    else {
                        const media = current.mediaMetadata.find(m => m.id === latest.value.resultMediaId);
                        if (!media || canonicalJson(media) !== metadata)
                            return failure('MEDIA_UNAVAILABLE', '产物已变化');
                    }
                    return {
                        ok: true, value: null
                    };
                }
            }
        };
    }
    review(id: string, input: ItemReviewInput, key: string): Promise<Result<Evaluation>> {
        return this.command(`review/${id}`, key, input, async (state) => {
            const v = validateHttpBody('review', input);
            if (!v.ok)
                return v;
            const verified = await this.resultDigest(state, id, input);
            if (!verified.ok)
                return verified;
            return {
                ok: true, value: s => {
                    const c = verified.value.check(s);
                    return c.ok ? saveItemReview(s, id, input, verified.value.digest, this.clock()) : c;
                }
            };
        });
    }
    saveAsset(id: string, input: ItemSaveInput, key: string): Promise<Result<Asset>> {
        return this.command(`asset/${id}`, key, input, async (state) => {
            const v = validateHttpBody('save', input);
            if (!v.ok)
                return v;
            const verified = await this.resultDigest(state, id, input);
            if (!verified.ok)
                return verified;
            return {
                ok: true, value: s => {
                    const c = verified.value.check(s);
                    return c.ok ? saveItemAsset(s, id, input, verified.value.digest, this.clock()) : c;
                }
            };
        });
    }
    loadFixture(input: FixtureLoadInput, key: string): Promise<Result<Asset>> {
        return this.command('fixture', key, input, async () => {
            const v = validateHttpBody('fixture', input);
            if (!v.ok)
                return v;
            const { media } = await this.fixtures.readFixture(input.key);
            return {
                ok: true, value: s => {
                    if (!s.mediaMetadata.some(m => m.id === media.id))
                        s.mediaMetadata.push(media);
                    const asset: Asset = {
                        id: nextId(s, 'asset'), workspaceId: 'demo', mediaFileId: media.id, mediaType: media.mediaType, availability: 'available', source: 'fixture', title: '演示素材', tags: [], createdAt: iso(this.clock()), isDemo: true
                    };
                    s.assets.push(asset);
                    return {
                        ok: true, value: asset
                    };
                }
            };
        });
    }
    setScenario(input: ScenarioInput, key: string): Promise<Result<null>> {
        return this.command('scenario', key, input, async () => {
            const v = validateHttpBody('scenario', input);
            return v.ok ? {
                ok: true, value: s => {
                    s.scenario = v.value.name;
                    return {
                        ok: true, value: null
                    };
                }
            } : v;
        });
    }
}
