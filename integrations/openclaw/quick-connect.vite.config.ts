import { defineConfig } from 'vite';

// A separate, dependency-free entry: copying this file never loses shared Rollup chunks.
export default defineConfig({
  envDir: false,
  build: {
    target: 'node22', outDir: 'web/downloads', emptyOutDir: false,
    lib: { entry: 'integrations/openclaw/quick-connect-cli.ts', formats: ['es'], fileName: () => 'sinaloa-openclaw.mjs' },
    rollupOptions: { external: [/^node:/], output: { codeSplitting: false } }
  }
});
