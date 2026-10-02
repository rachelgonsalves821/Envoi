import { defineConfig } from 'vite';
export default defineConfig({
  envDir: false,
  build: {
    target: 'node22', outDir: 'web/downloads', emptyOutDir: false,
    lib: { entry: 'integrations/connector/entry.ts', formats: ['es'], fileName: () => 'sinaloa-connector.mjs' },
    rollupOptions: { external: [/^node:/], output: { codeSplitting: false } }
  }
});
