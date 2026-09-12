import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { chromium, expect as browserExpect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { startLocalGeneration } from '../scripts/start.js';
import { AgnesProvider } from '../src/provider/agnes-provider.js';
import { FakeAgnesTransport } from './helpers/fake-agnes-transport.js';
import type { DemoSnapshot, GenerationState } from '../../contracts/src/index.js';

const run = promisify(execFile);
let root: string, mediaBytes: Buffer;
beforeAll(async () => {
  await mkdir(resolve('.cache/provider-http-tests'), { recursive: true });
  root = await mkdtemp(resolve('.cache/provider-http-tests/acceptance-'));
  const source = join(root, 'synthetic-provider.mp4');
  await run('ffmpeg', ['-v','error','-f','lavfi','-i','color=c=blue:s=1280x704:r=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-frames:v','121','-t','5.041667','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac',source], { windowsHide: true });
  mediaBytes = await readFile(source);
}, 30000);
afterAll(async () => {
  if (!root) return;
  const rel = relative(resolve('.cache/provider-http-tests'), root);
  if (!rel || rel.startsWith('..')) throw Error('cleanup containment');
  await rm(root, { recursive: true, force: true });
});

it('settles a definite pre-send rejection across the actual local HTTP module boundary', async () => {
  const transport = new FakeAgnesTransport({ apiKey: randomBytes(32).toString('hex'), replies: [] });
  const provider = new AgnesProvider({ apiKey: randomBytes(32).toString('hex'), fetchImpl: transport.fetchImpl });
  const app = await startLocalGeneration({ port: 4194, apiPort: 0, directory: join(root, 'rejected-state'), token: randomBytes(32).toString('hex'), provider });
  try {
    const response = await fetch(app.url + '/api/v1/generation-batches', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'pre-send-rejection', Origin: app.url }, body: JSON.stringify({ mode: 'video', prompt: 'unsupported Agnes duration', references: [], count: 1, video: { durationSeconds: 6, ratio: '16:9', resolution: '720p', audio: false } }) });
    expect(response.status).toBe(202);
    await browserExpect.poll(async () => {
      const snapshot = await (await fetch(app.url + '/api/v1/snapshot')).json();
      return snapshot.value.items[0]?.status;
    }, { timeout: 3000 }).toBe('failed');
    const state = JSON.parse(await readFile(join(root, 'rejected-state/state.json'), 'utf8')) as GenerationState;
    expect(state.credits.reserved).toBe(0);
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]?.externalJobId).toBeUndefined();
    expect(transport.calls).toHaveLength(0);
    expect(transport.realCalls).toBe(0);
  } finally { await app.close(); }
});

it.each(['create', 'poll'] as const)('redacts a simulated %s secret echo across persisted state, HTTP and captured logs', async operation => {
  const secret = randomBytes(32).toString('hex');
  const transport = new FakeAgnesTransport({ apiKey: secret, replies: operation === 'create'
    ? [{ operation: 'create', status: 503, body: { message: secret } }]
    : [{ operation: 'create', body: { video_id: 'secret-echo-job', status: 'queued' } }, { operation: 'get', body: { status: secret, message: secret } }] });
  const captured: string[] = [];
  const spies = (['log', 'info', 'warn', 'error'] as const).map(method => vi.spyOn(console, method).mockImplementation((...values: unknown[]) => { captured.push(values.map(String).join(' ')); }));
  let app: Awaited<ReturnType<typeof startLocalGeneration>> | undefined;
  try {
    const directory = join(root, 'secret-' + operation);
    app = await startLocalGeneration({ port: 4194, apiPort: 0, directory, token: randomBytes(32).toString('hex'), provider: new AgnesProvider({ apiKey: secret, fetchImpl: transport.fetchImpl }) });
    const response = await fetch(app.url + '/api/v1/generation-batches', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'secret-echo-' + operation, Origin: app.url }, body: JSON.stringify({ mode: 'video', prompt: 'synthetic secret boundary', references: [], count: 1, video: { durationSeconds: 5, ratio: '16:9', resolution: '720p', audio: false } }) });
    expect(response.status).toBe(202);
    const url = app.url;
    let publicJson = '';
    await browserExpect.poll(async () => {
      publicJson = await (await fetch(url + '/api/v1/snapshot')).text();
      return JSON.parse(publicJson).value.items[0]?.status;
    }, { timeout: 3000 }).toBe('needs_reconciliation');
    await app.close(); app = undefined;
    const persisted = await readFile(join(directory, 'state.json'), 'utf8');
    const safe = { state: !persisted.includes(secret), snapshot: !publicJson.includes(secret), logs: !captured.join('\n').includes(secret), fixture: !mediaBytes.includes(Buffer.from(secret)) };
    expect(Object.values(safe).every(Boolean)).toBe(true);
    const state = JSON.parse(persisted) as GenerationState;
    expect(state.credits.reserved).toBe(1);
    expect(state.attempts).toHaveLength(1);
    expect(transport.calls.filter(c => c === 'create')).toHaveLength(1);
    expect(transport.realCalls).toBe(0);
    const report = JSON.stringify({ operation, syntheticFixture: true, realProviderCalls: 0, secretAbsent: safe });
    expect(report.includes(secret)).toBe(false);
    await mkdir('artifacts/provider-simulation', { recursive: true });
    await writeFile(`artifacts/provider-simulation/secret-${operation}-report.json`, report);
  } finally { try { await app?.close(); } finally { for (const spy of spies) spy.mockRestore(); } }
});

it('runs actual HTTP and simulated Agnes through raw media, FFmpeg, browser review and explicit save', async () => {
  const secret = randomBytes(32).toString('hex');
  const localToken = randomBytes(32).toString('hex');
  const jobId = 'simulated-http-job';
  const mediaUrl = 'https://platform-outputs.agnes-ai.space/synthetic.mp4?signature=temporary-test';
  const expectedBody = { model: 'agnes-video-v2.0', prompt: 'synthetic provider simulation', width: 1280, height: 720, num_frames: 121, frame_rate: 24 };
  const transport = new FakeAgnesTransport({ apiKey: secret, mediaBytes, mediaUrl, replies: [
    { operation: 'create', body: { video_id: jobId, status: 'queued' } },
    { operation: 'get', body: { video_id: jobId, status: 'in_progress' } },
    { operation: 'get', body: { video_id: jobId, status: 'completed', seconds: 5, size: '1280x720', metadata: { url: mediaUrl } } },
  ] });
  let payloadVerified = false;
  const queryIds: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'POST') {
      expect(JSON.parse(String(init.body))).toEqual(expectedBody);
      payloadVerified = true;
    } else if (url.pathname === '/agnesapi') {
      queryIds.push(url.searchParams.get('video_id') ?? '');
      expect(url.searchParams.get('video_id')).toBe(jobId);
    }
    return transport.fetchImpl(input, init);
  };
  const provider = new AgnesProvider({ apiKey: secret, fetchImpl });
  const directory = join(root, 'state');
  const app = await startLocalGeneration({ port: 4194, apiPort: 0, directory, token: localToken, provider });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const requests: string[] = [];
  let pageErrors = 0, consoleErrors = 0, externalRequests = 0;
  context.on('request', request => { requests.push(JSON.stringify([request.url(), request.headers(), request.postData()])); });
  page.on('pageerror', () => { pageErrors++; });
  page.on('console', message => { if (message.type() === 'error') consoleErrors++; });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') { externalRequests++; return route.abort(); }
    return route.continue();
  });
  const snapshot = async (): Promise<DemoSnapshot> => {
    const response = await context.request.get(app.url + '/api/v1/snapshot');
    expect(response.status()).toBe(200);
    return (await response.json()).value;
  };
  try {
    await page.goto(app.url + '/history');
    const created = await page.evaluate(async () => {
      const response = await fetch('/api/v1/generation-batches', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'simulated-provider-http' }, body: JSON.stringify({ mode: 'video', prompt: 'synthetic provider simulation', references: [], count: 1, video: { durationSeconds: 5, ratio: '16:9', resolution: '720p', audio: false } }) });
      return { status: response.status, body: await response.json() };
    });
    expect(created.status).toBe(202);
    expect(created.body.ok).toBe(true);
    await browserExpect.poll(async () => (await snapshot()).items[0]?.status, { timeout: 30000 }).toBe('succeeded');
    const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as GenerationState;
    const attempt = state.attempts[0]!;
    expect(attempt.providerBindingId).toBe('agnes-simulated');
    expect(attempt.externalJobId).toBe(jobId);
    expect(attempt.actualCost).toBeNull();
    expect(attempt.rawMedia).toMatchObject({ rawActualWidth: 1280, rawActualHeight: 704, rawHasAudio: true, rawDecodeVerified: true, provenance: 'synthetic_provider_simulation' });
    expect(attempt.derivativeEvidence?.media).toMatchObject({ width: 1280, height: 720, durationMs: 5000, hasAudio: false });
    expect(transport.calls.filter(c => c === 'create')).toHaveLength(1);
    expect(queryIds).toEqual([jobId, jobId]);
    expect(payloadVerified).toBe(true);
    await page.reload();
    const card = page.getByTestId('batch-card').first();
    const video = card.getByLabel('演示视频', { exact: true });
    await browserExpect(video).toBeVisible();
    await video.evaluate(async element => { const v = element as HTMLVideoElement; v.muted = true; await v.play(); });
    await browserExpect.poll(() => video.evaluate(v => (v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    const start = await video.evaluate(v => (v as HTMLVideoElement).currentTime);
    await browserExpect.poll(() => video.evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(start);
    const playback = await video.evaluate(v => ({ readyState: (v as HTMLVideoElement).readyState, duration: (v as HTMLVideoElement).duration, currentTime: (v as HTMLVideoElement).currentTime }));
    const beforeApproval = (await snapshot()).assets.length;
    await card.getByRole('button', { name: '人工审核', exact: true }).click();
    const applicable = page.getByRole('checkbox', { name: /适用$/ });
    await browserExpect(applicable).toHaveCount(11);
    for (const field of await applicable.all()) await field.check();
    await page.getByRole('spinbutton', { name: '人工综合分（1–10 整数）' }).fill('8');
    await page.getByRole('button', { name: '保存审核', exact: true }).click();
    await browserExpect(card.getByText('通过未入库', { exact: true })).toBeVisible();
    const afterApproval = (await snapshot()).assets.length;
    expect(afterApproval).toBe(beforeApproval);
    await mkdir('artifacts/provider-simulation', { recursive: true });
    await page.screenshot({ path: 'artifacts/provider-simulation/provider-reviewed.png', fullPage: true });
    await card.getByRole('button', { name: '入库', exact: true }).click();
    await browserExpect(card.getByText('已入库', { exact: true })).toBeVisible();
    const afterSave = (await snapshot()).assets.length;
    expect(afterSave).toBe(beforeApproval + 1);
    await card.getByRole('button', { name: '改判', exact: true }).click();
    await page.getByRole('spinbutton', { name: '人工综合分（1–10 整数）' }).fill('10');
    await page.getByRole('checkbox', { name: '任务要求的商品完全缺失' }).check();
    await page.getByRole('textbox', { name: '审核备注' }).fill('Synthetic hard failure test, not real AI quality.');
    await page.getByRole('textbox', { name: '改判原因' }).fill('Synthetic revision invalidation verification');
    await page.getByRole('button', { name: '保存审核', exact: true }).click();
    await browserExpect(card.getByText(/审核已改判，原资产审核已失效/)).toBeVisible();
    await page.screenshot({ path: 'artifacts/provider-simulation/provider-invalidated.png', fullPage: true });
    const final = await snapshot();
    expect(final.assets[0]?.reviewValidity).toBe('review_invalidated');
    const storage = JSON.stringify([await context.storageState({ indexedDB: true }), await page.evaluate(() => JSON.stringify(sessionStorage))]);
    const persisted = await readFile(join(directory, 'state.json'), 'utf8');
    const publicJson = JSON.stringify(final);
    const browserData = JSON.stringify(requests) + storage;
    const secretAbsent = [secret, localToken].every(value => ![persisted, publicJson, browserData].some(text => text.includes(value)));
    expect(secretAbsent).toBe(true);
    expect(persisted.includes('signature=')).toBe(false);
    expect(publicJson.includes('rawMedia')).toBe(false);
    expect(requests.some(value => value.includes('"authorization"'))).toBe(false);
    expect(pageErrors).toBe(0); expect(consoleErrors).toBe(0); expect(externalRequests).toBe(0);
    expect(transport.realCalls).toBe(0);
    const report = { schemaVersion: 1, commit: (await run('git', ['rev-parse','HEAD'])).stdout.trim(),
      fixture: 'synthetic provider simulation', realProviderCalls: transport.realCalls, createCalls: transport.calls.filter(c => c === 'create').length,
      pollCalls: queryIds.length, downloadCalls: transport.calls.filter(c => c === 'download').length, payloadVerified,
      raw: { width: attempt.rawMedia!.rawActualWidth, height: attempt.rawMedia!.rawActualHeight, duration: attempt.rawMedia!.rawDuration, hasAudio: attempt.rawMedia!.rawHasAudio, sha256: attempt.rawMedia!.rawSha256 },
      derivative: { width: attempt.derivativeEvidence!.media.width, height: attempt.derivativeEvidence!.media.height, durationMs: attempt.derivativeEvidence!.media.durationMs, hasAudio: attempt.derivativeEvidence!.media.hasAudio, sha256: attempt.derivativeEvidence!.media.sha256 },
      playback: { ...playback, startTime: start }, assets: { beforeApproval, afterApproval, afterSave, invalidated: final.assets[0]?.reviewValidity },
      secretAbsent, pageErrors, consoleErrors, externalRequests, actualCost: attempt.actualCost };
    expect(JSON.stringify(report).includes(secret)).toBe(false);
    await writeFile('artifacts/provider-simulation/report.json', JSON.stringify(report, null, 2));
    console.log('Provider simulation — Real provider calls: 0');
  } finally { await browser.close(); await app.close(); }
}, 60000);
