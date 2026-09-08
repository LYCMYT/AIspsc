import { test, expect, resetScenario } from './fixtures';

for (const viewport of [{ width: 1672, height: 941 }, { width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
  test(`UI5 A16 A17 empty creation and upload workflows fit the desktop viewport ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await resetScenario(page, 'empty');
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByLabel('Prompt', { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: '生成', exact: true })).toBeInViewport({ ratio: 1 });
    expect.soft(await page.locator('main').evaluate(element => element.getBoundingClientRect().bottom), 'Empty creation should fit without unnecessary scrolling').toBeLessThanOrEqual(viewport.height);
    const nav = page.getByRole('navigation', { name: '主导航' });
    await nav.getByRole('link', { name: '历史记录', exact: true }).click();
    expect.soft(await page.getByRole('button', { name: '新建创作', exact: true }).count() + await page.getByRole('link', { name: '新建创作', exact: true }).count(), 'Only one global new-creation action').toBe(1);
    for (const [name, upload] of [['视频拆解', '上传视频'], ['素材识别', '上传素材']]) {
      await nav.getByRole('link', { name, exact: true }).click();
      await expect(page.getByRole('button', { name: upload, exact: true })).toBeInViewport({ ratio: 1 });
      await expect(page.locator('.tool-empty')).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    }
    await info.attach('desktop-layout', { body: JSON.stringify({ viewport, checks: ['primary actions in viewport', 'empty state in viewport', 'one new creation action', 'no horizontal overflow'] }), contentType: 'application/json' });
  });
}
