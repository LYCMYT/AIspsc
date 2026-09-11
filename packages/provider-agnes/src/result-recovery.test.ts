import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { AgnesVideoClient } from './index.ts';

const url = 'https://platform-outputs.agnes-ai.space/videos/test.mp4';
function clientFor(payload: unknown) {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  return new AgnesVideoClient({ apiKey: 'test-secret', fetchImpl });
}

describe('Agnes observed result schema regression', () => {
  it('reads the top-level url returned by the real recommended-query endpoint', async () => {
    const result = await clientFor({ id: 'upstream-id', status: 'completed', seconds: '5.04', size: '1280x720', url }).getVideo('opaque-video-id');
    assert.equal(result.resultUrl, url);
    assert.equal(result.videoId, 'opaque-video-id');
  });
  it('preserves documented metadata.url and gives it precedence', async () => {
    const result = await clientFor({ status: 'completed', metadata: { url }, url: `${url}?other=1` }).getVideo('opaque-video-id');
    assert.equal(result.resultUrl, url);
  });
  it('falls back to the top-level url when metadata.url is blank', async () => {
    const result = await clientFor({ status: 'completed', metadata: { url: ' ' }, url }).getVideo('opaque-video-id');
    assert.equal(result.resultUrl, url);
  });
  it('never mistakes input-reference or arbitrary nested URLs for generated outputs', async () => {
    const result = await clientFor({ status: 'completed', request_params: { image: url }, output: { unrelated: url } }).getVideo('opaque-video-id');
    assert.equal(result.resultUrl, undefined);
  });
  it('uses the original opaque query ID even when the provider returns a different ID', async () => {
    const result = await clientFor({ id: 'upstream-id', video_id: 'different-upstream-id', status: 'in_progress' }).getVideo('opaque-video-id');
    assert.equal(result.videoId, 'opaque-video-id');
  });
  it('still redacts a failed-task error after the flat-response compatibility change', async () => {
    const result = await clientFor({ status: 'failed', error: { message: 'bad key test-secret' } }).getVideo('opaque-video-id');
    assert.equal(result.errorMessage, 'bad key [REDACTED]');
  });
});
