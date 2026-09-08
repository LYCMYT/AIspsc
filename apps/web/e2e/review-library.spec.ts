import type { Page } from '@playwright/test';
import { expect, loadReferenceDemo, resetScenario, selectGenerationMode, test } from './fixtures';

async function resetEmpty(page: Page) {
  await resetScenario(page, 'empty');
}

async function generate(page: Page, mode: '视频生成' | '图片生成' | '文案生成', prompt: string) {
  await page.goto('/create');
  await selectGenerationMode(page, mode);
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByTestId('batch-card').first().getByText('生成成功', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
}

async function approveAndSave(page: Page, mode: 'video' | 'image' | 'copy') {
  await page.getByRole('button', { name: '人工审核' }).first().click();
  if (mode === 'video') {
    await page.getByRole('spinbutton', { name: '人工综合分（1–10 整数）' }).fill('8');
  } else {
    await page.getByRole('checkbox', { name: '输出可读取' }).check();
    await page.getByRole('checkbox', { name: '符合任务要求' }).check();
  }
  await page.getByRole('button', { name: '保存审核' }).click();
  await expect(page.getByText('通过未入库', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '入库' }).first().click();
  await expect(page.getByText('已入库', { exact: true }).first()).toBeVisible();
}

test('T08 video, image, and copy each require review followed by a separate save action', async ({ page }) => {
  await resetEmpty(page);
  await generate(page, '视频生成', '光影几何视频展示');
  await approveAndSave(page, 'video');
  await generate(page, '图片生成', '蓝紫几何商品主图');
  await approveAndSave(page, 'image');
  await generate(page, '文案生成', '为几何包装写一条演示文案');
  await approveAndSave(page, 'copy');
  await page.screenshot({ path: `${process.env.UI_EVIDENCE_DIR ?? '.ai/evidence'}/T08-three-mode-library.png`, fullPage: true });
});

test('T07 saved output is visibly invalidated after a rejected review revision', async ({ page }) => {
  await resetEmpty(page);
  await generate(page, '视频生成', '用于审核改判的几何视频');
  await approveAndSave(page, 'video');
  await page.getByRole('button', { name: '改判' }).first().click();
  await page.getByRole('checkbox', { name: '任务要求的商品完全缺失' }).check();
  await page.getByRole('textbox', { name: '审核备注' }).fill('商品未按任务要求出现');
  await page.getByRole('textbox', { name: '改判原因' }).fill('复核后发现严重问题');
  await page.getByRole('button', { name: '保存审核' }).click();
  await expect(page.getByText(/审核已改判，原资产审核已失效/)).toBeVisible();
  await page.screenshot({ path: `${process.env.UI_EVIDENCE_DIR ?? '.ai/evidence'}/T07-review-invalidated.png`, fullPage: true });

  await page.getByRole('button', { name: '改判' }).first().click();
  await page.getByRole('spinbutton', { name: '人工综合分（1–10 整数）' }).fill('8');
  await page.getByRole('textbox', { name: '改判原因' }).fill('复核后确认可以通过');
  await page.getByRole('button', { name: '保存审核' }).click();
  await expect(page.getByRole('button', { name: '入库', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '入库', exact: true }).click();
  await expect(page.getByText(/审核已改判，原资产审核已失效/)).toHaveCount(0);
});

test('T08 mode parameters stay isolated and copy mode asks before removing references', async ({ page }) => {
  await resetEmpty(page);
  await page.getByRole('button', { name: '生成参数' }).click();
  await page.getByRole('spinbutton', { name: '时长（秒）' }).fill('15');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '生成参数', exact: true })).toBeFocused();
  await loadReferenceDemo(page);

  await selectGenerationMode(page, '图片生成');
  await selectGenerationMode(page, '视频生成');
  await page.getByRole('button', { name: '生成参数' }).click();
  await expect(page.getByRole('spinbutton', { name: '时长（秒）' })).toHaveValue('15');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '生成参数', exact: true })).toBeFocused();

  await selectGenerationMode(page, '文案生成');
  const confirmation = page.getByRole('dialog', { name: '移除参考素材' });
  await expect(confirmation).toBeVisible();
  await expect(page.getByRole('combobox', { name: '生成类型' })).toHaveAttribute('data-value', 'video');
  await confirmation.getByRole('button', { name: '确认移除并切换' }).click();
  await expect(page.getByText('文案生成不接受参考素材', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '生成类型' })).toHaveAttribute('data-value', 'copy');
  await expect(page.getByRole('region', { name: '参考素材' })).toHaveCount(0);
});

test('T05 image mode asks before removing an incompatible video reference', async ({ page }) => {
  await resetEmpty(page);
  await loadReferenceDemo(page, '参考视频');
  await selectGenerationMode(page, '图片生成');
  const confirmation = page.getByRole('dialog', { name: '移除参考素材' });
  await expect(confirmation).toContainText('图片生成不接受参考视频');
  await expect(page.getByRole('combobox', { name: '生成类型' })).toHaveAttribute('data-value', 'video');
});
