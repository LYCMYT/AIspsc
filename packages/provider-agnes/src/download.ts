import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { DownloadedVideo } from './smoke-runner.ts';

const execFileAsync = promisify(execFile);
const MAX_RESULT_BYTES = 128 * 1024 * 1024;

/** Keep the credential-free output download separate from the authenticated API. */
export function checkedMediaUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('UNTRUSTED_MEDIA_URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'platform-outputs.agnes-ai.space' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('UNTRUSTED_MEDIA_URL');
  }
  return url;
}

export async function readBoundedMedia(response: Response, maximum: number): Promise<Buffer> {
  if (!response.ok) throw new Error('MEDIA_HTTP_ERROR');
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (mime !== 'video/mp4' && mime !== 'application/octet-stream') throw new Error('INVALID_MEDIA_TYPE');
  if (Number(response.headers.get('content-length')) > maximum) throw new Error('MEDIA_TOO_LARGE');
  if (!response.body) throw new Error('EMPTY_MEDIA');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let count = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > maximum) { await reader.cancel(); throw new Error('MEDIA_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  if (!count) throw new Error('EMPTY_MEDIA');
  return Buffer.concat(chunks, count);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseMediaProbe(payload: unknown): Omit<DownloadedVideo['media'], 'decodeVerified'> {
  if (!record(payload) || !Array.isArray(payload.streams)) throw new Error('INVALID_VIDEO');
  const video = payload.streams.find((stream: unknown) => record(stream) && stream.codec_type === 'video');
  const format = record(payload.format) ? payload.format : {};
  if (!record(video)) throw new Error('INVALID_VIDEO');
  const duration = Number(video.duration ?? format.duration);
  const width = Number(video.width);
  const height = Number(video.height);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error('INVALID_VIDEO');
  }
  return {
    durationMs: Math.round(duration * 1000), width, height,
    hasAudio: payload.streams.some((stream: unknown) => record(stream) && stream.codec_type === 'audio'),
  };
}

export async function downloadAgnesVideo(value: string, outputDir: string): Promise<DownloadedVideo> {
  const url = checkedMediaUrl(value);
  const partial = resolve(outputDir, 'result.pending.mp4');
  try {
    // No Authorization, cookies, redirect following or third-party proxy.
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
    const bytes = await readBoundedMedia(response, MAX_RESULT_BYTES);
    if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('INVALID_MP4');
    await writeFile(partial, bytes, { flag: 'wx', mode: 0o600 });
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', partial], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const media = parseMediaProbe(JSON.parse(stdout));
    // Decode the entire video: a valid container header alone is insufficient.
    await execFileAsync('ffmpeg', ['-v', 'error', '-xerror', '-i', partial, '-map', '0:v:0', '-f', 'null', '-'], { timeout: 90_000, maxBuffer: 1024 * 1024 });
    await rename(partial, resolve(outputDir, 'result.mp4'));
    return { filename: 'result.mp4', sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length, media: { ...media, decodeVerified: true } };
  } catch {
    await rm(partial, { force: true });
    throw new Error('RESULT_DOWNLOAD_OR_VALIDATION_FAILED'); // Never expose a signed URL through error/stack/cause.
  }
}
