import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { privateDirectory } from './store';
import { windowsAccountSid, windowsExecutable } from './windows';

const identity = vi.hoisted(() => ({ override: null as string | null }));
vi.mock('./windows', async importOriginal => {
  const actual = await importOriginal<typeof import('./windows')>();
  return { ...actual, windowsAccountSid: () => identity.override ? Promise.resolve(identity.override) : actual.windowsAccountSid() };
});

const directories: string[] = [];
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const powershell = (script: string) => execFileSync(windowsExecutable('powershell.exe'),
  ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${script}`], { encoding: 'utf8', windowsHide: true });

async function fixture() {
  // Deliberately use this checkout's volume; moving to the system temp volume hid the D: bug.
  const root = await mkdtemp(path.join(process.cwd(), '.envoi-owned-acl-test-'));
  directories.push(root);
  const directory = path.join(root, 'private');
  await mkdir(directory);
  return { root, directory, sid: await windowsAccountSid() };
}
function inspect(directory: string) {
  return JSON.parse(powershell(`$a=([System.IO.DirectoryInfo]::new(${quote(directory)})).GetAccessControl(); `
    + `$r=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); `
    + `@{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; protected=$a.AreAccessRulesProtected; `
    + `sddl=$a.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All); `
    + `rules=@($r | ForEach-Object { @{sid=$_.IdentityReference.Value; rights=[int]$_.FileSystemRights; `
    + `type=[int]$_.AccessControlType; inherited=$_.IsInherited; inheritance=[int]$_.InheritanceFlags; propagation=[int]$_.PropagationFlags} })} | ConvertTo-Json -Depth 4 -Compress`).trim());
}
function expectPrivate(directory: string, sid: string) {
  const state = inspect(directory);
  expect(state.owner).toBe(sid);
  expect(state.protected).toBe(true);
  expect(state.rules).toEqual([{ sid, rights: 2032127, type: 0, inherited: false, inheritance: 3, propagation: 0 }]);
}

afterEach(async () => {
  identity.override = null;
  for (const directory of directories.splice(0)) {
    const absolute = path.resolve(directory);
    if (path.dirname(absolute) !== process.cwd() || !path.basename(absolute).startsWith('.envoi-owned-acl-test-')) throw new Error('Unsafe fixture cleanup');
    await rm(absolute, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== 'win32')('owned Windows credential directories', () => {
  it('protects an owned directory without WRITE_OWNER, retaining an exact current-SID-only DACL', async () => {
    const { directory, sid } = await fixture();
    expect(inspect(directory).owner).toBe(sid);
    powershell(`$s=[System.Security.Principal.SecurityIdentifier]::new(${quote(sid)}); `
      + `$a=[System.Security.AccessControl.DirectorySecurity]::new(); $a.SetAccessRuleProtection($true,$false); `
      + `$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($s,'Modify','ContainerInherit,ObjectInherit','None','Allow')); `
      + `$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($s,'TakeOwnership','None','None','Deny')); `
      + `([System.IO.DirectoryInfo]::new(${quote(directory)})).SetAccessControl($a)`);
    const before = inspect(directory);
    const ownerWrite = spawnSync(windowsExecutable('powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; $d=[System.IO.DirectoryInfo]::new(${quote(directory)}); `
      + `$a=$d.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner); `
      + `$a.SetOwner([System.Security.Principal.SecurityIdentifier]::new(${quote(sid)})); $d.SetAccessControl($a)`],
    { encoding: 'utf8', windowsHide: true });
    expect(ownerWrite.status, 'fixture must refuse even a same-SID owner write').toBe(1);
    expect(inspect(directory).sddl).toBe(before.sddl);
    await expect(privateDirectory(directory)).resolves.toBe(directory);
    expectPrivate(directory, sid);
  });

  it('refuses a foreign owner without changing its owner, grants or existing contents', async () => {
    const { directory, sid } = await fixture();
    await writeFile(path.join(directory, 'existing.json'), '{}');
    const before = inspect(directory);
    // Model another authenticated caller without changing fixture ownership or requiring elevation.
    identity.override = sid === 'S-1-5-18' ? 'S-1-5-19' : 'S-1-5-18';
    await expect(privateDirectory(directory)).rejects.toThrow('Windows could not restrict credential storage');
    expect(inspect(directory)).toEqual(before);
    expect(await readFile(path.join(directory, 'existing.json'), 'utf8')).toBe('{}');
  });

  it('resets existing child grants while preserving an already-owned private directory', async () => {
    const { directory, sid } = await fixture();
    const filename = path.join(directory, 'existing.json');
    await writeFile(filename, '{}');
    powershell(`$s=[System.Security.Principal.SecurityIdentifier]::new(${quote(sid)}); `
      + `$a=[System.Security.AccessControl.FileSecurity]::new(); $a.SetAccessRuleProtection($true,$false); `
      + `$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','Allow')); `
      + `$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow')); `
      + `([System.IO.FileInfo]::new(${quote(filename)})).SetAccessControl($a)`);
    await privateDirectory(directory);
    expectPrivate(directory, sid);
    const child = JSON.parse(powershell(`$a=([System.IO.FileInfo]::new(${quote(filename)})).GetAccessControl(); `
      + `@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { `
      + `@{sid=$_.IdentityReference.Value; inherited=$_.IsInherited; rights=[int]$_.FileSystemRights} }) | ConvertTo-Json -Compress`).trim());
    expect([].concat(child)).toEqual([{ sid, inherited: true, rights: 2032127 }]);
    expect(await readFile(filename, 'utf8')).toBe('{}');
  });
});
