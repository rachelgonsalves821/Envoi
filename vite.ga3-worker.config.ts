import { defineConfig } from 'vite';
export default defineConfig({ build: { outDir: 'integrations/gates/.runtime', emptyOutDir: true,
  lib: { entry: 'integrations/gates/ga3-worker.ts', formats: ['es'], fileName: () => 'worker.mjs' },
  rolldownOptions: { platform: 'node', external: [/^node:/] }, minify: false } });
