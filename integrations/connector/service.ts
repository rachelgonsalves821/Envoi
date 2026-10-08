import { QuickConnectError } from '../openclaw/quick-connect-error';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { CONNECTOR_RUNTIMES } from '../../sdk/typescript/src/quick-connect';
import { rm } from 'node:fs/promises';
import { windowsAccountSid, windowsExecutable } from './windows';
import { ConnectorSetupError } from './adapter';
import { privateJson } from './store';

const execute = promisify(execFile);
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const unitArgument = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$')}"`;
const windowsArgument = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;

export interface ServiceDefinition { name: string; filename: string; contents: string; commands: Array<{ executable: string; args: string[] }>; files?: Array<{ filename: string; contents: string }> }

/** All service manifests contain file paths only. Credentials remain in private local storage. */
export function connectorService(directory: string, options: { platform?: string; home?: string; node?: string; user?: string; runtime?: string; env?: NodeJS.ProcessEnv } = {}): ServiceDefinition {
  if (options.runtime && !CONNECTOR_RUNTIMES.includes(options.runtime as typeof CONNECTOR_RUNTIMES[number])) throw new QuickConnectError('Unsupported startup runtime');
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const node = options.node ?? process.execPath;
  if ([directory, home, node, options.user || ''].some(value => /[\r\n\0]/.test(value))) throw new QuickConnectError('Service paths cannot contain control characters');
  const id = createHash('sha256').update(directory).digest('hex').slice(0, 16);
  const name = `sinaloa-${options.runtime || 'openclaw'}-${id}`;
  const connector = path.join(directory, 'connector.mjs');
  const args = [connector, 'start', '--state-dir', directory];
  if (platform === 'linux') {
    const filename = path.join(home, '.config', 'systemd', 'user', `${name}.service`);
    return { name, filename, contents: `[Unit]\nDescription=Envoi agent connector\nStartLimitIntervalSec=300\nStartLimitBurst=5\n\n[Service]\nType=simple\nExecStart=${[node, ...args].map(unitArgument).join(' ')}\nWorkingDirectory=${unitArgument(directory)}\nRestart=on-failure\nRestartSec=10\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`, commands: [
      { executable: 'systemctl', args: ['--user', 'daemon-reload'] },
      { executable: 'systemctl', args: ['--user', 'enable', '--now', `${name}.service`] }
    ] };
  }
  if (platform === 'darwin') {
    const label = `com.sinaloa.${name}`;
    const filename = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    return { name: label, filename,
      contents: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[node, ...args].map(value => `<string>${xml(value)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(directory)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(path.join(directory, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(directory, 'service.log'))}</string></dict></plist>\n`,
      commands: [{ executable: 'launchctl', args: ['load', '-w', filename] }] };
  }
  if (platform === 'win32') {
    if (!options.user) throw new QuickConnectError('Windows startup requires the current account SID');
    const filename = path.join(directory, 'startup-task.xml');
    const launcher = path.join(directory, 'startup-run.ps1');
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const launchArgs = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', launcher];
    const script = ["$ErrorActionPreference = 'Stop'", '$start = New-Object System.Diagnostics.ProcessStartInfo',
      `$start.FileName = ${quote(node)}`, `$start.Arguments = ${quote(args.map(windowsArgument).join(' '))}`, `$start.WorkingDirectory = ${quote(directory)}`,
      '$start.UseShellExecute = $false', '$start.CreateNoWindow = $true', '$start.RedirectStandardOutput = $true', '$start.RedirectStandardError = $true',
      '$child = [System.Diagnostics.Process]::Start($start)', '$output = $child.StandardOutput.ReadToEndAsync()', '$errors = $child.StandardError.ReadToEndAsync()',
      '$child.WaitForExit()', `[System.IO.File]::AppendAllText(${quote(path.join(directory, 'service.log'))}, $output.GetAwaiter().GetResult() + $errors.GetAwaiter().GetResult())`,
      '$code = $child.ExitCode', '$child.Dispose()', 'exit $code', ''
    ].join('\r\n');
    return { name, filename,
      files: [{ filename: launcher, contents: script }],
      contents: `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(options.user)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(options.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>5</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${xml(windowsExecutable('powershell.exe', options.env))}</Command><Arguments>${xml(launchArgs.map(windowsArgument).join(' '))}</Arguments><WorkingDirectory>${xml(directory)}</WorkingDirectory></Exec></Actions></Task>`,
      commands: [{ executable: windowsExecutable('schtasks.exe', options.env), args: ['/Create', '/TN', name, '/XML', filename, '/F'] }, { executable: windowsExecutable('schtasks.exe', options.env), args: ['/Run', '/TN', name] }] };
  }
  throw new QuickConnectError('Automatic startup supports Linux systemd, macOS launchd and Windows Task Scheduler. Use your host process supervisor');
}

export async function checkServiceManager() {
  try {
    if (process.platform === 'linux') await execute('systemctl', ['--user', 'show-environment'], { timeout: 10_000 });
    else if (process.platform === 'darwin') await execute('launchctl', ['list'], { timeout: 10_000 });
    else if (process.platform === 'win32') await execute(windowsExecutable('schtasks.exe'), ['/Query', '/FO', 'CSV', '/NH'], { timeout: 10_000, windowsHide: true });
    else throw new QuickConnectError('unsupported');
  } catch { throw new QuickConnectError('A user startup service is unavailable. Run setup with --no-service and use your host process supervisor to run the printed start command'); }
}

export async function installConnectorService(directory: string, runtime = 'openclaw') {
  await checkServiceManager();
  let user: string | undefined;
  if (process.platform === 'win32') {
    user = await windowsAccountSid();
  }
  const service = connectorService(directory, { user, runtime });
  await mkdir(path.dirname(service.filename), { recursive: true, mode: 0o700 });
  await writeFile(service.filename, process.platform === 'win32' ? Buffer.from(`\uFEFF${service.contents}`, 'utf16le') : service.contents, { mode: 0o600 });
  for (const file of service.files ?? []) await writeFile(file.filename, process.platform === 'win32' ? Buffer.from(`\uFEFF${file.contents}`, 'utf16le') : file.contents, { mode: 0o600 });
  try {
    for (const command of service.commands) {
      if (process.platform === 'darwin' && command.args[0] === 'load') {
        const target = `gui/${process.getuid!()}/${service.name}`;
        const loaded = await execute('launchctl', ['print', target], { timeout: 10_000 }).then(() => true).catch(() => false);
        if (loaded) { await execute('launchctl', ['kickstart', target], { timeout: 20_000 }); continue; }
      }
      await execute(command.executable, command.args, { timeout: 20_000, windowsHide: true });
    }
  } catch { throw new QuickConnectError('Startup registration failed. Your connection is saved; use the printed start command or retry install-service after checking the host service manager'); }
  await privateJson(path.join(directory, 'service-registration.json'), { version: 1, managed: true, name: service.name, registeredAt: new Date().toISOString() });
  return service.name;
}

/** Restart an already registered connector without re-enrollment or replacing its secrets. */
export async function startConnectorService(directory: string, runtime: string) {
  const service = connectorService(directory, { runtime, ...(process.platform === 'win32' ? { user: 'current-account' } : {}) });
  try {
    if (process.platform === 'win32') await execute(windowsExecutable('schtasks.exe'), ['/Run', '/TN', service.name], { timeout: 20_000, windowsHide: true });
    else if (process.platform === 'linux') await execute('systemctl', ['--user', 'start', `${service.name}.service`], { timeout: 20_000 });
    else if (process.platform === 'darwin') await execute('launchctl', ['kickstart', `gui/${process.getuid!()}/${service.name}`], { timeout: 20_000 });
    else throw new Error();
  } catch { throw new ConnectorSetupError('BACKGROUND_START_FAILED', 'The saved background connector could not start. Retry setup to repair its user service; credentials are preserved.'); }
}

export async function uninstallConnectorService(directory: string, runtime: string) {
  let user: string | undefined;
  if (process.platform === 'win32') {
    user = await windowsAccountSid();
  }
  const service = connectorService(path.resolve(directory), { user, runtime });
  // No manifest means this connection was never registered by this installer.
  // Still let the caller stop a foreground connector and preserve its state.
  if (!await lstat(service.filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) return service.name;
  if (process.platform === 'linux') {
    await execute('systemctl', ['--user', 'disable', '--now', `${service.name}.service`], { timeout: 20_000 });
    await rm(service.filename, { force: true });
    await execute('systemctl', ['--user', 'daemon-reload'], { timeout: 20_000 });
  } else if (process.platform === 'darwin') {
    await execute('launchctl', ['unload', '-w', service.filename], { timeout: 20_000 });
    await rm(service.filename, { force: true });
  } else if (process.platform === 'win32') {
    await execute(windowsExecutable('schtasks.exe'), ['/Change', '/TN', service.name, '/DISABLE'], { timeout: 20_000, windowsHide: true });
    // Deleting a task does not stop its running process. Disable restarts first;
    // the authenticated control channel then performs a graceful shutdown.
    await execute(windowsExecutable('schtasks.exe'), ['/Delete', '/TN', service.name, '/F'], { timeout: 20_000, windowsHide: true });
    await rm(service.filename, { force: true });
  }
  await rm(path.join(directory, 'service-registration.json'), { force: true });
  await rm(path.join(directory, 'startup-request.json'), { force: true });
  for (const file of service.files ?? []) await rm(file.filename, { force: true });
  return service.name;
}
