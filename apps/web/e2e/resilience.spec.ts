import type { Page } from '@playwright/test';
import { expect, resetScenario as reset, test } from './fixtures';

async function resetScenario(page: Page, value: string) {
  await reset(page, value);
  await page.goto('/history');
}

test('T07 unknown outcome is read-only until explicit simulated reconciliation', async ({ page }) => {
  await resetScenario(page, 'unknown');
  await expect(page.getByTestId('batch-card').getByText('待确认状态', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(0);
  await page.getByRole('button', { name: '模拟对账' }).click();
  await page.getByRole('button', { name: '对账为成功' }).click();
  await expect(page.getByTestId('batch-card').first().getByText('生成成功', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
});

test('T07 failed output can retry while retaining a link to the original item', async ({ page }) => {
  await resetScenario(page, 'failure');
  await expect(page.getByTestId('batch-card').getByText('生成失败', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '只读详情', exact: true }).click();
  const originalDetails = page.getByRole('dialog', { name: '任务只读详情' });
  await originalDetails.getByText('开发诊断', { exact: true }).click();
  const originalId = (await originalDetails.locator('dt').filter({ hasText: /^子任务 ID$/ }).locator('+ dd').innerText()).trim();
  await originalDetails.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '重新生成' }).click();
  const retry = page.getByTestId('batch-card').filter({ has: page.locator('small').filter({ hasText: /^重新生成$/ }) }).first();
  await expect(retry.locator('small').filter({ hasText: /^重新生成$/ })).toBeVisible();
  await retry.getByRole('button', { name: '只读详情', exact: true }).click();
  const details = page.getByRole('dialog', { name: '任务只读详情' });
  await details.getByText('开发诊断', { exact: true }).click();
  await expect(details.locator('dt').filter({ hasText: /^重试自$/ }).locator('+ dd')).toHaveText(originalId);
});

test('T07 output download failure offers an independent recovery action', async ({ page }) => {
  await resetScenario(page, 'download_failure');
  await expect(page.getByTestId('batch-card').getByText('产物下载失败', { exact: true })).toBeVisible();
  await expect(page.getByTestId('batch-card').getByText(/NETWORK_ERROR/)).toHaveCount(0);
  await page.getByRole('button', { name: '重试下载' }).click();
  await expect(page.getByTestId('batch-card').getByText('生成成功', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
});

test('T05 routing and pricing appear only inside read-only details', async ({ page }) => {
  await resetScenario(page, 'success');
  await expect(page.getByText(/demo-t2v/)).toHaveCount(0);
  await page.getByRole('button', { name: '只读详情' }).click();
  const details = page.getByRole('dialog', { name: '任务只读详情' });
  await expect(details.getByText('demo-t2v', { exact: true })).not.toBeVisible();
  await details.getByText('开发诊断', { exact: true }).click();
  await expect(details.getByText('demo-t2v', { exact: true })).toBeVisible();
  await expect(details.getByText('demo-pricing-v1')).toBeVisible();
  await expect(details.getByText('routing-v2-rebuild')).toBeVisible();
});

test('T07 insufficient quota keeps the request editable and creates no task', async ({ page }) => {
  await resetScenario(page, 'quota_insufficient');
  await page.goto('/create');
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('额度不足时保留的请求');
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page.getByText('演示额度不足', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('额度不足时保留的请求');
  await page.goto('/history');
  await expect(page.getByText('暂无历史记录')).toBeVisible();
});

test('T07 active task survives refresh and converges to its persisted result', async ({ page }) => {
  await resetScenario(page, 'processing');
  await expect(page.getByTestId('batch-card').getByText('运行中', { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('batch-card').getByText('生成成功', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
});

test('T07 cancellation requires confirmation and exposes the settled state', async ({ page }) => {
  await resetScenario(page, 'processing');
  await page.getByRole('button', { name: '取消任务' }).click();
  const dialog = page.getByRole('dialog', { name: '确认取消任务' });
  await expect(dialog).toContainText('任务仍可能收敛为成功');
  await dialog.getByRole('button', { name: '确认取消' }).click();
  await expect(page.getByTestId('batch-card').getByText('已取消', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
});
