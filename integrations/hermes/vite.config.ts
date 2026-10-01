import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node22',
    outDir: 'integrations/hermes/dist',
    emptyOutDir: true,
    lib: {
      entry: { run: 'integrations/hermes/run.ts' },
      formats: ['es'], fileName: (_format, entryName) => `${entryName}.mjs`
    },
    rollupOptions: { external: [/^node:/] }
  }
});
