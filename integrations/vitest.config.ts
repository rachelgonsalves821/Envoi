import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['integrations/**/*.test.ts'], maxWorkers: 4, testTimeout: 30_000 }
});
