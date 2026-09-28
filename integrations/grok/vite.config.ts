import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node22',
    outDir: 'integrations/grok/dist',
    emptyOutDir: true,
    lib: { entry: 'integrations/grok/run.ts', formats: ['es'], fileName: () => 'run.mjs' },
    rollupOptions: { external: [/^node:/] }
  }
});
