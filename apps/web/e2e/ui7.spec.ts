import { test, expect, resetScenario } from './fixtures';

test('UI7 creation keeps one parameter entry with immediate changes and no decorative dropdown arrows', async ({ page }) => {
  await resetScenario(page, 'empty');
  await expect(page.getByRole('button', { name: '视频时长', exact: true })).toHaveCount(0);
  await expect(page.locator('.select-trigger > svg:last-child')).toHaveCount(0);
  const trigger = page.getByRole('button', { name: '生成参数', exact: true });
  await trigger.click();
  const panel = page.getByRole('dialog', { name: '生成参数', exact: true });
  await expect(panel.getByRole('button', { name: '确认参数', exact: true })).toHaveCount(0);
  await panel.getByRole('radio', { name: '1080p', exact: true }).check();
  await panel.getByRole('spinbutton', { name: '时长（秒）', exact: true }).fill('15');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText('1080p');
  await trigger.click();
  await expect(panel.getByRole('spinbutton', { name: '时长（秒）', exact: true })).toHaveValue('15');
});

test('UI7 design text can be edited directly on the canvas and survives refresh', async ({ page }) => {
  await page.goto('/design-panel.html');
  await expect(page.getByRole('button', { name: '视频时长', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '生成参数', exact: true }).click();
  await expect(page.getByRole('button', { name: '应用到预览', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const title = page.locator('[data-copy-key="history-title"]');
  await title.dblclick();
  await expect(title).toHaveAttribute('contenteditable', 'plaintext-only');
  await title.fill('我的作品记录');
  await page.keyboard.press('Tab');
  await page.reload();
  await expect(title).toHaveText('我的作品记录');
});

test('UI7 layout edits move and resize the selected region with undo redo and persistence', async ({ page }) => {
  await page.goto('/design-panel.html');
  await page.getByRole('button', { name: '编辑布局', exact: true }).click();
  const composer = page.locator('[data-design-id="create-composer"]');
  await composer.click({ position: { x: 30, y: 20 } });
  await page.getByLabel('区域内边距', { exact: true }).fill('32');
  await page.getByLabel('区域内边距', { exact: true }).press('Tab');
  await expect.poll(() => composer.evaluate(element => getComputedStyle(element).paddingTop)).toBe('32px');
  const before = await composer.boundingBox();
  const move = await page.getByLabel('移动选中区域', { exact: true }).boundingBox();
  await page.mouse.move(move!.x + move!.width / 2, move!.y + move!.height / 2);
  await page.mouse.down();
  await page.mouse.move(move!.x + move!.width / 2 + 40, move!.y + move!.height / 2 + 20, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await composer.boundingBox())!.x - before!.x)).toBe(40);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => Math.round((await composer.boundingBox())!.x - before!.x)).toBe(0);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => Math.round((await composer.boundingBox())!.x - before!.x)).toBe(40);
  const resizeBefore = await composer.boundingBox();
  const resize = await page.getByLabel('调整选中区域大小', { exact: true }).boundingBox();
  await page.mouse.move(resize!.x + resize!.width / 2, resize!.y + resize!.height / 2);
  await page.mouse.down();
  await page.mouse.move(resize!.x + resize!.width / 2 + 24, resize!.y + resize!.height / 2 + 18, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await composer.boundingBox())!.height - resizeBefore!.height)).toBe(18);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => Math.round((await composer.boundingBox())!.height)).toBe(Math.round(resizeBefore!.height));
  await page.getByLabel('区域高度', { exact: true }).fill('420');
  await page.getByLabel('区域高度', { exact: true }).press('Tab');
  await expect.poll(async () => Math.round((await composer.boundingBox())!.height)).toBe(420);
  await page.reload();
  await expect.poll(() => composer.evaluate(element => getComputedStyle(element).paddingTop)).toBe('32px');
  await expect.poll(async () => Math.round((await composer.boundingBox())!.height)).toBe(420);
});

test('UI7 Chinese composition remains editable and tool pages expose their own layout regions', async ({ page }) => {
  await page.goto('/design-panel.html');
  const title = page.locator('[data-copy-key="history-title"]');
  await title.dblclick();
  await title.fill('中文作品记录');
  await title.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
  await expect(title).toHaveAttribute('contenteditable', 'plaintext-only');
  await title.press('Enter');
  await expect(title).not.toHaveAttribute('contenteditable', /.+/);
  await title.dblclick();
  await title.fill('放弃这次修改');
  await title.press('Escape');
  await expect(title).toHaveText('中文作品记录');
  await page.getByRole('button', { name: '编辑布局', exact: true }).click();
  for (const [label, id] of [['视频拆解', 'decompose-upload'], ['素材识别', 'recognize-upload']]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    const region = page.locator(`[data-design-id="${id}"]`);
    await region.click({ position: { x: 20, y: 20 } });
    await expect(region).toHaveClass(/design-selected/);
    await expect(page.getByLabel('区域宽度', { exact: true })).toBeVisible();
    const before = await region.boundingBox();
    await page.getByLabel('移动选中区域', { exact: true }).press('Shift+ArrowRight');
    await expect.poll(async () => Math.round((await region.boundingBox())!.x - before!.x)).toBe(10);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => Math.round((await region.boundingBox())!.x - before!.x)).toBe(0);
  }
});
