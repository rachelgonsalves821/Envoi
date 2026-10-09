import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConnectorSetupError } from './adapter';

const execute = promisify(execFile);
type WindowsHelper = 'whoami.exe' | 'icacls.exe' | 'schtasks.exe' | 'powershell.exe';

/** Git Bash ships a different whoami.exe. Native helpers must never use PATH. */
export function windowsExecutable(name: WindowsHelper, env: NodeJS.ProcessEnv = process.env): string {
  const root = Object.entries(env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1]
    ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'windir')?.[1];
  if (!root || !/^[A-Za-z]:[\\/]/.test(root) || /[\x00-\x1f<>"|?*]/.test(root)) {
    throw new ConnectorSetupError('WINDOWS_HELPER_UNAVAILABLE', 'Windows system directory could not be located. Run the connector from a normal Windows terminal with SystemRoot set; preserve any saved connection for retry.');
  }
  return name === 'powershell.exe'
    ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', name)
    : path.win32.join(root, 'System32', name);
}

export async function windowsAccountSid() {
  try {
    const { stdout } = await execute(windowsExecutable('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10_000 });
    const sid = stdout.match(/\bS-1-[0-9]+(?:-[0-9]+)+\b/)?.[0];
    if (!sid) throw new Error();
    return sid;
  } catch {
    throw new ConnectorSetupError('WINDOWS_ACCOUNT_UNAVAILABLE', 'Could not identify the current Windows account for private credential storage or user startup. Run the connector from your Windows account; preserve any saved connection for retry.');
  }
}
