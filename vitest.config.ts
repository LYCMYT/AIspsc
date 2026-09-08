import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'contracts', include: ['packages/contracts/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'unit', include: ['packages/domain/**/*.test.ts', 'packages/media-store/**/*.test.ts', 'packages/mock-service/**/*.test.ts'], environment: 'node' } },
    ],
  },
});
