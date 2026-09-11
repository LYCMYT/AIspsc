import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createDemoFetcher } from './demo-fetch.ts';

function capture(base: string) {
  const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
  const fake: typeof fetch = async (input, init) => { calls.push({ input, init }); return new Response('ok'); };
  return { calls, fetcher: createDemoFetcher(base, fake) };
}

describe('Pages demo-media base-path adapter', () => {
  it('prefixes the manifest request with the configured repository base', async () => {
    const h = capture('/AIspsc/'); await h.fetcher('/demo/MEDIA_MANIFEST.json');
    assert.equal(h.calls[0]?.input, '/AIspsc/demo/MEDIA_MANIFEST.json');
  });
  it('prefixes media and clip paths as well as the manifest', async () => {
    const h = capture('/AIspsc/'); await h.fetcher('/demo/videos/test.mp4'); await h.fetcher('/demo/clips/test.mp4');
    assert.deepEqual(h.calls.map(c => c.input), ['/AIspsc/demo/videos/test.mp4', '/AIspsc/demo/clips/test.mp4']);
  });
  it('preserves the root deployment behavior', async () => {
    const h = capture('/'); await h.fetcher('/demo/MEDIA_MANIFEST.json');
    assert.equal(h.calls[0]?.input, '/demo/MEDIA_MANIFEST.json');
  });
  it('does not double-prefix URLs or rewrite unrelated APIs', async () => {
    const h = capture('/AIspsc/');
    for (const path of ['/AIspsc/demo/a.png', '/api/jobs', 'https://example.test/demo/a.png', 'blob:https://example.test/a']) await h.fetcher(path);
    assert.deepEqual(h.calls.map(c => c.input), ['/AIspsc/demo/a.png', '/api/jobs', 'https://example.test/demo/a.png', 'blob:https://example.test/a']);
  });
  it('preserves request init including abort and cache options', async () => {
    const h = capture('/AIspsc'); const init = { signal: new AbortController().signal, cache: 'no-store' as const };
    await h.fetcher('/demo/a.png', init);
    assert.equal(h.calls[0]?.init, init); assert.equal(h.calls[0]?.input, '/AIspsc/demo/a.png');
  });
  it('passes Request objects through unchanged', async () => {
    const h = capture('/AIspsc/'); const request = new Request('https://example.test/demo/a.png');
    await h.fetcher(request); assert.equal(h.calls[0]?.input, request);
  });
});
