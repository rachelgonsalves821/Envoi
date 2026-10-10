import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.env.ENVOI_GA4_TARGET_ROOT;
if (!target || !path.isAbsolute(target)) throw new Error('Set ENVOI_GA4_TARGET_ROOT to the exact combined Envoi worktree');
export default defineConfig({
  resolve: { alias: {
    '@ga4/connector': path.join(target, 'sdk/typescript/src/connector.ts'),
    '@ga4/core': path.join(target, 'integrations/connector/core.ts'),
    '@ga4/store': path.join(target, 'integrations/agent-bridges/file-store.ts')
  } },
  build: { outDir: path.join(here, '.runtime'), emptyOutDir: false,
    lib: { entry: path.join(here, 'ga4-worker.mjs'), formats: ['es'], fileName: () => 'ga4-worker.mjs' },
    rolldownOptions: { platform: 'node', external: [/^node:/] }, minify: false },
  plugins: [{ name: 'ga4-source-identity', async closeBundle() {
    const { execFileSync } = await import('node:child_process');
    const { createHash } = await import('node:crypto');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const protectedDiff = execFileSync('git', ['diff', 'HEAD', '--', '.', ':(exclude)integrations/gates'], { cwd: target, encoding: 'utf8' });
    if (protectedDiff) throw new Error('Target production tree is dirty');
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).trim();
    const bundleHash = createHash('sha256').update(readFileSync(path.join(here, '.runtime/ga4-worker.mjs'))).digest('hex');
    writeFileSync(path.join(here, '.runtime/ga4-source.json'), JSON.stringify({ target: path.resolve(target), sha, bundleHash }));
  } }]
});
