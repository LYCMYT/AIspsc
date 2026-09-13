import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createServer, preview } from 'vite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DemoSnapshot } from '../../../packages/contracts/src/index';
import { startLocalGeneration } from '../../../packages/generation-api/scripts/start';

async function snapshot(request: APIRequestContext): Promise<DemoSnapshot> {
  const response = await request.get('/api/v1/snapshot');
  expect(response.status()).toBe(200);
  return (await response.json()).value;
}
async function scenario(request: APIRequestContext, name: string) {
  const response = await request.post('/api/v1/scenario', {
    headers: { 'Idempotency-Key': randomUUID() }, data: { name },
  });
  expect(response.status()).toBe(200);
}
async function generate(page: Page, prompt: string, mode = '视频生成') {
  await page.goto('/create');
  await page.getByRole('combobox', { name: '生成类型', exact: true }).click();
  await page.getByRole('option', { name: mode, exact: true }).click();
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill(prompt);
  await expect(page.getByRole('button', { name: '生成', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page).toHaveURL(/\/history$/);
}

test('local HTTP composition reads the real API snapshot', async ({ page, request }) => {
  const response = await request.get('/api/v1/snapshot');
  expect(response.status()).toBe(200);
  expect((await response.json()).ok).toBe(true);
  const snapshot = page.waitForResponse('**/api/v1/snapshot');
  await page.goto('/create');
  expect((await snapshot).status()).toBe(200);
  await expect(page.getByRole('button', { name: '生成', exact: true })).toBeVisible();
});

test('private configured state, lock and temporary files cannot be fetched through Vite', async ({ request }) => {
  const directory = process.env.GENERATION_DATA_DIR!;
  await writeFile(resolve(directory, 'pending.tmp'), 'PRIVATE-STATE-REGRESSION');
  for (const name of ['state.json', '.lock', 'pending.tmp']) {
    const path = resolve(directory, name).replaceAll('\\', '/');
    const expected = await readFile(path, 'utf8');
    for (const encoded of [path, encodeURI(path), path.replace(/\//g, '%2F')]) {
      const response = await request.get('/@fs/' + encoded);
      expect([403, 404], name).toContain(response.status());
      expect(await response.text()).not.toContain(expected);
    }
  }
});

test('accepted retry with lost response reuses command after snapshot refresh', async ({ page, request }) => {
  await scenario(request, 'failure');
  const prompt = `lost-response-${randomUUID()}`;
  await generate(page, prompt);
  const original = page.getByTestId('batch-card').filter({ has: page.getByRole('heading', { name: prompt, exact: true }) }).last();
  await expect(original.getByRole('button', { name: '重新生成', exact: true })).toBeVisible();
  const before = await snapshot(request);
  await scenario(request, 'success');
  const commands: { key: string | undefined; body: string | null }[] = [];
  await page.route('**/api/v1/generation-items/*/retry', async route => {
    commands.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    if (commands.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await original.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(original.getByRole('alert')).toBeVisible();
  await expect.poll(async () => (await snapshot(request)).batches.length).toBe(before.batches.length + 1);
  // A real subsequent browser snapshot updates the adapter while retaining the mounted history callsite.
  await page.waitForResponse('**/api/v1/snapshot');
  await original.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  await expect(original.getByRole('alert')).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });
  expect(commands[1]).toEqual(commands[0]);
  const after = await snapshot(request);
  expect(after.batches).toHaveLength(before.batches.length + 1);
  expect(Object.keys(after.credits.reservations)).toHaveLength(Object.keys(before.credits.reservations).length + 1);
});

test('loopback proxy validates Host, Origin and Fetch Metadata before supplying server authorization', async ({ request }) => {
  const hostileHeaders: Record<string, string>[] = [
    { Origin: 'http://hostile.invalid' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { Origin: 'null' },
  ];
  for (const headers of hostileHeaders) {
    expect((await request.get('/api/v1/snapshot', { headers })).status()).toBe(403);
  }
  const hostileHostStatus = await new Promise<number>(resolveStatus => {
    const outgoing = httpRequest('http://127.0.0.1:4174/api/v1/snapshot', { headers: { Host: 'hostile.invalid:4174' } }, response => {
      response.resume(); response.on('end', () => resolveStatus(response.statusCode!));
    });
    outgoing.end();
  });
  expect(hostileHostStatus).toBe(403);
  const overwritten = await request.get('/api/v1/snapshot', {
    headers: { Authorization: 'Bearer caller-cannot-select-operator', Origin: 'http://127.0.0.1:4174', 'Sec-Fetch-Site': 'same-origin' },
  });
  expect(overwritten.status()).toBe(200);
  for (const path of ['/', '/src/services/platform.ts', '/@vite/client', '/api/v1/snapshot', '/api/config']) {
    const response = await request.get(path);
    expect((await response.text()).includes(process.env.HTTP_TEST_TOKEN!), 'actual operator token must never be returned').toBe(false);
  }
});

test('acknowledged retry survives a failed refresh and a later click creates a new command', async ({ page, request }) => {
  await scenario(request, 'failure');
  const prompt = `acknowledged-refresh-${randomUUID()}`;
  await generate(page, prompt, '文案生成');
  const original = page.getByTestId('batch-card').filter({ has: page.getByRole('heading', { name: prompt, exact: true }) }).last();
  await expect(original.getByRole('button', { name: '重新生成', exact: true })).toBeVisible();
  const before = await snapshot(request);
  await scenario(request, 'success');
  let failNextSnapshot = false;
  let failedSnapshots = 0;
  const commands: { key: string | undefined; body: string | null; status: number }[] = [];
  await page.route('**/api/v1/snapshot', async route => {
    if (failNextSnapshot) {
      failNextSnapshot = false; failedSnapshots++;
      await route.abort('failed');
    } else await route.continue();
  });
  await page.route('**/api/v1/generation-items/*/retry', async route => {
    const response = await route.fetch();
    commands.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData(), status: response.status() });
    if (commands.length === 1) failNextSnapshot = true;
    await route.fulfill({ response });
  });
  await original.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect.poll(() => failedSnapshots).toBe(1);
  await expect(original.getByRole('button', { name: '重新生成', exact: true })).toBeEnabled();
  expect(commands[0]?.status).toBe(202);
  await expect(original.getByRole('alert'), 'successful retry must not be reported as a failed mutation').toHaveCount(0);
  await expect(page.getByRole('alert'), 'refresh failure is still surfaced independently').toHaveCount(1);
  await page.waitForResponse('**/api/v1/snapshot');
  await expect.poll(async () => (await snapshot(request)).batches.length).toBe(before.batches.length + 1);
  const nextResponse = page.waitForResponse('**/api/v1/generation-items/*/retry');
  await original.getByRole('button', { name: '重新生成', exact: true }).click();
  expect((await nextResponse).status()).toBe(202);
  await page.unrouteAll({ behavior: 'wait' });
  expect(commands).toHaveLength(2);
  expect(commands[1]!.key).not.toBe(commands[0]!.key);
  expect(commands[1]!.body).not.toBe(commands[0]!.body);
  const after = await snapshot(request);
  expect(after.batches).toHaveLength(before.batches.length + 2);
  expect(Object.keys(after.credits.reservations)).toHaveLength(Object.keys(before.credits.reservations).length + 2);
});

async function approve(page: Page, mode: 'video' | 'image' | 'copy', revision = false) {
  await page.getByRole('button', { name: revision ? '改判' : '人工审核', exact: true }).first().click();
  if (mode === 'video') {
    const applicable = page.getByRole('checkbox', { name: /适用$/ });
    await expect(applicable).toHaveCount(11);
    for (const control of await applicable.all()) await control.check();
    await page.getByRole('spinbutton', { name: '人工综合分（1–10 整数）' }).fill('8');
  } else {
    await page.getByRole('checkbox', { name: '输出可读取' }).check();
    await page.getByRole('checkbox', { name: '符合任务要求' }).check();
  }
  if (revision) await page.getByRole('textbox', { name: '改判原因' }).fill('重新复核演示文件后通过');
  await page.getByRole('button', { name: '保存审核', exact: true }).click();
  await expect(page.getByText('通过未入库', { exact: true }).first()).toBeVisible();
}

test('worker completes after page closes; playable video and all modalities require review then manual save', async ({ context, page, request }) => {
  const seenRequests: string[] = [];
  const errors: string[] = [];
  let consoleErrorCount = 0;
  const observePage = (observed: Page) => {
    observed.on('pageerror', error => errors.push(error.name));
    observed.on('console', message => { if (message.type() === 'error') consoleErrorCount++; });
  };
  observePage(page);
  context.on('request', request => {
    seenRequests.push(JSON.stringify([request.url(), request.headers(), request.postData()]));
  });
  context.on('page', observePage);
  await scenario(request, 'processing');
  const prompt = `browser-closed-${randomUUID()}`;
  await generate(page, prompt);
  const active = (await snapshot(request)).batches.find(batch => batch.requestSnapshot.prompt === prompt)!;
  expect(['queued', 'running']).toContain(active.items[0]!.status);
  const initialSession = await page.evaluate(() => JSON.stringify(sessionStorage));
  await page.close();
  // GET only: no page, pump endpoint, or client-side adapter exists during completion.
  await expect.poll(async () => (await snapshot(request)).items.find(item => item.id === active.items[0]!.id)?.status).toBe('succeeded');
  const reopened = await context.newPage();
  await reopened.goto('/history');
  const batch = reopened.getByTestId('batch-card').filter({ has: reopened.getByRole('heading', { name: prompt, exact: true }) });
  const video = batch.getByLabel('演示视频', { exact: true });
  await expect(video).toBeVisible();
  await video.evaluate(async node => { const media = node as HTMLVideoElement; media.muted = true; await media.play(); });
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  const readyState = await video.evaluate(node => (node as HTMLVideoElement).readyState);
  const duration = await video.evaluate(node => (node as HTMLVideoElement).duration);
  expect(readyState).toBeGreaterThanOrEqual(2);
  expect(duration).toBeGreaterThan(0);
  const start = await video.evaluate(node => (node as HTMLVideoElement).currentTime);
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(start);
  const advancedTime = await video.evaluate(node => (node as HTMLVideoElement).currentTime);
  expect(advancedTime).toBeGreaterThan(start);
  await reopened.screenshot({ path: '.ai/evidence/B21A-T4A-playing-video.png', fullPage: true });
  const count = (await snapshot(request)).assets.length;
  await approve(reopened, 'video');
  const approvedAssetCount = (await snapshot(request)).assets.length;
  expect(approvedAssetCount).toBe(count);
  await reopened.screenshot({ path: '.ai/evidence/B21A-T4A-approved-awaiting-save.png', fullPage: true });
  await batch.getByRole('button', { name: '入库', exact: true }).click();
  await expect(batch.getByText('已入库', { exact: true })).toBeVisible();
  const savedAssetCount = (await snapshot(request)).assets.length;
  expect(savedAssetCount).toBe(count + 1);
  await batch.getByRole('button', { name: '改判', exact: true }).click();
  await reopened.getByRole('checkbox', { name: '任务要求的商品完全缺失' }).check();
  await reopened.getByRole('textbox', { name: '审核备注' }).fill('人工复核发现商品缺失');
  await reopened.getByRole('textbox', { name: '改判原因' }).fill('复核不通过');
  await reopened.getByRole('button', { name: '保存审核', exact: true }).click();
  await expect(batch.getByText(/审核已改判，原资产审核已失效/)).toBeVisible();
  await reopened.screenshot({ path: '.ai/evidence/B21A-T4A-invalidated-asset.png', fullPage: true });
  const invalidatedState = (await snapshot(request)).assets.find(asset => asset.originItemId === active.items[0]!.id)?.reviewValidity;
  expect(invalidatedState).toBe('review_invalidated');
  await approve(reopened, 'video', true);
  expect((await snapshot(request)).assets.find(asset => asset.originItemId === active.items[0]!.id)?.reviewValidity).toBe('review_invalidated');
  await batch.getByRole('button', { name: '入库', exact: true }).click();
  await expect(batch.getByText(/审核已改判，原资产审核已失效/)).toHaveCount(0);
  await scenario(request, 'success');
  for (const [mode, label] of [['image', '图片生成'], ['copy', '文案生成']] as const) {
    await generate(reopened, `http-${mode}-${randomUUID()}`, label);
    await expect(reopened.getByTestId('batch-card').first().getByText('生成成功', { exact: true }).first()).toBeVisible();
    const assetsBefore = (await snapshot(request)).assets.length;
    await approve(reopened, mode);
    expect((await snapshot(request)).assets).toHaveLength(assetsBefore);
    await reopened.getByRole('button', { name: '入库', exact: true }).first().click();
    await expect.poll(async () => (await snapshot(request)).assets.length).toBe(assetsBefore + 1);
  }
  const storage = await context.storageState({ indexedDB: true });
  const session = await reopened.evaluate(() => JSON.stringify(sessionStorage));
  const tokenPresent = JSON.stringify([seenRequests, storage, initialSession, session]).includes(process.env.HTTP_TEST_TOKEN!);
  expect(tokenPresent, 'actual token absent from browser requests and storage').toBe(false);
  const authorizationPresent = seenRequests.some(value => value.includes('"authorization"'));
  expect(authorizationPresent, 'browser supplies no authorization').toBe(false);
  expect(errors).toEqual([]);
  expect(consoleErrorCount).toBe(0);
  const allRequestsLocal = seenRequests.every(value => !/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(value));
  expect(allRequestsLocal, 'all browser requests stay local').toBe(true);
  // Only observed scalar values leave the test: no tokens, snapshots, URLs, headers or raw errors.
  await mkdir('artifacts/http-e2e', { recursive: true });
  await writeFile('artifacts/http-e2e/acceptance-observations.json', JSON.stringify({
    schemaVersion: 1,
    commit: (await promisify(execFile)('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    video: { readyState, duration, startTime: start, advancedTime },
    assets: { beforeApproval: count, afterApproval: approvedAssetCount, afterManualSave: savedAssetCount, invalidatedState },
    browser: { requestCount: seenRequests.length, tokenPresent, authorizationPresent, allRequestsLocal,
      pageErrorCount: errors.length, consoleErrorCount },
  }, null, 2));
});

for (const variant of ['default development', 'production build', 'development-environment build'] as const) {
  const production = variant !== 'default development';
  test(`${variant}${production ? ' --mode local-http' : ''} executes MockPlatform`, async ({ browser, request }) => {
    test.setTimeout(120_000);
    const configFile = resolve('apps/web/vite.config.ts');
    if (production) {
      // A prior in-process dev server sets NODE_ENV; use the real build CLI in a clean production environment.
      await promisify(execFile)(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--config', configFile, '--mode', 'local-http'], {
        cwd: process.cwd(), env: { ...process.env, NODE_ENV: variant === 'development-environment build' ? 'development' : 'production' }, timeout: 60_000,
      });
    }
    const server = production
      ? await preview({ configFile, mode: 'local-http', preview: { host: '127.0.0.1', port: 4176, strictPort: true } })
      : await createServer({ configFile, mode: 'development', server: { host: '127.0.0.1', port: 4175, strictPort: true } });
    if ('listen' in server) await server.listen();
    const port = production ? 4176 : 4175;
    const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}` });
    try {
      const page = await context.newPage();
      const apiRequests: string[] = [];
      page.on('request', outgoing => { if (new URL(outgoing.url()).pathname.startsWith('/api/')) apiRequests.push(outgoing.url()); });
      await generate(page, `mock-runtime-${randomUUID()}`);
      await expect(page.getByTestId('batch-card').first().getByText('生成成功', { exact: true }).first()).toBeVisible();
      expect(apiRequests).toEqual([]);
      expect(await page.evaluate(async () => (await indexedDB.databases()).length)).toBeGreaterThan(0);
      if (!production) {
        const path = resolve(process.env.GENERATION_DATA_DIR!, 'state.json').replaceAll('\\', '/');
        const response = await request.get(`http://127.0.0.1:${port}/@fs/${encodeURI(path)}`);
        expect([403, 404]).toContain(response.status());
        const demo = await request.get(`http://127.0.0.1:${port}/demo/MEDIA_MANIFEST.json`);
        expect(demo.status()).toBe(200);
      }
    } finally {
      try { await context.close(); } finally { await server.close(); }
    }
  });
}

test('custom workspace data is private and graceful close releases the lock for restart', async ({ request }) => {
  const directory = resolve('.cache', `http-custom-${randomUUID()}`);
  let service = await startLocalGeneration({ port: 4177, apiPort: 0, directory });
  try {
    const response = await request.post(`${service.url}/api/v1/scenario`, {
      headers: { 'Idempotency-Key': randomUUID() }, data: { name: 'processing' },
    });
    expect(response.status()).toBe(200);
    const created = await request.post(`${service.url}/api/v1/generation-batches`, {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { mode: 'copy', prompt: 'restart-worker-proof', count: 1, references: [], copy: { language: 'zh-CN', maxCharacters: 100 } },
    });
    expect(created.status()).toBe(202);
    const itemId = (await created.json()).value.items[0].id as string;
    const marker = 'CUSTOM-PRIVATE-STATE';
    await writeFile(resolve(directory, 'pending.tmp'), marker);
    for (const file of ['state.json', '.lock', 'pending.tmp']) {
      const filePath = resolve(directory, file).replaceAll('\\', '/');
      for (const path of [encodeURI(filePath), filePath.replace(/\//g, '%2F')]) {
        const denied = await request.get(`${service.url}/@fs/${path}`);
        expect(denied.status()).toBe(403);
        expect(await denied.text()).not.toContain(marker);
      }
    }
    await service.close();
    await expect(readFile(resolve(directory, '.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    service = await startLocalGeneration({ port: 4177, apiPort: 0, directory });
    await expect.poll(async () => {
      const response = await request.get(`${service.url}/api/v1/generation-items/${itemId}`);
      return (await response.json()).value.status;
    }).toBe('succeeded');
  } finally { await service.close(); }
  await expect(readFile(resolve(directory, '.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('launcher rejects frontend-served data directories before creating state', async ({ request }, testInfo) => {
  const publicRoot = resolve('apps/web/public');
  const name = `http-private-${randomUUID()}`;
  const directory = resolve(publicRoot, name);
  // Validate the immutable absolute cleanup target before creating any test state.
  if (relative(publicRoot, directory) !== name) throw Error('UNSAFE_TEST_CLEANUP');
  let service: Awaited<ReturnType<typeof startLocalGeneration>> | undefined;
  let failure: string | undefined;
  try {
    try { service = await startLocalGeneration({ port: 4177, apiPort: 0, directory }); }
    catch (error) { failure = error instanceof Error ? error.message : 'UNKNOWN'; }
    if (service) {
      const response = await request.get(`${service.url}/${name}/state.json`);
      const exposedState = response.status() === 200 && await response.text() === await readFile(resolve(directory, 'state.json'), 'utf8');
      await testInfo.attach('public-state-probe', {
        body: JSON.stringify({ status: response.status(), bodyMatchesPersistedState: exposedState }), contentType: 'application/json',
      });
    }
    expect(failure).toBe('LOCAL_DATA_MUST_BE_PRIVATE');
    await expect(readFile(resolve(directory, 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await service?.close();
    // Only this test's prevalidated unique directory is removed.
    await rm(directory, { recursive: true, force: true });
  }
});

// Synthetic local FakeProvider output only. The overridden metadata exercises source identity;
// these bytes are never evidence of an actual Agnes result.
for (const isDemo of [true, false]) {
  test(`synthetic preview identity: isDemo=${isDemo} in history and review`, async ({ page, request }) => {
    await scenario(request, 'success');
    const prompt = `synthetic-preview-${isDemo}-${randomUUID()}`;
    await generate(page, prompt);
    const card = page.getByTestId('batch-card').filter({ has: page.getByRole('heading', { name: prompt, exact: true }) });
    await expect(card.getByLabel('演示视频', { exact: true })).toBeVisible();
    const original = await snapshot(request);
    const item = original.batches.find(batch => batch.requestSnapshot.prompt === prompt)!.items[0]!;
    expect(original.mediaMetadata.find(media => media.id === item.resultMediaId)?.isDemo).toBe(true);
    await page.route('**/api/v1/snapshot', async route => {
      const response = await route.fetch();
      const body = await response.json();
      const metadata = (body.value as DemoSnapshot).mediaMetadata.find(media => media.id === item.resultMediaId)!;
      metadata.isDemo = isDemo;
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    const label = isDemo ? '演示视频' : '视频生成';
    const preview = card.getByLabel(label, { exact: true });
    await expect(preview).toBeVisible();
    await expect(card.locator('.demo-watermark')).toHaveCount(isDemo ? 1 : 0);
    await expect(card.getByLabel('上传的源视频', { exact: true })).toHaveCount(0);
    await preview.evaluate(async node => { const video = node as HTMLVideoElement; video.muted = true; await video.play(); });
    await expect.poll(() => preview.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
    await card.getByRole('button', { name: '人工审核', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel(label, { exact: true })).toBeVisible();
    await expect(dialog.locator('.demo-watermark')).toHaveCount(isDemo ? 1 : 0);
    await expect(dialog.getByText('演示结果', { exact: true })).toHaveCount(isDemo ? 1 : 0);
    // Opening review alone must not approve or save this synthetic result.
    const after = await snapshot(request);
    expect(after.items.find(entry => entry.id === item.id)?.reviewState).toBe('pending');
    expect(after.assets).toHaveLength(original.assets.length);
  });
}

test('synthetic uploaded source video retains uploaded identity', async ({ browser }) => {
  // Upload is intentionally unsupported in HTTP mode; exercise its actual MockPlatform UI.
  const server = await createServer({ configFile: resolve('apps/web/vite.config.ts'), mode: 'development', server: { host: '127.0.0.1', port: 4175, strictPort: true } });
  await server.listen();
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4175' });
  try {
    const page = await context.newPage();
    const manifest = JSON.parse(await readFile('apps/web/public/demo/MEDIA_MANIFEST.json', 'utf8'));
    const entry = manifest.files.find((file: { key: string }) => file.key === 'scene-source');
    const buffer = Buffer.concat([await readFile(`apps/web/public/demo/${entry.path}`), Buffer.from('synthetic-preview-upload')]);
    await page.goto('/decompose');
    await expect(page.getByLabel('上传拆解视频')).toBeEnabled();
    await page.getByLabel('上传拆解视频').setInputFiles({ name: 'synthetic-upload.mp4', mimeType: 'video/mp4', buffer });
    await expect(page.getByLabel('上传的源视频', { exact: true })).toBeVisible();
    await expect(page.locator('.demo-watermark')).toHaveCount(0);
  } finally { try { await context.close(); } finally { await server.close(); } }
});
