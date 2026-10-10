import { lstat, rename, realpath } from 'node:fs/promises';
import path from 'node:path';
import { CONNECTOR_RUNTIMES } from '../../sdk/typescript/src/quick-connect';
import { ConnectorSetupError } from './adapter';
import { acquireConnectorLock, privateDirectory } from './store';

const exists = (filename: string) => lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });

/** One-time filesystem move, never an old credential, tool, or configuration fallback. */
export async function migrateConnectionDirectory(requested: string, secure = privateDirectory): Promise<string> {
  const absolute = path.resolve(requested), runtimeDir = path.dirname(absolute), productDir = path.dirname(runtimeDir);
  const product = path.basename(productDir), runtime = path.basename(runtimeDir), id = path.basename(absolute);
  if (!['envoi', 'sinaloa'].includes(product) || !CONNECTOR_RUNTIMES.includes(runtime as typeof CONNECTOR_RUNTIMES[number]) || !/^[a-f0-9]{24}$/.test(id)) return absolute;
  const base = path.dirname(productDir);
  const target = path.join(base, 'envoi', runtime, id), previous = path.join(base, 'sinaloa', runtime, id);
  if (!await exists(previous)) return target;
  const canonical = path.resolve(await realpath(previous));
  if ((process.platform === 'win32' ? canonical.toLowerCase() !== previous.toLowerCase() : canonical !== previous) || !(await lstat(previous)).isDirectory())
    throw new ConnectorSetupError('STATE_INVALID', 'The prior state directory must be an owned directory without symbolic links');
  // Serialize migrations separately from normal setup/start and lock the source too.
  await secure(path.dirname(target));
  const unlockMigration = await acquireConnectorLock(path.dirname(target));
  let moved = false;
  let unlockSource: (() => Promise<void>) | undefined;
  try {
    if (!await exists(previous)) return target;
    if (await exists(target)) throw new ConnectorSetupError('STATE_MIGRATION_CONFLICT', 'Both prior and current state directories exist. Preserve both and resolve their identity before starting');
    unlockSource = await acquireConnectorLock(previous, () => moved ? target : previous);
    await rename(previous, target);
    moved = true;
    return target;
  } finally { try { await unlockSource?.(); } finally { await unlockMigration(); } }
}
