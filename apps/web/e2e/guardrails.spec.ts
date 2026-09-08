import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test, expect, loadReferenceDemo, resetScenario, selectGenerationMode, selectMenuByValue, unknownPng } from './fixtures';

test('A01 reference never bypasses blank Prompt or consumes quota', async ({ page }) => {
  await resetScenario(page, 'empty');
  await loadReferenceDemo(page);
  await expect(page.locator('.reference-slot img')).toBeVisible();
  await page.getByLabel('Prompt', { exact: true }).fill('   ');
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Prompt 不能为空');
  await expect(page.locator('.quota-value')).toHaveText('1286');
  await page.getByRole('link', { name: '历史记录', exact: true }).click();
  await expect(page.getByText('暂无历史记录', { exact: true })).toBeVisible();
});

test('A09 A10 uploaded non-fixture video has real metadata but no scene or fake clip downloads', async ({ page }) => {
  await page.goto('/decompose');
  const manifest = JSON.parse(readFileSync('apps/web/public/demo/MEDIA_MANIFEST.json', 'utf8'));
  const entry = manifest.files.find((file: { key: string }) => file.key === 'scene-source');
  const original = readFileSync(`apps/web/public/demo/${entry.path}`);
  // A valid, independently hashed container; its filename must never grant fixture privileges.
  const video = Buffer.concat([original, Buffer.from('B1 uploaded non-fixture test variant')]);
  await expect(page.getByLabel('上传拆解视频')).toBeEnabled();
  await page.getByLabel('上传拆解视频').setInputFiles({ name: 'scene-source.mp4', mimeType: 'video/mp4', buffer: video });
  await expect(page.getByRole('button', { name: '规划区间', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '场景检测', exact: true }).click();
  await page.getByRole('button', { name: '规划区间', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('未知素材不能使用固定场景检测样例');
  await page.getByRole('button', { name: '顺序拆解', exact: true }).click();
  await page.getByRole('button', { name: '规划区间', exact: true }).click();
  await expect(page.getByText('尚未生成切片文件', { exact: true })).toHaveCount(3);
  await expect(page.getByRole('link', { name: /下载切片/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '27.000–32.000 秒', exact: true })).toBeVisible();
});

test('A11 A18 Blob survives a second tab; reset confirms and preserves unrelated storage', async ({ page, context }) => {
  await page.goto('/assets');
  await expect(page.getByLabel('上传素材文件')).toBeEnabled();
  await page.getByLabel('上传素材文件').setInputFiles({ name: 'cross-tab.png', mimeType: 'image/png', buffer: await unknownPng(page) });
  await expect(page.getByRole('button', { name: '查看 cross-tab.png' })).toBeVisible();
  await page.evaluate(() => localStorage.setItem('unrelated-example', 'keep'));
  const second = await context.newPage();
  await second.goto('/assets');
  await second.getByRole('button', { name: '查看 cross-tab.png' }).click();
  await expect.poll(() => second.getByRole('dialog').getByRole('img').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(120);
  await second.close();
  await page.getByRole('button', { name: '演示工具', exact: true }).click();
  await selectMenuByValue(page, '选择测试场景', 'empty');
  await page.getByRole('button', { name: '重置演示', exact: true }).click();
  await page.getByRole('button', { name: '保留当前数据', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '查看 cross-tab.png' })).toBeVisible();
  await resetScenario(page, 'empty');
  expect(await page.evaluate(() => localStorage.getItem('unrelated-example'))).toBe('keep');
  await page.getByRole('link', { name: '资产库', exact: true }).click();
  await expect(page.locator('.asset-card')).toHaveCount(0);
});

test('A19 invalid media fails clearly, storage failure keeps finalizing and recovers by saving the same output', async ({ page }) => {
  await page.goto('/assets');
  await expect(page.getByLabel('上传素材文件')).toBeEnabled();
  await page.getByLabel('上传素材文件').setInputFiles({ name: 'pretend.png', mimeType: 'image/png', buffer: Buffer.from('this is not an image') });
  await expect(page.getByRole('alert')).toContainText('文件类型与内容不符');
  await expect(page.getByRole('button', { name: '查看 pretend.png' })).toHaveCount(0);
  await resetScenario(page, 'storage_failure');
  await page.getByRole('link', { name: '历史记录', exact: true }).click();
  await expect(page.getByText('本地存储空间不足', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '重试下载', exact: true }).click();
  await expect(page.locator('.result-card').getByText('生成成功', { exact: true })).toBeVisible();
  await expect(page.locator('.quota-value')).toHaveText('1285');
});

test('A11 missing file restores only from its original bytes and can then be reused', async ({ page }) => {
  await resetScenario(page, 'missing_file');
  await page.getByRole('link', { name: '资产库', exact: true }).click();
  await page.locator('.asset-card').filter({ hasText: '文件需重新选择' }).getByRole('button', { name: /^查看 / }).click();
  const dialog = page.getByRole('dialog', { name: '素材详情', exact: true });
  await expect(dialog.getByRole('button', { name: '用于创作', exact: true })).toBeDisabled();
  const png = await unknownPng(page);
  await dialog.getByLabel('重新选择文件').setInputFiles({ name: 'wrong.png', mimeType: 'image/png', buffer: png });
  await expect(dialog.getByRole('alert')).not.toContainText('INVALID_PARAMETERS');
  await expect(dialog.getByRole('alert')).toContainText('请选择与原文件一致的素材');
  const manifest = JSON.parse(readFileSync('apps/web/public/demo/MEDIA_MANIFEST.json', 'utf8'));
  const entry = manifest.files.find((file: { key: string }) => file.key === 'image-16x9-1024');
  await dialog.getByLabel('重新选择文件').setInputFiles(`apps/web/public/demo/${entry.path}`);
  await expect(dialog.getByRole('img')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '用于创作', exact: true })).toBeEnabled();
});

test('A18 scenario reset restores default form parameters as well as business data', async ({ page }) => {
  await page.goto('/create');
  await selectGenerationMode(page, '文案生成');
  await page.getByRole('button', { name: '生成参数' }).click();
  await page.getByLabel('最大字符数', { exact: true }).fill('17');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '生成参数', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '演示工具', exact: true }).click();
  await selectMenuByValue(page, '选择测试场景', 'empty');
  await page.getByRole('button', { name: '重置演示', exact: true }).click();
  await page.getByRole('button', { name: '确认重置', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '生成类型', exact: true })).toHaveAttribute('data-value', 'video');
  await page.getByRole('button', { name: '生成参数' }).click();
  await expect(page.getByLabel('时长（秒）', { exact: true })).toHaveValue('10');
});

test('A15 rendered fixture clip downloads the real source-bound MP4 bytes', async ({ page }) => {
  await page.goto('/decompose');
  await page.getByRole('button', { name: '使用固定测试视频', exact: true }).click();
  await page.getByRole('button', { name: '规划区间', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: '下载切片 1', exact: true }).click()]);
  const chunks: Buffer[] = [];
  const stream = await download.createReadStream();
  if (!stream) throw new Error('No actual download bytes');
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  expect(bytes.subarray(4, 8).toString()).toBe('ftyp');
  const manifest = JSON.parse(readFileSync('apps/web/public/demo/MEDIA_MANIFEST.json', 'utf8'));
  const expected = manifest.files.filter((file: { sourceSha256?: string; startMs?: number; endMs?: number }) => file.sourceSha256 && file.startMs === 0 && file.endMs === 15000);
  expect(expected.map((file: { sha256: string }) => file.sha256)).toContain(createHash('sha256').update(bytes).digest('hex'));
});
