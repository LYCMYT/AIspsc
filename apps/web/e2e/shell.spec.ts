import { expect, test } from './fixtures';
test('A02 five real routes with an explicit simulation environment', async ({ page }) => {
  await page.goto('/create');
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  for (const [label, path] of [['创作', '/create'], ['资产库', '/assets'], ['历史记录', '/history'], ['视频拆解', '/decompose'], ['素材识别', '/recognize']]) {
    await page.getByRole('navigation').getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { level: 1, name: label, exact: true })).toBeVisible();
  }
  await expect(page.getByText('演示环境', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: /模型|参考强度/ })).toHaveCount(0);
});
