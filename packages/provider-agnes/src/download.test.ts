import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { checkedMediaUrl, readBoundedMedia, parseMediaProbe } from './download.ts';

describe('Agnes result download validation', () => {
  it('allows only the documented HTTPS output host without credentials', () => {
    assert.equal(checkedMediaUrl('https://platform-outputs.agnes-ai.space/videos/a.mp4?signature=private').hostname, 'platform-outputs.agnes-ai.space');
    assert.equal(checkedMediaUrl('https://cos-platform-outputs.agnes-ai.cn/videos/a.mp4').hostname, 'cos-platform-outputs.agnes-ai.cn');
    for (const value of ['http://platform-outputs.agnes-ai.space/a.mp4', 'https://cos-platform-outputs.agnes-ai.cn.evil.test/a.mp4', 'https://localhost/a.mp4', 'https://127.0.0.1/a.mp4', 'https://platform-outputs.agnes-ai.space.evil.test/a.mp4', 'https://user:pass@platform-outputs.agnes-ai.space/a.mp4']) {
      assert.throws(() => checkedMediaUrl(value), /UNTRUSTED_MEDIA_URL/);
    }
  });
  it('rejects HTML returned with HTTP 200', async () => {
    await assert.rejects(readBoundedMedia(new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }), 1024), /INVALID_MEDIA_TYPE/);
  });
  it('enforces a byte ceiling even without content-length', async () => {
    await assert.rejects(readBoundedMedia(new Response(new Uint8Array(20), { headers: { 'content-type': 'video/mp4' } }), 10), /MEDIA_TOO_LARGE/);
  });
  it('rejects an empty result', async () => {
    await assert.rejects(readBoundedMedia(new Response(new Uint8Array(), { headers: { 'content-type': 'video/mp4' } }), 1024), /EMPTY_MEDIA/);
  });
  it('keeps actual media dimensions and audio rather than copying requested parameters', () => {
    assert.deepEqual(parseMediaProbe({ streams: [{ codec_type: 'video', width: 1280, height: 768, duration: '5.041667' }, { codec_type: 'audio' }], format: { duration: '5.041667' } }), { durationMs: 5042, width: 1280, height: 768, hasAudio: true });
  });
  it('rejects missing video streams and nonfinite duration', () => {
    assert.throws(() => parseMediaProbe({ streams: [], format: { duration: '5' } }), /INVALID_VIDEO/);
    assert.throws(() => parseMediaProbe({ streams: [{ codec_type: 'video', width: 100, height: 100 }], format: { duration: 'nan' } }), /INVALID_VIDEO/);
  });
});
