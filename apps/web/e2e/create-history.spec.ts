import { expect, loadReferenceDemo, resetScenario, test } from './fixtures';

test('T03 trims Prompt, exposes the supported defaults, and never exposes model controls', async ({ page }) => {
  await resetScenario(page, 'empty');
  await loadReferenceDemo(page);
  await expect(page.getByRole('region', { name: '参考素材' }).locator('small').filter({ hasText: '重建测试样例 · 几何图形' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('   ');
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Prompt 不能为空');

  await page.getByRole('button', { name: '生成参数' }).click();
  const parameters = page.getByRole('dialog', { name: '生成参数', exact: true });
  await expect(parameters.getByRole('spinbutton', { name: '时长（秒）' })).toHaveValue('10');
  await expect(parameters.getByRole('radiogroup', { name: '选择比例', exact: true }).getByRole('radio', { name: '9:16', exact: true })).toBeChecked();
  await expect(parameters.getByRole('radiogroup', { name: '选择分辨率', exact: true }).getByRole('radio', { name: '720p', exact: true })).toBeChecked();
  await expect(parameters.getByRole('radiogroup', { name: '选择生成数量', exact: true }).getByRole('radio', { name: '1', exact: true })).toBeChecked();
  await expect(parameters.getByRole('checkbox', { name: '生成音频' })).not.toBeChecked();
  await expect(page.getByRole('combobox', { name: /模型|参考强度/ })).toHaveCount(0);
});

test('T03 double click creates one batch and its demo video can really play', async ({ page }) => {
  await resetScenario(page, 'empty');
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('光影几何商品包装缓慢旋转展示');
  await page.getByRole('button', { name: '生成', exact: true }).dblclick();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByTestId('batch-card')).toHaveCount(1);
  await expect(page.getByTestId('batch-card').getByText('生成成功', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  const video = page.getByLabel('演示视频');
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.duration)).toBeGreaterThan(9.5);
  await video.evaluate(async (node: HTMLVideoElement) => { await node.play(); });
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(0);
});

test('T03 history shows partial success at batch and independent item levels', async ({ page }) => {
  await resetScenario(page, 'partial_success');
  await page.goto('/history');
  const batch = page.getByTestId('batch-card');
  await expect(batch.getByText('部分成功', { exact: true })).toBeVisible();
  await expect(batch.getByTestId('result-card').filter({ hasText: '生成成功' })).toHaveCount(2);
  await expect(batch.getByTestId('result-card').filter({ hasText: '生成失败' })).toHaveCount(1);
  await page.screenshot({ path: `${process.env.UI_EVIDENCE_DIR ?? '.ai/evidence'}/T03-partial-history.png`, fullPage: true });
});

test('T05 unsupported duration is rejected in place while the supported boundary is accepted', async ({ page }) => {
  await resetScenario(page, 'empty');
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('验证时长能力边界');
  await page.getByRole('button', { name: '生成参数' }).click();
  await page.getByRole('spinbutton', { name: '时长（秒）' }).fill('4');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '生成参数' })).toBeFocused();
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page).toHaveURL(/\/create$/);
  await expect(page.getByText('时长需为 5–15 秒的整数', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('验证时长能力边界');

  await page.getByRole('button', { name: '生成参数' }).click();
  await page.getByRole('spinbutton', { name: '时长（秒）' }).fill('5');
  await page.screenshot({ path: `${process.env.UI_EVIDENCE_DIR ?? '.ai/evidence'}/T03-create-parameters.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '生成参数' })).toBeFocused();
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page).toHaveURL(/\/history$/);
});

test('T05 two reference roles submit as plain contract records', async ({ page }) => {
  await resetScenario(page, 'empty');
  await loadReferenceDemo(page, '产品');
  await loadReferenceDemo(page, '模特');
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('同时遵循商品与人物角色参考');
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByTestId('batch-card')).toHaveCount(1);
});
