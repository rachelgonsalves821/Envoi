import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node22',
    outDir: 'integrations/openclaw/dist',
    emptyOutDir: true,
    lib: { entry: 'integrations/openclaw/run.ts', formats: ['es'], fileName: () => 'run.mjs' },
    rollupOptions: { external: [/^node:/] }
  }
});
