import { lstat, rename, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CONNECTOR_RUNTIMES } from '../../sdk/typescript/src/quick-connect';
import { ConnectorSetupError } from './adapter';
import { acquireConnectorLock, privateDirectory, privateJson } from './store';
import { optionalText, replaceConfiguration, setEnvValue } from '../hermes/config';

const exists = (filename: string) => lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
async function savedRecord(filename: string): Promise<Record<string, any>> {
  try {
    const value = JSON.parse(await readFile(filename, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ConnectorSetupError('STATE_INVALID', 'Saved migration state is unreadable; preserve the private directory for recovery'); }
}

/** Finish the local profile rename before a migrated Hermes connection is opened. */
async function migrateHermesProfile(directory: string) {
  const filename = path.join(directory, 'hermes-relay.json');
  const stat = await exists(filename);
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000) throw new ConnectorSetupError('STATE_INVALID', 'Hermes relay state must be a regular private file');
  const relay = await savedRecord(filename);
  if (typeof relay.serverName !== 'string' || !/^sinaloa_[a-f0-9]{16}$/.test(relay.serverName)) return;
  if (relay.version !== 1 || !Number.isSafeInteger(relay.port) || relay.port < 1 || relay.port > 65535 || !/^[a-f0-9]{64}$/.test(relay.token))
    throw new ConnectorSetupError('STATE_INVALID', 'The prior Hermes relay state is invalid');
  const configFile = path.join(directory, 'connection.json'), configStat = await exists(configFile);
  if (!configStat?.isFile() || configStat.isSymbolicLink() || configStat.size > 128_000) throw new ConnectorSetupError('STATE_INVALID', 'The migrated connection needs its saved Hermes profile');
  const saved = await savedRecord(configFile);
  const profile = saved.configuration;
  if (saved.runtime !== 'hermes' || typeof profile?.home !== 'string' || !path.isAbsolute(profile.home)
    || typeof profile.configPath !== 'string' || !path.isAbsolute(profile.configPath)) throw new ConnectorSetupError('STATE_INVALID', 'The migrated Hermes profile paths are invalid');
  const suffix = relay.serverName.slice('sinaloa_'.length), nextName = `envoi_${suffix}`;
  const oldVariable = `SINALOA_MCP_${suffix.toUpperCase()}`, nextVariable = `ENVOI_MCP_${suffix.toUpperCase()}`;
  const original = await optionalText(profile.configPath);
  if (original !== null) {
    const oldEntry = new RegExp(`^  ${relay.serverName}:`, 'gm');
    const newEntry = new RegExp(`^  ${nextName}:`, 'm');
    if (oldEntry.test(original) && newEntry.test(original)) throw new ConnectorSetupError('STATE_MIGRATION_CONFLICT', 'Both prior and current Hermes MCP entries exist. Preserve the profile and resolve the duplicate');
    // Only the owned server block is migrated; other servers retain their config.
    const lines = original.split(/\r?\n/);
    const start = lines.findIndex(line => new RegExp(`^  ${relay.serverName}:`).test(line));
    if (start >= 0) {
      let end = start + 1;
      while (end < lines.length && !/^(?:[^\s#]| {2}[A-Za-z0-9_-]+:)/.test(lines[end])) end++;
      const block = lines.slice(start, end).join('\n').replace(relay.serverName, nextName)
        .replaceAll(oldVariable, nextVariable).replace(/\bsinaloa_(?=[a-z])/g, 'envoi_');
      lines.splice(start, end - start, ...block.split('\n'));
      await replaceConfiguration(profile.configPath, original, lines.join('\n'));
    }
  }
  const envPath = path.join(profile.home, '.env'), originalEnv = await optionalText(envPath);
  let environment = (originalEnv ?? '').split(/\r?\n/).filter(line => !new RegExp(`^\\s*${oldVariable}=`).test(line)).join('\n');
  environment = setEnvValue(environment, nextVariable, relay.token);
  await replaceConfiguration(envPath, originalEnv, environment);
  // Commit last: interruption before this write retries the conversion on start.
  await privateJson(filename, { ...relay, serverName: nextName });
}

/** One-time filesystem move, never an old credential, tool, or configuration fallback. */
export async function migrateConnectionDirectory(requested: string, secure = privateDirectory): Promise<string> {
  const absolute = path.resolve(requested), runtimeDir = path.dirname(absolute), productDir = path.dirname(runtimeDir);
  const product = path.basename(productDir), runtime = path.basename(runtimeDir), id = path.basename(absolute);
  if (!['envoi', 'sinaloa'].includes(product) || !CONNECTOR_RUNTIMES.includes(runtime as typeof CONNECTOR_RUNTIMES[number]) || !/^[a-f0-9]{24}$/.test(id)) return absolute;
  const base = path.dirname(productDir);
  const target = path.join(base, 'envoi', runtime, id), previous = path.join(base, 'sinaloa', runtime, id);
  if (!await exists(previous)) {
    if (runtime === 'hermes' && await exists(target)) {
      const unlock = await acquireConnectorLock(target);
      try { await migrateHermesProfile(target); } finally { await unlock(); }
    }
    return target;
  }
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
    if (runtime === 'hermes') await migrateHermesProfile(target);
    return target;
  } finally { try { await unlockSource?.(); } finally { await unlockMigration(); } }
}
