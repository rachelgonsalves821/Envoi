import { defineConfig } from 'vitest/config';

/** Explicit local source pairing; never contacts an installed host or provider. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['frontend/test/remote-auth-server.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000
  }
});
