import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build, type InlineConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import connector from './vite.config';
import onboarding from '../onboarding/vite.config';

describe('private connector bundle reproducibility', () => {
  it.each([['connector', connector], ['onboarding', onboarding]] as const)('%s disables host-location debug metadata', (_name, config) => {
    expect(config.build?.rolldownOptions?.experimental?.attachDebugInfo).toBe('none');
  });

  it('produces identical bytes with checkout-local and junctioned dependencies', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'envoi-bundle-repro-'));
    try {
      const ordinary = path.join(directory, 'ordinary');
      const junctioned = path.join(directory, 'junctioned');
      const shared = path.join(directory, 'shared-deps', 'node_modules');
      for (const modules of [path.join(ordinary, 'node_modules'), shared]) {
        const dependency = path.join(modules, 'repro-fixture');
        await mkdir(dependency, { recursive: true });
        await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ name: 'repro-fixture', main: 'index.js' }));
        await writeFile(path.join(dependency, 'index.js'), 'module.exports = class Fixture { value() { return "same dependency"; } };\n');
      }
      await mkdir(junctioned);
      await symlink(shared, path.join(junctioned, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      for (const root of [ordinary, junctioned]) await writeFile(path.join(root, 'entry.js'), 'import Fixture from "repro-fixture"; export const value = new Fixture().value();\n');
      const compile = async (root: string, stable: boolean) => {
        const config: InlineConfig = {
          configFile: false, envDir: false, root, logLevel: 'silent',
          build: {
            target: 'node22', write: false, minify: false,
            lib: { entry: path.join(root, 'entry.js'), formats: ['es'] },
            rolldownOptions: stable ? connector.build?.rolldownOptions : { experimental: { attachDebugInfo: 'full' } }
          }
        };
        const result = await build(config);
        if (!Array.isArray(result)) throw new Error('Expected a library build');
        const chunk = result[0].output.find(output => output.type === 'chunk');
        if (!chunk || chunk.type !== 'chunk') throw new Error('Expected generated code');
        return chunk.code;
      };
      const unstable = await Promise.all([compile(ordinary, false), compile(junctioned, false)]);
      expect(unstable[0]).not.toBe(unstable[1]);
      const stable = await Promise.all([compile(ordinary, true), compile(junctioned, true)]);
      expect(stable[0]).toBe(stable[1]);
      expect(stable[0]).not.toContain('//#region');
      expect(stable[0]).not.toContain('shared-deps');
      expect(stable[0]).toContain('same dependency');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
