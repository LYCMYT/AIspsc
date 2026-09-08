import { readFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { test, expect } from './fixtures';

test('UI4 design panel supports editable copy, styling, five views and portable offline export', async ({ page, browser }, info) => {
  await page.goto('/design-panel.html');
  await expect(page.getByText('设计预览', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '导出修改稿', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '导出 HTML', exact: true })).toBeVisible();
  for (const name of ['资产库', '历史记录', '视频拆解', '素材识别', '创作']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
  }
  const title = page.locator('[data-copy-key="history-title"]');
  const original = await title.textContent();
  await page.getByRole('button', { name: '编辑文案', exact: true }).click();
  await title.click();
  await page.getByLabel('选中文案', { exact: true }).fill('我的创作 <修改稿>');
  await expect(title).toHaveText('我的创作 <修改稿>');
  await page.getByLabel('圆角', { exact: true }).focus();
  await page.keyboard.press('End');
  await expect.poll(() => page.locator('.composer').evaluate(element => getComputedStyle(element).borderTopLeftRadius)).toBe('26px');
  await page.reload();
  await expect(title).toHaveText('我的创作 <修改稿>');
  await expect(page.getByLabel('圆角', { exact: true })).toHaveValue('26');
  const jsonDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出修改稿', exact: true }).click();
  await (await jsonDownload).saveAs(info.outputPath('design-draft.json'));
  const draft = JSON.parse(readFileSync(info.outputPath('design-draft.json'), 'utf8'));
  expect(draft.tokens.radius).toBe(26);
  expect(draft.texts['history-title']).toBe('我的创作 <修改稿>');
  await page.getByRole('button', { name: '编辑文案', exact: true }).click();
  await title.click();
  const htmlDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 HTML', exact: true }).click();
  const htmlPath = info.outputPath('design-panel.html');
  await (await htmlDownload).saveAs(htmlPath);
  const offline = await browser.newContext({ offline: true, viewport: { width: 1440, height: 900 } });
  const standalone = await offline.newPage();
  const errors: string[] = [];
  standalone.on('pageerror', error => errors.push(error.message));
  standalone.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await standalone.goto(pathToFileURL(htmlPath).href);
    await expect(standalone.locator('[data-copy-key="history-title"]')).toHaveText('我的创作 <修改稿>');
    await expect(standalone.getByLabel('圆角', { exact: true })).toHaveValue('26');
    await expect(standalone.getByRole('button', { name: '编辑文案', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(standalone.getByLabel('选中文案', { exact: true })).toBeDisabled();
    await standalone.getByRole('button', { name: '恢复默认设计', exact: true }).click();
    await expect(standalone.locator('[data-copy-key="history-title"]')).toHaveText(original!);
    await expect(standalone.getByLabel('圆角', { exact: true })).toHaveValue('16');
    expect(errors).toEqual([]);
  } finally { await offline.close(); }
});

test('UI4 imports are bounded, invalid drafts preserve design and preview parameters reject invalid values', async ({ page }) => {
  await page.goto('/design-panel.html');
  const draft = { version: 1, view: 'create', tokens: { radius: -999, sidebarWidth: 1e308, contentGap: 999, baseSize: 0, accent: 'url(https://bad.example)' }, texts: { 'history-title': '<img src=x onerror=alert(1)>' } };
  await page.getByLabel('导入修改稿 JSON', { exact: true }).setInputFiles({ name: 'bounded.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(draft)) });
  await expect(page.locator('[data-copy-key="history-title"]')).toHaveText(draft.texts['history-title']);
  await expect(page.locator('[data-copy-key="history-title"] img')).toHaveCount(0);
  await expect.poll(() => page.getByLabel('侧栏宽度', { exact: true }).inputValue()).toBe('280');
  await expect(page.getByLabel('圆角', { exact: true })).toHaveValue('8');
  await expect(page.getByLabel('正文字号', { exact: true })).toHaveValue('12');
  await page.getByLabel('导入修改稿 JSON', { exact: true }).setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{ invalid') });
  await expect(page.locator('#design-status')).toContainText('格式无效');
  await expect(page.locator('[data-copy-key="history-title"]')).toHaveText(draft.texts['history-title']);
  await page.getByRole('button', { name: '恢复默认设计', exact: true }).click();
  await page.getByRole('button', { name: '上传素材', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择参考素材' });
  for (const role of ['参考视频', '模特', '产品', '背景']) await expect(picker.getByRole('tab', { name: role, exact: true })).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => picker.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '上传素材', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '生成参数', exact: true }).click();
  const params = page.getByRole('dialog', { name: '生成参数' });
  await params.getByLabel('时长（秒）', { exact: true }).fill('16');
  await params.getByLabel('时长（秒）', { exact: true }).press('Tab');
  await expect(params).toBeVisible();
  await expect(params.getByLabel('时长（秒）', { exact: true })).toHaveValue('16');
  await expect(page.locator('#design-status')).toContainText('时长必须是 5–15 秒整数');
  await params.getByLabel('时长（秒）', { exact: true }).fill('15');
  await params.getByRole('radiogroup', { name: '选择生成数量', exact: true }).getByRole('radio', { name: '4', exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(params).toBeHidden();
  await page.getByRole('combobox', { name: '生成类型', exact: true }).click();
  await page.getByRole('option', { name: /图片生成/ }).click();
  await page.getByRole('button', { name: '生成参数', exact: true }).click();
  await expect(params.getByRole('radio', { name: '1:1', exact: true })).toBeChecked();
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: '生成类型', exact: true }).click();
  await page.getByRole('option', { name: /文案生成/ }).click();
  await expect(page.getByRole('button', { name: '上传素材', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '生成参数', exact: true }).click();
  await expect(params.getByRole('radiogroup', { name: '选择生成数量', exact: true })).toBeVisible();
  await params.getByLabel('最多字符', { exact: true }).fill('2000');
  await page.keyboard.press('Escape');
  await expect(params).toBeHidden();
});

test('UI8 design panel menus and parameters stay below their triggers in a short viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.goto('/design-panel.html');
  const mode = page.getByRole('combobox', { name: '生成类型', exact: true });
  await mode.click();
  const menu = page.getByRole('listbox', { name: '生成类型选项', exact: true });
  const modeBounds = await mode.boundingBox();
  const menuBounds = await menu.boundingBox();
  expect(menuBounds!.y).toBeGreaterThanOrEqual(modeBounds!.y + modeBounds!.height + 4);
  expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(609);
  await page.keyboard.press('Escape');
  await expect(mode).toBeFocused();

  const parameters = page.getByRole('button', { name: '生成参数', exact: true });
  await parameters.click();
  const dialog = page.getByRole('dialog', { name: '生成参数', exact: true });
  const parameterBounds = await parameters.boundingBox();
  const dialogBounds = await dialog.boundingBox();
  expect(dialogBounds!.y).toBeGreaterThanOrEqual(parameterBounds!.y + parameterBounds!.height + 4);
  expect(dialogBounds!.y + dialogBounds!.height).toBeLessThanOrEqual(609);
  await page.keyboard.press('Escape');

  await mode.click();
  await page.getByRole('option', { name: /文案生成/ }).click();
  await parameters.click();
  const language = dialog.getByRole('combobox', { name: '语言', exact: true });
  const length = dialog.getByRole('spinbutton', { name: '最多字符', exact: true });
  await language.click();
  const languageMenu = page.getByRole('listbox', { name: '语言选项', exact: true });
  await page.keyboard.press('Tab');
  await expect(length).toBeFocused();
  await expect(languageMenu).toBeHidden();
  await expect(language).toHaveAttribute('aria-expanded', 'false');

  await language.click();
  await page.setViewportSize({ width: 1280, height: 680 });
  await expect.poll(async () => {
    const triggerBounds = await language.boundingBox();
    const listBounds = await languageMenu.boundingBox();
    return Math.round(listBounds!.y - (triggerBounds!.y + triggerBounds!.height));
  }).toBe(8);
});

for (const viewport of [{ width: 1672, height: 941 }, { width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
  test(`@capture UI4 editable panel at ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto('/design-panel.html');
    const directory = `${process.env.UI_PANEL_EVIDENCE_DIR ?? '.ai/evidence/UI4'}/screenshots/${viewport.width}`;
    mkdirSync(directory, { recursive: true });
    for (const [name, file] of [['创作', 'create'], ['资产库', 'assets'], ['历史记录', 'history'], ['视频拆解', 'decompose'], ['素材识别', 'recognize']] as const) {
      await page.getByRole('button', { name, exact: true }).click();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect.poll(() => page.locator('.product-preview').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const path = `${directory}/${file}.png`;
      await page.screenshot({ path, animations: 'disabled' });
      await info.attach(file, { path, contentType: 'image/png' });
    }
    await page.getByRole('button', { name: '创作', exact: true }).click();
    await page.getByRole('button', { name: '上传素材', exact: true }).click();
    await page.screenshot({ path: `${directory}/reference-dialog.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.getByRole('combobox', { name: '生成类型', exact: true }).click();
    await page.screenshot({ path: `${directory}/mode-menu.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.getByRole('combobox', { name: '参考方式', exact: true }).click();
    await expect(page.getByRole('option', { name: '首尾帧', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await page.screenshot({ path: `${directory}/reference-method.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '生成参数', exact: true }).click();
    await page.screenshot({ path: `${directory}/parameters.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
    const inlineTitle = page.locator('[data-copy-key="history-title"]');
    await inlineTitle.dblclick();
    await inlineTitle.fill('我的作品记录');
    await page.screenshot({ path: `${directory}/inline-copy.png`, animations: 'disabled' });
    await page.keyboard.press('Tab');
    await page.getByRole('button', { name: '编辑布局', exact: true }).click();
    await page.locator('[data-design-id="create-composer"]').click({ position: { x: 30, y: 20 } });
    await page.screenshot({ path: `${directory}/direct-editor.png`, animations: 'disabled' });
  });
}
