import type { CreateGenerationRequest, MediaFile, TechnicalErrorCode } from '../../contracts/src/index';
import { fail, sha256 } from './helpers';

export type ProbedMedia = Pick<MediaFile, 'width' | 'height' | 'durationMs' | 'hasAudio'>;
export type MediaProbe = (blob: Blob, type: 'image' | 'video') => Promise<ProbedMedia>;
const MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']);
export async function validateFile(blob: Blob): Promise<'image' | 'video'> {
  if (blob.size > 200 * 1024 * 1024) fail('MEDIA_TOO_LARGE', '文件不得超过 200MB');
  if (blob.size === 0 || !MIME.has(blob.type)) fail('UNSUPPORTED_MEDIA', '请选择 PNG、JPEG、WebP、MP4 或 WebM 文件');
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const signature = (start: number, value: string) => [...value].every((char, index) => bytes[start + index] === char.charCodeAt(0));
  const valid = blob.type === 'image/png' ? [137,80,78,71,13,10,26,10].every((byte, index) => bytes[index] === byte)
    : blob.type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : blob.type === 'image/webp' ? signature(0, 'RIFF') && signature(8, 'WEBP')
    : blob.type === 'video/mp4' ? signature(4, 'ftyp')
    : [26,69,223,163].every((byte, index) => bytes[index] === byte);
  if (!valid) fail('UNSUPPORTED_MEDIA', '文件类型与内容不符');
  return blob.type.startsWith('image/') ? 'image' : 'video';
}
/** Browser decoders verify dimensions/duration; absence of a reliable audio API stays unknown. */
export const browserProbe: MediaProbe = async (blob, type) => {
  const url = URL.createObjectURL(blob);
  try {
    if (type === 'image') {
      const bitmap = await createImageBitmap(blob);
      const result = { width: bitmap.width, height: bitmap.height }; bitmap.close(); return result;
    }
    return await new Promise<ProbedMedia>((resolve, reject) => {
      const video = document.createElement('video');
      const finish = () => { clearTimeout(timeout); video.removeAttribute('src'); video.load(); };
      const timeout = setTimeout(() => { finish(); reject(new Error('MEDIA_DECODE_TIMEOUT')); }, 10000);
      video.preload = 'metadata';
      video.onerror = () => { finish(); reject(new Error('MEDIA_DECODE_FAILED')); };
      video.onloadedmetadata = () => {
        const result = { width: video.videoWidth, height: video.videoHeight, durationMs: Math.round(video.duration * 1000) };
        finish(); resolve(result);
      };
      video.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
};
export async function inspectFile(blob: Blob, probe: MediaProbe): Promise<Omit<MediaFile, 'id' | 'blobKey'>> {
  const mediaType = await validateFile(blob);
  let measured: ProbedMedia;
  try { measured = await probe(blob, mediaType); } catch { fail('UNSUPPORTED_MEDIA', '文件无法解码'); }
  if (!Number.isInteger(measured.width) || !Number.isInteger(measured.height) || measured.width! <= 0 || measured.height! <= 0
    || mediaType === 'video' && (!Number.isSafeInteger(measured.durationMs) || measured.durationMs! <= 0)) fail('UNSUPPORTED_MEDIA', '无法读取有效媒体元数据');
  return { workspaceId: 'demo', mediaType, mime: blob.type, byteSize: blob.size, sha256: await sha256(blob), availability: 'available', ...measured };
}
export function technicalPreflight(request: CreateGenerationRequest, media?: MediaFile): TechnicalErrorCode[] {
  if (request.mode === 'copy') return [];
  if (!media || media.availability !== 'available') return ['TECH_CORRUPT'];
  const errors: TechnicalErrorCode[] = [];
  const parameters = request.mode === 'video' ? request.video : request.image;
  const [w, h] = parameters.ratio.split(':').map(Number);
  if (!media.width || !media.height || Math.abs(media.width / media.height - w! / h!) > 0.003) errors.push('TECH_RESOLUTION');
  const expected = request.mode === 'video' ? Number.parseInt(request.video.resolution) : Number(request.image.resolution);
  const dimension = request.mode === 'video' ? Math.min(media.width ?? 0, media.height ?? 0) : Math.max(media.width ?? 0, media.height ?? 0);
  if (dimension !== expected && !errors.includes('TECH_RESOLUTION')) errors.push('TECH_RESOLUTION');
  if (request.mode === 'video') {
    if (!media.durationMs || media.durationMs > 15000 || Math.abs(media.durationMs - request.video.durationSeconds * 1000) > 80) errors.push('TECH_DURATION');
    if (request.video.audio && media.hasAudio !== true) errors.push('TECH_AUDIO');
  }
  return errors;
}
