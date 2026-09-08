import { expect, selectMenuValue, test, unknownPng } from './fixtures';
test('A10 unknown content is never given sample recognition tags; manual labels persist', async ({ page }) => {
  await page.goto('/recognize');
  const pixel = await unknownPng(page);
  await expect(page.getByLabel('上传识别素材')).toBeEnabled();
  await page.getByLabel('上传识别素材').setInputFiles({ name: 'unknown.png', mimeType: 'image/png', buffer: pixel });
  await expect(page.getByText('内容识别未执行', { exact: true })).toBeVisible();
  await expect(page.getByText('几何图形', { exact: true })).toHaveCount(0);
  await page.getByLabel('人工标签').fill('人工确认,参考');
  await page.getByRole('button', { name: '保存人工标签' }).click();
  await expect(page.getByText('人工标签已保存', { exact: true })).toBeVisible();
  await page.reload();
  await selectMenuValue(page, '选择识别素材', 'unknown.png');
  await expect(page.getByLabel('人工标签')).toHaveValue('人工确认，参考');
});
