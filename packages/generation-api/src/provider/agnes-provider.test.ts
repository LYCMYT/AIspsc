import { randomUUID, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgnesProvider } from './agnes-provider.js';
import type { ProviderContext } from './port.js';
import { FakeAgnesTransport } from '../../tests/helpers/fake-agnes-transport.js';
import { AGNES_VIDEO_MODEL } from '../../../provider-agnes/src/index.js';

const secret = randomUUID();
const ctx: ProviderContext = { request: { mode: 'video', prompt: 'synthetic geometric product', count: 1, references: [], video: { durationSeconds: 5, ratio: '16:9', resolution: '720p', audio: false } }, itemId: 'item-1', itemIndex: 0, attemptId: 'attempt-1', externalIdempotencyKey: 'key-1', submittedAt: '2026-09-13T00:00:00.000Z', now: 1789257600000, scenario: 'success', cancelRequested: false, recovery: false };
const url = 'https://platform-outputs.agnes-ai.space/videos/synthetic.mp4?signature=synthetic';
function harness(payload: unknown, status = 200) {
  const calls: Array<{ method: string; id: string | null }> = [];
  const provider = new AgnesProvider({ apiKey: secret, fetchImpl: async (input, init) => {
    const u = new URL(String(input));
    expect(u.origin).toBe('https://apihub.agnes-ai.com');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`);
    calls.push({ method: init?.method ?? 'GET', id: u.searchParams.get('video_id') });
    return new Response(JSON.stringify(payload), { status });
  } });
  return { provider, calls };
}
describe('Agnes adapter with injected transport only', () => {
  it.each(['create', 'get'] as const)('enforces an actual AbortSignal deadline for %s with exactly one transport request', async operation => {
    let calls = 0;
    let observedAbort = false;
    const p = new AgnesProvider({ apiKey: secret, timeoutMs: 20, fetchImpl: async (_input, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => { observedAbort = true; reject(Error('SIMULATION_TIMEOUT')); }, { once: true });
      });
    } });
    await expect(operation === 'create' ? p.create(ctx, ctx) : p.get('job-1', ctx)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', category: 'transient', submissionCertainty: 'unknown' });
    expect(observedAbort).toBe(true);
    expect(calls).toBe(1);
  }, 2000);
  it('strict transport validates expected create payload and original query ID privately', async () => {
    const options = { apiKey: secret, replies: [{ operation: 'create' as const, body: { video_id: 'job-1', status: 'queued' } }, { operation: 'get' as const, body: { status: 'queued' } }], expectedCreateBody: { model: AGNES_VIDEO_MODEL, prompt: ctx.request.prompt, width: 1280, height: 720, num_frames: 121, frame_rate: 24 }, expectedVideoId: 'job-1' };
    const t = new FakeAgnesTransport(options);
    const p = new AgnesProvider({ apiKey: secret, fetchImpl: t.fetchImpl });
    await p.create(ctx, ctx);
    await p.get('job-1', ctx);
    expect(t.calls).toEqual(['create', 'get']);
    const invalid = new FakeAgnesTransport(options);
    await expect(invalid.fetchImpl('https://apihub.agnes-ai.com/v1/videos', { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ prompt: 'incorrect' }) })).rejects.toThrow('SIMULATION_CREATE_BODY_MISMATCH');
    await expect(t.fetchImpl(`https://apihub.agnes-ai.com/agnesapi?model_name=${AGNES_VIDEO_MODEL}&video_id=wrong`, { method: 'GET', headers: { authorization: `Bearer ${secret}` } })).rejects.toThrow('SIMULATION_VIDEO_ID_MISMATCH');
    expect(JSON.stringify(t)).not.toContain(ctx.request.prompt);
  });
  it('strict simulation transports authenticate internally and never delegate unknown requests', async () => {
    const t = new FakeAgnesTransport({ apiKey: secret, replies: [{ operation: 'create', body: { video_id: 'job-1', status: 'queued' } }, { operation: 'get', body: { status: 'completed', url } }], mediaUrl: url, mediaBytes: new Uint8Array([1, 2, 3]) });
    const p = new AgnesProvider({ apiKey: secret, fetchImpl: t.fetchImpl });
    await p.create(ctx, ctx);
    const result = await p.get('job-1', ctx);
    await p.download(result.result!, ctx);
    expect(t.calls).toEqual(['create', 'get', 'download']);
    expect(t.realCalls).toBe(0);
    await expect(t.fetchImpl('https://evil.invalid')).rejects.toThrow('SIMULATION_REQUEST_FORBIDDEN');
    await expect(t.fetchImpl('https://apihub.agnes-ai.com/v1/videos', { method: 'POST' })).rejects.toThrow('SIMULATION_AUTH_INVALID');
    expect(JSON.stringify(t)).not.toContain(secret);
  });
  it('creates once and polls the original opaque ID', async () => {
    const h = harness({ video_id: 'job-1', status: 'queued' });
    expect(await h.provider.create(ctx, ctx)).toEqual({ externalJobId: 'job-1', status: 'queued' });
    expect(await h.provider.get('job-1', ctx)).toEqual({ status: 'queued' });
    expect(h.calls).toEqual([{ method: 'POST', id: null }, { method: 'GET', id: 'job-1' }]);
  });
  it('accepts the durable 200-character ID boundary and polls it without another create', async () => {
    const id = 'a'.repeat(200);
    const h = harness({ video_id: id, status: 'queued' });
    expect(await h.provider.create(ctx, ctx)).toEqual({ externalJobId: id, status: 'queued' });
    await h.provider.get(id, ctx);
    expect(h.calls).toEqual([{ method: 'POST', id: null }, { method: 'GET', id }]);
  });
  it('treats a 201-character create ID as ambiguous without retrying create', async () => {
    const h = harness({ video_id: 'a'.repeat(201), status: 'queued' });
    await expect(h.provider.create(ctx, ctx)).rejects.toMatchObject({ code: 'PROVIDER_OUTCOME_UNKNOWN', submissionCertainty: 'unknown' });
    expect(h.calls).toEqual([{ method: 'POST', id: null }]);
  });
  it('retains reported metadata at durable boundaries', async () => {
    expect(await harness({ status: 'completed', url, seconds: 60, size: '9999x9999' }).provider.get('job-1', ctx)).toEqual({ status: 'result_ready', result: { kind: 'https', url, providerReportedSeconds: 60, providerReportedSize: '9999x9999' } });
  });
  it('omits reported metadata beyond durable boundaries without blocking result download', async () => {
    expect(await harness({ status: 'completed', url, seconds: 60.01, size: '10000x9999' }).provider.get('job-1', ctx)).toEqual({ status: 'result_ready', result: { kind: 'https', url } });
  });
  it.each([[400, 'invalid_request', 'rejected'], [401, 'unauthorized', 'rejected'], [429, 'rate_limited', 'rejected'], [503, 'transient', 'unknown']])('maps HTTP %i without raw errors or retry', async (status, category, certainty) => {
    const h = harness({ message: secret }, Number(status));
    await expect(h.provider.create(ctx, ctx)).rejects.toMatchObject({ category, submissionCertainty: certainty });
    expect(h.calls).toHaveLength(1);
    try { await h.provider.get('job-1', ctx); } catch (error) { expect(JSON.stringify(error)).not.toContain(secret); expect(String(error)).not.toContain(secret); }
  });
  it.each([null, {}, { status: 'queued' }, { video_id: secret, status: 'queued' }, { video_id: 'a'.repeat(300), status: 'queued' }])('treats invalid create response as ambiguous', async payload => {
    await expect(harness(payload).provider.create(ctx, ctx)).rejects.toMatchObject({ submissionCertainty: 'unknown' });
  });
  it.each(['create', 'get'] as const)('maps %s transport timeout safely without retry', async operation => {
    let calls = 0;
    const p = new AgnesProvider({ apiKey: secret, fetchImpl: async () => { calls++; throw Error(secret); } });
    await expect(operation === 'create' ? p.create(ctx, ctx) : p.get('job-1', ctx)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', submissionCertainty: 'unknown' });
    expect(calls).toBe(1);
  });
  it.each(['unexpected', secret])('normalizes unknown status without persisting it', async status => {
    expect(await harness({ status }).provider.get('job-1', ctx)).toEqual({ status: 'unknown' });
  });
  it.each([{ url }, { metadata: { url } }])('extracts supported URL shape and sanitizes reported metadata', async shape => {
    expect(await harness({ status: 'completed', seconds: '5.04', size: '1280x704', ...shape }).provider.get('job-1', ctx)).toEqual({ status: 'result_ready', result: { kind: 'https', url, providerReportedSeconds: 5.04, providerReportedSize: '1280x704' } });
  });
  it.each([undefined, 'https://evil.invalid/a', `${url}&key=${secret}`])('keeps completed without safe URL finalizing', async value => {
    expect(await harness({ status: 'completed', url: value }).provider.get('job-1', ctx)).toEqual({ status: 'result_ready' });
  });
  it('drops malformed or secret-echo reported fields', async () => {
    expect(await harness({ status: 'completed', url, seconds: -1, size: secret }).provider.get('job-1', ctx)).toEqual({ status: 'result_ready', result: { kind: 'https', url } });
  });
  it('rejects unsupported requests before transport', async () => {
    const h = harness({});
    for (const request of [{ ...ctx.request, prompt: ' ' }, { ...ctx.request, references: [{ assetId: 'a', role: 'product' }] }, { ...ctx.request, video: { ...ctx.request.video, audio: true } }, { ...ctx.request, video: { ...ctx.request.video, durationSeconds: 6 } }]) {
      await expect(h.provider.create({ ...ctx, request } as typeof ctx, ctx)).rejects.toMatchObject({ submissionCertainty: 'not_submitted', code: 'PROVIDER_INVALID_REQUEST' });
    }
    expect(h.calls).toHaveLength(0);
  });
  it('downloads bounded credential-free bytes with hash and redirects disabled', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const p = new AgnesProvider({ apiKey: secret, fetchImpl: async (input, init) => {
      expect(String(input)).toBe(url); expect(init?.redirect).toBe('error'); expect(init?.credentials).toBe('omit'); expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return new Response(bytes, { headers: { 'content-type': 'video/mp4' } });
    } });
    expect(await p.download({ kind: 'https', url }, ctx)).toMatchObject({ kind: 'media', sha256: createHash('sha256').update(bytes).digest('hex'), mime: 'video/mp4', provenance: 'synthetic_provider_simulation' });
  });
  it.each(['untrusted', 'oversize', 'redirect', 'failure'])('rejects %s downloads safely', async kind => {
    let calls = 0;
    const p = new AgnesProvider({ apiKey: secret, maxResultBytes: 1, fetchImpl: async () => { calls++; if (kind === 'failure') throw Error(secret); return new Response(new Uint8Array([1, 2]), { status: kind === 'redirect' ? 302 : 200, headers: { 'content-type': 'video/mp4' } }); } });
    await expect(p.download({ kind: 'https', url: kind === 'untrusted' ? 'https://unknown.invalid/a' : url }, ctx)).rejects.toMatchObject({ code: 'PROVIDER_DOWNLOAD_FAILED' });
    expect(calls).toBe(kind === 'untrusted' ? 0 : 1);
  });
  it('requires an explicit transport at runtime', () => {
    expect(() => new AgnesProvider({ apiKey: secret } as never)).toThrow('REAL_PROVIDER_CREATE_DISABLED');
  });
});
