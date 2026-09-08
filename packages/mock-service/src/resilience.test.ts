import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { BrowserRepository } from '../../media-store/src/index';
import { MockPlatform } from './index';
import type { BasicMediaReviewInput, CopyGenerationRequest, Result, ScenarioName } from '../../contracts/src/index';
const request: CopyGenerationRequest = { mode: 'copy', prompt: '测试输入', references: [], count: 1, copy: { language: 'zh-CN', maxCharacters: 100 } };
function value<T>(r: Result<T>): T { if (!r.ok) throw new Error(r.error.code); return r.value; }
async function setup(scenario: ScenarioName = 'success') {
  let now = 10000;
  const platform = new MockPlatform({ repository: new BrowserRepository(crypto.randomUUID()), clock: () => now, manifest: { version: 1, files: [] } });
  await platform.ready(); await platform.resetScenario('empty', true); await platform.setScenario(scenario);
  return { platform, advance: () => { now += 10000; } };
}
describe('T07 reliability', () => {
  it('retry is a new atomic intent and cannot repurpose the original idempotency key', async () => {
    const { platform, advance } = await setup('failure');
    const item = value(await platform.generation.create(request, { idempotencyKey: 'a' })).items[0]!;
    advance(); await platform.pump();
    expect(await platform.generation.retry(item.id, { idempotencyKey: 'a' })).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect((await platform.snapshot()).items[0]?.retryOfItemId).toBeUndefined();
    const retry = value(await platform.generation.retry(item.id, { idempotencyKey: 'b' }));
    expect(retry.items[0]?.retryOfItemId).toBe(item.id);
    expect(value(await platform.generation.retry(item.id, { idempotencyKey: 'b' })).id).toBe(retry.id);
  });
  it('partial success settles 2 of 3 without duplicate callbacks affecting ledger', async () => {
    const { platform, advance } = await setup('partial_success');
    const batch = value(await platform.generation.create({ ...request, count: 3 }, { idempotencyKey: 'a' }));
    advance(); await platform.pump(); await platform.pump();
    expect(value(await platform.generation.get(batch.id)).status).toBe('partial_succeeded');
    expect((await platform.snapshot()).credits).toMatchObject({ available: 1284, reserved: 0, spent: 2 });
  });
  it('unknown retains reservation and never retries a submission until explicit reconciliation', async () => {
    const { platform, advance } = await setup('unknown');
    const item = value(await platform.generation.create(request, { idempotencyKey: 'a' })).items[0]!;
    advance(); await platform.pump();
    expect((await platform.snapshot()).items[0]?.status).toBe('needs_reconciliation');
    expect((await platform.generation.retry(item.id, { idempotencyKey: 'b' })).ok).toBe(false);
    await platform.pump(); expect((await platform.snapshot()).attempts).toHaveLength(1);
    expect((await platform.snapshot()).credits.reserved).toBe(1);
    value(await platform.resolveUnknown(item.id, 'success')); await platform.pump();
    expect((await platform.snapshot()).reconciliations[0]).toMatchObject({ itemId: item.id, outcome: 'success', evidence: '重建测试样例：人工触发确定性模拟对账结果' });
    expect((await platform.snapshot()).credits.spent).toBe(1);
    expect((await platform.snapshot()).attempts).toHaveLength(1);
  });
  it('queued cancellation releases once and cancel race converges to paid success', async () => {
    const { platform, advance } = await setup('cancel_race');
    const a = value(await platform.generation.create(request, { idempotencyKey: 'a' })).items[0]!;
    value(await platform.generation.cancel(a.id)); value(await platform.generation.cancel(a.id));
    const b = value(await platform.generation.create(request, { idempotencyKey: 'b' })).items[0]!;
    await platform.pump(); value(await platform.generation.cancel(b.id)); advance(); await platform.pump();
    expect((await platform.snapshot()).items.map(item => item.status)).toEqual(['cancelled', 'succeeded']);
    expect((await platform.snapshot()).credits).toMatchObject({ spent: 1, reserved: 0, available: 1285 });
  });
  it('download retry fetches existing output without another generation or reservation', async () => {
    const { platform, advance } = await setup('download_failure');
    const item = value(await platform.generation.create(request, { idempotencyKey: 'a' })).items[0]!;
    advance(); await platform.pump(); expect((await platform.snapshot()).items[0]?.status).toBe('finalizing');
    value(await platform.retryDownload(item.id)); await platform.pump();
    expect((await platform.snapshot()).credits.spent).toBe(1);
    expect((await platform.snapshot()).attempts).toHaveLength(1);
  });
});
describe('T04 immutable review and deliberate library insertion', () => {
  const form: BasicMediaReviewInput = { rubricVersion: 'basic-media-review-v1', humanDecision: 'approved', readable: true, followsTask: true };
  it('approval never auto saves; duplicate save is idempotent; revision rejection invalidates asset', async () => {
    const { platform, advance } = await setup();
    const item = value(await platform.generation.create(request, { idempotencyKey: 'a' })).items[0]!;
    expect((await platform.asset.saveApprovedOutput(item.id, 'unknown')).ok).toBe(false);
    advance(); await platform.pump();
    const review = value(await platform.review.save(item.id, form.rubricVersion, form));
    expect(value(await platform.review.save(item.id, form.rubricVersion, form)).id).toBe(review.id);
    expect((await platform.snapshot()).assets).toHaveLength(0);
    const asset = value(await platform.asset.saveApprovedOutput(item.id, review.id));
    expect(value(await platform.asset.saveApprovedOutput(item.id, review.id)).id).toBe(asset.id);
    const rejected = { ...form, humanDecision: 'rejected' as const, reason: '文案不符合要求' };
    expect((await platform.review.save(item.id, rejected.rubricVersion, rejected)).ok).toBe(false);
    value(await platform.saveReviewRevision(item.id, rejected, '重新检查后发现不符'));
    expect((await platform.snapshot()).evaluations).toHaveLength(2);
    expect((await platform.snapshot()).assets[0]?.reviewValidity).toBe('review_invalidated');
    expect((await platform.asset.saveApprovedOutput(item.id, review.id)).ok).toBe(false);
  });
});
