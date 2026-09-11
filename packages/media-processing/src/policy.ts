export interface DeliveryTarget {
  durationSeconds: number;
  ratio: '16:9' | '9:16' | '1:1';
  resolution: '720p' | '1080p';
  audio: false;
}
export interface VideoFacts {
  width: number;
  height: number;
  durationSeconds: number;
  fps: number;
  frames: number;
  hasAudio: boolean;
  sar: string;
  rotation: number;
}
export const DELIVERY_VERSION = 'delivery-v1' as const;
export function validateTarget(value: unknown): DeliveryTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_TARGET');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !['durationSeconds', 'ratio', 'resolution', 'audio'].includes(key)) ||
      !Number.isInteger(v.durationSeconds) || Number(v.durationSeconds) < 5 || Number(v.durationSeconds) > 15 ||
      !['16:9', '9:16', '1:1'].includes(String(v.ratio)) || !['720p', '1080p'].includes(String(v.resolution)) || v.audio !== false) {
    throw new Error('INVALID_TARGET');
  }
  return { durationSeconds: Number(v.durationSeconds), ratio: v.ratio as DeliveryTarget['ratio'], resolution: v.resolution as DeliveryTarget['resolution'], audio: false };
}
export function planDelivery(source: VideoFacts, input: unknown) {
  const target = validateTarget(input);
  if (!Number.isFinite(source.durationSeconds) || source.durationSeconds <= 0 || source.durationSeconds > 60 ||
      !Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height) ||
      source.width <= 0 || source.height <= 0 || Math.max(source.width, source.height) > 4096 ||
      !Number.isFinite(source.fps) || source.fps <= 0 || source.fps > 120) throw new Error('INVALID_SOURCE');
  if (source.rotation !== 0 || source.sar !== '1:1') throw new Error('UNSUPPORTED_SOURCE_GEOMETRY');
  if (source.durationSeconds < target.durationSeconds - 0.001) throw new Error('SOURCE_TOO_SHORT');
  if (source.durationSeconds > target.durationSeconds + 0.1 + 0.000001) throw new Error('EXCESS_DURATION_REQUIRES_EDIT');
  const short = target.resolution === '720p' ? 720 : 1080;
  const long = target.resolution === '720p' ? 1280 : 1920;
  const [width, height] = target.ratio === '16:9' ? [long, short] : target.ratio === '9:16' ? [short, long] : [short, short];
  const frames = target.durationSeconds * 24;
  const changes: string[] = [];
  if (source.width !== width || source.height !== height) changes.push('fit_and_pad_no_crop');
  if (source.hasAudio) changes.push('remove_audio');
  if (source.durationSeconds > target.durationSeconds + 0.001) changes.push('trim_encoder_tail');
  if (Math.abs(source.fps - 24) > 0.0001) changes.push('normalize_frame_rate');
  return {
    version: DELIVERY_VERSION, target, width, height, fps: 24, frames, changes,
    filter: `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=24,trim=end_frame=${frames},setpts=N/(24*TB)`,
  };
}
