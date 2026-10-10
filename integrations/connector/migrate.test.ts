import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateConnectionDirectory } from './migrate';
import { acquireConnectorLock } from './store';
import { connectionDirectory } from './core';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { force: true, recursive: true }); });
const secure = async (value: string) => { await mkdir(value, { recursive: true }); return value; };
async function fixture(runtime = 'hermes') {
  const root = await mkdtemp(path.join(tmpdir(), 'envoi-migrate-')); directories.push(root);
  const id = 'a'.repeat(24), previous = path.join(root, 'sinaloa', runtime, id), target = path.join(root, 'envoi', runtime, id);
  await mkdir(path.join(previous, 'work'), { recursive: true });
  await writeFile(path.join(previous, 'session.json'), '{"agentId":"same","cursor":"00000000000000000044","agentRefreshToken":"preserve"}');
  await writeFile(path.join(previous, 'work', 'receipt.json'), '{"processed":true}');
  return { previous, target };
}
describe('Envoi state cutover', () => {
  it.each(['hermes', 'openclaw', 'grok'])('moves %s once without enrollment, token rewrites, or lost receipts', async runtime => {
    const f = await fixture(runtime); const original = await readFile(path.join(f.previous, 'session.json'), 'utf8');
    expect(await migrateConnectionDirectory(f.target, secure)).toBe(f.target);
    expect(await readFile(path.join(f.target, 'session.json'), 'utf8')).toBe(original);
    expect(await readFile(path.join(f.target, 'work', 'receipt.json'), 'utf8')).toBe('{"processed":true}');
    await expect(lstat(f.previous)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await migrateConnectionDirectory(f.target, secure)).toBe(f.target);
    expect(await migrateConnectionDirectory(f.previous, secure)).toBe(f.target);
  });
  it('refuses active connectors and conflicting destinations, preserving both directories', async () => {
    const f = await fixture(); const unlock = await acquireConnectorLock(f.previous);
    await expect(migrateConnectionDirectory(f.target, secure)).rejects.toThrow('already running'); await unlock();
    await mkdir(f.target); await writeFile(path.join(f.target, 'session.json'), 'other');
    await expect(migrateConnectionDirectory(f.target, secure)).rejects.toMatchObject({ code: 'STATE_MIGRATION_CONFLICT' });
    expect(await readFile(path.join(f.target, 'session.json'), 'utf8')).toBe('other');
    expect(await readFile(path.join(f.previous, 'session.json'), 'utf8')).toContain('preserve');
  });
  it('uses Envoi platform defaults and leaves explicit custom paths intact', async () => {
    const f = await fixture(); const root = path.dirname(path.dirname(path.dirname(f.target)));
    const dir = connectionDirectory('https://api.example', 'agent@example.test', 'hermes', { platform: 'linux', env: { XDG_STATE_HOME: root } });
    expect(dir).toMatch(/envoi[\\/]hermes[\\/][a-f0-9]{24}$/);
    const custom = path.join(root, 'custom'); expect(await migrateConnectionDirectory(custom, secure)).toBe(custom);
  });
  it('migrates the owned Hermes server entry and secret binding once, keeping unrelated profile entries', async () => {
    const f = await fixture(); const home = path.join(path.dirname(path.dirname(path.dirname(f.target))), 'profile');
    await mkdir(home); const configPath = path.join(home, 'config.yaml'), suffix = '1234567890abcdef', token = 'a'.repeat(64);
    await writeFile(configPath, `mcp_servers:\n  sinaloa_${suffix}:\n    url: "http://127.0.0.1:8788/mcp"\n    headers:\n      Authorization: "Bearer \${SINALOA_MCP_${suffix.toUpperCase()}}"\n    tools:\n      include: [sinaloa_agent_info, sinaloa_send_message]\n  other:\n    url: "https://other.example/mcp"\n`);
    await writeFile(path.join(home, '.env'), `OTHER=keep\nSINALOA_MCP_${suffix.toUpperCase()}=${token}\n`);
    await writeFile(path.join(f.previous, 'connection.json'), JSON.stringify({ runtime: 'hermes', configuration: { home, configPath } }));
    await writeFile(path.join(f.previous, 'hermes-relay.json'), JSON.stringify({ version: 1, serverName: `sinaloa_${suffix}`, port: 8788, token }));
    await migrateConnectionDirectory(f.target, secure);
    const config = await readFile(configPath, 'utf8'), env = await readFile(path.join(home, '.env'), 'utf8');
    expect(config).toContain(`envoi_${suffix}:`); expect(config).toContain('envoi_agent_info, envoi_send_message');
    expect(config).toContain('https://other.example/mcp'); expect(config).not.toContain('sinaloa');
    expect(env).toContain(`ENVOI_MCP_${suffix.toUpperCase()}=${token}`); expect(env).toContain('OTHER=keep'); expect(env).not.toContain('SINALOA');
    expect(JSON.parse(await readFile(path.join(f.target, 'hermes-relay.json'), 'utf8'))).toEqual({ version: 1, serverName: `envoi_${suffix}`, port: 8788, token });
    await migrateConnectionDirectory(f.target, secure); expect(await readFile(configPath, 'utf8')).toBe(config);
  });
});
