import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['frontend/test/**/*.test.ts'],
    environment: 'node'
  }
});
