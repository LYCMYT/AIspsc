import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

async function openFreshDesignPanel(page: Page) {
  await page.goto('/design-panel.html');
  await expect(page.locator('[data-design-id="create-composer"]')).toBeVisible();
}

test('direct text and layout edits survive JSON export and an offline HTML round trip', async ({ browser, page }, testInfo) => {
  await openFreshDesignPanel(page);

  const title = page.locator('[data-copy-key="history-title"]');
  await title.dblclick();
  await expect(title).toHaveAttribute('contenteditable', 'plaintext-only');
  await title.fill('可携带的作品记录');
  await title.press('Tab');
  await expect(title).not.toHaveAttribute('contenteditable', /.+/);
  await expect(title).toHaveText('可携带的作品记录');

  await page.getByRole('button', { name: '编辑布局', exact: true }).click();
  const composer = page.locator('[data-design-id="create-composer"]');
  await composer.click({ position: { x: 30, y: 20 } });
  await page.getByLabel('区域内边距', { exact: true }).fill('32');
  await page.getByLabel('区域内边距', { exact: true }).press('Tab');
  await page.getByLabel('区域高度', { exact: true }).fill('420');
  await page.getByLabel('区域高度', { exact: true }).press('Tab');
  await expect.poll(() => composer.evaluate(element => (element as HTMLElement).style.padding)).toBe('32px');
  await expect.poll(() => composer.evaluate(element => (element as HTMLElement).style.height)).toBe('420px');

  await title.dblclick();
  await title.fill('导出时提交的作品记录');
  await expect(title).toHaveAttribute('contenteditable', 'plaintext-only');
  const jsonDownloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出修改稿', exact: true }).click();
  const jsonDownload = await jsonDownloadEvent;
  await expect(title).not.toHaveAttribute('contenteditable', /.+/);
  expect(jsonDownload.suggestedFilename()).toBe('ai-video-design-draft.json');
  const jsonPath = await jsonDownload.path();
  expect(jsonPath).not.toBeNull();
  const draftText = await readFile(jsonPath!, 'utf8');
  const draft = JSON.parse(draftText) as {
    version: number;
    texts: Record<string, string>;
    nodes?: Record<string, Record<string, unknown>>;
  };
  expect(draft.version).toBe(1);
  expect(draft.texts['history-title']).toBe('导出时提交的作品记录');
  expect(draft.nodes?.['create-composer']).toMatchObject({ padding: 32, height: 420 });
  expect(draftText).not.toContain('contenteditable');
  expect(draftText).not.toContain('design-selected');

  const htmlDownloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 HTML', exact: true }).click();
  const htmlDownload = await htmlDownloadEvent;
  expect(htmlDownload.suggestedFilename()).toBe('ai-video-design-panel.html');
  const exportedHtmlPath = testInfo.outputPath('portable-design-panel.html');
  await htmlDownload.saveAs(exportedHtmlPath);

  const offlineContext = await browser.newContext();
  await offlineContext.setOffline(true);
  const offlineRequests: string[] = [];
  const offlineErrors: string[] = [];
  const offlinePage = await offlineContext.newPage();
  offlinePage.on('request', request => {
    if (/^https?:/.test(request.url())) offlineRequests.push(request.url());
  });
  offlinePage.on('pageerror', error => offlineErrors.push(error.message));
  try {
    await offlinePage.goto(pathToFileURL(exportedHtmlPath).href);
    const offlineTitle = offlinePage.locator('[data-copy-key="history-title"]');
    const offlineComposer = offlinePage.locator('[data-design-id="create-composer"]');
    await expect(offlineTitle).toHaveText('导出时提交的作品记录');
    await expect.poll(() => offlineComposer.evaluate(element => (element as HTMLElement).style.padding)).toBe('32px');
    await expect.poll(() => offlineComposer.evaluate(element => (element as HTMLElement).style.height)).toBe('420px');
    await expect(offlineTitle).not.toHaveAttribute('contenteditable', /.+/);
    await expect(offlinePage.locator('body')).not.toHaveClass(/layout-mode/);
    await expect(offlineComposer).not.toHaveClass(/design-selected/);
    await expect(offlinePage.getByRole('button', { name: '编辑布局', exact: true })).toHaveAttribute('aria-pressed', 'false');

    await offlinePage.getByRole('button', { name: '恢复默认设计', exact: true }).click();
    await expect(offlineTitle).toHaveText('生成历史');
    await expect.poll(() => offlineComposer.evaluate(element => (element as HTMLElement).style.padding)).toBe('');
    await offlinePage.getByLabel('导入修改稿 JSON', { exact: true }).setInputFiles({
      name: 'portable-design.json',
      mimeType: 'application/json',
      buffer: Buffer.from(draftText),
    });
    await expect(offlineTitle).toHaveText('导出时提交的作品记录');
    await expect.poll(() => offlineComposer.evaluate(element => (element as HTMLElement).style.padding)).toBe('32px');
    await expect.poll(() => offlineComposer.evaluate(element => (element as HTMLElement).style.height)).toBe('420px');
    expect(offlineRequests).toEqual([]);
    expect(offlineErrors).toEqual([]);
  } finally {
    await offlineContext.close();
  }

  const legacyV1 = {
    version: 1,
    updatedAt: '2026-09-08T00:00:00.000Z',
    view: 'create',
    tokens: {},
    texts: { 'history-title': '旧版修改稿仍可导入' },
  };
  await page.getByLabel('导入修改稿 JSON', { exact: true }).setInputFiles({
    name: 'legacy-v1-design.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(legacyV1)),
  });
  await expect(page.locator('#design-status')).toHaveText('修改稿已导入并保存在本机');
  await expect(title).toHaveText('旧版修改稿仍可导入');
  await expect.poll(() => composer.evaluate(element => (element as HTMLElement).style.padding)).toBe('');
  await expect.poll(() => composer.evaluate(element => (element as HTMLElement).style.height)).toBe('');
});

test('import treats copy as text, clamps node values, and cannot edit protected labels', async ({ page }) => {
  await openFreshDesignPanel(page);
  const externalRequests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      externalRequests.push(request.url());
    }
  });

  const literalCopy = '<img src="https://evil.invalid/pixel"> <script>window.__designPwned = true</script>';
  const hostileDraft = {
    version: 1,
    updatedAt: '2026-09-08T00:00:00.000Z',
    view: 'create',
    tokens: {},
    texts: {
      'history-title': literalCopy,
      brand: '伪造品牌',
      mock: '正式环境',
      'design-status': '已发布',
    },
    nodes: {
      'create-composer': {
        x: 999999,
        y: -999999,
        width: 999999,
        height: 999999,
        padding: 999999,
        radius: -999999,
        fontSize: 999999,
        color: 'url(https://evil.invalid/color)',
        background: 'url(https://evil.invalid/background)',
        backgroundImage: 'url(https://evil.invalid/image)',
        cssText: 'position:fixed;inset:0',
        onclick: 'window.__designPwned = true',
      },
      'unknown-node': {
        width: 500,
        background: '#ffffff',
      },
    },
  };

  await page.getByLabel('导入修改稿 JSON', { exact: true }).setInputFiles({
    name: 'hostile-design.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(hostileDraft)),
  });
  await expect(page.locator('#design-status')).toHaveText('修改稿已导入并保存在本机');

  const title = page.locator('[data-copy-key="history-title"]');
  await expect(title).toHaveText(literalCopy);
  await expect(title.locator('img, script')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as Window & { __designPwned?: boolean }).__designPwned)).toBeUndefined();

  const composer = page.locator('[data-design-id="create-composer"]');
  await expect.poll(() => composer.evaluate(element => {
    const style = (element as HTMLElement).style;
    return {
      transform: style.transform,
      width: style.width,
      height: style.height,
      padding: style.padding,
      borderRadius: style.borderRadius,
      fontSize: style.fontSize,
      color: style.color,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      position: style.position,
    };
  })).toEqual({
    transform: 'translate(160px, -120px)',
    width: '1200px',
    height: '700px',
    padding: '48px',
    borderRadius: '0px',
    fontSize: '40px',
    color: '',
    backgroundColor: '',
    backgroundImage: '',
    position: '',
  });

  const stored = await page.evaluate(() => {
    const raw = localStorage.getItem('ai-video-design-panel:v1');
    return raw ? JSON.parse(raw) : null;
  }) as { nodes?: Record<string, Record<string, unknown>> } | null;
  expect(stored?.nodes?.['create-composer']).toEqual({
    x: 160,
    y: -120,
    width: 1200,
    height: 700,
    padding: 48,
    radius: 0,
    fontSize: 40,
  });
  expect(stored?.nodes?.['unknown-node']).toBeUndefined();

  const brand = page.locator('.brand');
  const mockBadge = page.locator('.mock-badge');
  const status = page.locator('#design-status');
  await brand.dblclick({ force: true });
  await mockBadge.dblclick({ force: true });
  await status.dblclick({ force: true });
  await expect(brand).not.toHaveAttribute('contenteditable', /.+/);
  await expect(mockBadge).not.toHaveAttribute('contenteditable', /.+/);
  await expect(status).not.toHaveAttribute('contenteditable', /.+/);
  await expect(brand).toContainText('多模型 AI');
  await expect(brand).toContainText('营销视频生产平台');
  await expect(mockBadge).toHaveText('Mock');
  expect(externalRequests).toEqual([]);
});
