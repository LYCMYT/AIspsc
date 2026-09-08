import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { BrowserRepository } from '../../media-store/src/index';
import { MockPlatform } from './index';
import type { DemoManifest, Result } from '../../contracts/src/index';
import { sha256 } from './helpers';
function value<T>(r: Result<T>): T { if (!r.ok) throw new Error(r.error.code); return r.value; }
const source = new Blob([new Uint8Array([0,0,0,16,102,116,121,112,109,112,52,50,0,0,0,0])], { type: 'video/mp4' });
const clip = new Blob([source, 'clip'], { type: 'video/mp4' });
async function setup() {
  const hash = await sha256(source);
  const manifest: DemoManifest = { version: 1, files: [
    { key: 'scene-source', path: '/demo/scene.mp4', sha256: hash, source: 'procedural', mime: 'video/mp4', width: 720, height: 1280, durationMs: 32000, hasAudio: false, fixtureKey: 'scene-source', sceneCutMs: [3000,12000,20000] },
    { key: 'clip-first', path: '/demo/clip.mp4', sha256: await sha256(clip), source: 'procedural', mime: 'video/mp4', width: 720, height: 1280, durationMs: 15000, hasAudio: false, fixtureKey: 'clip-first', sourceSha256: hash, startMs: 0, endMs: 15000 },
  ] };
  const platform = new MockPlatform({ repository: new BrowserRepository(crypto.randomUUID()), manifest, fetcher: async (url) => new Response(String(url).includes('clip') ? clip : source), probe: async () => ({ width: 720, height: 1280, durationMs: 32000 }) });
  await platform.ready(); await platform.resetScenario('empty', true);
  return platform;
}
it('T06 plans unknown video intervals but never fabricates downloadable clips or scene cuts', async () => {
  const platform = await setup();
  const asset = value(await platform.upload(new Blob([source, 'unknown'], { type: 'video/mp4' }), 'unknown.mp4'));
  const split = value(await platform.split.create({ sourceMediaId: asset.mediaFileId!, mode: 'sequential' }));
  expect(split.intervals.map(({ startMs, endMs }) => [startMs,endMs])).toEqual([[0,15000],[15000,30000],[27000,32000]]);
  expect(split.intervals.every(interval => !interval.mediaFileId)).toBe(true);
  expect((await platform.saveClipAsset(split.id, 0)).ok).toBe(false);
  expect(await platform.split.create({ sourceMediaId: asset.mediaFileId!, mode: 'scene' })).toMatchObject({ ok: false, error: { code: 'SCENE_FIXTURE_REQUIRED' } });
});
it('T06 exact source hash and interval link a real clip, and all split operations cost zero', async () => {
  const platform = await setup(); const asset = value(await platform.upload(source, 'source.mp4'));
  const split = value(await platform.split.create({ sourceMediaId: asset.mediaFileId!, mode: 'average' }));
  expect(split.intervals.map(({ startMs,endMs }) => [startMs,endMs])).toEqual([[0,15000],[8500,23500],[17000,32000]]);
  expect(split.intervals[0]?.mediaFileId).toBeTruthy(); expect(split.intervals[1]?.mediaFileId).toBeUndefined();
  const saved = value(await platform.saveClipAsset(split.id, 0));
  expect(saved.source).toBe('fixture');
  expect(value(await platform.saveClipAsset(split.id, 0)).id).toBe(saved.id);
  expect((await platform.snapshot()).credits).toMatchObject({ available: 1286, spent: 0 });
  const scene = value(await platform.split.create({ sourceMediaId: asset.mediaFileId!, mode: 'scene' }));
  expect(scene.intervals[0]).toMatchObject({ startMs: 0, endMs: 5000 });
  expect((await platform.split.create({ sourceMediaId: asset.mediaFileId!, mode: 'manual', manualIntervals: [{ startMs: -1, endMs: 9000 }] })).ok).toBe(false);
});
