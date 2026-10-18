import { EnvoiError } from '../../sdk/typescript/src/index';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { privateJson } from './quick-connect-store';

export function assertOpenClawScopedAdmission(env: NodeJS.ProcessEnv = process.env, saved?: object) {
  if (env.ENVOI_SCOPED_TOOLS !== undefined && env.ENVOI_SCOPED_TOOLS !== 'true' && env.ENVOI_SCOPED_TOOLS !== 'false') {
    throw new TypeError('ENVOI_SCOPED_TOOLS must be true or false');
  }
  const savedMode = (saved as Record<string, unknown> | undefined)?.scopedTools;
  if (savedMode !== undefined && savedMode !== true) throw new TypeError('Invalid saved scoped mode');
  if (savedMode === true) {
    if (env.ENVOI_SCOPED_TOOLS === 'false') {
      throw new EnvoiError('This connection was saved in scoped mode. Keep scoped mode enabled; do not downgrade its existing work to legacy execution.',
        undefined, 'SCOPED_MODE_DOWNGRADE_UNAVAILABLE');
    }
    env = { ...env, ENVOI_SCOPED_TOOLS: 'true' };
  }
  if (env.ENVOI_SCOPED_TOOLS === 'true') {
    const legacySettings = ['OPENCLAW_MCP_RELAY_TOKEN', 'OPENCLAW_MCP_RELAY_PORT', 'OPENCLAW_MCP_WRITE_ENABLED', 'ENVOI_MCP_URL', 'ENVOI_ASSET_MANIFEST_PATH'];
    const savedSettings = saved as Record<string, unknown> | undefined;
    if (legacySettings.some(name => env[name] !== undefined)
      || ['relayToken', 'relayPort', 'mcpWriteEnabled', 'assetManifestPath'].some(name => savedSettings?.[name] !== undefined)) {
      throw new EnvoiError('Scoped mode cannot use privileged legacy Envoi relay or asset settings. Remove those settings from the selected connector environment.',
        undefined, 'SCOPED_LEGACY_CONFIGURATION_UNAVAILABLE');
    }
  }
  return env;
}

export async function openClawRuntimeEnvironment(directory: string, env: NodeJS.ProcessEnv, saved?: object) {
  const selected = assertOpenClawScopedAdmission(env, saved);
  const filename = path.join(directory, 'openclaw-mode.json');
  let mode: unknown;
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('Invalid saved OpenClaw mode');
    mode = JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return selected;
    throw new Error('Cannot read saved OpenClaw mode; preserve the private state directory');
  }
  if (!mode || typeof mode !== 'object' || Array.isArray(mode)
    || Object.keys(mode).sort().join(',') !== 'scopedTools,version'
    || (mode as Record<string, unknown>).version !== 1 || (mode as Record<string, unknown>).scopedTools !== true) {
    throw new Error('Invalid saved OpenClaw mode; preserve the private state directory');
  }
  return assertOpenClawScopedAdmission(selected, mode);
}

export async function saveOpenClawScopedMode(directory: string, env: NodeJS.ProcessEnv) {
  if (env.ENVOI_SCOPED_TOOLS === 'true') await privateJson(path.join(directory, 'openclaw-mode.json'), { version: 1, scopedTools: true });
}
