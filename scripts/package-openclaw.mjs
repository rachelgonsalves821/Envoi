import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filename = path.join(root, 'web', 'downloads', 'sinaloa-openclaw.mjs');
const artifact = await readFile(filename);
const release = { version: 1, runtime: 'openclaw', nodeMinimum: 22,
  artifacts: { 'sinaloa-openclaw.mjs': { sha256: createHash('sha256').update(artifact).digest('hex'), size: artifact.byteLength } } };
await writeFile(path.join(root, 'web', 'downloads', 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
process.stdout.write('Packaged standalone OpenClaw Quick Connect download and SHA256 metadata.\n');
