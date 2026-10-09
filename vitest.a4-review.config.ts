import { defineConfig } from 'vitest/config';
import { sharedFixtureSetup } from './integrations/contract-fixtures/vitest.ts';

// Pre-approval publication review, invoked explicitly against a canonical publishing worktree.
export default defineConfig({ test: {
  setupFiles: [sharedFixtureSetup], environment: 'node', include: ['sdk/typescript/reviews/a4-wake.review.ts']
} });
