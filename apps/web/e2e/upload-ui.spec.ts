import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, selectMenuValue, unknownPng } from './fixtures';

async function drop(page: Page, files: { name: string; type: string; bytes: number[] }[]) {
  const transfer = await page.evaluateHandle((items) => {
    const data = new DataTransfer();
    for (const item of items) data.items.add(new File([new Uint8Array(item.bytes)], item.name, { type: item.type }));
    return data;
  }, files);
  await page.getByTestId('upload-dropzone').dispatchEvent('dragenter', { dataTransfer: transfer });
  await page.getByTestId('upload-dropzone').dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
}

test('UI2 A10 A11 recognize drag/drop reads real file and persists it without claiming AI recognition', async ({ page }) => {
  await page.goto('/recognize');
  const bytes = [...await unknownPng(page)];
  await expect(page.getByTestId('upload-dropzone')).toBeVisible();
  await expect(page.getByLabel('上传识别素材')).toBeEnabled();
  await drop(page, [{ name: '拖拽素材.png', type: 'image/png', bytes }]);
  await expect(page.getByText('内容识别未执行', { exact: true })).toBeVisible();
  await expect(page.locator('img')).toHaveJSProperty('naturalWidth', 120);
  await expect(page.getByText('几何图形', { exact: true })).toHaveCount(0);
  await page.getByLabel('人工标签').fill('拖拽确认');
  await page.getByRole('button', { name: '保存人工标签', exact: true }).click();
  await expect(page.getByText('人工标签已保存')).toBeVisible();
  await page.reload();
  await selectMenuValue(page, '选择识别素材', '拖拽素材.png');
  await expect(page.getByLabel('人工标签')).toHaveValue('拖拽确认');
  await expect(page.locator('img')).toHaveJSProperty('naturalWidth', 120);
});

test('UI2 A19 upload errors recover; multiple files rejected and same file can be selected again', async ({ page }) => {
  await page.goto('/recognize');
  await expect(page.getByLabel('上传识别素材')).toBeEnabled();
  await drop(page, [{ name: 'invalid.txt', type: 'text/plain', bytes: [1] }]);
  await expect(page.getByTestId('upload-dropzone').getByRole('alert')).toContainText('不支持此文件格式');
  const bytes = [...await unknownPng(page)];
  await drop(page, [{ name: 'a.png', type: 'image/png', bytes }, { name: 'b.png', type: 'image/png', bytes }]);
  await expect(page.getByTestId('upload-dropzone').getByRole('alert')).toContainText('单次请选择一个文件');
  await page.getByLabel('上传识别素材').setInputFiles({ name: 'same.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect(page.getByText('内容识别未执行', { exact: true })).toBeVisible();
  await expect(page.getByLabel('上传识别素材')).toHaveValue('');
  await page.getByRole('button', { name: '移除文件', exact: true }).click();
  await expect(page.getByText('暂无识别结果')).toBeVisible();
  await page.getByLabel('上传识别素材').setInputFiles({ name: 'same.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect(page.getByText('内容识别未执行', { exact: true })).toBeVisible();
  await expect(page.getByTestId('upload-dropzone').getByRole('alert')).toHaveCount(0);
});

test('UI2 A09 A10 replacing split fixture with dropped upload clears clips and prevents false downloads', async ({ page }) => {
  await page.goto('/decompose');
  await page.getByRole('button', { name: '使用固定测试视频' }).click();
  await page.getByRole('button', { name: '规划区间', exact: true }).click();
  await expect(page.getByRole('link', { name: '下载切片 1' })).toBeVisible();
  const manifest = JSON.parse(readFileSync('apps/web/public/demo/MEDIA_MANIFEST.json', 'utf8'));
  const entry = manifest.files.find((file: { key: string }) => file.key === 'scene-source');
  const bytes = [...Buffer.concat([readFileSync(`apps/web/public/demo/${entry.path}`), Buffer.from('UI2 unique source')])];
  await drop(page, [{ name: '自己的视频.mp4', type: 'video/mp4', bytes }]);
  await expect(page.getByRole('heading', { name: /区间列表/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '自己的视频.mp4' })).toBeVisible();
  await page.getByRole('button', { name: '规划区间', exact: true }).click();
  await expect(page.getByText('尚未生成切片文件', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /下载切片/ })).toHaveCount(0);
  await page.getByRole('button', { name: '场景检测', exact: true }).click();
  await page.getByRole('button', { name: '规划区间', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('未知素材不能使用固定场景检测样例');
});

test('UI2 A17 upload zone and keyboard button each open one real file chooser', async ({ page }) => {
  await page.goto('/recognize');
  await expect(page.getByLabel('上传识别素材')).toBeEnabled();
  let chooserCount = 0;
  page.on('filechooser', () => { chooserCount += 1; });
  const clickChooser = page.waitForEvent('filechooser');
  await page.getByRole('heading', { name: '点击或拖拽素材到此处' }).click();
  await (await clickChooser).setFiles([]);
  expect(chooserCount).toBe(1);
  const button = page.getByRole('button', { name: '上传素材', exact: true });
  await button.focus();
  const keyboardChooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await keyboardChooser).setFiles({ name: 'keyboard.png', mimeType: 'image/png', buffer: await unknownPng(page) });
  await expect(page.getByText('内容识别未执行', { exact: true })).toBeVisible();
  expect(chooserCount).toBe(2);
});

test('UI2 switching split mode while reading a replacement keeps the successfully uploaded source', async ({ page }) => {
  await page.goto('/decompose');
  await page.getByRole('button', { name: '使用固定测试视频' }).click();
  await expect(page.getByRole('button', { name: '规划区间', exact: true })).toBeEnabled();
  const manifest = JSON.parse(readFileSync('apps/web/public/demo/MEDIA_MANIFEST.json', 'utf8'));
  const entry = manifest.files.find((file: { key: string }) => file.key === 'scene-source');
  const buffer = Buffer.concat([readFileSync(`apps/web/public/demo/${entry.path}`), Buffer.from('UI2 delayed metadata')]);
  // Hold actual hashing at the media boundary, without modifying production service behavior.
  await page.evaluate(() => {
    const state = window as typeof window & { releaseUpload?: () => void; hashingUpload?: boolean };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const gate = new Promise<void>((resolve) => { state.releaseUpload = resolve; });
    crypto.subtle.digest = async (algorithm, data) => { state.hashingUpload = true; await gate; return digest(algorithm, data); };
  });
  await page.getByLabel('上传拆解视频').setInputFiles({ name: '模式切换上传.mp4', mimeType: 'video/mp4', buffer });
  await expect.poll(() => page.evaluate(() => (window as typeof window & { hashingUpload?: boolean }).hashingUpload)).toBe(true);
  await expect(page.getByTestId('upload-dropzone').getByRole('status')).toContainText('正在读取文件');
  await page.getByRole('button', { name: '平均拆解', exact: true }).click();
  await page.evaluate(() => (window as typeof window & { releaseUpload?: () => void }).releaseUpload?.());
  await expect(page.getByRole('heading', { name: '模式切换上传.mp4' })).toBeVisible();
  await expect(page.getByRole('button', { name: '平均拆解', exact: true })).toHaveClass(/active/);
});

test('UI2 rejected media bytes show a local error and a valid file recovers', async ({ page }) => {
  await page.goto('/recognize');
  await expect(page.getByLabel('上传识别素材')).toBeEnabled();
  await page.getByLabel('上传识别素材').setInputFiles({ name: 'damaged.png', mimeType: 'image/png', buffer: Buffer.from('not a png') });
  await expect(page.getByTestId('upload-dropzone').getByRole('alert')).toContainText('文件类型与内容不符');
  await page.getByLabel('上传识别素材').setInputFiles({ name: 'recovered.png', mimeType: 'image/png', buffer: await unknownPng(page) });
  await expect(page.getByText('内容识别未执行', { exact: true })).toBeVisible();
  await expect(page.getByTestId('upload-dropzone').getByRole('alert')).toHaveCount(0);
});

test('UI2 empty and oversize files are rejected before storage and selecting a sample clears errors', async ({ page }) => {
  await page.goto('/recognize');
  await expect(page.getByLabel('上传识别素材')).toBeEnabled();
  await drop(page, [{ name: 'empty.png', type: 'image/png', bytes: [] }]);
  await expect(page.getByTestId('upload-dropzone').getByRole('alert')).toContainText('文件不能为空');
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(200 * 1024 * 1024 + 1)], 'too-large.mp4', { type: 'video/mp4' }));
    return data;
  });
  await page.getByTestId('upload-dropzone').dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
  await expect(page.getByTestId('upload-dropzone').getByRole('alert')).toContainText('文件不能超过 200 MB');
  await expect(page.getByText('暂无识别结果')).toBeVisible();
  await page.getByRole('button', { name: '使用识别样例' }).click();
  await expect(page.getByText('几何图形', { exact: true })).toBeVisible();
  await expect(page.getByTestId('upload-dropzone').getByRole('alert')).toHaveCount(0);
});
