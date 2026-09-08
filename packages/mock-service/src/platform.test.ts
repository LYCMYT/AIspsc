import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { BrowserRepository } from '../../media-store/src/index';
import { MockPlatform } from './index';
import type { CopyGenerationRequest, Result } from '../../contracts/src/index';

export const request: CopyGenerationRequest = { mode: 'copy', prompt: '展示商品外包装', references: [], count: 1, copy: { language: 'zh-CN', maxCharacters: 100 } };
export function value<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.value; }
export async function setup() {
  let now = 10000;
  const repository = new BrowserRepository(`test-${crypto.randomUUID()}`);
  const options = { repository, clock: () => now, manifest: { version: 1 as const, files: [] } };
  const platform = new MockPlatform(options);
  await platform.ready();
  await platform.resetScenario('empty', true);
  return { platform, options, advance: (ms = 10000) => { now += ms; } };
}
describe('T02/T03 persistent generation', () => {
  it('starts with the granted ledger and validates before reserving', async () => {
    const { platform } = await setup();
    const result = await platform.generation.create({ ...request, prompt: '   ' }, { idempotencyKey: 'bad' });
    expect(result.ok).toBe(false);
    expect((await platform.snapshot()).credits).toMatchObject({ granted: 1286, available: 1286, reserved: 0, spent: 0 });
    expect((await platform.snapshot()).batches).toHaveLength(0);
    expect((await platform.snapshot()).ledger).toHaveLength(1);
  });
  it('atomically deduplicates two tabs and rejects conflicting keys', async () => {
    const { platform, options } = await setup();
    const tab = new MockPlatform(options); await tab.ready();
    const [a, b] = await Promise.all([platform.generation.create(request, { idempotencyKey: 'same' }), tab.generation.create(request, { idempotencyKey: 'same' })]);
    expect(value(a).id).toBe(value(b).id);
    expect(value(a).requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await platform.snapshot()).credits.reserved).toBe(1);
    expect(await tab.generation.create({ ...request, prompt: '不同' }, { idempotencyKey: 'same' })).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });
  it('recovers due tasks after reconstruction and commits once without library insertion', async () => {
    const { platform, options, advance } = await setup();
    const batch = value(await platform.generation.create(request, { idempotencyKey: 'a' }));
    await platform.pump(); advance();
    const reopened = new MockPlatform(options); await reopened.ready();
    await Promise.all([platform.pump(), reopened.pump()]);
    const state = await reopened.snapshot();
    expect(state.items[0]).toMatchObject({ status: 'succeeded', version: 3, reviewState: 'pending', libraryState: 'not_saved' });
    expect(state.items[0]?.text).toContain('演示');
    expect(state.items[0]?.text?.length).toBeLessThanOrEqual(100);
    expect(state.credits).toMatchObject({ available: 1285, reserved: 0, spent: 1 });
    expect(state.assets).toHaveLength(0);
    expect(value(await reopened.generation.get(batch.id)).status).toBe('succeeded');
  });
  it('requires reset confirmation and does not clear another namespace', async () => {
    const { platform } = await setup();
    await platform.generation.create(request, { idempotencyKey: 'x' });
    expect((await platform.resetScenario('empty', false)).ok).toBe(false);
    expect((await platform.snapshot()).items).toHaveLength(1);
    await platform.resetScenario('empty', true);
    expect((await platform.snapshot()).items).toHaveLength(0);
  });
});
