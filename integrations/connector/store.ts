import { QuickConnectError } from '../openclaw/quick-connect-error';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);

/** Restrict the whole credential directory, including inherited Windows ACLs. */
export async function privateDirectory(directory: string) {
  const absolute = path.resolve(directory);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const canonical = path.resolve(await realpath(absolute));
  if ((await lstat(absolute)).isSymbolicLink() || (process.platform === 'win32' ? canonical.toLowerCase() !== absolute.toLowerCase() : canonical !== absolute)) {
    throw new QuickConnectError('Choose a private state directory without symbolic links');
  }
  if (process.platform === 'win32') {
    const { stdout } = await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    const sid = stdout.match(/S-1-[0-9-]+/)?.[0];
    if (!sid) throw new QuickConnectError('Could not identify the Windows account for credential protection');
    // Replace explicit as well as inherited grants; chmod does not protect files on Windows.
    // Use .NET directly: an inherited PowerShell 7 module path can break Windows
    // PowerShell's Set-Acl autoload. Terminating errors prevent unprotected setup.
    const script = `$ErrorActionPreference='Stop'; $p='${absolute.replaceAll("'", "''")}'; $s=New-Object System.Security.Principal.SecurityIdentifier('${sid}'); $a=New-Object System.Security.AccessControl.DirectorySecurity; $a.SetAccessRuleProtection($true,$false); $a.SetOwner($s); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $a.AddAccessRule($r); ([System.IO.DirectoryInfo]::new($p)).SetAccessControl($a)`;
    try {
      await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
      if ((await readdir(absolute)).length) await execute('icacls.exe', [path.join(absolute, '*'), '/reset', '/T', '/L', '/Q'], { windowsHide: true });
    } catch { throw new QuickConnectError('Windows could not restrict credential storage to your account. Choose an owned private state directory and retry; this check did not redeem an enrollment token'); }
  } else await chmod(absolute, 0o700);
  return absolute;
}

export async function privateJson(filename: string, value: unknown) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); }
  finally { await handle.close(); }
  try { await rename(temporary, filename); }
  finally { await rm(temporary, { force: true }); }
}

/** One setup or running connector per state directory. Recover locks left by a dead process. */
export async function acquireConnectorLock(directory: string): Promise<() => Promise<void>> {
  const filename = path.join(directory, 'connector.lock');
  const owner = { pid: process.pid, nonce: randomUUID() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(filename, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(owner));
      await handle.close();
      return async () => {
        const current = JSON.parse(await readFile(filename, 'utf8'));
        if (current.nonce === owner.nonce) await rm(filename);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let prior: { pid: number; nonce: string };
      try { prior = JSON.parse(await readFile(filename, 'utf8')); }
      catch { throw new QuickConnectError('The connector lock is incomplete. Check for a running setup before removing connector.lock'); }
      if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0 || !prior.nonce) throw new QuickConnectError('Invalid connector lock; inspect the state directory');
      try { process.kill(prior.pid, 0); }
      catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
          // Serialize dead-owner recovery independently from the main lock.
          const recoveryPath = `${filename}.recovery`;
          let recovery = await open(recoveryPath, 'wx', 0o600).catch(() => null);
          if (!recovery) {
            let recoveryOwner: { pid: number; nonce: string };
            try { recoveryOwner = JSON.parse(await readFile(recoveryPath, 'utf8')); }
            catch { throw new QuickConnectError('The recovery lock is incomplete. Verify no setup is running before removing connector.lock.recovery'); }
            if (!Number.isSafeInteger(recoveryOwner.pid) || recoveryOwner.pid <= 0 || !recoveryOwner.nonce) throw new QuickConnectError('Invalid recovery lock; inspect the state directory');
            try { process.kill(recoveryOwner.pid, 0); }
            catch (recoveryProbe) {
              if ((recoveryProbe as NodeJS.ErrnoException).code === 'ESRCH') {
                const currentRecovery = JSON.parse(await readFile(recoveryPath, 'utf8'));
                if (currentRecovery.nonce === recoveryOwner.nonce) await rm(recoveryPath);
                recovery = await open(recoveryPath, 'wx', 0o600).catch(() => null);
              }
            }
          }
          if (!recovery) throw new QuickConnectError('Another setup is recovering this connector. Try again shortly');
          try {
            await recovery.writeFile(JSON.stringify(owner));
            const current = JSON.parse(await readFile(filename, 'utf8'));
            if (current.nonce === prior.nonce) await rm(filename);
          } finally { await recovery.close(); await rm(recoveryPath, { force: true }); }
          continue;
        }
      }
      throw new QuickConnectError('This Sinaloa connection is already running. Stop its existing connector before setup or start');
    }
  }
  throw new QuickConnectError('Could not acquire the connector lock. Try again after the existing connector stops');
}
