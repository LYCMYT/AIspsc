import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, '.cache/ms-playwright');
process.env.HTTP_TEST_TOKEN ??= randomUUID();
process.env.GENERATION_DATA_DIR ??= resolve(root, 'artifacts', `http-e2e-${randomUUID()}`);
export default defineConfig({
  testDir: './e2e-http', fullyParallel: false, workers: 1, retries: 0,
  timeout: 45_000, expect: { timeout: 15_000 },
  outputDir: '../../artifacts/test-results-http',
  reporter: [['list'], ['json', { outputFile: resolve(root, '.ai/evidence/B21A-T4A-http-results.json') }]],
  use: {
    baseURL: 'http://127.0.0.1:4174', viewport: { width: 1440, height: 900 },
    timezoneId: 'Asia/Shanghai', locale: 'zh-CN', reducedMotion: 'reduce',
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node packages/generation-api/scripts/start.ts --port 4174', cwd: root,
    url: 'http://127.0.0.1:4174', reuseExistingServer: false, timeout: 30_000,
    env: { GENERATION_API_PORT: '0', GENERATION_API_TOKEN: process.env.HTTP_TEST_TOKEN },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
