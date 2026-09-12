import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'provider', include: ['packages/generation-api/**/*.provider.test.ts'], environment: 'node', testTimeout: 60000, hookTimeout: 30000, maxWorkers: 1 } },
      { test: { name: 'http', include: ['packages/generation-api/**/*.integration.test.ts'], environment: 'node', testTimeout: 10000, hookTimeout: 10000, maxWorkers: 1 } },
      { test: { name: 'delivery', include: ['packages/media-processing/**/*.integration.test.ts', 'packages/delivery-workbench/**/*.integration.test.ts'], environment: 'node', testTimeout: 30000, hookTimeout: 30000, maxWorkers: 1 } },
      { test: { name: 'contracts', include: ['packages/contracts/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'unit', exclude: [...configDefaults.exclude, '**/*.integration.test.ts', '**/*.provider.test.ts'], include: ['packages/http-platform/**/*.test.ts', 'packages/generation-api/**/*.test.ts', 'packages/domain/**/*.test.ts', 'packages/media-store/**/*.test.ts', 'packages/mock-service/**/*.test.ts', 'packages/provider-agnes/**/*.test.ts', 'packages/media-processing/**/*.test.ts', 'packages/delivery-workbench/**/*.test.ts'], environment: 'node' } },
    ],
  },
});
