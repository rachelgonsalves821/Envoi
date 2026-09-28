import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['sdk/typescript/test/**/*.test.ts'],
    environment: 'node'
  }
});
