import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CreateGenerationRequest, ScenarioName } from '../../../contracts/src/index.js';
import { FixtureCatalog } from '../fixtures.js';
import { DeterministicFakeProvider } from './fake-provider.js';
import { ProviderOperationError, type ProviderContext } from './port.js';

const video: CreateGenerationRequest = { mode: 'video', prompt: '几何商品演示', count: 1, references: [], video: { durationSeconds: 5, ratio: '16:9', resolution: '720p', audio: false } };
const image: CreateGenerationRequest = { mode: 'image', prompt: '几何商品演示', count: 1, references: [], image: { ratio: '16:9', resolution: '1024' } };
const copy: CreateGenerationRequest = { mode: 'copy', prompt: '几何商品演示', count: 1, references: [], copy: { language: 'zh-CN', maxCharacters: 200 } };
const context = (overrides: Partial<ProviderContext> = {}): ProviderContext => ({ request: video, itemId: 'item-1', itemIndex: 0, attemptId: 'attempt-1', externalIdempotencyKey: 'fake-item-1', submittedAt: '2026-09-13T00:00:00.000Z', now: 1789257600100, scenario: 'success', cancelRequested: false, recovery: false, ...overrides });
const open = async () => new DeterministicFakeProvider(await FixtureCatalog.open(resolve('apps/web/public/demo')));
async function cleanup(root: string, dir: string): Promise<void> {
  const rel = relative(root, dir);
  if (!rel || rel.startsWith('..')) throw Error('cleanup containment');
  await rm(dir, { recursive: true, force: true });
}

describe('deterministic Provider port', () => {
  it('returns queued then running and resumes ready using durable context in a fresh adapter', async () => {
    const provider = await open();
    const ctx = context();
    expect(await provider.create(ctx, ctx)).toEqual({ externalJobId: 'fake-job-item-1', status: 'queued' });
    expect(await provider.get('fake-job-item-1', ctx)).toEqual({ status: 'running' });
    expect(await (await open()).get('fake-job-item-1', { ...ctx, lastPolledAt: ctx.submittedAt })).toMatchObject({ status: 'result_ready', result: { kind: 'fixture' } });
  });
  it.each([video, image, copy])('downloads actual $mode results without altering context', async request => {
    const provider = await open();
    const ctx = context({ request, lastPolledAt: context().submittedAt });
    const before = structuredClone(ctx);
    const poll = await provider.get('fake-job-item-1', ctx);
    expect(poll.status).toBe('result_ready');
    const result = await provider.download(poll.result!, ctx);
    if (request.mode === 'copy') expect(result).toEqual({ kind: 'text', text: `演示文案：${request.prompt}` });
    else {
      expect(result.kind).toBe('media');
      if (result.kind !== 'media') throw Error('expected media');
      expect(result.sha256).toBe(createHash('sha256').update(result.bytes).digest('hex'));
      expect(result.fixtureMedia?.sha256).toBe(result.sha256);
      expect(result.bytes.length).toBeGreaterThan(24);
      expect(result.provenance).toBe('synthetic_provider_simulation');
    }
    expect(ctx).toEqual(before);
  });
  it.each<[ScenarioName, number, string]>([['failure', 0, 'failed'], ['partial_success', 1, 'failed'], ['partial_success', 2, 'result_ready'], ['unknown', 0, 'unknown']])('maps %s item %i only to Provider status', async (scenario, itemIndex, status) => {
    expect(await (await open()).get('fake-job-item-1', context({ scenario, itemIndex, lastPolledAt: context().submittedAt }))).toMatchObject({ status });
  });
  it('confirms fake cancellation but retains the completed cancel race', async () => {
    const provider = await open();
    expect(await provider.get('fake-job-item-1', context({ cancelRequested: true }))).toEqual({ status: 'cancelled' });
    expect(await provider.get('fake-job-item-1', context({ cancelRequested: true, scenario: 'cancel_race', lastPolledAt: context().submittedAt }))).toMatchObject({ status: 'result_ready' });
  });
  it.each<[ScenarioName, string]>([['download_failure', 'PROVIDER_DOWNLOAD_FAILED'], ['storage_failure', 'PROVIDER_STORAGE_FAILED']])('preserves %s until explicit recovery', async (scenario, code) => {
    const provider = await open();
    const ctx = context({ scenario, lastPolledAt: context().submittedAt });
    const poll = await provider.get('fake-job-item-1', ctx);
    await expect(provider.download(poll.result!, ctx)).rejects.toMatchObject({ code, category: 'transient' });
    expect((await provider.download(poll.result!, { ...ctx, recovery: true })).kind).toBe('media');
  });
  it('explicit recovery resolves synthetic unknown', async () => {
    expect(await (await open()).get('fake-job-item-1', context({ scenario: 'unknown', recovery: true, lastPolledAt: context().submittedAt }))).toMatchObject({ status: 'result_ready' });
  });
  it('rejects unknown job and unsupported URL reference with fixed safe errors', async () => {
    const provider = await open();
    await expect(provider.get('secret-job', context())).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
    await expect(provider.download({ kind: 'https', url: 'https://secret.invalid/?token=secret' }, context())).rejects.toMatchObject({ code: 'PROVIDER_INVALID_REQUEST' });
  });
  it('rechecks catalog bytes at download and sanitizes underlying errors', async () => {
    const root = resolve('.cache/provider-port-tests');
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, 'fixture-'));
    try {
      await cp(resolve('apps/web/public/demo'), dir, { recursive: true });
      const catalog = await FixtureCatalog.open(dir);
      const provider = new DeterministicFakeProvider(catalog);
      const ctx = context({ lastPolledAt: context().submittedAt });
      const poll = await provider.get('fake-job-item-1', ctx);
      if (poll.result?.kind !== 'fixture') throw Error('expected fixture');
      const fixtureKey = poll.result.fixtureKey;
      const fixture = catalog.manifest.files.find(f => f.key === fixtureKey)!;
      await writeFile(join(dir, fixture.path), 'secret-invalid-media');
      await expect(provider.download(poll.result, ctx)).rejects.toMatchObject({ message: 'PROVIDER_DOWNLOAD_FAILED', code: 'PROVIDER_DOWNLOAD_FAILED' });
    } finally {
      await cleanup(root, dir);
    }
  });
  it('normalizes untrusted constructor input and never retains raw text or causes', () => {
    const error = new ProviderOperationError('secret-url' as never, 'secret-category' as never, 'secret-certainty' as never);
    expect(error.message).toBe('PROVIDER_OUTCOME_UNKNOWN');
    expect(error.category).toBe('unknown');
    expect(error.submissionCertainty).toBe('unknown');
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(error.cause).toBeUndefined();
  });
});
