import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import type { DemoSnapshot, GenerationBatchSnapshot, GenerationItem, Result } from '../../contracts/src/index.js';
import { startGenerationApi } from './server.js';
import { HttpPlatform } from '../../http-platform/src/index.js';

const token = 'synthetic-http-test-token';
const origin = 'http://127.0.0.1:5173';
const root = resolve('.cache/generation-http-tests');
const copy = { mode: 'copy', prompt: '几何商品演示', references: [], count: 1, copy: { language: 'zh-CN', maxCharacters: 200 } };
const basic = { rubricVersion: 'basic-media-review-v1', humanDecision: 'approved', readable: true, followsTask: true };
let app: Awaited<ReturnType<typeof startGenerationApi>>;
let dir: string;
let sequence = 0;
beforeEach(async () => {
  await mkdir(root, { recursive: true });
  dir = await mkdtemp(join(root, 'server-'));
  app = await startGenerationApi({ directory: join(dir, 'state'), fixtureRoot: resolve('apps/web/public/demo'), token, port: 0, allowedOrigins: [origin], workerIntervalMs: 5 });
});
afterEach(async () => {
  await app?.close();
  if (!dir) return;
  const rel = relative(root, dir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('cleanup containment');
  await rm(dir, { recursive: true, force: true });
});
function get(path: string) { return fetch(app.url + path, { headers: { Authorization: `Bearer ${token}` } }); }
function post(path: string, body: unknown, key = `action-${++sequence}`) {
  return fetch(app.url + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
}
async function value<T>(response: Response): Promise<T> {
  const result = await response.json() as Result<T>;
  if (!result.ok) throw Error(result.error.code);
  return result.value;
}
async function snapshot() { return value<DemoSnapshot>(await get('/v1/snapshot')); }
async function create(body = copy) { const response = await post('/v1/generation-batches', body); expect(response.status).toBe(202); return value<GenerationBatchSnapshot>(response); }
async function item(id: string) { return value<GenerationItem>(await get(`/v1/generation-items/${id}`)); }
async function waitStatus(id: string, status: string) {
  await vi.waitFor(async () => expect((await item(id)).status).toBe(status), { timeout: 3000, interval: 25 });
  return item(id);
}

it('acknowledges real scenario null responses as void and ends the adapter command', async () => {
  const commands: Array<{ key: string | null; body: RequestInit['body'] }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init?.method === 'POST') commands.push({ key: headers.get('Idempotency-Key'), body: init.body });
    return fetch(input, { ...init, headers });
  };
  const platform = new HttpPlatform({ baseUrl: app.url, fetcher });
  await platform.ready();
  const first = await platform.setScenario('failure');
  const persisted = await platform.snapshot();
  const second = await platform.setScenario('failure');
  expect(persisted.scenario).toBe('failure');
  expect((await snapshot()).scenario).toBe('failure');
  expect(first).toEqual({ ok: true, value: undefined });
  expect(second).toEqual({ ok: true, value: undefined });
  expect(commands).toHaveLength(2);
  expect(commands[0]?.body).toBe('{"name":"failure"}');
  expect(commands[1]?.body).toBe(commands[0]?.body);
  expect(commands[0]?.key).toEqual(expect.any(String));
  expect(commands[1]?.key).toEqual(expect.any(String));
  expect(commands[1]?.key).not.toBe(commands[0]?.key);
});

it('guards exact Host, bearer and configured Origin before bodies and exposes only public state', async () => {
  expect((await fetch(app.url + '/v1/snapshot')).status).toBe(401);
  const hostileHost = await new Promise<number>((resolve, reject) => {
    const req = request(app.url + '/v1/snapshot', { headers: { Authorization: `Bearer ${token}`, Host: 'hostile.invalid' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject); req.end();
  });
  expect(hostileHost).toBe(403);
  expect((await fetch(app.url + '/v1/snapshot', { headers: { Authorization: `Bearer ${token}`, Origin: 'https://hostile.invalid' } })).status).toBe(403);
  const response = await fetch(app.url + '/v1/snapshot', { headers: { Authorization: `Bearer ${token}`, Origin: origin } });
  expect(response.status).toBe(200);
  expect(response.headers.has('access-control-allow-origin')).toBe(false);
  const s = await value<DemoSnapshot>(response);
  for (const key of ['pending', 'memo', 'reviewForms', 'sequence']) expect(s).not.toHaveProperty(key);
  expect(JSON.stringify(s)).not.toContain(token);
  expect((await get('/unknown')).status).toBe(404);
  expect((await get('/v1/generation-items/missing')).status).toBe(404);
  expect((await get('/v1/media/missing/file')).status).toBe(404);
});

it('rejects malformed JSON, wrong MIME, oversized declared and chunked bodies with actual 413 responses', async () => {
  for (const [body, type, status] of [['{', 'application/json', 400], ['{}', 'text/plain', 400], [JSON.stringify({ text: 'x'.repeat(65536) }), 'application/json', 413]] as const) {
    const response = await fetch(app.url + '/v1/fixtures', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type, 'Idempotency-Key': 'bad' }, body });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMETERS' } });
  }
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(app.url + '/v1/fixtures', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'stream' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.write('x'.repeat(40000)); req.write('x'.repeat(40000)); req.end();
  });
  expect(status).toBe(413);
});

it('requires strict bodies, idempotency keys and versions on every mutation', async () => {
  const batch = await create();
  for (const [action, body] of [['cancel', {}], ['retry', {}], ['retry-download', {}], ['reconcile', { outcome: 'success' }], ['reviews', { form: basic, reason: '' }], ['assets', { evaluationId: 'missing' }]] as const) {
    expect((await post(`/v1/generation-items/${batch.items[0]!.id}/${action}`, body)).status).toBe(400);
  }
  for (const [path, body] of [['/v1/scenario', { name: 'success', extra: true }], ['/v1/fixtures', { key: 'x', extra: true }], ['/v1/generation-batches', { ...copy, extra: true }]] as const) expect((await post(path, body)).status).toBe(400);
  expect((await post('/v1/generation-batches', copy, '')).status).toBe(400);
  expect((await post('/v1/generation-batches', { ...copy, prompt: '  ' })).status).toBe(400);
});

it('replays canonical creates, rejects changed keys, and serializes concurrent version conflicts', async () => {
  await post('/v1/scenario', { name: 'processing' });
  const first = await post('/v1/generation-batches', copy, 'same');
  const accepted = await value<GenerationBatchSnapshot>(first);
  expect(await value(await post('/v1/generation-batches', { ...copy, prompt: ` ${copy.prompt} ` }, 'same'))).toEqual(accepted);
  expect((await post('/v1/generation-batches', { ...copy, prompt: 'different' }, 'same')).status).toBe(409);
  const row = accepted.items[0]!;
  const responses = await Promise.all([post(`/v1/generation-items/${row.id}/cancel`, { expectedVersion: row.version }), post(`/v1/generation-items/${row.id}/cancel`, { expectedVersion: row.version })]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  expect(await value(await get('/v1/generation-batches/' + accepted.id))).toMatchObject({ id: accepted.id });
  expect(await value<unknown[]>(await get('/v1/generation-batches'))).toHaveLength(1);
});

it('runs autonomously without GET, returns verified playable demo video bytes and fixture-source assets', async () => {
  const batch = await create({ mode: 'video', prompt: '演示', references: [], count: 1, video: { durationSeconds: 5, ratio: '16:9', resolution: '720p', audio: false } } as unknown as typeof copy);
  await vi.waitFor(() => expect(app.store.read().items[0]?.status).toBe('succeeded'), { timeout: 3000 });
  const row = await item(batch.items[0]!.id);
  const media = (await snapshot()).mediaMetadata.find(m => m.id === row.resultMediaId)!;
  expect(await value(await get(`/v1/media/${media.id}`))).toEqual(media);
  const response = await get(`/v1/media/${media.id}/file`);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(response.headers.get('content-type')).toBe('video/mp4');
  expect(bytes.toString('ascii', 4, 8)).toBe('ftyp');
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(media.sha256);
  expect((await snapshot()).assets).toHaveLength(0);
  expect(await value(await post('/v1/fixtures', { key: 'video-5-16x9-720p-silent' }))).toMatchObject({ source: 'fixture', isDemo: true });
  expect(await value(await get('/v1/quota'))).toEqual((await snapshot()).credits);
  await app.close();
  expect(app.worker.status().running).toBe(false);
});

it('requires manual save and invalidates saved assets on approved review revision', async () => {
  const batch = await create(); const id = batch.items[0]!.id;
  let row = await waitStatus(id, 'succeeded');
  const failed = await value<{ decision: string; id: string }>(await post(`/v1/generation-items/${id}/reviews`, { expectedVersion: row.version, form: { ...basic, readable: false }, reason: '' }));
  expect(failed.decision).not.toBe('approved');
  row = await item(id);
  expect((await post(`/v1/generation-items/${id}/assets`, { expectedVersion: row.version, evaluationId: failed.id })).status).toBe(409);
  const approved = await value<{ id: string }>(await post(`/v1/generation-items/${id}/reviews`, { expectedVersion: row.version, form: basic, reason: '人工重新确认' }));
  expect(await value<unknown[]>(await get('/v1/assets'))).toHaveLength(0);
  row = await item(id);
  expect((await post(`/v1/generation-items/${id}/assets`, { expectedVersion: row.version, evaluationId: approved.id })).status).toBe(200);
  row = await item(id);
  expect((await post(`/v1/generation-items/${id}/reviews`, { expectedVersion: row.version, form: basic, reason: '再次检查' })).status).toBe(200);
  expect((await snapshot()).assets[0]).toMatchObject({ reviewValidity: 'review_invalidated' });
  expect((await item(id)).libraryState).toBe('not_saved');
});

it.each(['partial_success', 'failure', 'unknown', 'download_failure', 'cancel_race'] as const)('executes %s and explicit recovery through HTTP', async scenario => {
  await post('/v1/scenario', { name: scenario });
  const batch = await create({ ...copy, count: scenario === 'partial_success' ? 3 : 1 }); const id = batch.items[0]!.id;
  if (scenario === 'cancel_race') {
    const row = await waitStatus(id, 'running');
    expect((await post(`/v1/generation-items/${id}/cancel`, { expectedVersion: row.version })).status).toBe(200);
  }
  if (scenario === 'unknown' || scenario === 'download_failure') {
    const row = await waitStatus(id, scenario === 'unknown' ? 'needs_reconciliation' : 'finalizing');
    const response = await post(`/v1/generation-items/${id}/${scenario === 'unknown' ? 'reconcile' : 'retry-download'}`, { expectedVersion: row.version, ...(scenario === 'unknown' ? { outcome: 'success' } : {}) });
    expect(response.status).toBe(scenario === 'unknown' ? 200 : 202);
  }
  await waitStatus(id, scenario === 'failure' ? 'failed' : 'succeeded');
  if (scenario === 'partial_success') await waitStatus(batch.items[1]!.id, 'failed');
  if (scenario === 'failure') {
    const row = await item(id);
    expect((await post(`/v1/generation-items/${id}/retry`, { expectedVersion: row.version })).status).toBe(202);
  }
});
