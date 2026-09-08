import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { BrowserRepository } from '../../media-store/src/index';
import { MockPlatform } from './index';
import { sha256 } from './helpers';
import type { Result } from '../../contracts/src/index';

function value<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.value; }
async function controlledScenario() {
  let now = 1000;
  const blob = new Blob(['controlled output']);
  const options = { repository: new BrowserRepository(crypto.randomUUID()), clock: () => now, manifest: { version: 1 as const, files: [{ key: 'video-10-9x16-720p-silent', fixtureKey: 'video-10-9x16-720p-silent', path: 'video.mp4', sha256: await sha256(blob), source: 'test', mime: 'video/mp4', width: 720, height: 1280, durationMs: 10000, hasAudio: false }] }, fetcher: async () => new Response(blob) };
  const platform = new MockPlatform(options); await platform.ready();
  return { platform, options, advance: (ms: number) => { now += ms; } };
}

it('T07 cancel-race preset leaves a persistent human cancellation window then settles the existing success', async () => {
  const { platform, options, advance } = await controlledScenario();
  value(await platform.resetScenario('cancel_race', true));
  expect((await platform.snapshot()).items[0]?.status).toBe('running');
  advance(10000);
  const reopened = new MockPlatform(options); await reopened.ready(); await reopened.pump();
  const item = (await reopened.snapshot()).items[0]!;
  expect(item.status).toBe('running');
  expect(value(await reopened.generation.cancel(item.id)).status).toBe('cancel_requested');
  await reopened.pump();
  expect((await reopened.snapshot()).items[0]?.status).toBe('cancel_requested');
  advance(1200); await reopened.pump();
  expect((await reopened.snapshot()).items[0]).toMatchObject({ id: item.id, status: 'succeeded' });
  expect((await reopened.snapshot()).credits).toMatchObject({ available: 1285, reserved: 0, spent: 1 });
  expect((await reopened.snapshot()).attempts).toHaveLength(1);
});

it('T07 cancel-race preset also settles deterministically when the user does not cancel', async () => {
  const { platform, advance } = await controlledScenario();
  value(await platform.resetScenario('cancel_race', true));
  advance(29999); await platform.pump();
  expect((await platform.snapshot()).items[0]?.status).toBe('running');
  advance(1); await platform.pump();
  expect((await platform.snapshot()).items[0]?.status).toBe('succeeded');
});

it('T07 unknown preset stays recoverable until the existing UI reconciliation action is invoked', async () => {
  const { platform, advance } = await controlledScenario();
  value(await platform.resetScenario('unknown', true));
  const item = (await platform.snapshot()).items[0]!;
  expect(item.status).toBe('needs_reconciliation');
  advance(60000); await platform.pump();
  expect((await platform.snapshot()).credits).toMatchObject({ reserved: 1, spent: 0 });
  value(await platform.resolveUnknown(item.id, 'success')); await platform.pump();
  expect((await platform.snapshot()).items[0]?.status).toBe('succeeded');
  expect((await platform.snapshot()).attempts).toHaveLength(1);
});

it.each(['download_failure', 'storage_failure'] as const)('T07 %s preset remains finalizing until the existing UI download retry action', async scenario => {
  const { platform, advance } = await controlledScenario();
  value(await platform.resetScenario(scenario, true));
  const item = (await platform.snapshot()).items[0]!;
  expect(item.status).toBe('finalizing');
  advance(60000); await platform.pump();
  expect((await platform.snapshot()).items[0]?.status).toBe('finalizing');
  expect((await platform.snapshot()).credits).toMatchObject({ reserved: 1, spent: 0 });
  value(await platform.retryDownload(item.id)); await platform.pump();
  const completed = (await platform.snapshot()).items[0]!;
  expect(completed.status).toBe('succeeded');
  expect(value(await platform.media.get(completed.resultMediaId!)).blob.size).toBeGreaterThan(0);
  expect((await platform.snapshot()).attempts).toHaveLength(1);
  expect((await platform.snapshot()).credits).toMatchObject({ reserved: 0, spent: 1 });
});
it('T02 scenario reset uses fixture blobs and a real success pipeline, keeps reviews pending', async () => {
  const blob = new Blob(['controlled fixture']);
  const platform = new MockPlatform({ repository: new BrowserRepository(crypto.randomUUID()), manifest: { version: 1, files: [{ key: 'image-9x16-1024', fixtureKey: 'image-9x16-1024', path: 'image.png', sha256: await sha256(blob), source: 'procedural', mime: 'image/png', width: 576, height: 1024, hasAudio: false }] }, fetcher: async () => new Response(blob) });
  await platform.ready();
  expect((await platform.snapshot()).assets).toHaveLength(1);
  expect((await platform.snapshot()).assets[0]?.source).toBe('fixture');
  expect((await platform.resetScenario('success', true)).ok).toBe(true);
  expect((await platform.snapshot()).items[0]).toMatchObject({ status: 'succeeded', reviewState: 'pending' });
  expect((await platform.snapshot()).credits.spent).toBe(1);
  expect((await platform.snapshot()).assets.every(asset => asset.source === 'fixture')).toBe(true);
  await platform.resetScenario('processing', true);
  expect((await platform.snapshot()).items[0]?.status).toBe('running');
  const asset = await platform.loadFixture('image-9x16-1024');
  expect(asset.ok).toBe(true);
  expect(await platform.loadFixture('image-9x16-1024')).toEqual(asset);
  expect((await platform.snapshot()).items).toHaveLength(1);
});
