import { defineConfig } from 'vitest/config';
import { sharedFixtureSetup } from './integrations/contract-fixtures/vitest.ts';

// Explicit pre-approval review. No B-3 production implementation is loaded here.
export default defineConfig({ test: {
  setupFiles: [sharedFixtureSetup], environment: 'node',
  include: ['sdk/typescript/reviews/a5-presence.review.ts']
} });
