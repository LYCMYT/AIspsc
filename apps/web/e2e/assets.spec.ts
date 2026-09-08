import { expect, test, unknownPng } from './fixtures';
test('A11 uploaded source survives reload and can be reused without inventing a prompt', async ({ page }) => {
  await page.goto('/assets');
  const pixel = await unknownPng(page);
  await expect(page.getByLabel('上传素材文件')).toBeEnabled();
  await page.getByLabel('上传素材文件').setInputFiles({ name: 'local-product.png', mimeType: 'image/png', buffer: pixel });
  await expect(page.getByText('local-product.png', { exact: true }).first()).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '查看 local-product.png' }).click();
  await expect(page.getByRole('dialog').getByText('上传源素材', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('img')).toBeVisible();
  await page.getByRole('button', { name: '用于创作', exact: true }).click();
  await expect(page).toHaveURL(/\/create$/);
  await expect(page.getByLabel('Prompt')).toHaveValue('');
  await expect(page.locator('.reference-slot small').filter({ hasText: 'local-product.png' })).toBeVisible();
});
