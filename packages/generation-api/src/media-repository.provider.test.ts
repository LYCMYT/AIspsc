import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { FixtureCatalog } from './fixtures.js';
import { GenerationMediaRepository } from './media-repository.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let root: string, bytes: Buffer, repository: GenerationMediaRepository;
const reference = { kind: 'https' as const, url: 'https://platform-outputs.agnes-ai.space/synthetic.mp4?signature=ephemeral', providerReportedSeconds: 5, providerReportedSize: '1280x720' };
const target = { durationSeconds: 5, ratio: '16:9' as const, resolution: '720p' as const, audio: false };
beforeAll(async () => {
  await mkdir(resolve('.cache/provider-media-tests'), { recursive: true });
  root = await mkdtemp(resolve('.cache/provider-media-tests/provider-media-'));
  const input = join(root, 'synthetic.mp4');
  await promisify(execFile)('ffmpeg', ['-v','error','-f','lavfi','-i','color=c=blue:s=1280x704:r=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-frames:v','121','-t','5.041667','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac',input], { windowsHide: true });
  bytes = await readFile(input);
  repository = await GenerationMediaRepository.open(join(root, 'state'), await FixtureCatalog.open(resolve('apps/web/public/demo')));
}, 30000);
afterAll(async () => {
  if (!root) return;
  const rel = relative(resolve('.cache/provider-media-tests'), root);
  if (!rel || rel.startsWith('..')) throw Error('cleanup containment');
  await rm(root, { recursive: true, force: true });
});
describe('private synthetic provider raw and derivative media', () => {
  it('preserves the full accepted 200-character external job identifier', async () => {
    const job = 'j'.repeat(200);
    const raw = await repository.captureRaw({ bytes, sha256: sha(bytes) }, reference, 'agnes-simulated', job, 1000);
    expect(raw.externalJobId).toBe(job);
    await expect(repository.captureRaw({ bytes, sha256: sha(bytes) }, reference, 'agnes-simulated', job + 'j', 1000)).rejects.toThrow('MEDIA_UNAVAILABLE');
  });
  it('rejects corrupted or oversized persisted delivery evidence and unbound reads', async () => {
    const raw = await repository.captureRaw({ bytes, sha256: sha(bytes) }, reference, 'agnes-simulated', 'manifest-job', 1000);
    const derived = await repository.finalize(raw, target);
    const path = join(root, 'state', derived.media.objectKey!.replace('result.mp4', 'delivery.json'));
    const original = await readFile(path, 'utf8');
    type MutableReport = { source: { sha256: string }; policy: unknown; result: { media: { frames: number } }; padding?: string };
    for (const corrupt of [
      (r: MutableReport) => { r.source.sha256 = '0'.repeat(64); },
      (r: MutableReport) => { r.policy = { ...target, durationSeconds: 10, audio: true }; },
      (r: MutableReport) => { r.result.media.frames = 1; },
      (r: MutableReport) => { r.padding = 'x'.repeat(1024 * 1024); },
    ]) {
      const report = JSON.parse(original);
      corrupt(report);
      await writeFile(path, JSON.stringify(report));
      await expect(repository.readMedia(derived.media, derived)).rejects.toThrow('MEDIA_UNAVAILABLE');
    }
    await writeFile(path, original);
    await expect(repository.readMedia(derived.media)).rejects.toThrow('MEDIA_UNAVAILABLE');
  }, 30000);
  it('preserves actual raw facts before real delivery-v1 normalization', async () => {
    const raw = await repository.captureRaw({ bytes, sha256: sha(bytes) }, reference, 'agnes-simulated', 'job-1', 1000);
    expect(raw).toMatchObject({ rawActualWidth: 1280, rawActualHeight: 704, rawHasAudio: true, rawFps: 24, rawSha256: sha(bytes), rawDecodeVerified: true });
    expect(raw.rawDuration).toBeCloseTo(5.041667, 5);
    expect(JSON.stringify(raw)).not.toMatch(/signature|ephemeral|https?:|synthetic.mp4/);
    const derived = await repository.finalize(raw, target);
    expect(derived.media).toMatchObject({ width: 1280, height: 720, durationMs: 5000, hasAudio: false, isDemo: true });
    expect(derived.sourceSha256).toBe(raw.rawSha256);
    expect(derived.media.sha256).not.toBe(raw.rawSha256);
    expect(await readFile(join(root, 'state', raw.rawObjectKey))).toEqual(bytes);
    const actual = await repository.readMedia(derived.media, derived);
    expect(sha(actual.bytes)).toBe(derived.media.sha256);
    const reopened = await GenerationMediaRepository.open(join(root, 'state'), await FixtureCatalog.open(resolve('apps/web/public/demo')));
    expect((await reopened.readMedia(derived.media, derived)).bytes).toEqual(actual.bytes);
  }, 30000);
  it('retains raw after postprocess failure and retries in a new operation directory', async () => {
    const raw = await repository.captureRaw({ bytes, sha256: sha(bytes) }, reference, 'agnes-simulated', 'job-2', 1000);
    await expect(repository.finalize(raw, { ...target, durationSeconds: 10 })).rejects.toThrow();
    expect(await readFile(join(root, 'state', raw.rawObjectKey))).toEqual(bytes);
    const first = await repository.finalize(raw, target);
    const second = await repository.finalize(raw, target);
    expect(first.media.objectKey).not.toBe(second.media.objectKey);
    expect(first.sourceSha256).toBe(second.sourceSha256);
  }, 30000);
  it('rejects wrong hash, malformed MP4, untrusted host and post-persistence tampering', async () => {
    await expect(repository.captureRaw({ bytes, sha256: 'a'.repeat(64) }, reference, 'agnes-simulated', 'job-3', 1000)).rejects.toThrow('MEDIA_UNAVAILABLE');
    const malformed = Buffer.from('not-a-valid-mp4');
    await expect(repository.captureRaw({ bytes: malformed, sha256: sha(malformed) }, reference, 'agnes-simulated', 'job-3', 1000)).rejects.toThrow('MEDIA_UNAVAILABLE');
    const corruptedEncoding = Buffer.from(bytes);
    let corruptedPayload = false;
    for (let offset = 0; offset + 8 <= corruptedEncoding.length;) {
      const size = corruptedEncoding.readUInt32BE(offset);
      if (size < 8 || offset + size > corruptedEncoding.length) throw Error('invalid synthetic box');
      if (corruptedEncoding.toString('ascii', offset + 4, offset + 8) === 'mdat') {
        corruptedEncoding.fill(0, offset + 8, offset + size);
        corruptedPayload = true;
      }
      offset += size;
    }
    expect(corruptedPayload).toBe(true);
    expect(corruptedEncoding.subarray(0, 32)).toEqual(bytes.subarray(0, 32));
    await expect(repository.captureRaw({ bytes: corruptedEncoding, sha256: sha(corruptedEncoding) }, reference, 'agnes-simulated', 'job-3', 1000)).rejects.toThrow('MEDIA_UNAVAILABLE');
    await expect(repository.captureRaw({ bytes, sha256: sha(bytes) }, { ...reference, url: 'https://example.com/raw.mp4' }, 'agnes-simulated', 'job-3', 1000)).rejects.toThrow('MEDIA_UNAVAILABLE');
    const raw = await repository.captureRaw({ bytes, sha256: sha(bytes) }, reference, 'agnes-simulated', 'job-3', 1000);
    await writeFile(join(root, 'state', raw.rawObjectKey), 'tampered');
    await expect(repository.finalize(raw, target)).rejects.toThrow('MEDIA_UNAVAILABLE');
  }, 30000);
  it('rejects traversal and metadata tampering while retaining the fixture reader', async () => {
    const fixtures = await FixtureCatalog.open(resolve('apps/web/public/demo'));
    const fixture = await fixtures.readFixture('video-5-16x9-720p-silent');
    expect((await repository.readMedia(fixture.media)).bytes).toEqual(fixture.bytes);
    await expect(repository.readMedia({ ...fixture.media, objectKey: '../synthetic.mp4' })).rejects.toThrow('MEDIA_UNAVAILABLE');
    const raw = await repository.captureRaw({ bytes, sha256: sha(bytes) }, reference, 'agnes-simulated', 'job-4', 1000);
    const output = await repository.finalize(raw, target);
    await expect(repository.readMedia({ ...output.media, objectKey: '../synthetic.mp4' }, output)).rejects.toThrow('MEDIA_UNAVAILABLE');
    await expect(repository.readMedia({ ...output.media, sha256: 'a'.repeat(64) }, output)).rejects.toThrow('MEDIA_UNAVAILABLE');
  }, 30000);
});
