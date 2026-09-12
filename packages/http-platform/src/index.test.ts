import { expect, it } from 'vitest';
import * as adapter from './index.js';
import type { DemoSnapshot, GenerationItem, GenerationBatchSnapshot, Asset, Evaluation, MediaFile, ReviewInput } from '../../contracts/src/index.js';

const request = { mode: 'copy', prompt: '演示商品', references: [], count: 1, copy: { language: 'zh-CN', maxCharacters: 200 } };
const form: ReviewInput = { rubricVersion: 'basic-media-review-v1', humanDecision: 'approved', readable: true, followsTask: true };
const item = (version = 2): GenerationItem => ({ id: 'i1', batchId: 'b1', index: 0, version, status: 'succeeded', mode: 'copy', text: '演示', resultAvailable: true, routingSnapshot: { modelKey: 'mock-copy', bindingId: 'demo', ruleVersion: 'v1', reason: 'demo', capabilitySnapshot: { taskTypes: ['COPY_GENERATION'], maxReferences: 0, copy: { languages: ['zh-CN'], maxCharacters: 200 } } }, pricingSnapshot: { version: 'v1', unitCost: 1, unitName: 'demo-credit' }, reviewState: 'pending', libraryState: 'not_saved', updatedAt: '2026-09-12T00:00:00Z' });
const batch = (version = 2): GenerationBatchSnapshot => ({ id: 'b1', workspaceId: 'w1', requestSnapshot: request as GenerationBatchSnapshot['requestSnapshot'], requestedCount: 1, idempotencyKey: 'create-1', requestHash: 'hash', createdAt: '2026-09-12T00:00:00Z', status: 'succeeded', items: [item(version)] });
const asset: Asset = { id: 'a1', workspaceId: 'w1', mediaType: 'text', text: '演示', availability: 'available', source: 'generated', originItemId: 'i1', reviewId: 'e1', reviewValidity: 'valid', title: '演示', tags: [], createdAt: '2026-09-12T00:00:00Z', isDemo: true };
const evaluation: Evaluation = { id: 'e1', itemId: 'i1', revision: 1, rubricVersion: 'basic-media-review-v1', issueTags: [], hardFailures: [], technicalErrors: [], decision: 'approved', reason: '人工', reviewerId: 'u1', createdAt: '2026-09-12T00:00:00Z' };
const snapshot = (version = 2): DemoSnapshot => ({ version: 1, epoch: 'epoch1', scenario: 'success', batches: [batch(version)], items: [item(version)], evaluations: [evaluation], assets: [asset], mediaMetadata: [], credits: { granted: 100, available: 99, spent: 1, reserved: 0, reservations: { i1: { itemId: 'i1', reservedUnits: 1, finalState: 'committed' } }, appliedActions: ['grant'] }, ledger: [{ referenceId: 'i1', action: 'COMMIT', units: 1, createdAt: '2026-09-12T00:00:00Z' }], attempts: [{ itemId: 'i1', attemptNo: 1, providerBindingId: 'demo', externalIdempotencyKey: 'x', submissionState: 'settled', createdAt: 'now', updatedAt: 'now' }], reconciliations: [], splits: [] });
const ok = (value?: unknown, status = 200) => Response.json({ ok: true, ...(value === undefined ? {} : { value }) }, { status });
const conflict = () => Response.json({ ok: false, error: { code: 'VERSION_CONFLICT', message: 'secret C:/private?token=secret', field: 'expectedVersion' } }, { status: 409 });
type Call = { url: string; method: string; body: unknown; rawBody: RequestInit['body']; key: string | null; init?: RequestInit };
function setup(handler: (call: Call, index: number) => Response | Promise<Response>, baseUrl?: string) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const call = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined, rawBody: init?.body, key: new Headers(init?.headers).get('Idempotency-Key'), init };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { platform: new adapter.HttpPlatform({ fetcher, baseUrl }), calls };
}
const network = { ok: false, error: { code: 'NETWORK_ERROR' } };

it('exports a browser platform and maps snapshot, ready, quota and no-op pump', async () => {
  expect(adapter.HttpPlatform).toBeTypeOf('function');
  const { platform, calls } = setup(call => ok(call.url.endsWith('/quota') ? snapshot().credits : snapshot()), '/proxy/');
  await platform.ready();
  expect(await platform.snapshot()).toEqual(snapshot());
  expect(await platform.quota.get()).toEqual({ ok: true, value: snapshot().credits });
  await platform.pump();
  expect(calls.map(c => [c.method, c.url])).toEqual([['GET', '/proxy/v1/snapshot'], ['GET', '/proxy/v1/snapshot'], ['GET', '/proxy/v1/quota']]);
  expect(calls.every(c => !new Headers(c.init?.headers).has('Authorization'))).toBe(true);
});

it('maps all supported generation, review, asset and fixture commands with exact bodies', async () => {
  const { platform, calls } = setup(call => {
    if (call.url.endsWith('/snapshot')) return ok(snapshot(5));
    if (call.url.endsWith('/reviews')) return ok(evaluation);
    if (call.url.endsWith('/assets') || call.url.endsWith('/fixtures')) return ok(asset);
    if (call.url.endsWith('/scenario')) return ok();
    if (call.url.includes('generation-batches') || call.url.endsWith('/retry')) return ok(batch(), call.method === 'POST' ? 202 : 200);
    return ok(item(3), call.url.endsWith('/retry-download') ? 202 : 200);
  });
  expect((await platform.generation.create(request, { idempotencyKey: 'caller-create' })).ok).toBe(true);
  expect((await platform.generation.get('b1')).ok).toBe(true);
  expect((await platform.generation.cancel('i1', 1)).ok).toBe(true);
  expect((await platform.generation.retry('i1', { idempotencyKey: 'caller-retry' })).ok).toBe(true);
  expect((await platform.resolveUnknown('i1', 'success')).ok).toBe(true);
  expect((await platform.retryDownload('i1')).ok).toBe(true);
  expect((await platform.review.save('i1', form.rubricVersion, form)).ok).toBe(true);
  expect((await platform.saveReviewRevision('i1', form, '重新人工审核')).ok).toBe(true);
  expect((await platform.asset.saveApprovedOutput('i1', 'e1')).ok).toBe(true);
  expect((await platform.loadFixture('video-5')).ok).toBe(true);
  expect((await platform.setScenario('success')).ok).toBe(true);
  const posts = calls.filter(c => c.method === 'POST');
  expect(posts.map(c => [c.url, c.body])).toEqual([
    ['/api/v1/generation-batches', request], ['/api/v1/generation-items/i1/cancel', { expectedVersion: 1 }],
    ['/api/v1/generation-items/i1/retry', { expectedVersion: 3 }], ['/api/v1/generation-items/i1/reconcile', { expectedVersion: 3, outcome: 'success' }],
    ['/api/v1/generation-items/i1/retry-download', { expectedVersion: 3 }], ['/api/v1/generation-items/i1/reviews', { expectedVersion: 3, form, reason: '' }],
    ['/api/v1/generation-items/i1/reviews', { expectedVersion: 5, form, reason: '重新人工审核' }], ['/api/v1/generation-items/i1/assets', { expectedVersion: 5, evaluationId: 'e1' }],
    ['/api/v1/fixtures', { key: 'video-5' }], ['/api/v1/scenario', { name: 'success' }],
  ]);
  expect(posts[0]?.key).toBe('caller-create');
  expect(posts[2]?.key).toBe('caller-retry');
  expect(posts.every(c => /^[A-Za-z0-9_-]{1,100}$/.test(c.key ?? ''))).toBe(true);
});

it('forbids every unsupported operation without any network fallback', async () => {
  const { platform, calls } = setup(() => { throw Error('must not fetch'); });
  const blob = new Blob(['x']);
  const results = await Promise.all([
    platform.upload(blob, 'x'), platform.restore('a1', blob), platform.updateAsset('a1', { title: 'x', tags: [] }), platform.deleteAsset('a1'),
    platform.resetScenario('empty', true), platform.saveClipAsset('s1', 0), platform.media.remove('m1'),
    platform.media.put({ blob, metadata: {} as MediaFile }), platform.split.create({ sourceMediaId: 'm1', mode: 'scene' }), platform.split.get('s1'),
  ]);
  for (const result of results) {
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', message: expect.any(String) } });
  }
  expect(calls).toHaveLength(0);
});

it('fetches an unknown item version once, returns conflict without rebasing and preserves safe code/field', async () => {
  const { platform, calls } = setup(call => call.method === 'GET' ? ok(item(7)) : conflict());
  const result = await platform.generation.cancel('i1');
  expect(result).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT', field: 'expectedVersion' } });
  expect(JSON.stringify(result)).not.toMatch(/secret|private|token/);
  expect(calls.map(c => [c.url, c.body])).toEqual([['/api/v1/generation-items/i1', undefined], ['/api/v1/generation-items/i1/cancel', { expectedVersion: 7 }]]);
});

it('retains the exact ambiguous command after a newer snapshot and ends it on a definite result', async () => {
  let posts = 0;
  const { platform, calls } = setup(call => {
    if (call.method === 'GET') return ok(snapshot(posts ? 9 : 2));
    posts++;
    if (posts === 1) throw Error('private token');
    return ok(item(posts === 2 ? 3 : 10));
  });
  await platform.snapshot();
  expect(await platform.generation.cancel('i1')).toMatchObject(network);
  await platform.snapshot();
  expect((await platform.generation.cancel('i1')).ok).toBe(true);
  expect((await platform.generation.cancel('i1')).ok).toBe(true);
  const commands = calls.filter(c => c.method === 'POST');
  expect(commands[1]?.rawBody).toBe(commands[0]?.rawBody);
  expect(commands[1]?.key).toBe(commands[0]?.key);
  expect(commands[1]?.body).toEqual({ expectedVersion: 2 });
  expect(commands[2]?.body).toEqual({ expectedVersion: 9 });
  expect(commands[2]?.key).not.toBe(commands[0]?.key);
});

it('honors supplied create keys and sends changed input instead of replaying retained input', async () => {
  const { platform, calls } = setup((_call, index) => {
    if (index === 0) throw Error('lost');
    return Response.json({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT', message: 'conflict' } }, { status: 409 });
  });
  await platform.generation.create(request, { idempotencyKey: 'same' });
  expect(await platform.generation.create({ ...request, prompt: 'changed' }, { idempotencyKey: 'same' })).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
  expect(calls.map(c => c.key)).toEqual(['same', 'same']);
  expect(calls[1]?.body).toEqual({ ...request, prompt: 'changed' });
});

it('retains caller retry key and version after ambiguity but honors a different caller key', async () => {
  let posts = 0;
  const { platform, calls } = setup(call => {
    if (call.method === 'GET') return ok(snapshot(posts ? 8 : 2));
    posts++;
    if (posts === 1) throw Error('lost');
    return ok(batch(3), 202);
  });
  await platform.snapshot();
  await platform.generation.retry('i1', { idempotencyKey: 'retry-key' });
  await platform.snapshot();
  await platform.generation.retry('i1', { idempotencyKey: 'retry-key' });
  await platform.generation.retry('i1', { idempotencyKey: 'next-key' });
  expect(calls.filter(c => c.method === 'POST').map(c => [c.key, c.body])).toEqual([
    ['retry-key', { expectedVersion: 2 }], ['retry-key', { expectedVersion: 2 }], ['next-key', { expectedVersion: 8 }],
  ]);
});

it('does not let a late older snapshot replace a newer snapshot or regress cached versions', async () => {
  let finish!: (response: Response) => void;
  const { platform, calls } = setup((call, index) => {
    if (index === 0) return new Promise(resolve => { finish = resolve; });
    return ok(call.method === 'GET' ? snapshot(9) : item(10));
  });
  const older = platform.snapshot();
  expect((await platform.snapshot()).items[0]?.version).toBe(9);
  finish(ok(snapshot(2)));
  expect((await older).items[0]?.version).toBe(9);
  await platform.generation.cancel('i1');
  expect(calls.at(-1)?.body).toEqual({ expectedVersion: 9 });
});

it.each([
  ['invalid JSON', () => new Response('{', { headers: { 'Content-Type': 'application/json' } })],
  ['bad envelope', () => Response.json({ ok: 'true', value: snapshot() })],
  ['wrong HTTP status', () => ok(snapshot(), 202)],
  ['unknown error', () => Response.json({ ok: false, error: { code: 'INVENTED', message: 'private' } }, { status: 409 })],
  ['success error envelope', () => Response.json({ ok: false, error: { code: 'FORBIDDEN', message: 'private' } })],
  ['invalid nested item', () => { const value = snapshot(); value.items[0]!.routingSnapshot.capabilitySnapshot.copy!.maxCharacters = 'bad' as unknown as number; return ok(value); }],
  ['invalid nested batch', () => { const value = snapshot(); value.batches[0]!.items[0]!.version = -1; return ok(value); }],
  ['invalid credit reservation', () => { const value = snapshot(); value.credits.reservations.i1!.finalState = 'bad' as 'committed'; return ok(value); }],
  ['invalid asset', () => { const value = snapshot(); value.assets[0]!.tags = [1] as unknown as string[]; return ok(value); }],
  ['invalid evaluation', () => { const value = snapshot(); value.evaluations[0]!.decision = 'pending' as 'approved'; return ok(value); }],
  ['invalid attempt', () => { const value = snapshot(); value.attempts[0]!.submissionState = 'bad' as 'settled'; return ok(value); }],
  ['transport exception', () => { throw Error('C:/private?token=secret'); }],
] as const)('rejects %s safely in snapshot and ready', async (_name, response) => {
  const { platform } = setup(response);
  await expect(platform.snapshot()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  await expect(platform.ready()).rejects.not.toThrow(/private|secret|token/);
});

it.each([
  ['batch', (p: adapter.HttpPlatform) => p.generation.get('b1'), { ...batch(), items: [{ ...item(), pricingSnapshot: { unitCost: 'bad' } }] }],
  ['item', (p: adapter.HttpPlatform) => p.generation.cancel('i1', 2), { ...item(), resultAvailable: 'yes' }],
  ['asset', (p: adapter.HttpPlatform) => p.loadFixture('video'), { ...asset, source: 'invented' }],
  ['quota', (p: adapter.HttpPlatform) => p.quota.get(), { ...snapshot().credits, available: '99' }],
] as const)('rejects malformed %s success payloads', async (_name, call, payload) => {
  const { platform } = setup(() => ok(payload));
  expect(await call(platform)).toMatchObject(network);
});

const media: MediaFile = { id: 'm1', workspaceId: 'w1', mediaType: 'video', mime: 'video/mp4', byteSize: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', availability: 'available', isDemo: true, fixtureKey: 'fixture-video', hasAudio: false };
it('retrieves verified binary Blob by id and preserves demo fixture metadata', async () => {
  const { platform, calls } = setup(call => call.url.endsWith('/file') ? new Response('abc', { headers: { 'Content-Type': 'video/mp4' } }) : ok(media));
  const result = await platform.media.get('m1');
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.media).toEqual(media);
    expect(result.value.blob).toBeInstanceOf(Blob);
    expect(await result.value.blob.text()).toBe('abc');
  }
  expect(calls.map(c => c.url)).toEqual(['/api/v1/media/m1', '/api/v1/media/m1/file']);
});
it.each([
  ['hash', media, 'abd', 'video/mp4'], ['size', media, 'abcd', 'video/mp4'], ['MIME', media, 'abc', 'text/plain'],
  ['metadata', { ...media, byteSize: '3' }, 'abc', 'video/mp4'],
] as const)('rejects media %s mismatch', async (_name, metadata, bytes, mime) => {
  const { platform } = setup(call => call.url.endsWith('/file') ? new Response(bytes, { headers: { 'Content-Type': mime } }) : ok(metadata));
  expect(await platform.media.get('m1')).toMatchObject(network);
});
