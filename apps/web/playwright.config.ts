import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH = fileURLToPath(new URL('../../.cache/ms-playwright', import.meta.url));
export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1, retries: 0,
  timeout: 30_000, expect: { timeout: 10_000 },
  outputDir: '../../test-results', reporter: [['list'], ['json', { outputFile: `../../${process.env.UI_EVIDENCE_DIR ?? '.ai/evidence'}/e2e-results.json` }]],
  use: { baseURL: 'http://127.0.0.1:4173', viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai', locale: 'zh-CN', reducedMotion: 'reduce', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm dev --port 4173', cwd: root, url: 'http://127.0.0.1:4173', reuseExistingServer: false, timeout: 60_000 },
});
