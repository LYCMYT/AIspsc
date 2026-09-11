import { describe, expect, it } from 'vitest';
import { planDelivery, validateTarget } from './policy.ts';
const target = { durationSeconds: 5, ratio: '16:9', resolution: '720p', audio: false } as const;
const source = { width: 1280, height: 704, durationSeconds: 121 / 24, fps: 24, frames: 121, hasAudio: true, sar: '1:1', rotation: 0 };
describe('explicit delivery policy', () => {
  it('pads rather than cropping, trims only the tail and drops audio', () => {
    const plan = planDelivery(source, target);
    expect(plan).toMatchObject({ width: 1280, height: 720, frames: 120, fps: 24 });
    expect(plan.filter).toContain('pad=1280:720');
    expect(plan.filter).not.toContain('crop');
    expect(plan.filter).toContain('trim=end_frame=120');
    expect(plan.changes).toContain('remove_audio');
    expect(plan.changes).toContain('trim_encoder_tail');
  });
  it.each(['4:3', 'bad'])('rejects unsupported ratio %s', ratio => expect(() => validateTarget({ ...target, ratio })).toThrow());
  it.each([0, 4, 5.5, 16, NaN])('rejects duration %s', durationSeconds => expect(() => validateTarget({ ...target, durationSeconds })).toThrow());
  it('rejects audio=true instead of silently removing desired sound', () => expect(() => validateTarget({ ...target, audio: true })).toThrow());
  it('rejects unknown fields and malformed values', () => {
    expect(() => validateTarget({ ...target, ffmpeg: '-y' })).toThrow();
    expect(() => validateTarget(null)).toThrow();
    expect(() => validateTarget({ ...target, resolution: '4K' })).toThrow();
  });
  it('does not invent missing frames or cut a long scene', () => {
    expect(() => planDelivery({ ...source, durationSeconds: 4.9 }, target)).toThrow('SOURCE_TOO_SHORT');
    expect(() => planDelivery({ ...source, durationSeconds: 8 }, target)).toThrow('EXCESS_DURATION_REQUIRES_EDIT');
  });
  it('rejects rotation and anamorphic inputs rather than changing composition silently', () => {
    expect(() => planDelivery({ ...source, rotation: 90 }, target)).toThrow();
    expect(() => planDelivery({ ...source, sar: '2:1' }, target)).toThrow();
  });
  it('supports portrait/square canvas without relabeling the source', () => {
    expect(planDelivery(source, { ...target, ratio: '9:16' })).toMatchObject({ width: 720, height: 1280 });
    expect(planDelivery(source, { ...target, ratio: '1:1', resolution: '1080p' })).toMatchObject({ width: 1080, height: 1080 });
    expect(source.height).toBe(704);
  });
});
