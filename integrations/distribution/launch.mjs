import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNode, canonicalDirectory, regularFile, verifiedArtifacts, verifyLauncherFiles } from './artifacts.mjs';

export async function runLocalLauncher(directory, args, nodeVersion = process.versions.node) {
  assertNode(nodeVersion);
  const root = await canonicalDirectory(directory);
  const record = JSON.parse((await regularFile(root, 'installation.json', 16_384)).toString('utf8'));
  if (!record || Object.keys(record).sort().join(',') !== 'installedAt,launchers,manifestSha256,nodeMinimum,private,serviceInstalled,version'
    || record.version !== 1 || record.private !== true || record.nodeMinimum !== 22 || record.serviceInstalled !== false
    || typeof record.installedAt !== 'string' || !Number.isFinite(Date.parse(record.installedAt))) throw new Error('Incomplete local installation.');
  await verifiedArtifacts(root, record.manifestSha256);
  await verifyLauncherFiles(root, record.launchers);
  const helper = path.join(root, 'envoi-link.mjs');
  process.argv = [process.execPath, helper, ...args];
  await import(pathToFileURL(helper).href);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runLocalLauncher(path.dirname(fileURLToPath(import.meta.url)), process.argv.slice(2));
  } catch {
    console.error('Local Envoi launch failed. Check Node.js 22+ and the complete trusted private installation. Preserve existing agent state.');
    process.exitCode = 1;
  }
}
