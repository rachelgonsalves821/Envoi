import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const artifactNames = ['envoi-link.mjs', 'envoi-connector.mjs'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function assertNode(version = process.versions.node) {
  if (!/^\d+\./.test(version) || Number(version.split('.')[0]) < 22) throw new Error('Install Node.js 22 or newer before installing Envoi.');
}

export async function regularFile(directory, name, maximum = 32 * 1024 * 1024) {
  if (path.basename(name) !== name || /[\\/\x00-\x1f]/.test(name)) throw new Error('Invalid package filename.');
  const filename = path.join(directory, name);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) throw new Error('Package contains an unsafe or oversized file.');
  const bytes = await readFile(filename);
  if (bytes.length !== stat.size) throw new Error('Package changed while being read.');
  return bytes;
}

export async function canonicalDirectory(directory) {
  const absolute = path.resolve(directory);
  const stat = await lstat(absolute);
  const canonical = await realpath(absolute);
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(canonical) !== normalize(absolute)) throw new Error('Use a directory without symbolic links.');
  return absolute;
}

export function parseManifest(bytes) {
  if (bytes.length > 16_384) throw new Error('Package manifest is oversized.');
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid package manifest.'); }
  if (!manifest || Object.keys(manifest).sort().join(',') !== 'artifacts,coreContract,nodeMinimum,private,published,version'
    || manifest.version !== 1 || manifest.private !== true || manifest.published !== false || manifest.nodeMinimum !== 22
    || manifest.coreContract?.id !== 'agent-registration' || manifest.coreContract.version !== 1 || manifest.coreContract.revision !== 3
    || Object.keys(manifest.coreContract).sort().join(',') !== 'id,publication,revision,version'
    || manifest.coreContract.publication !== '4da219e7156138c94e26b8105efe7ffe43ec6f98'
    || !manifest.artifacts || Object.keys(manifest.artifacts).sort().join(',') !== [...artifactNames].sort().join(',')) throw new Error('Unsupported private helper manifest.');
  for (const name of artifactNames) {
    const record = manifest.artifacts[name];
    if (!record || Object.keys(record).sort().join(',') !== 'sha256,size' || !/^[0-9a-f]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.size) || record.size < 1 || record.size > 32 * 1024 * 1024) throw new Error('Invalid artifact integrity record.');
  }
  return manifest;
}

export async function verifiedArtifacts(directory, expectedManifestSha256) {
  if (!/^[0-9a-f]{64}$/.test(expectedManifestSha256 ?? '')) throw new Error('Supply the independently recorded private manifest SHA-256.');
  const root = await canonicalDirectory(directory);
  const bytes = await regularFile(root, 'private-release.json', 16_384);
  if (sha256(bytes) !== expectedManifestSha256) throw new Error('Private manifest checksum does not match the approved value.');
  const manifest = parseManifest(bytes);
  const artifacts = new Map();
  for (const name of artifactNames) {
    const content = await regularFile(root, name);
    if (content.length !== manifest.artifacts[name].size || sha256(content) !== manifest.artifacts[name].sha256) throw new Error('Helper artifact checksum or size does not match.');
    artifacts.set(name, content);
  }
  return { root, manifest, bytes, artifacts };
}

export function optionsFrom(args, allowed) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!allowed.includes(key) || result[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--') || /[\x00-\x1f]/.test(args[index + 1])) throw new Error('Unknown, duplicate or incomplete distribution option.');
    result[key] = args[index + 1];
  }
  for (const key of allowed) if (!result[key]) throw new Error(`Supply ${key}.`);
  return result;
}
