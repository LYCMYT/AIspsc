import { readFileSync } from 'node:fs';
import { expect, loadReferenceDemo, resetScenario, selectGenerationMode, test, unknownPng } from './fixtures';

test('UI3 creation opens a role picker only after clicking the upload tile', async ({ page }) => {
  await resetScenario(page, 'empty');
  await expect(page.getByRole('dialog', { name: '选择参考素材' })).toHaveCount(0);
  await page.getByRole('button', { name: '上传素材', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择参考素材' });
  await expect(picker).toBeVisible();
  for (const role of ['参考视频', '模特', '产品', '背景']) await expect(picker.getByRole('tab', { name: role, exact: true })).toBeVisible();
  await picker.getByRole('tab', { name: '产品', exact: true }).click();
  await picker.getByRole('button', { name: '载入演示参考', exact: true }).click();
  await picker.getByRole('button', { name: '完成选择', exact: true }).click();
  await expect(page.getByRole('region', { name: '参考素材' }).getByRole('img')).toBeVisible();
  await page.getByLabel('Prompt', { exact: true }).fill('   ');
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Prompt 不能为空');
  await expect(page.locator('.quota-value')).toHaveText('1286');
});

test('UI3 mode and parameter dropdowns are keyboard accessible and nested Escape preserves the parameter panel', async ({ page }) => {
  await page.goto('/create');
  const mode = page.getByRole('combobox', { name: '生成类型', exact: true });
  await mode.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox', { name: '生成类型' })).toBeVisible();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(mode).toContainText('图片生成');
  const trigger = page.getByRole('button', { name: '生成参数', exact: true });
  await trigger.click();
  const panel = page.getByRole('dialog', { name: '生成参数', exact: true });
  const ratio = panel.getByRole('radiogroup', { name: '选择比例', exact: true });
  await ratio.getByRole('radio', { name: '1:1', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(ratio.getByRole('radio', { name: '16:9', exact: true })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await selectGenerationMode(page, '文案生成');
  await trigger.click();
  const copyPanel = page.getByRole('dialog', { name: '生成参数', exact: true });
  await copyPanel.getByRole('combobox', { name: '语言', exact: true }).click();
  await expect(page.getByRole('listbox', { name: '语言', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: '语言', exact: true })).toHaveCount(0);
  await expect(copyPanel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(copyPanel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('UI3 split carousel reads real frames for the selected interval and frame click seeks the video', async ({ page }) => {
  await page.goto('/decompose');
  await page.getByRole('button', { name: '使用固定测试视频', exact: true }).click();
  await page.getByRole('button', { name: '规划区间', exact: true }).click();
  const carousel = page.getByRole('region', { name: '视频片段轮播', exact: true });
  await expect(carousel).toBeVisible();
  const frames = carousel.getByRole('region', { name: '片段帧预览', exact: true }).getByRole('img');
  await expect(frames).toHaveCount(5);
  await expect.poll(() => frames.evaluateAll((images) => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  const firstPixels = await frames.first().getAttribute('src');
  const firstFingerprint = await frames.first().evaluate(image => {
    const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 24;
    const context = canvas.getContext('2d')!; context.drawImage(image as HTMLImageElement, 0, 0, 24, 24);
    return [...context.getImageData(0, 0, 24, 24).data];
  });
  await carousel.getByRole('button', { name: '下一个片段', exact: true }).click();
  await expect(frames.first()).toHaveAttribute('alt', '片段 2 帧 1');
  await expect(frames).toHaveCount(5);
  await expect.poll(() => frames.first().getAttribute('src')).not.toBe(firstPixels);
  await expect.poll(() => frames.first().evaluate(image => {
    const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 24;
    const context = canvas.getContext('2d')!; context.drawImage(image as HTMLImageElement, 0, 0, 24, 24);
    return [...context.getImageData(0, 0, 24, 24).data];
  })).not.toEqual(firstFingerprint);
  await expect.poll(() => frames.evaluateAll(images => images.every(image => { const ms = Number(image.getAttribute('data-source-time-ms')); return ms >= 15000 && ms < 30000; }))).toBe(true);
  await carousel.getByRole('button', { name: '定位到帧 3', exact: true }).click();
  await expect.poll(() => carousel.locator('video').evaluate(video => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(5);
});

test('UI3 upload modal assigns the explicit role and only closes after real upload; picker restores focus', async ({ page }) => {
  await resetScenario(page, 'empty');
  const trigger = page.getByRole('button', { name: '上传素材', exact: true });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: '选择参考素材', exact: true });
  await picker.getByRole('tab', { name: '模特', exact: true }).click();
  await picker.locator('input[type=file]').setInputFiles({ name: '实际模特参考.png', mimeType: 'image/png', buffer: await unknownPng(page) });
  await picker.getByRole('button', { name: '完成选择', exact: true }).click();
  await expect(trigger).toBeFocused();
  const reference = page.getByRole('region', { name: '参考素材' });
  await expect(reference).toContainText('模特');
  await expect(reference).toContainText('实际模特参考.png');
  await page.getByLabel('Prompt', { exact: true }).fill('使用模特参考生成演示视频');
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page).toHaveURL(/\/history$/);
  await page.getByRole('button', { name: '只读详情', exact: true }).first().click();
  await expect(page.getByRole('dialog').locator('pre').first()).toContainText('"role": "person"');
});

test('UI3 unknown upload has real source-interval preview and frames without fake clip downloads', async ({ page }) => {
  await page.goto('/decompose');
  const manifest = JSON.parse(readFileSync('apps/web/public/demo/MEDIA_MANIFEST.json', 'utf8'));
  const entry = manifest.files.find((file: { key: string }) => file.key === 'scene-source');
  const buffer = Buffer.concat([readFileSync(`apps/web/public/demo/${entry.path}`), Buffer.from('UI3 source-only preview')]);
  await expect(page.getByLabel('上传拆解视频')).toBeEnabled();
  await page.getByLabel('上传拆解视频').setInputFiles({ name: '上传区间预览.mp4', mimeType: 'video/mp4', buffer });
  await page.getByRole('button', { name: '规划区间', exact: true }).click();
  const carousel = page.getByRole('region', { name: '视频片段轮播', exact: true });
  await expect(carousel).toContainText('源视频区间预览');
  await expect(carousel.getByRole('region', { name: '片段帧预览' }).getByRole('img')).toHaveCount(5);
  await carousel.getByRole('button', { name: '下一个片段', exact: true }).click();
  await expect(carousel.getByRole('img', { name: '片段 2 帧 1', exact: true })).toBeVisible();
  await carousel.getByRole('button', { name: '定位到帧 3', exact: true }).click();
  await expect.poll(() => carousel.locator('video').evaluate(video => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(20);
  await carousel.locator('video').evaluate(video => { (video as HTMLVideoElement).currentTime = 2; });
  await expect.poll(() => carousel.locator('video').evaluate(video => (video as HTMLVideoElement).currentTime)).toBe(15);
  await carousel.locator('video').evaluate(video => { (video as HTMLVideoElement).currentTime = 31; });
  await expect.poll(() => carousel.locator('video').evaluate(video => (video as HTMLVideoElement).currentTime)).toBeLessThan(30);
  await expect.poll(() => carousel.locator('video').evaluate(video => (video as HTMLVideoElement).paused)).toBe(true);
  await expect(page.getByRole('link', { name: /下载切片/ })).toHaveCount(0);
  await page.getByRole('button', { name: '移除文件', exact: true }).click();
  await expect(carousel).toHaveCount(0);
  await expect(page.getByRole('img', { name: /片段 \d+ 帧/ })).toHaveCount(0);
});

test('UI3 picker rejects a file with the wrong role and closing an in-flight selection prevents late attachment', async ({ page }) => {
  await resetScenario(page, 'empty');
  await page.getByRole('button', { name: '上传素材', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择参考素材' });
  await picker.getByRole('tab', { name: '参考视频', exact: true }).click();
  await picker.locator('input[type=file]').setInputFiles({ name: '并非视频.png', mimeType: 'image/png', buffer: await unknownPng(page) });
  await expect(picker.getByRole('alert')).toContainText('参考视频需要视频素材');
  await expect(page.locator('.selected-references .reference-slot')).toHaveCount(0);
  await picker.getByRole('tab', { name: '产品', exact: true }).click();
  await expect(picker.getByRole('alert')).toHaveCount(0);
  let releaseFetch!: () => void;
  const barrier = new Promise<void>(resolve => { releaseFetch = resolve; });
  await page.route('**/demo/**', async route => { await barrier; await route.continue(); });
  await picker.getByRole('button', { name: '载入演示参考', exact: true }).click();
  await expect(picker.getByRole('button', { name: '完成选择', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  releaseFetch();
  await page.unrouteAll({ behavior: 'wait' });
  await page.getByRole('button', { name: '上传素材', exact: true }).click();
  await expect(picker.getByRole('button', { name: '完成选择', exact: true })).toBeEnabled();
  await picker.getByRole('button', { name: '完成选择', exact: true }).click();
  await expect(page.locator('.selected-references .reference-slot')).toHaveCount(0);
});

test('UI3 frame extraction handles undecodable media and abort without leaking object URLs', async ({ page }) => {
  await page.goto('/decompose');
  const outcomes = await page.evaluate(async () => {
    const modulePath = '/src/features/decompose/videoFrames.ts';
    const { extractVideoFrames } = await import(/* @vite-ignore */ modulePath);
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    const outstanding = new Set<string>();
    URL.createObjectURL = blob => { const url = create(blob); outstanding.add(url); return url; };
    URL.revokeObjectURL = url => { outstanding.delete(url); revoke(url); };
    try {
      const invalid = new Blob(['not a video'], { type: 'video/mp4' });
      const interval = { startMs: 0, endMs: 5000 };
      let decodeRejected = false;
      try { await extractVideoFrames(invalid, interval, new AbortController().signal); } catch { decodeRejected = true; }
      const afterDecode = outstanding.size;
      const controller = new AbortController();
      const extraction = extractVideoFrames(invalid, interval, controller.signal);
      controller.abort();
      let abortName = '';
      try { await extraction; } catch (error) { abortName = (error as DOMException).name; }
      return { decodeRejected, afterDecode, abortName, afterAbort: outstanding.size };
    } finally {
      URL.createObjectURL = create; URL.revokeObjectURL = revoke;
    }
  });
  expect(outcomes).toEqual({ decodeRejected: true, afterDecode: 0, abortName: 'AbortError', afterAbort: 0 });
});

test('UI3 real generation history appears below the composer and incompatible references remain protected', async ({ page }) => {
  await resetScenario(page, 'partial_success');
  await expect(page.getByRole('heading', { name: '生成历史', exact: true })).toBeVisible();
  await expect(page.locator('.recent-card .badge').getByText('部分成功', { exact: true })).toBeVisible();
  await loadReferenceDemo(page, '参考视频');
  await page.getByRole('combobox', { name: '生成类型' }).click();
  await page.getByRole('option', { name: '图片生成', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '移除参考素材', exact: true });
  await expect(confirmation).toContainText('图片生成不接受参考视频');
  await confirmation.getByRole('button', { name: '保留并返回' }).click();
  await expect(page.getByRole('combobox', { name: '生成类型' })).toHaveAttribute('data-value', 'video');
});
