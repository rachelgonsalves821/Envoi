import { defineConfig } from 'vitest/config';
import { sharedFixtureSetup } from './integrations/contract-fixtures/vitest.ts';

export default defineConfig({
  test: {
    setupFiles: [sharedFixtureSetup],
    include: ['sdk/typescript/test/**/*.test.ts'],
    environment: 'node'
  }
});
