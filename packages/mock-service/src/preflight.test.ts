import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { BrowserRepository } from '../../media-store/src/index';
import { MockPlatform } from './index';
import { sha256 } from './helpers';
import type { EvaluationDimensionId, Result, VideoReviewInput } from '../../contracts/src/index';
function value<T>(r: Result<T>): T { if (!r.ok) throw new Error(r.error.code); return r.value; }
const form: VideoReviewInput = { rubricVersion: 'rubric-v2-rebuild', score: 10, applicability: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`Q${String(i + 1).padStart(2, '0')}`, { applicable: true }])) as Record<EvaluationDimensionId, { applicable: boolean }>, issueTags: [], hardFailures: [], technicalErrors: [] };
it('T04 derives technical failures from persisted media, never trusts a cleared UI technicalErrors list', async () => {
  let time = 1000; const blob = new Blob(['fixture test input']);
  const platform = new MockPlatform({ repository: new BrowserRepository(crypto.randomUUID()), clock: () => time, manifest: { version: 1, files: [{ key: 'video-10-9x16-720p-audio', fixtureKey: 'incorrect-metadata', path: 'video.mp4', source: 'test', mime: 'video/mp4', width: 640, height: 480, durationMs: 16000, hasAudio: false, sha256: await sha256(blob) }] }, fetcher: async () => new Response(blob) });
  await platform.ready();
  const batch = value(await platform.generation.create({ mode: 'video', prompt: '演示', references: [], count: 1, video: { durationSeconds: 10, ratio: '9:16', resolution: '720p', audio: true } }, { idempotencyKey: 'a' }));
  time += 10000; await platform.pump();
  const evaluation = value(await platform.review.save(batch.items[0]!.id, form.rubricVersion, form));
  expect(evaluation.decision).toBe('rejected');
  expect(evaluation.technicalErrors).toEqual(expect.arrayContaining(['TECH_DURATION','TECH_RESOLUTION','TECH_AUDIO']));
  expect((await platform.asset.saveApprovedOutput(batch.items[0]!.id, evaluation.id)).ok).toBe(false);
});
it('T05 no compatible mode or unsupported combination creates no reservation', async () => {
  const platform = new MockPlatform({ repository: new BrowserRepository(crypto.randomUUID()), manifest: { version: 1, files: [] } }); await platform.ready();
  const result = await platform.generation.create({ mode: 'image', prompt: '演示', references: [], count: 1, image: { ratio: '9:16', resolution: '8192' } }, { idempotencyKey: 'a' });
  expect(result).toMatchObject({ ok: false, error: { code: 'NO_COMPATIBLE_MODEL' } });
  expect((await platform.snapshot()).credits.reserved).toBe(0);
});
