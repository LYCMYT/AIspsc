import { test as base, expect, type Page } from '@playwright/test';

export const test = base.extend<{ browserAudit: void }>({
  browserAudit: [async ({ page }, use, testInfo) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const externalRequests: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(`${url.origin}${url.pathname}`);
    });
    await use();
    await testInfo.attach('browser-audit', { body: JSON.stringify({ consoleErrors, pageErrors, externalRequests }, null, 2), contentType: 'application/json' });
    expect(pageErrors, 'uncaught browser errors').toEqual([]);
    expect(consoleErrors, 'browser console errors').toEqual([]);
    expect(externalRequests, 'B1 must not call external services').toEqual([]);
  }, { auto: true }],
});
export { expect };

export async function selectMenuValue(page: Page, label: string, optionLabel: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: optionLabel, exact: true }).click();
}

export async function selectMenuByValue(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  const escapedValue = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  await page.getByRole('listbox', { name: label, exact: true }).locator(`[role="option"][data-value="${escapedValue}"]`).click();
}

export async function selectGenerationMode(page: Page, label: string) {
  await selectMenuValue(page, '生成类型', label);
}

export async function loadReferenceDemo(page: Page, role = '产品') {
  await page.getByRole('button', { name: '上传素材', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择参考素材', exact: true });
  await picker.getByRole('tab', { name: role, exact: true }).click();
  await picker.getByRole('button', { name: '载入演示参考', exact: true }).click();
  await picker.getByRole('button', { name: '完成选择', exact: true }).click();
  await expect(picker).toHaveCount(0);
}

export async function unknownPng(page: Page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 120; canvas.height = 80;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#264355'; context.fillRect(0, 0, 120, 80);
    context.fillStyle = '#fac582'; context.fillRect(28, 18, 64, 44);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  return Buffer.from(data, 'base64');
}

export async function resetScenario(page: Page, scenario: string) {
  await page.goto('/create');
  await expect(page.getByRole('button', { name: '演示工具', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '演示工具', exact: true }).click();
  await selectMenuByValue(page, '选择测试场景', scenario);
  await page.getByRole('button', { name: '重置演示', exact: true }).click();
  await page.getByRole('button', { name: '确认重置', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
