import { test, expect, resetScenario } from './fixtures';
test('A15 A16 video element and its native controls fit within the visible preview', async ({ page }) => {
  await resetScenario(page, 'success');
  await page.getByRole('link', { name: '历史记录', exact: true }).click();
  const video = page.locator('.result-card video');
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const frame = element.parentElement!.getBoundingClientRect();
    return { inside: bounds.top >= frame.top && bounds.bottom <= frame.bottom && bounds.left >= frame.left && bounds.right <= frame.right, height: bounds.height, frame: frame.height };
  })).toMatchObject({ inside: true });
});
