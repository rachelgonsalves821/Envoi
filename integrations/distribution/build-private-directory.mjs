import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'vite';

const directory = path.dirname(fileURLToPath(import.meta.url));
export const privateDirectoryBundle = path.join(directory, 'private-directory.mjs');

export async function buildPrivateDirectory() {
  const result = await build({
    configFile: false, envDir: false, publicDir: false, logLevel: 'silent',
    root: path.resolve(directory, '../..'),
    build: {
      target: 'node22', write: false, minify: true, sourcemap: false,
      lib: { entry: path.join(directory, 'private-directory.ts'), formats: ['es'], fileName: () => 'private-directory.mjs' },
      rollupOptions: { external: [/^node:/] }
    }
  });
  const builds = Array.isArray(result) ? result : [result];
  const entries = builds.flatMap(item => item.output).filter(item => item.type === 'chunk');
  if (entries.length !== 1 || !entries[0].isEntry) throw new Error('Private-directory bundle must contain one standalone entry.');
  return entries[0].code.replace(/^\/\/#(?:region .*|endregion)\r?\n/gm, '');
}

export async function checkPrivateDirectoryBundle() {
  if (await readFile(privateDirectoryBundle, 'utf8') !== await buildPrivateDirectory()) {
    throw new Error('Private-directory bundle drifted; run the distribution build:private-directory command.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('This build takes no arguments.');
  await writeFile(privateDirectoryBundle, await buildPrivateDirectory());
}
