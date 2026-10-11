import { defineConfig } from 'vitest/config';
import { sharedFixtureSetup } from './integrations/contract-fixtures/vitest.ts';

export default defineConfig({
  test: {
    setupFiles: [sharedFixtureSetup],
    environment: 'node',
    include: ['frontend/reviews/envoi-browser-names.review.ts']
  }
});

