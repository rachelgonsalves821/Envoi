import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { windowsAccountSid, windowsExecutable } from './windows';
import { privateDirectory } from './store';
import { replaceConfiguration } from '../hermes/config';
import { connectorService } from './service';

afterEach(() => vi.unstubAllEnvs());
describe('native Windows helpers', () => {
  it('resolves Windows tools independently of PATH and environment-key casing', () => {
    const env = { SYSTEMROOT: 'D:/Windows', PATH: 'C:\\Program Files\\Git\\usr\\bin' };
    expect(windowsExecutable('whoami.exe', env)).toBe('D:\\Windows\\System32\\whoami.exe');
    expect(windowsExecutable('powershell.exe', env)).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(windowsExecutable('icacls.exe', { windir: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\icacls.exe');
    const service = connectorService('C:\\private\\agent', { platform: 'win32', user: 'S-1-5-123', env });
    expect(service.commands.map(command => command.executable)).toEqual(['D:\\Windows\\System32\\schtasks.exe', 'D:\\Windows\\System32\\schtasks.exe']);
  });
  it('rejects unavailable or unsafe system directories without echoing environment values', () => {
    for (const SystemRoot of [undefined, 'relative', '\\\\remote\\Windows', 'C:\\bad\nsecret', 'C:\\Windows|secret']) {
      try { windowsExecutable('whoami.exe', { SystemRoot }); throw new Error('Unexpected success'); }
      catch (error) {
        expect(error).toMatchObject({ code: 'WINDOWS_HELPER_UNAVAILABLE' });
        expect((error as Error).message).not.toContain('secret');
      }
    }
  });
  it.skipIf(process.platform !== 'win32')('protects credentials despite Git-style PATH shadows', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'envoi-windows-path-'));
    try {
      const shadow = path.join(root, 'shadow'); await mkdir(shadow);
      for (const tool of ['whoami.exe', 'powershell.exe', 'icacls.exe', 'schtasks.exe']) {
        await writeFile(path.join(shadow, tool), 'This is deliberately not a Windows executable.');
      }
      vi.stubEnv('PATH', `${shadow};${process.env.PATH ?? ''}`);
      expect(await windowsAccountSid()).toMatch(/^S-1-/);
      const state = await privateDirectory(path.join(root, 'state'));
      await writeFile(path.join(state, 'existing.json'), '{}');
      await expect(privateDirectory(state)).resolves.toBe(state); // Existing-file ACL reset too.
      await expect(replaceConfiguration(path.join(state, '.env'), null, 'API_SERVER_KEY=fixture-private-key\n')).resolves.toBeUndefined();
    } finally { vi.unstubAllEnvs(); await rm(root, { force: true, recursive: true }); }
  });
});
