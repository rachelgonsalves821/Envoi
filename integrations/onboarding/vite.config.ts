import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
export default defineConfig({
  envDir: false, define: { __ENVOI_LINK_BUNDLED__: 'true' },
  plugins: [{ name: 'private-local-helper-metadata', async closeBundle() {
    const directory = path.resolve('integrations/onboarding/dist');
    await copyFile(path.resolve('web/downloads/envoi-connector.mjs'), path.join(directory, 'envoi-connector.mjs'));
    const artifacts: Record<string, { sha256: string; size: number }> = {};
    for (const name of ['envoi-link.mjs', 'envoi-connector.mjs']) {
      const bytes = await readFile(path.join(directory, name));
      artifacts[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength };
    }
    await writeFile(path.join(directory, 'private-release.json'), JSON.stringify({
      version: 1, private: true, published: false, nodeMinimum: 22,
      coreContract: { id: 'agent-registration', version: 1, revision: 3, publication: '4da219e7156138c94e26b8105efe7ffe43ec6f98' },
      artifacts
    }, null, 2) + '\n');
  } }],
  build: {
    target: 'node22', outDir: 'integrations/onboarding/dist', emptyOutDir: true,
    lib: { entry: 'integrations/onboarding/entry.ts', formats: ['es'], fileName: () => 'envoi-link.mjs' },
    rolldownOptions: { external: [/^node:/], output: { codeSplitting: false, banner: '#!/usr/bin/env node' }, experimental: { attachDebugInfo: 'none' } }
  }
});
