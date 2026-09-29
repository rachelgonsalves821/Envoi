import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node22',
    outDir: 'integrations/openclaw/dist',
    emptyOutDir: true,
    lib: {
      entry: { run: 'integrations/openclaw/run.ts', 'mcp-smoke': 'integrations/openclaw/mcp-smoke.ts',
        'share-asset': 'integrations/agent-bridges/share-asset.ts' },
      formats: ['es'], fileName: (_format, entryName) => `${entryName}.mjs`
    },
    rollupOptions: { external: [/^node:/] }
  }
});
