import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { windowsExecutable, windowsAccountSid } from '../connector/windows';
import { artifactNames, launcherNames, sha256 } from './artifacts.mjs';
import { installPrivatePackage } from './install.mjs';
import { preparePackage } from './prepare.mjs';
import { checkPrivateDirectoryBundle } from './build-private-directory.mjs';

const fault = vi.hoisted(() => ({ target: '', write: '', corrupt: '', protect: false, rename: false, staleBundle: false, events: [] as string[] }));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const filePaths = await import('node:path');
  return {
    ...actual,
    readFile: async (filename: string, options: any) => {
      const bytes = await actual.readFile(filename, options);
      if (fault.staleBundle && filePaths.basename(String(filename)) === 'private-directory.mjs') {
        return typeof bytes === 'string' ? bytes + '\nSTALE' : Buffer.concat([bytes, Buffer.from('\nSTALE')]);
      }
      return bytes;
    },
    writeFile: async (filename: string, bytes: any, options: any) => {
      if (fault.target && String(filename).startsWith(fault.target + filePaths.sep)) {
        const name = filePaths.basename(String(filename));
        fault.events.push(`write:${name}`);
        if (name === fault.write) {
          await actual.writeFile(filename, Buffer.from(bytes).subarray(0, 4), options);
          throw Object.assign(new Error('Simulated interrupted write'), { code: 'EIO' });
        }
        if (name === fault.corrupt) return actual.writeFile(filename, 'CORRUPTED_AFTER_VERIFICATION', options);
      }
      return actual.writeFile(filename, bytes, options);
    },
    rename: async (source: string, destination: string) => {
      if (fault.target && source === filePaths.join(fault.target, 'installation.pending.json')) {
        fault.events.push('commit');
        if (fault.rename) throw Object.assign(new Error('Simulated commit failure'), { code: 'EIO' });
      }
      return actual.rename(source, destination);
    }
  };
});

vi.mock('./private-directory.mjs', async importOriginal => {
  const actual = await importOriginal<{ privateDirectory(directory: string): Promise<string> }>();
  return { privateDirectory: async (directory: string) => {
    fault.events.push('protect');
    expect(directory).toBe(fault.target);
    expect(await readdir(directory)).toEqual([]);
    if (fault.protect) throw new Error('Simulated directory protection failure');
    return actual.privateDirectory(directory);
  } };
});

const directories: string[] = [];
afterEach(async () => {
  Object.assign(fault, { target: '', write: '', corrupt: '', protect: false, rename: false, staleBundle: false, events: [] });
  for (const directory of directories.splice(0)) {
    const absolute = path.resolve(directory);
    if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('envoi-install-hardening-')) throw new Error('Unsafe fixture cleanup');
    await rm(absolute, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'envoi-install-hardening-'));
  directories.push(root);
  const source = path.join(root, 'source');
  const saved = path.join(root, 'existing agent state');
  const destination = path.join(root, "new install 'quoted'");
  await mkdir(source);
  await mkdir(saved);
  const artifacts: Record<string, { sha256: string; size: number }> = {};
  for (const name of artifactNames) {
    const bytes = Buffer.from('export const fixtureOnly = true;\n');
    await writeFile(path.join(source, name), bytes);
    artifacts[name] = { sha256: sha256(bytes), size: bytes.length };
  }
  const bytes = Buffer.from(JSON.stringify({ version: 1, private: true, published: false, nodeMinimum: 22,
    coreContract: { id: 'agent-registration', version: 1, revision: 3, publication: '4da219e7156138c94e26b8105efe7ffe43ec6f98' }, artifacts }));
  await writeFile(path.join(source, 'private-release.json'), bytes);
  for (const name of ['session.json', 'cursor.json', 'receipts.json']) await writeFile(path.join(saved, name), `PRESERVE_${name}`);
  fault.target = destination;
  fault.events = [];
  return { root, source, saved, destination, bytes, digest: sha256(bytes) };
}

async function preserved(value: Awaited<ReturnType<typeof fixture>>) {
  expect(await readFile(path.join(value.source, 'private-release.json'))).toEqual(value.bytes);
  for (const name of artifactNames) expect(await readFile(path.join(value.source, name), 'utf8')).toBe('export const fixtureOnly = true;\n');
  for (const name of ['session.json', 'cursor.json', 'receipts.json']) expect(await readFile(path.join(value.saved, name), 'utf8')).toBe(`PRESERVE_${name}`);
}

async function noCompletion(directory: string) {
  await expect(readFile(path.join(directory, 'installation.json'))).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('installation protection and interruption recovery', () => {
  it('commits a standalone bundle generated from the existing private-directory helper without drift', async () => {
    await expect(checkPrivateDirectoryBundle()).resolves.toBeUndefined();
  });

  it('rebuilds the same bundle outside the checkout without working-directory-specific output', async () => {
    const value = await fixture();
    const moduleUrl = pathToFileURL(path.resolve('integrations/distribution/build-private-directory.mjs')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { buildPrivateDirectory } from ${JSON.stringify(moduleUrl)}; process.stdout.write(await buildPrivateDirectory());`],
      { cwd: value.root, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(await readFile(path.resolve('integrations/distribution/private-directory.mjs'), 'utf8'));
  });

  it('refuses to prepare a stale protection helper before creating package output', async () => {
    const value = await fixture();
    const output = path.join(value.root, 'stale bundle');
    fault.staleBundle = true;
    await expect(preparePackage(value.source, output, value.digest)).rejects.toThrow(/drifted/);
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    await preserved(value);
  });

  it('protects only the newly-created empty directory before any artifact or completion record is written', async () => {
    const value = await fixture();
    expect(await installPrivatePackage(value.source, value.destination, value.digest)).toMatchObject({ connected: false, serviceInstalled: false });
    expect(fault.events).toEqual(['protect', 'write:envoi-link.mjs', 'write:envoi-connector.mjs', 'write:private-release.json', ...launcherNames.map(name => `write:${name}`), 'write:installation.pending.json', 'commit']);
    expect(JSON.parse(await readFile(path.join(value.destination, 'installation.json'), 'utf8')).manifestSha256).toBe(value.digest);
    await preserved(value);
  });

  it('fails closed before writing artifacts when account-only protection fails', async () => {
    const value = await fixture();
    fault.protect = true;
    await expect(installPrivatePackage(value.source, value.destination, value.digest)).rejects.toThrow(/protection failure/);
    expect(fault.events).toEqual(['protect']);
    expect(await readdir(value.destination)).toEqual([]);
    await noCompletion(value.destination);
    await preserved(value);
  });

  it.each([...artifactNames, 'private-release.json', ...launcherNames, 'installation.pending.json'])('never commits after an interrupted %s write', async filename => {
    const value = await fixture();
    fault.write = filename;
    await expect(installPrivatePackage(value.source, value.destination, value.digest)).rejects.toMatchObject({ code: 'EIO' });
    expect((await readFile(path.join(value.destination, filename))).length).toBe(4);
    expect(fault.events).not.toContain('commit');
    await noCompletion(value.destination);
    await preserved(value);
  });

  it('leaves pending evidence and no success marker when final rename fails', async () => {
    const value = await fixture();
    fault.rename = true;
    await expect(installPrivatePackage(value.source, value.destination, value.digest)).rejects.toMatchObject({ code: 'EIO' });
    expect(JSON.parse(await readFile(path.join(value.destination, 'installation.pending.json'), 'utf8')).manifestSha256).toBe(value.digest);
    await noCompletion(value.destination);
    await preserved(value);
  });

  it.each(['envoi-link.mjs', ...launcherNames])('rechecks persisted %s bytes before producing any completion record', async filename => {
    const value = await fixture();
    fault.corrupt = filename;
    await expect(installPrivatePackage(value.source, value.destination, value.digest)).rejects.toThrow(/checksum/);
    expect(fault.events).not.toContain('write:installation.pending.json');
    await noCompletion(value.destination);
    await preserved(value);
  });

  it('refuses to protect or overwrite an existing agent directory', async () => {
    const value = await fixture();
    fault.target = value.saved;
    await expect(installPrivatePackage(value.source, value.saved, value.digest)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fault.events).toEqual([]);
    await preserved(value);
  });

  it('preserves an interrupted installation, refuses reuse, and succeeds only at a fresh destination', async () => {
    const value = await fixture();
    fault.write = 'envoi-connector.mjs';
    await expect(installPrivatePackage(value.source, value.destination, value.digest)).rejects.toMatchObject({ code: 'EIO' });
    const partial = await readFile(path.join(value.destination, fault.write));
    fault.write = '';
    fault.events = [];
    await expect(installPrivatePackage(value.source, value.destination, value.digest)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fault.events).toEqual([]);
    expect(await readFile(path.join(value.destination, 'envoi-connector.mjs'))).toEqual(partial);
    fault.target = path.join(value.root, 'fresh retry');
    await expect(installPrivatePackage(value.source, fault.target, value.digest)).resolves.toMatchObject({ connected: false });
    await noCompletion(value.destination);
    await preserved(value);
  });

  it('does not create or protect a destination for an unapproved manifest', async () => {
    const value = await fixture();
    await expect(installPrivatePackage(value.source, value.destination, '0'.repeat(64))).rejects.toThrow(/checksum/);
    expect(fault.events).toEqual([]);
    await expect(stat(value.destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await preserved(value);
  });

  it('packages the actual protection helper and runs the packaged installer with no repository dependency', async () => {
    const value = await fixture();
    const bundle = path.join(value.root, 'private bundle');
    await preparePackage(value.source, bundle, value.digest);
    expect(await readFile(path.join(bundle, 'private-directory.mjs'))).toEqual(await readFile(path.resolve('integrations/distribution/private-directory.mjs')));
    const result = spawnSync(process.execPath, [path.join(bundle, 'install.mjs'), '--bundle', bundle, '--destination', value.destination,
      '--manifest-sha256', value.digest], { cwd: value.root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ connected: false, serviceInstalled: false });
    await preserved(value);
  });

  it.runIf(process.platform !== 'win32')('creates account-only POSIX install files and directories', async () => {
    const value = await fixture();
    await installPrivatePackage(value.source, value.destination, value.digest);
    expect((await stat(value.destination)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(value.destination, 'envoi-link'))).mode & 0o777).toBe(0o700);
    for (const name of [...artifactNames, ...launcherNames.filter(name => name !== 'envoi-link'), 'private-release.json', 'installation.json']) expect((await stat(path.join(value.destination, name))).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform === 'win32')('uses the existing helper to restrict real disposable Windows install ACLs to the current SID', async () => {
    const value = await fixture();
    const sid = await windowsAccountSid();
    const acl = (filename: string, directory: boolean) => {
      const script = `$ErrorActionPreference='Stop'; $p='${filename.replaceAll("'", "''")}'; $a=([System.IO.${directory ? 'DirectoryInfo' : 'FileInfo'}]::new($p)).GetAccessControl(); @{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; protected=$a.AreAccessRulesProtected; rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value; rights=$_.FileSystemRights.ToString(); type=$_.AccessControlType.ToString()} })} | ConvertTo-Json -Depth 5 -Compress`;
      return JSON.parse(execFileSync(windowsExecutable('powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }));
    };
    const parentBefore = acl(value.root, true);
    await installPrivatePackage(value.source, value.destination, value.digest);
    const protectedDirectory = acl(value.destination, true);
    expect(protectedDirectory.protected).toBe(true);
    for (const record of [protectedDirectory, ...[...artifactNames, ...launcherNames, 'installation.json'].map(name => acl(path.join(value.destination, name), false))]) {
      expect(record.owner).toBe(sid);
      expect(record.rules).toEqual([{ sid, rights: 'FullControl', type: 'Allow' }]);
    }
    expect(acl(value.root, true)).toEqual(parentBefore);
    await preserved(value);
  });
});
