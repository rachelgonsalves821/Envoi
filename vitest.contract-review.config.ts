import { defineConfig } from 'vitest/config';
import { sharedFixtureSetup } from './integrations/contract-fixtures/vitest.ts';

/** Dedicated pre-approval review; publication lives outside integration until ACK. */
export default defineConfig({
  test: {
    setupFiles: [sharedFixtureSetup],
    environment: 'node',
    include: ['sdk/typescript/test/*.review.ts']
  }
});
