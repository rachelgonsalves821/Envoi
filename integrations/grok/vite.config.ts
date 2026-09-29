import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node22',
    outDir: 'integrations/grok/dist',
    emptyOutDir: true,
    lib: {
      entry: { run: 'integrations/grok/run.ts', 'mcp-smoke': 'integrations/grok/mcp-smoke.ts' },
      formats: ['es'], fileName: (_format, entryName) => `${entryName}.mjs`
    },
    rollupOptions: { external: [/^node:/] }
  }
});
