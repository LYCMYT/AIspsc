import { readFileSync } from 'node:fs';
import { test, expect, selectMenuByValue } from './fixtures';

test('A09 exact millisecond manual interval is accepted without floating-point drift', async ({ page }) => {
  await page.goto('/decompose');
  await page.getByRole('button', { name: '使用固定测试视频' }).click();
  await page.getByRole('button', { name: '手动区间', exact: true }).click();
  await page.getByLabel('开始时间（秒）', { exact: true }).fill('1.001');
  await page.getByLabel('结束时间（秒）', { exact: true }).fill('6.001');
  await page.getByRole('button', { name: '规划区间', exact: true }).click();
  await expect(page.getByRole('heading', { name: '1.001–6.001 秒', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /下载切片/ })).toHaveCount(0);
});

test('A10 changing source during fixture planning never attaches old clips to new source', async ({ page }) => {
  await page.goto('/decompose');
  const manifest = JSON.parse(readFileSync('apps/web/public/demo/MEDIA_MANIFEST.json', 'utf8'));
  const entry = manifest.files.find((file: { key: string }) => file.key === 'scene-source');
  const buffer = Buffer.concat([readFileSync(`apps/web/public/demo/${entry.path}`), Buffer.from('independently-hashed upload')]);
  await expect(page.getByLabel('上传拆解视频')).toBeEnabled();
  await page.getByLabel('上传拆解视频').setInputFiles({ name: 'unknown-source.mp4', mimeType: 'video/mp4', buffer });
  const sourceMenu = page.getByRole('combobox', { name: '选择源视频', exact: true });
  await expect(sourceMenu).not.toHaveAttribute('data-value', '');
  const unknownId = await sourceMenu.getAttribute('data-value');
  expect(unknownId).toBeTruthy();
  await page.getByRole('button', { name: '使用固定测试视频' }).click();
  await expect(sourceMenu).not.toHaveAttribute('data-value', unknownId!);
  let release!: () => void;
  let reached = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/demo/clips/*.mp4', async (route) => { reached = true; await gate; await route.continue(); });
  await page.getByRole('button', { name: '规划区间', exact: true }).click();
  await expect.poll(() => reached).toBe(true);
  await selectMenuByValue(page, '选择源视频', unknownId!);
  release();
  await expect(page.getByRole('button', { name: '规划区间', exact: true })).toBeEnabled();
  await expect(page.getByRole('heading', { name: /区间列表/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /下载切片/ })).toHaveCount(0);
});
