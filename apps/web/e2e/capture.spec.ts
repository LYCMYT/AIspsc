import { test, expect, loadReferenceDemo, resetScenario, unknownPng } from './fixtures';
import type { Locator, Page, TestInfo } from '@playwright/test';

const sizes = [{ width: 1672, height: 941 }, { width: 1440, height: 900 }, { width: 1280, height: 800 }];
async function capture(page: Page, info: TestInfo, name: string, region?: Locator) {
  const hasPopover = await page.getByRole('listbox').count() > 0;
  if (await page.getByRole('dialog').count() === 0 && !hasPopover) await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('img')].every((img) => !img.getClientRects().length || (img.complete && img.naturalWidth > 0)))).toBe(true);
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('video')].every((video) => !video.getClientRects().length || video.readyState > 0))).toBe(true);
  await page.evaluate(async () => {
    await Promise.all([...document.querySelectorAll('video')].filter((video) => video.getClientRects().length).map(async (video) => {
      video.preload = 'auto'; video.currentTime = 0.25;
      await video.play(); video.pause();
    }));
  });
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('video')].every((video) => !video.getClientRects().length || (video.readyState >= 2 && !video.seeking)))).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const path = `${process.env.UI_EVIDENCE_DIR ?? '.ai/evidence'}/screenshots/${page.viewportSize()!.width}/${name}.png`;
  if (region) await region.screenshot({ path, animations: 'disabled' });
  else await page.screenshot({ path, fullPage: await page.getByRole('dialog').count() === 0 && !hasPopover, animations: 'disabled' });
  if (hasPopover) await expect(page.getByRole('listbox')).toBeVisible();
  await info.attach(name, { path, contentType: 'image/png' });
}

for (const viewport of sizes) {
  test(`@capture A16 A17 three-size complete business states ${viewport.width}`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    await page.clock.setFixedTime(new Date('2026-09-08T08:00:00Z'));
    await resetScenario(page, 'seed');
    await capture(page, info, '23-create-empty');
    await page.getByLabel('Prompt', { exact: true }).fill('蓝紫光影中的几何商品包装缓慢旋转展示，保留干净背景与完整轮廓。');
    await loadReferenceDemo(page);
    await expect(page.locator('.reference-slot img')).toBeVisible();
    await capture(page, info, '01-create-with-reference');
    await page.getByRole('combobox', { name: '参考方式', exact: true }).click();
    await expect(page.getByRole('option', { name: '首尾帧', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await capture(page, info, '24-reference-method-dropdown');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '上传素材', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '选择参考素材' })).toBeVisible();
    await capture(page, info, '20-reference-picker');
    await page.keyboard.press('Escape');
    await page.getByRole('combobox', { name: '生成类型', exact: true }).click();
    await expect(page.getByRole('listbox', { name: '生成类型' })).toBeVisible();
    await capture(page, info, '21-mode-dropdown');
    await page.keyboard.press('Escape');
    const trigger = page.getByRole('button', { name: '生成参数' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '生成参数', exact: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Tab');
    await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await trigger.click();
    await capture(page, info, '02-parameters-focus');
    await expect(dialog.getByRole('radiogroup', { name: '选择比例', exact: true })).toBeVisible();
    await capture(page, info, '22-parameter-groups', dialog);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await resetScenario(page, 'partial_success');
    await page.getByRole('link', { name: '历史记录', exact: true }).click();
    await expect(page.getByTestId('batch-card').getByText('部分成功', { exact: true })).toBeVisible();
    await expect.poll(() => page.locator('video').first().evaluate((video) => (video as HTMLVideoElement).readyState)).toBeGreaterThan(0);
    await capture(page, info, '03-partial-history');
    await page.getByRole('button', { name: '人工审核', exact: true }).first().click();
    await capture(page, info, '04-review-rubric');
    await page.getByRole('button', { name: '保存审核', exact: true }).scrollIntoViewIfNeeded();
    await capture(page, info, '05-review-technical-and-decision');
    await page.getByRole('button', { name: '保存审核', exact: true }).click();
    await expect(page.getByText('通过未入库', { exact: true })).toBeVisible();
    await capture(page, info, '06-approved-awaiting-manual-save');
    await page.getByRole('button', { name: '入库', exact: true }).click();
    await expect(page.getByText('已入库', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: '资产库', exact: true }).click();
    await expect(page.locator('.asset-card')).toHaveCount(5);
    await capture(page, info, '07-assets-with-approved-result');
    await page.getByRole('button', { name: '额度流水', exact: true }).click();
    await capture(page, info, '08-quota-ledger');
    await page.keyboard.press('Escape');

    await page.getByRole('link', { name: '视频拆解', exact: true }).click();
    await page.getByRole('button', { name: '使用固定测试视频', exact: true }).click();
    for (const [mode, name] of [['顺序拆解', '09-split-sequential'], ['平均拆解', '10-split-average'], ['场景检测', '11-split-scene'], ['手动区间', '12-split-manual']] as const) {
      await page.getByRole('button', { name: mode, exact: true }).click();
      await page.getByRole('button', { name: '规划区间', exact: true }).click();
      await expect(page.getByRole('heading', { name: /区间列表/ })).toBeVisible();
      const carousel = page.getByRole('region', { name: '视频片段轮播', exact: true });
      await expect(carousel.getByRole('region', { name: '片段帧预览' }).getByRole('img')).toHaveCount(5);
      await capture(page, info, name);
      await capture(page, info, `carousel-${name}`, carousel);
    }
    await page.getByRole('link', { name: '素材识别', exact: true }).click();
    const png = await unknownPng(page);
    await page.getByLabel('上传识别素材').setInputFiles({ name: '人工上传示例.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByText('内容识别未执行', { exact: true })).toBeVisible();
    await capture(page, info, '13-unrecognized-upload');

    await resetScenario(page, 'missing_file');
    await page.getByRole('link', { name: '资产库', exact: true }).click();
    await expect(page.getByText('文件需重新选择', { exact: true }).first()).toBeVisible();
    await capture(page, info, '14-missing-file');
    await resetScenario(page, 'failure');
    await page.getByRole('link', { name: '历史记录', exact: true }).click();
    await expect(page.getByRole('button', { name: '重新生成', exact: true })).toBeVisible();
    await capture(page, info, '15-failed-history');
    await resetScenario(page, 'empty');
    await page.getByRole('link', { name: '历史记录', exact: true }).click();
    await expect(page.getByText('暂无历史记录', { exact: true })).toBeVisible();
    await capture(page, info, '16-empty-history');
    await page.getByRole('link', { name: '视频拆解', exact: true }).click();
    await expect(page.getByText('暂无拆解内容')).toBeVisible();
    await capture(page, info, '17-split-upload');
    await page.getByRole('link', { name: '素材识别', exact: true }).click();
    await expect(page.getByText('暂无识别结果')).toBeVisible();
    await capture(page, info, '18-recognize-upload');
    await page.getByLabel('上传识别素材').setInputFiles({ name: '错误文件.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid') });
    await expect(page.getByTestId('upload-dropzone').getByRole('alert')).toBeVisible();
    await capture(page, info, '19-upload-error');
  });
}
