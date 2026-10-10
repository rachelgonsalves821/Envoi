import { defineConfig } from 'vite';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  envDir: false,
  plugins: [{ name: 'retire-previous-connector-downloads', async closeBundle() {
    // Artifact removal belongs to generation, alongside the Envoi replacements.
    for (const filename of ['sinaloa-connector.mjs', 'sinaloa-openclaw.mjs'])
      await rm(fileURLToPath(new URL(`../../web/downloads/${filename}`, import.meta.url)), { force: true });
  } }],
  build: {
    target: 'node22', outDir: 'web/downloads', emptyOutDir: false,
    lib: { entry: 'integrations/connector/entry.ts', formats: ['es'], fileName: () => 'envoi-connector.mjs' },
    rollupOptions: { external: [/^node:/], output: { codeSplitting: false } }
  }
});
