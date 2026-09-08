import { test, expect, resetScenario } from './fixtures';

test('UI6 A01 A03 parameter groups are anchored and reference modes never imply unsupported first/last frames', async ({ page }) => {
  await resetScenario(page, 'empty');
  await expect(page.getByText('Prompt 必填 · 最多 5000 字', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveAttribute('required', '');
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveAttribute('maxlength', '5000');
  await page.getByRole('combobox', { name: '参考方式', exact: true }).click();
  await expect(page.getByRole('option', { name: '首尾帧', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: '参考方式', exact: true })).toContainText('全能参考');
  const trigger = page.getByRole('button', { name: '生成参数', exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: '视频时长', exact: true })).toHaveCount(0);
  const panel = page.getByRole('dialog', { name: '生成参数', exact: true });
  await expect(panel.getByRole('radiogroup', { name: '选择比例', exact: true })).toBeVisible();
  await panel.getByRole('radio', { name: '16:9', exact: true }).check();
  await panel.getByRole('radio', { name: '1080p', exact: true }).check();
  await panel.getByRole('radiogroup', { name: '选择生成数量', exact: true }).getByRole('radio', { name: '4', exact: true }).check();
  const bounds = await panel.boundingBox(); const anchor = await trigger.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(460);
  expect(Math.abs(bounds!.x - anchor!.x)).toBeLessThan(100);
  expect(bounds!.y >= anchor!.y + anchor!.height + 4 || bounds!.y + bounds!.height <= anchor!.y - 4).toBe(true);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText('16:9');
  await expect(trigger).toContainText('1080p');
  await expect(trigger).toContainText('4');
  await trigger.click();
  await expect(panel.getByRole('radio', { name: '16:9', exact: true })).toBeChecked();
  await page.getByRole('heading', { name: '生成历史', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const durationInput = panel.getByRole('spinbutton', { name: '时长（秒）', exact: true });
  await durationInput.fill('15');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(durationInput).toHaveValue('15');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('UI6 A17 every application filter uses the shared keyboard dropdown', async ({ page }) => {
  await resetScenario(page, 'seed');
  for (const [route, label] of [['资产库', '素材来源'], ['历史记录', '任务状态筛选'], ['视频拆解', '选择源视频'], ['素材识别', '选择识别素材']] as const) {
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: route, exact: true }).click();
    await expect(page.getByRole('heading', { name: route, exact: true, level: 1 })).toBeVisible();
    expect(await page.locator('select').count(), `${route} must use the shared visible control`).toBe(0);
    const filter = page.getByRole('combobox', { name: label, exact: true });
    await filter.focus(); await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(filter).toBeFocused();
  }
  await page.getByRole('button', { name: '演示工具', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '固定测试场景', exact: true });
  await dialog.getByRole('combobox', { name: '选择测试场景', exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('UI6 editable panel shares grouped parameters and disabled first/last reference', async ({ page }) => {
  await page.goto('/design-panel.html');
  await expect(page.getByText('Prompt 必填 · 最多 5000 字', { exact: true })).toHaveCount(0);
  expect(await page.locator('select').count()).toBe(0);
  await page.getByRole('combobox', { name: '参考方式', exact: true }).click();
  await expect(page.getByRole('option', { name: '首尾帧', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '生成参数', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '生成参数', exact: true });
  const bounds = await panel.boundingBox();
  const anchor = await page.getByRole('button', { name: '生成参数', exact: true }).boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(460);
  expect(Math.abs(bounds!.x - anchor!.x)).toBeLessThan(100);
  expect(bounds!.y >= anchor!.y + anchor!.height + 4 || bounds!.y + bounds!.height <= anchor!.y - 4).toBe(true);
  await panel.getByRole('radio', { name: '16:9', exact: true }).check();
  await panel.getByRole('radio', { name: '1080p', exact: true }).check();
  await panel.getByRole('radiogroup', { name: '选择生成数量', exact: true }).getByRole('radio', { name: '4', exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '生成参数', exact: true })).toContainText('16:9');
});
