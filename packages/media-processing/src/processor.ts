import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { DELIVERY_VERSION, planDelivery } from './policy.ts';
import type { DeliveryTarget, VideoFacts } from './policy.ts';
const exec = promisify(execFile);
export const MAX_MEDIA_BYTES = 128 * 1024 * 1024;
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
async function tool(name: 'ffprobe' | 'ffmpeg', args: string[]) {
  try {
    const result = await exec(name, args, { timeout: 90_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false,
      env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
    return result.stdout;
  } catch { throw new Error('MEDIA_TOOL_FAILED'); }
}
export async function readMp4(path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 12 || info.size > MAX_MEDIA_BYTES) throw new Error('INVALID_LOCAL_MP4');
  const bytes = await readFile(path);
  if (bytes.length > MAX_MEDIA_BYTES || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('INVALID_LOCAL_MP4');
  return bytes;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_PROBE');
  return value as Record<string, unknown>;
}
export async function probeVideo(path: string): Promise<VideoFacts> {
  await readMp4(path);
  const stdout = await tool('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', 'mov', '-count_frames', '-show_streams', '-of', 'json', resolve(path)]);
  const probe = object(JSON.parse(stdout));
  if (!Array.isArray(probe.streams)) throw new Error('INVALID_PROBE');
  const streams = probe.streams.map(object);
  const videos = streams.filter(stream => stream.codec_type === 'video');
  if (videos.length !== 1) throw new Error('INVALID_VIDEO_STREAMS');
  const v = videos[0]!;
  const [n, d] = String(v.avg_frame_rate).split('/').map(Number);
  const rotation = Array.isArray(v.side_data_list)
    ? v.side_data_list.map(object).find(side => typeof side.rotation === 'number')?.rotation : undefined;
  const tags = v.tags && typeof v.tags === 'object' ? object(v.tags) : {};
  const facts: VideoFacts = {
    width: Number(v.width), height: Number(v.height), durationSeconds: Number(v.duration),
    fps: n! / d!, frames: Number(v.nb_read_frames), hasAudio: streams.some(stream => stream.codec_type === 'audio'),
    sar: !v.sample_aspect_ratio || v.sample_aspect_ratio === 'N/A' ? '1:1' : String(v.sample_aspect_ratio),
    rotation: Number(rotation ?? tags.rotate ?? 0),
  };
  if (!Number.isFinite(facts.durationSeconds) || facts.durationSeconds <= 0 || facts.durationSeconds > 60 ||
      !Number.isFinite(facts.fps) || facts.fps <= 0 || !Number.isSafeInteger(facts.frames) || facts.frames < 1 ||
      !Number.isSafeInteger(facts.width) || !Number.isSafeInteger(facts.height) ||
      Math.min(facts.width, facts.height) <= 0 || Math.max(facts.width, facts.height) > 4096) throw new Error('INVALID_PROBE');
  return facts;
}
export async function decodeVideo(path: string) {
  await tool('ffmpeg', ['-v', 'error', '-xerror', '-nostdin', '-protocol_whitelist', 'file,pipe', '-f', 'mov', '-i', resolve(path), '-map', '0:v:0', '-threads', '1', '-f', 'null', '-']);
}
/** Isolated codec query never reads free-form stream tags into durable evidence. */
export async function probeVideoCodec(path: string): Promise<'h264' | 'hevc' | 'av1' | 'vp9' | 'mpeg4'> {
  await readMp4(path);
  const stdout = await tool('ffprobe', ['-v','error','-protocol_whitelist','file,pipe','-f','mov','-select_streams','v','-show_entries','stream=codec_name','-of','json',resolve(path)]);
  const probe = object(JSON.parse(stdout));
  if (!Array.isArray(probe.streams) || probe.streams.length !== 1) throw Error('INVALID_PROBE');
  const codec = object(probe.streams[0]).codec_name;
  if (codec !== 'h264' && codec !== 'hevc' && codec !== 'av1' && codec !== 'vp9' && codec !== 'mpeg4') throw Error('INVALID_PROBE');
  return codec;
}
export interface DeliveryReport {
  version: typeof DELIVERY_VERSION;
  startedAt: string;
  completedAt: string;
  policy: DeliveryTarget;
  transformations: string[];
  source: { sha256: string; byteSize: number; media: VideoFacts };
  result: { filename: 'result.mp4'; sha256: string; byteSize: number; media: VideoFacts };
  validation: 'passed';
  encoder: string;
  businessReview: 'pending';
}
/** A new derivative only. The source is never rewritten; output directories are exclusive. */
export async function processDelivery(sourcePath: string, outputDirectory: string, target: unknown): Promise<DeliveryReport> {
  const startedAt = new Date().toISOString();
  const sourceBytes = await readMp4(sourcePath);
  const sourceSha = sha(sourceBytes);
  const source = await probeVideo(sourcePath);
  const plan = planDelivery(source, target);
  const out = resolve(outputDirectory);
  try { await mkdir(out, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('OUTPUT_EXISTS', { cause: error });
    throw error;
  }
  const partial = resolve(out, 'result.pending.mp4');
  try {
    await decodeVideo(sourcePath);
    await tool('ffmpeg', ['-v', 'error', '-xerror', '-nostdin', '-n', '-protocol_whitelist', 'file,pipe', '-f', 'mov', '-i', resolve(sourcePath),
      '-map', '0:v:0', '-vf', plan.filter, '-r', '24', '-fps_mode', 'cfr', '-frames:v', String(plan.frames), '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-threads', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', partial]);
    const actual = await probeVideo(partial);
    if (actual.width !== plan.width || actual.height !== plan.height || actual.frames !== plan.frames || actual.hasAudio ||
        actual.sar !== '1:1' || actual.rotation !== 0 || Math.abs(actual.fps - 24) > 0.00001 || Math.abs(actual.durationSeconds - plan.target.durationSeconds) > 0.001) {
      throw new Error('DELIVERY_CONFORMANCE_FAILED');
    }
    await decodeVideo(partial);
    if (sha(await readMp4(sourcePath)) !== sourceSha) throw new Error('SOURCE_CHANGED');
    const bytes = await readMp4(partial);
    const encoder = (await tool('ffmpeg', ['-version'])).split('\n')[0]!.slice(0, 300);
    const report: DeliveryReport = {
      version: DELIVERY_VERSION, startedAt, completedAt: new Date().toISOString(), policy: plan.target, transformations: plan.changes,
      source: { sha256: sourceSha, byteSize: sourceBytes.length, media: source },
      result: { filename: 'result.mp4', sha256: sha(bytes), byteSize: bytes.length, media: actual },
      validation: 'passed', encoder, businessReview: 'pending',
    };
    await rename(partial, resolve(out, 'result.mp4'));
    await writeFile(resolve(out, 'delivery.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return report;
  } catch {
    await rm(out, { recursive: true, force: true });
    throw new Error('DELIVERY_PROCESSING_FAILED'); // The server may log only a stable code, never paths or raw subprocess output.
  }
}
