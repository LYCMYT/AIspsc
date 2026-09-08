import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { BrowserRepository } from '../../media-store/src/index';
import { MockPlatform } from './index';
import { sha256 } from './helpers';
import type { DemoManifest } from '../../contracts/src/index';
async function manifest(): Promise<DemoManifest> {
  return { version: 1, files: [{ key: 'image-1x1-1024', fixtureKey: 'image-1x1-1024', path: 'image.png', sha256: await sha256(new Blob(['image'])), source: 'test', mime: 'image/png', width: 1024, height: 1024, hasAudio: false }] };
}
it('T02 default browser fetch preserves the global receiver', async () => {
  vi.stubGlobal('fetch', function(this: unknown) { if (this !== globalThis) throw new TypeError('Illegal invocation'); return Promise.resolve(new Response(new Blob(['image']))); });
  try {
    const platform = new MockPlatform({ repository: new BrowserRepository(crypto.randomUUID()), manifest: await manifest() });
    await expect(platform.ready()).resolves.toBeUndefined();
    expect((await platform.snapshot()).assets).toHaveLength(1);
  } finally { vi.unstubAllGlobals(); }
});
it('T02 failed startup retries seeding, while completed startup never reseeds deleted assets', async () => {
  let online = false;
  const options = { repository: new BrowserRepository(crypto.randomUUID()), manifest: await manifest(), fetcher: async () => { if (!online) throw new TypeError('offline'); return new Response(new Blob(['image'])); } };
  const platform = new MockPlatform(options);
  await expect(platform.ready()).rejects.toThrow();
  online = true; await expect(platform.ready()).resolves.toBeUndefined();
  const asset = (await platform.snapshot()).assets[0]!;
  await platform.deleteAsset(asset.id);
  const reopened = new MockPlatform(options); await reopened.ready();
  expect((await reopened.snapshot()).assets.filter(asset => !asset.archivedAt)).toHaveLength(0);
});
