import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { processDelivery, probeVideo } from './processor.ts';
const run = promisify(execFile);
let root: string;
let source: string;
const target = { durationSeconds: 5, ratio: '16:9', resolution: '720p', audio: false } as const;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'delivery spaces '));
  source = join(root, "original 'quoted'.mp4");
  await run('ffmpeg', ['-v','error','-f','lavfi','-i','color=c=blue:s=1280x704:r=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-frames:v','121','-t','5.041667','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac',source]);
}, 30_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
describe('real offline FFmpeg delivery', () => {
  it('preserves original bytes and validates an exact silent 120-frame derivative', async () => {
    const before = createHash('sha256').update(await readFile(source)).digest('hex');
    const report = await processDelivery(source, join(root, 'derived'), target);
    expect(report.source.sha256).toBe(before);
    expect(createHash('sha256').update(await readFile(source)).digest('hex')).toBe(before);
    expect(report.result.media).toMatchObject({ width: 1280, height: 720, frames: 120, fps: 24, hasAudio: false });
    expect(report.result.media.durationSeconds).toBeCloseTo(5, 5);
    expect(report.validation).toBe('passed');
    expect(report.result.sha256).not.toBe(before);
    expect(JSON.stringify(report)).not.toContain(root);
    expect(await probeVideo(join(root, 'derived/result.mp4'))).toMatchObject({ hasAudio: false });
    await expect(processDelivery(source, join(root, 'derived'), target)).rejects.toThrow('OUTPUT_EXISTS');
  }, 30_000);
  it('rejects symlinks and malformed containers', async () => {
    const linked = join(root, 'linked.mp4'); await symlink(source, linked);
    await expect(processDelivery(linked, join(root, 'linked-result'), target)).rejects.toThrow();
    const bad = join(root, 'bad.mp4'); await writeFile(bad, '<html>not a video</html>');
    await expect(processDelivery(bad, join(root, 'bad-result'), target)).rejects.toThrow();
  });
});
