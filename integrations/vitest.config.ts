import { defineConfig } from 'vitest/config';
import { sharedFixtureSetup } from './contract-fixtures/vitest.ts';

export default defineConfig({
  test: {
    setupFiles: [sharedFixtureSetup],
    environment: 'node',
    include: ['integrations/**/*.test.ts'],
    maxWorkers: 4,
    testTimeout: 30_000
  }
});
