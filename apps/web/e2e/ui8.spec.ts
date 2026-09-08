import { test, expect, resetScenario } from './fixtures';

test('UI8 parameters always open below the trigger in a short viewport', async ({ page }) => {
  await resetScenario(page, 'empty');
  await page.setViewportSize({ width: 1280, height: 620 });
  const trigger = page.getByRole('button', { name: '生成参数', exact: true });
  await trigger.click();
  const panel = page.getByRole('dialog', { name: '生成参数', exact: true });
  await expect(panel).toBeVisible();
  const anchor = await trigger.boundingBox(); const bounds = await panel.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(anchor!.y + anchor!.height + 4);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(609);
  await panel.getByRole('spinbutton', { name: '时长（秒）', exact: true }).fill('15');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('UI8 sidebar keeps quota while test controls live in the header tools', async ({ page }) => {
  await resetScenario(page, 'empty');
  const sidebar = page.locator('.sidebar');
  await expect(sidebar.getByText('固定测试场景', { exact: true })).toHaveCount(0);
  await expect(sidebar.getByText(/预占/)).toHaveCount(0);
  await expect(sidebar.getByText('演示额度', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '演示工具', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '选择测试场景', exact: true })).toBeVisible();
});

test('UI8 task details show readable information before developer diagnostics', async ({ page }) => {
  await resetScenario(page, 'success');
  await page.goto('/history');
  await page.getByRole('button', { name: '只读详情', exact: true }).click();
  const details = page.getByRole('dialog', { name: '任务只读详情', exact: true });
  await expect(details.getByText('demo-t2v', { exact: true })).not.toBeVisible();
  await expect(details.getByRole('heading', { name: '创作内容', exact: true })).toBeVisible();
  await details.getByText('开发诊断', { exact: true }).click();
  await expect(details.getByText('demo-t2v', { exact: true })).toBeVisible();
});

test('UI8 design panel parameters also expand downward near the viewport bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.goto('/design-panel.html');
  const trigger = page.getByRole('button', { name: '生成参数', exact: true });
  await trigger.click();
  const panel = page.getByRole('dialog', { name: '生成参数', exact: true });
  await expect(panel).toBeVisible();
  const anchor = await trigger.boundingBox(); const bounds = await panel.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(anchor!.y + anchor!.height + 4);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(609);
});

test('UI8 recognition keeps file information and demo honesty without raw identifiers', async ({ page }) => {
  await resetScenario(page, 'seed');
  await page.goto('/recognize');
  await page.getByRole('combobox', { name: '选择识别素材', exact: true }).click();
  await page.getByRole('option').first().click();
  await expect(page.getByText('关联 fixture', { exact: true })).toHaveCount(0);
  await expect(page.getByText('SHA-256', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '人工标签', exact: true })).toBeVisible();
});

test('UI8 all shared filters and the long tools menu stay below their anchors', async ({ page }) => {
  await resetScenario(page, 'seed');
  await page.setViewportSize({ width: 1280, height: 620 });
  for (const [route, label] of [['创作', '生成类型'], ['资产库', '素材来源'], ['历史记录', '任务状态筛选'], ['视频拆解', '选择源视频'], ['素材识别', '选择识别素材']] as const) {
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: route, exact: true }).click();
    const trigger = page.getByRole('combobox', { name: label, exact: true });
    await trigger.click();
    const menu = page.getByRole('listbox', { name: label, exact: true });
    await expect(menu).toBeVisible();
    const anchor = await trigger.boundingBox(); const bounds = await menu.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(anchor!.y + anchor!.height + 4);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(609);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  }
  await page.getByRole('button', { name: '演示工具', exact: true }).click();
  const trigger = page.getByRole('combobox', { name: '选择测试场景', exact: true });
  await trigger.click();
  const menu = page.getByRole('listbox', { name: '选择测试场景', exact: true });
  await expect(menu).toBeVisible();
  const anchor = await trigger.boundingBox(); const bounds = await menu.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(anchor!.y + anchor!.height + 4);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(609);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(trigger).toContainText('取消与成功竞争');
  await expect(trigger).toBeFocused();
});

test('UI8 compact navigation stays named and fits a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/create');
  for (const name of ['创作', '资产库', '历史记录', '视频拆解', '素材识别']) {
    const link = page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeAttached();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${process.env.UI_EVIDENCE_DIR ?? '.ai/evidence'}/phone/${name}.png`, fullPage: true });
  }
});

test('UI8 Escape cancels a dropdown before its opening animation frame', async ({ page }) => {
  await resetScenario(page, 'empty');
  const trigger = page.getByRole('combobox', { name: '生成类型', exact: true });
  await trigger.focus();
  await trigger.evaluate(node => {
    (node as HTMLButtonElement).click();
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
