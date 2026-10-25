import { defineConfig } from 'vite';

export default defineConfig({
  envDir: false,
  build: {
    target: 'node22', outDir: 'integrations/onboarding/dist', emptyOutDir: false,
    lib: { entry: 'integrations/onboarding/portable-rest-entry.ts', formats: ['es'], fileName: () => 'envoi-rest-host.mjs' },
    rolldownOptions: { external: [/^node:/], output: { codeSplitting: false, banner: '#!/usr/bin/env node' },
      experimental: { attachDebugInfo: 'none' } },
  },
});
