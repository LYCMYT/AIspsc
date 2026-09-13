import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { startAuthorizedLocalGeneration, startLocalGeneration } from '../scripts/start.js';
import { runAuthorizedExperiment } from '../scripts/b21c-authorized.js';
import { AUTHORIZED_QUOTE, AUTHORIZED_AT, EXPERIMENT_ID, IDEMPOTENCY_KEY, digest } from '../src/provider/authorized-request.js';
import { B21C_REQUEST } from '../../domain/src/authorized-agnes.js';
import { FakeAgnesTransport } from './helpers/fake-agnes-transport.js';
import type { AuthorizedSessionOptions } from '../src/provider/authorized-session.js';
import type { GenerationState } from '../../contracts/src/index.js';
const opened: Array<{ close(): Promise<void> }> = [];
// Explicit fake transport exercises the otherwise non-CI session; no ambient network fallback exists.
beforeEach(() => { vi.stubEnv('CI', 'false'); });
afterEach(async () => { for (const item of opened.splice(0).reverse()) await item.close(); vi.unstubAllEnvs(); });
async function freePort() { const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const p = (server.address() as { port: number }).port; await new Promise<void>(r => server.close(() => r())); return p; }
async function setup(fetchImpl: typeof fetch) {
  await mkdir(resolve('.cache/authorized-tests'), { recursive: true }); const worktree = await mkdtemp(resolve('.cache/authorized-tests/http-'));
  const commonDir = join(worktree, 'git-private-not-dotgit'); await mkdir(commonDir);
  const sourceSha = 'a'.repeat(40);
  const options: AuthorizedSessionOptions = { mode: 'create', explicitOptIn: true, env: { PROVIDER_MODE: 'agnes', AGNES_REAL_CREATE_ENABLED: 'true', AGNES_API_KEY: 'synthetic-session-key' }, location: { worktree, commonDir, sourceSha }, fetchImpl,
    authorization: async () => ({ version: 1, experimentId: EXPERIMENT_ID, authorizedAt: AUTHORIZED_AT, quote: AUTHORIZED_QUOTE, request: structuredClone(B21C_REQUEST), requestHash: digest(B21C_REQUEST), sourceSha }),
  };
  return { options, worktree, directory: join(worktree, '.ai/evidence/B21C/live'), commonDir };
}
async function post(url: string, path: string, body: unknown, key = IDEMPOTENCY_KEY) {
  return fetch(url + '/api/v1/' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
}
async function until(check: () => boolean, timeout = 45000) { const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw Error('SYNTHETIC_WAIT_TIMEOUT'); await new Promise(r => setTimeout(r, 100)); } }
it('same-loader HTTP session persists intent before its sole POST and finalizes actual synthetic MP4 to pending/not_saved', async () => {
  let directory = ''; let beforePost = false;
  const fixture = await setup(async (input, init) => {
    if (init?.method === 'POST') {
      const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as GenerationState;
      expect(state.batches).toHaveLength(1); expect(state.items).toHaveLength(1); expect(state.attempts).toHaveLength(1);
      const item = state.items[0]!; const attempt = state.attempts[0]!;
      expect(state.batches[0]!.requestSnapshot).toEqual(B21C_REQUEST);
      expect(item.routingSnapshot).toMatchObject({ bindingId: 'agnes-authorized-real', modelKey: 'agnes-video-v2.0', ruleVersion: 'b21c-fixed-t2v-v1' });
      expect(attempt).toMatchObject({ itemId: item.id, submissionState: 'submitting', providerBindingId: 'agnes-authorized-real' });
      expect(attempt.attemptId).toBeTruthy(); expect(attempt.submittedAt).toBeTruthy();
      expect(state.credits.reservations[item.id]!.finalState).toBe('reserved');
      beforePost = true;
    }
    expect(init?.redirect).toBe('error'); return fake.fetchImpl(input, init);
  }); directory = fixture.directory;
  const input = join(fixture.worktree, 'synthetic.mp4');
  await promisify(execFile)('ffmpeg', ['-v','error','-f','lavfi','-i','color=c=blue:s=1280x704:r=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-frames:v','121','-t','5.041667','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac',input], { windowsHide: true });
  const mediaUrl = 'https://platform-outputs.agnes-ai.space/synthetic.mp4?signature=synthetic-private';
  const fake = new FakeAgnesTransport({ apiKey: 'synthetic-session-key', expectedVideoId: 'original-video', mediaUrl, mediaBytes: await readFile(input), replies: [
    { operation: 'create', body: { video_id: 'original-video', task_id: 'original-task', status: 'queued' } },
    { operation: 'get', body: { video_id: 'wrong-response-id', status: 'completed', seconds: 5.041667, size: '1280x704', metadata: { url: mediaUrl } } },
  ] });
  const app = await startAuthorizedLocalGeneration({ session: fixture.options, port: await freePort(), apiPort: 0 }); opened.push(app);
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const experiment = runAuthorizedExperiment({ session: fixture.options, start: async () => app, onStarted: async () => barrier });
  opened.push({ async close() { release(); await experiment; } });
  const [first, replay, other] = await Promise.all([post(app.url, 'generation-batches', B21C_REQUEST), post(app.url, 'generation-batches', B21C_REQUEST), post(app.url, 'generation-batches', B21C_REQUEST, 'different')]);
  expect(first.status).toBe(202); expect(replay.status).toBe(202); expect(await first.json()).toEqual(await replay.json()); expect(other.status).toBe(403);
  const item = app.session.store.read().items[0]!;
  expect((await post(app.url, `generation-items/${item.id}/retry`, { expectedVersion: item.version }, 'retry')).status).toBe(403);
  expect((await post(app.url, 'scenario', { name: 'seed' }, 'scenario')).status).toBe(403);
  const privatePath = fixture.commonDir.replaceAll('\\', '/') + '/aispsc-b21c/' + EXPERIMENT_ID + '/registry.json';
  expect((await fetch(app.url + '/@fs/' + privatePath)).status).toBe(403);
  await until(() => app.session.store.read().items[0]?.status === 'succeeded');
  const state = app.session.store.read();
  expect(beforePost).toBe(true); expect(fake.calls).toEqual(['create','get','download']); expect(fake.realCalls).toBe(0);
  expect(state.items[0]).toMatchObject({ status: 'succeeded', reviewState: 'pending', libraryState: 'not_saved' });
  expect(state.assets).toEqual([]); expect(state.evaluations).toEqual([]);
  expect(state.attempts[0]!.rawMedia).toMatchObject({ provenance: 'real_provider_output', rawActualHeight: 704, rawHasAudio: true, rawDecodeVerified: true });
  expect(state.attempts[0]!.derivativeEvidence!.media).toMatchObject({ isDemo: false, height: 720, durationMs: 5000, hasAudio: false });
  expect(app.session.budget.snapshot()).toMatchObject({ create: 1, createInvocations: 1, get: 1, media: 1, originalId: 'original-video' });
  expect(fixture.options.env.AGNES_REAL_CREATE_ENABLED).toBe('false');
  expect((await post(app.url, 'generation-batches', B21C_REQUEST, 'second')).status).toBe(403);
  expect((await post(app.url, `generation-items/${item.id}/reviews`, {}, 'review')).status).toBe(400);
  await expect(app.session.provider.create({ request: { ...B21C_REQUEST, count: 2 }, itemId: item.id, itemIndex: 0 }, {} as never)).rejects.toThrow();
  expect(fake.calls).toEqual(['create','get','download']);
  expect(await readFile(join(directory, 'state.json'), 'utf8')).not.toMatch(/synthetic-session-key|signature=/);
  release(); const result = await experiment;
  expect(result.code).toBe('AUTHORIZED_SUCCEEDED_PENDING_REVIEW');
  const evidence = JSON.parse(await readFile(join(directory, result.evidenceFile), 'utf8'));
  expect(evidence).toMatchObject({ reviewState: 'pending', libraryState: 'not_saved', evaluationCount: 0, assetCount: 0 });
  const view = await startAuthorizedLocalGeneration({ session: { ...fixture.options, mode: 'observe', env: {} }, port: await freePort(), apiPort: 0 }); opened.push(view);
  expect(view.session.store.read().items[0]!.id).toBe(item.id);
  expect((await post(view.url, 'generation-batches', B21C_REQUEST)).status).toBe(403);
  expect(fake.calls).toEqual(['create','get','download']);
}, 60000);
it('lost Create response pauses the original reservation and replay/restart never dispatches another POST', async () => {
  const transport = vi.fn(async () => { throw Error('SYNTHETIC_RESPONSE_LOSS'); }); const fixture = await setup(transport);
  const app = await startAuthorizedLocalGeneration({ session: fixture.options, port: await freePort(), apiPort: 0 }); opened.push(app);
  expect((await post(app.url, 'generation-batches', B21C_REQUEST)).status).toBe(202);
  await until(() => app.session.store.read().attempts[0]?.submissionState === 'needs_reconciliation');
  const state = app.session.store.read(); expect(state.credits.reservations[state.items[0]!.id]!.finalState).toBe('reserved');
  expect(transport).toHaveBeenCalledTimes(1); expect(app.session.budget.snapshot()).toMatchObject({ create: 1, createInvocations: 1 });
  await app.close();
  const next = await startAuthorizedLocalGeneration({ session: { ...fixture.options, env: { ...fixture.options.env, AGNES_REAL_CREATE_ENABLED: 'true' } }, port: await freePort(), apiPort: 0 }); opened.push(next);
  expect((await post(next.url, 'generation-batches', B21C_REQUEST)).status).toBe(202);
  expect((await post(next.url, 'generation-batches', B21C_REQUEST, 'new-key')).status).toBe(403);
  expect(transport).toHaveBeenCalledTimes(1);
}, 60000);
it('ordinary launcher refuses a real flag with no capability', async () => {
  const prior = process.env.AGNES_REAL_CREATE_ENABLED; process.env.AGNES_REAL_CREATE_ENABLED = 'true';
  try { await expect(startLocalGeneration({ port: await freePort(), apiPort: 0 })).rejects.toThrow('REAL_PROVIDER_CALL_OUTSIDE_STAGE'); }
  finally { process.env.AGNES_REAL_CREATE_ENABLED = prior; }
});
