import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { BrowserRepository } from '../../media-store/src/index';
import { MockPlatform } from './index';
import type { DemoManifest, Result } from '../../contracts/src/index';
import { sha256 } from './helpers';
function value<T>(r: Result<T>): T { if (!r.ok) throw new Error(r.error.code); return r.value; }
const png = new Blob([new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0])], { type: 'image/png' });
async function setup() {
  const hash = await sha256(png);
  const manifest: DemoManifest = { version: 1, files: [{ key: 'image-9x16-1024', path: '/demo/image.png', sha256: hash, source: 'procedural', mime: 'image/png', width: 576, height: 1024, hasAudio: false, fixtureKey: 'geometry-image' }] };
  const platform = new MockPlatform({ repository: new BrowserRepository(crypto.randomUUID()), manifest, fetcher: async () => new Response(png), probe: async () => ({ width: 576, height: 1024 }) });
  await platform.ready(); await platform.resetScenario('empty', true);
  return { platform, manifest };
}
describe('T08 uploaded file provenance and actual metadata', () => {
  it('rejects mismatched MIME/header before decoding', async () => {
    const { platform } = await setup();
    expect(await platform.upload(new Blob(['text pretending image'], { type: 'image/png' }), 'fake.png')).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_MEDIA' } });
    expect((await platform.snapshot()).assets).toHaveLength(0);
  });
  it('stores actual file metadata and recognizes fixtures only by matching SHA256', async () => {
    const { platform } = await setup();
    const fixture = value(await platform.upload(png, 'changed-name.png'));
    expect(fixture).toMatchObject({ source: 'upload', isDemo: true });
    const metadata = (await platform.snapshot()).mediaMetadata[0];
    expect(metadata).toMatchObject({ width: 576, height: 1024, fixtureKey: 'geometry-image' });
    const unknown = value(await platform.upload(new Blob([png, 'different'], { type: 'image/png' }), 'other.png'));
    expect(unknown.isDemo).toBe(false);
    expect(unknown.tags).toEqual([]);
    expect((await platform.snapshot()).credits.spent).toBe(0);
  });
  it('missing file is explicit and restore requires original hash', async () => {
    const { platform } = await setup();
    const asset = value(await platform.upload(png, 'original.png'));
    await platform.media.remove(asset.mediaFileId!);
    expect((await platform.snapshot()).assets[0]?.availability).toBe('missing');
    expect((await platform.restore(asset.id, new Blob([png, 'different'], { type: 'image/png' }))).ok).toBe(false);
    expect(value(await platform.restore(asset.id, png)).availability).toBe('available');
    expect(value(await platform.media.get(asset.mediaFileId!)).blob.size).toBe(png.size);
  });
  it('returns the original idempotent request after its reference file becomes unavailable', async () => {
    const { platform } = await setup(); const asset = value(await platform.upload(png, 'reference.png'));
    const request = { mode: 'image', prompt: '演示', references: [{ assetId: asset.id, role: 'product' }], count: 1, image: { ratio: '9:16', resolution: '1024' } };
    const batch = value(await platform.generation.create(request, { idempotencyKey: 'a' }));
    await platform.media.remove(asset.mediaFileId!); await platform.snapshot();
    expect(value(await platform.generation.create(request, { idempotencyKey: 'a' })).id).toBe(batch.id);
    expect((await platform.generation.create(request, { idempotencyKey: 'new' })).ok).toBe(false);
  });
});
