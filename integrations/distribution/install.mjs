import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNode, canonicalDirectory, launcherNames, optionsFrom, regularFile, sha256, verifiedArtifacts, verifyLauncherFiles } from './artifacts.mjs';
import { privateDirectory } from './private-directory.mjs';

export async function installPrivatePackage(source, destination, expectedManifestSha256) {
  assertNode();
  const verified = await verifiedArtifacts(source, expectedManifestSha256);
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  const launchers = { version: 1, files: {} };
  const launcherFiles = new Map();
  for (const name of launcherNames) {
    const bytes = await regularFile(scripts, name, 1024 * 1024);
    launcherFiles.set(name, bytes);
    launchers.files[name] = { sha256: sha256(bytes), size: bytes.length };
  }
  const target = path.resolve(destination);
  const parent = await canonicalDirectory(path.dirname(target));
  if (target === verified.root || target.startsWith(verified.root + path.sep)) throw new Error('Install outside the package source directory.');
  if (/[\x00-\x1f]/.test(target) || parent === target) throw new Error('Choose a new installation directory.');
  await mkdir(target, { mode: 0o700 });
  await privateDirectory(target);
  for (const [name, bytes] of verified.artifacts) await writeFile(path.join(target, name), bytes, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(target, 'private-release.json'), verified.bytes, { flag: 'wx', mode: 0o600 });
  for (const [name, bytes] of launcherFiles) await writeFile(path.join(target, name), bytes, { flag: 'wx', mode: name === 'envoi-link' ? 0o700 : 0o600 });
  await verifiedArtifacts(target, expectedManifestSha256);
  await verifyLauncherFiles(target, launchers);
  const record = { version: 1, private: true, manifestSha256: expectedManifestSha256, nodeMinimum: 22, installedAt: new Date().toISOString(), serviceInstalled: false, launchers };
  await writeFile(path.join(target, 'installation.pending.json'), JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(path.join(target, 'installation.pending.json'), path.join(target, 'installation.json'));
  return { state: 'private_files_installed', published: false, serviceInstalled: false, connected: false, nodeMinimum: 22 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = optionsFrom(process.argv.slice(2), ['--bundle', '--destination', '--manifest-sha256']);
    console.log(JSON.stringify(await installPrivatePackage(options['--bundle'], options['--destination'], options['--manifest-sha256'])));
  } catch { console.error('Private installation failed. Check the approved checksum and choose a new directory beside an existing parent. Preserve any previous connection state.'); process.exitCode = 1; }
}
