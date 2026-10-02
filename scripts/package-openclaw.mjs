import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filename = path.join(root, 'web', 'downloads', 'sinaloa-openclaw.mjs');
const artifact = await readFile(filename);
const release = { version: 1, runtime: 'openclaw', nodeMinimum: 22,
  artifacts: { 'sinaloa-openclaw.mjs': { sha256: createHash('sha256').update(artifact).digest('hex'), size: artifact.byteLength } } };
const unified = await readFile(path.join(root, 'web', 'downloads', 'sinaloa-connector.mjs')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
if (unified) {
  release.runtimes = ['openclaw', 'hermes', 'grok'];
  release.artifacts['sinaloa-connector.mjs'] = { sha256: createHash('sha256').update(unified).digest('hex'), size: unified.byteLength };
}
await writeFile(path.join(root, 'web', 'downloads', 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
process.stdout.write('Packaged Sinaloa connector downloads and SHA256 metadata.\n');
