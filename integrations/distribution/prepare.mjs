import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { assertNode, canonicalDirectory, launcherNames, optionsFrom, regularFile, verifiedArtifacts } from './artifacts.mjs';
import { checkPrivateDirectoryBundle } from './build-private-directory.mjs';

export async function preparePackage(source, output, expectedManifestSha256) {
  assertNode();
  const verified = await verifiedArtifacts(source, expectedManifestSha256);
  await checkPrivateDirectoryBundle();
  const destination = path.resolve(output);
  await canonicalDirectory(path.dirname(destination));
  if (destination === verified.root || destination.startsWith(verified.root + path.sep)) throw new Error('Prepare outside the source directory.');
  await mkdir(destination, { mode: 0o700 });
  for (const [name, bytes] of verified.artifacts) await writeFile(path.join(destination, name), bytes, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(destination, 'private-release.json'), verified.bytes, { flag: 'wx', mode: 0o600 });
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  for (const name of new Set([...launcherNames, 'install.mjs', 'private-directory.mjs', 'install.sh', 'install.ps1'])) {
    await writeFile(path.join(destination, name), await regularFile(scripts, name), { flag: 'wx', mode: ['install.sh', 'envoi-link'].includes(name) ? 0o700 : 0o600 });
  }
  return { state: 'private_package_prepared', published: false, manifestSha256: expectedManifestSha256, artifactCount: verified.artifacts.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = optionsFrom(process.argv.slice(2), ['--source', '--output', '--manifest-sha256']);
    console.log(JSON.stringify(await preparePackage(options['--source'], options['--output'], options['--manifest-sha256'])));
  } catch { console.error('Private package preparation failed. Verify the source manifest, artifact checksums and a new output directory.'); process.exitCode = 1; }
}
