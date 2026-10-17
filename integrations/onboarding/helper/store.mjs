import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

export function windowsExecutable(name, env = process.env) {
  const root = Object.entries(env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1]
    ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'windir')?.[1];
  if (!root || !/^[A-Za-z]:[\\/]/.test(root) || /[\x00-\x1f<>"|?*]/.test(root)) throw new Error('PRIVATE_STORAGE_UNAVAILABLE');
  return name === 'powershell.exe' ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', name) : path.win32.join(root, 'System32', name);
}

export async function secureDirectory(directory, { platform = process.platform, run = execute, env = process.env } = {}) {
  const absolute = path.resolve(directory);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const canonical = path.resolve(await realpath(absolute));
  if ((await lstat(absolute)).isSymbolicLink() || (platform === 'win32' ? canonical.toLowerCase() !== absolute.toLowerCase() : canonical !== absolute)) throw new Error('PRIVATE_STORAGE_UNAVAILABLE');
  if (platform === 'win32') {
    const { stdout } = await run(windowsExecutable('whoami.exe', env), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10_000 });
    const sid = stdout.match(/\bS-1-[0-9]+(?:-[0-9]+)+\b/)?.[0];
    if (!sid) throw new Error('PRIVATE_STORAGE_UNAVAILABLE');
    const script = `$ErrorActionPreference='Stop'; $p='${absolute.replaceAll("'", "''")}'; $s=New-Object System.Security.Principal.SecurityIdentifier('${sid}'); $a=New-Object System.Security.AccessControl.DirectorySecurity; $a.SetAccessRuleProtection($true,$false); $a.SetOwner($s); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $a.AddAccessRule($r); ([System.IO.DirectoryInfo]::new($p)).SetAccessControl($a)`;
    await run(windowsExecutable('powershell.exe', env), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 });
    // Existing explicit child ACLs must not retain older broad grants.
    if ((await readdir(absolute)).length) await run(windowsExecutable('icacls.exe', env), [path.join(absolute, '*'), '/reset', '/T', '/L', '/Q'], { windowsHide: true, timeout: 20_000 });
  } else await chmod(absolute, 0o700);
  return absolute;
}

async function syncDirectory(directory) {
  // Windows FlushFileBuffers is used on each file. Node cannot open directory
  // handles for flushing on Windows; do not claim power-loss guarantees there.
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export class PrivateStore {
  constructor(directory, options = {}) { this.directory = path.resolve(directory); this.options = options; }
  async init() { await (this.options.secureDirectory ?? secureDirectory)(this.directory); return this; }
  filename(name) {
    if (!['helper-state.json', 'session.json', 'helper.lock', 'helper.lock.recovery', 'connector.lock'].includes(name)) throw new Error('STATE_INVALID');
    return path.join(this.directory, name);
  }
  async read(name) {
    const filename = this.filename(name);
    let stat;
    try { stat = await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000) throw new Error('STATE_INVALID');
    const value = JSON.parse(await readFile(filename, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('STATE_INVALID');
    return value;
  }
  async write(name, value) {
    const filename = this.filename(name);
    const prior = await lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (prior && (!prior.isFile() || prior.isSymbolicLink())) throw new Error('STATE_INVALID');
    const temporary = path.join(this.directory, `.helper-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
        await this.options.fault?.('after_file_sync', name);
      } finally { await handle.close(); }
      await rename(temporary, filename);
      await syncDirectory(this.directory);
      await this.options.fault?.('after_rename', name);
    } finally { await rm(temporary, { force: true }); }
  }
  async lock(operation, { allowConnector = false } = {}) {
    const filename = this.filename('helper.lock');
    const nonce = randomUUID();
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { handle = await open(filename, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = await this.read('helper.lock');
        if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner.nonce !== 'string') throw new Error('STATE_LOCK_INVALID');
        try { process.kill(owner.pid, 0); throw new Error('STATE_BUSY'); }
        catch (probe) {
          if (probe.code !== 'ESRCH') throw probe;
          // Serialize dead-owner recovery separately, including recovery after
          // a crash of the process that held this recovery lock.
          const recovery = `${filename}.recovery`;
          let recoveryHandle = await open(recovery, 'wx', 0o600).catch(() => null);
          if (!recoveryHandle) {
            const prior = await this.read('helper.lock.recovery');
            if (!Number.isSafeInteger(prior?.pid) || prior.pid <= 0 || typeof prior.nonce !== 'string' || !prior.nonce) throw new Error('STATE_LOCK_INVALID');
            try { process.kill(prior.pid, 0); }
            catch (probe) {
              if (probe.code === 'ESRCH') {
                const latest = await this.read('helper.lock.recovery');
                if (latest?.nonce === prior.nonce) await rm(recovery);
                recoveryHandle = await open(recovery, 'wx', 0o600).catch(() => null);
              }
            }
          }
          if (!recoveryHandle) throw new Error('STATE_BUSY');
          try {
            await recoveryHandle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
            await recoveryHandle.sync();
            const latest = await this.read('helper.lock');
            if (latest?.nonce === owner.nonce) await rm(filename);
          } finally {
            await recoveryHandle.close();
            const latest = await this.read('helper.lock.recovery');
            if (latest?.nonce === nonce) await rm(recovery, { force: true });
          }
        }
      }
    }
    if (!handle) throw new Error('STATE_BUSY');
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); await handle.sync();
      // A running legacy connector must never share the credential writer.
      if (!allowConnector) {
        const connector = await this.read('connector.lock');
        if (connector) {
          if (!Number.isSafeInteger(connector.pid) || connector.pid <= 0 || typeof connector.nonce !== 'string' || !connector.nonce) throw new Error('STATE_LOCK_INVALID');
          try { process.kill(connector.pid, 0); throw new Error('STATE_BUSY'); }
          catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
          // Core owns reclamation of the dead connector's lock during adoption.
        }
      }
      return await operation();
    } finally {
      await handle.close();
      const owner = await this.read('helper.lock');
      if (owner?.nonce === nonce) await rm(filename);
    }
  }
}
