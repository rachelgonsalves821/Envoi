import { defineConfig } from 'vitest/config';
import { sharedFixtureSetup } from './integrations/contract-fixtures/vitest.ts';
export default defineConfig({ test: { setupFiles: [sharedFixtureSetup], environment: 'node', include: ['sdk/typescript/reviews/envoi-names.review.ts'] } });
