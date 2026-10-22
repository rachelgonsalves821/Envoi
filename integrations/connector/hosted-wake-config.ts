import { lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseHostedWakeConfig, type HostedWakeConfig } from './hosted-wake-runner';
import { acquireConnectorLock, privateDirectory, privateJson } from './store';

const filename = (directory: string) => path.join(directory, 'hosted-wake.json');
const invalid = () => new Error('Saved hosted wake configuration is invalid; stop the connector and configure wake again');

/** A missing file means ordinary polling. An invalid file must never silently disable wake. */
export async function readHostedWakeConfig(directory: string): Promise<HostedWakeConfig | null> {
  const file = filename(directory);
  const stat = await lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw invalid();
  let value: unknown;
  try { value = JSON.parse(await readFile(file, 'utf8')); } catch { throw invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.registeredUrl !== 'string' || typeof record.port !== 'number'
    || typeof record.installationId !== 'string' || Object.keys(record).sort().join(',') !== 'installationId,port,registeredUrl,version') throw invalid();
  let parsed: HostedWakeConfig | null;
  try { parsed = parseHostedWakeConfig({ ENVOI_WAKE_URL: record.registeredUrl, ENVOI_WAKE_PORT: String(record.port),
    ENVOI_WAKE_INSTALLATION_ID: record.installationId }); } catch { throw invalid(); }
  if (!parsed || parsed.port !== record.port) throw invalid();
  return parsed;
}

export async function resolveHostedWakeConfig(directory: string, env: NodeJS.ProcessEnv): Promise<HostedWakeConfig | null> {
  const supplied = parseHostedWakeConfig(env);
  const saved = await readHostedWakeConfig(directory);
  if (supplied && saved && (supplied.registeredUrl !== saved.registeredUrl || supplied.port !== saved.port
    || supplied.installationId !== saved.installationId)) {
    throw new Error('Hosted wake environment differs from saved configuration; stop the connector and configure wake again');
  }
  return supplied ?? saved;
}

/** Called by the normal service installer, so wake survives a supervisor restart. */
export async function prepareHostedWakeService(directory: string, env: NodeJS.ProcessEnv = process.env,
  secureDirectory: typeof privateDirectory = privateDirectory) {
  const supplied = parseHostedWakeConfig(env);
  const secure = await secureDirectory(directory);
  const unlock = await acquireConnectorLock(secure);
  try {
    const saved = await readHostedWakeConfig(secure);
    if (supplied && saved && (supplied.registeredUrl !== saved.registeredUrl || supplied.port !== saved.port
      || supplied.installationId !== saved.installationId)) {
      throw new Error('Hosted wake environment differs from saved configuration; use configure-wake to rotate it');
    }
    if (supplied && !saved) await privateJson(filename(secure), { version: 1, ...supplied });
  } finally { await unlock(); }
}

/** Explicit rotation/removal requires the connector to be stopped. */
export async function configureHostedWake(directory: string, env: NodeJS.ProcessEnv = process.env,
  secureDirectory: typeof privateDirectory = privateDirectory) {
  const supplied = parseHostedWakeConfig(env);
  if (!supplied) throw new Error('Set ENVOI_WAKE_URL, ENVOI_WAKE_PORT and ENVOI_WAKE_INSTALLATION_ID together');
  const secure = await secureDirectory(directory);
  const unlock = await acquireConnectorLock(secure);
  try { await privateJson(filename(secure), { version: 1, ...supplied }); }
  finally { await unlock(); }
}

export async function clearHostedWake(directory: string, secureDirectory: typeof privateDirectory = privateDirectory) {
  const secure = await secureDirectory(directory);
  const unlock = await acquireConnectorLock(secure);
  try { await rm(filename(secure), { force: true }); }
  finally { await unlock(); }
}
