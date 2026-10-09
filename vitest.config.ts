import { defineConfig } from 'vitest/config';
import { sharedFixtureSetup } from './integrations/contract-fixtures/vitest.ts';

export default defineConfig({
  test: {
    setupFiles: [sharedFixtureSetup],
    include: ['frontend/test/**/*.test.ts'],
    environment: 'node'
  }
});
