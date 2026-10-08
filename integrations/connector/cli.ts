import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONNECTOR_RUNTIMES, validateQuickConnectHandoff, type ConnectorRuntime } from '../../sdk/typescript/src/quick-connect';
import { adapterFor } from './adapters';
import { ConnectorSetupError } from './adapter';
import { connectionDirectory, connectionStatus, doctorConnection, prepareConnection, readConnection, removeInstalledExecutable, reportBackgroundFailure, setupConnection, startCommand, startConnection } from './core';
import { installConnectorService, uninstallConnectorService } from './service';
import { queryControl } from './control';
import { waitForConnection } from './activation';
import { hermesMcpClient } from '../hermes/mcp-client';

const usage = `Envoi connector (Node.js 22+) — OpenClaw, Hermes, Grok\n
prepare --runtime <openclaw|hermes|grok> --api-url <Envoi origin> [--prepare-runtime]\n
setup --handoff <private JSON file> [--no-service] [--prepare-runtime]\n
setup --handoff-stdin [--no-service] [--prepare-runtime]\n
start|status|doctor|install-service|stop|uninstall --state-dir <directory>\n
mcp --state-dir <Hermes connection directory> (started automatically by Hermes)\n
Setup installs and checks background startup by default. --no-service is for an existing host supervisor.\n
Discovery overrides: --config <path> --profile <name> --agent <id> --gateway-url <origin>\n
Hermes setup migration: --replace-mcp-server <existing Envoi server name>\n
Stop the old connector first. This replaces only its profile MCP entry and preserves its state.\n
Keep keys in local secret storage. Never pass them as arguments.\n
Hermes --prepare-runtime configures its local API key and API settings.\n
It does not configure a missing model provider or restart a Gateway serving your chat.\n`;
const stringOptions = ['--handoff', '--state-dir', '--runtime', '--api-url', '--config', '--profile', '--agent', '--gateway-url', '--replace-mcp-server'];
const flagOptions = ['--handoff-stdin', '--install-service', '--no-service', '--prepare-runtime'];

async function managedStartup(directory: string, runtime: string, ready: boolean) {
  try {
    const name = await installConnectorService(directory, runtime);
    await waitForConnection(directory, { ready, timeoutMs: ready ? 90_000 : 30_000 });
    return name;
  } catch (error) {
    const code = error instanceof ConnectorSetupError && error.code === 'BACKGROUND_NOT_READY' ? error.code : 'BACKGROUND_START_FAILED';
    await reportBackgroundFailure(directory, code).catch(() => {});
    if (error instanceof ConnectorSetupError) throw error;
    throw new ConnectorSetupError(code, 'Your agent is paired, but background startup failed. Retry setup with its saved state directory to repair startup; no new token is needed.');
  }
}
export async function connectorMain(args = process.argv.slice(2)) {
  if (!args.length || args.length === 1 && args[0] === '--help') { process.stdout.write(usage); return; }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new ConnectorSetupError('NODE_UNSUPPORTED', 'Install Node.js 22 or newer before connecting');
  const [command, ...rest] = args;
  const values = new Map<string, string>(); const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (flagOptions.includes(key)) { if (flags.has(key)) throw new ConnectorSetupError('ARGUMENT_INVALID', 'Duplicate option'); flags.add(key); continue; }
    if (!stringOptions.includes(key) || !rest[i + 1] || rest[i + 1].startsWith('--') || values.has(key)) throw new ConnectorSetupError('ARGUMENT_INVALID', 'Unknown, duplicate or incomplete option. Run --help');
    values.set(key, rest[++i]);
  }
  const options = { configPath: values.get('--config'), profile: values.get('--profile'), agentId: values.get('--agent'),
    gatewayUrl: values.get('--gateway-url'), prepareRuntime: flags.has('--prepare-runtime'), replaceMcpServer: values.get('--replace-mcp-server') };
  if (command === 'prepare') {
    if (options.replaceMcpServer && values.get('--runtime') !== 'hermes') throw new ConnectorSetupError('ARGUMENT_INVALID', '--replace-mcp-server is supported only for Hermes.');
    if (!CONNECTOR_RUNTIMES.includes(values.get('--runtime') as ConnectorRuntime) || !values.get('--api-url') || flags.has('--install-service')
      || flags.has('--no-service') || flags.has('--handoff-stdin') || values.has('--handoff') || values.has('--state-dir')) throw new ConnectorSetupError('ARGUMENT_INVALID', 'Supply --runtime and --api-url for prepare. Run --help');
    const result = await prepareConnection(values.get('--runtime') as ConnectorRuntime, values.get('--api-url')!, adapterFor, options);
    process.stdout.write(`${JSON.stringify(result)}\n`); return;
  }
  if (command === 'setup') {
    if (flags.has('--install-service') && flags.has('--no-service')) throw new ConnectorSetupError('ARGUMENT_INVALID', 'Choose managed startup or --no-service, not both.');
    if (values.has('--handoff') === flags.has('--handoff-stdin') || values.has('--runtime') || values.has('--api-url')) throw new ConnectorSetupError('ARGUMENT_INVALID', 'Supply either --handoff <file> or --handoff-stdin. The runtime and origin come from the handoff');
    let source: string;
    if (flags.has('--handoff-stdin')) {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of process.stdin) { length += chunk.length; if (length > 16_384) throw new ConnectorSetupError('HANDOFF_INVALID', 'Setup input is too large'); chunks.push(Buffer.from(chunk)); }
      source = Buffer.concat(chunks).toString('utf8');
    } else {
      const filename = path.resolve(values.get('--handoff')!); const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new ConnectorSetupError('HANDOFF_INVALID', 'Choose a regular private setup file of at most 16 KB');
      if (process.platform !== 'win32' && stat.mode & 0o077) throw new ConnectorSetupError('HANDOFF_INVALID', 'Restrict the setup file to your account (chmod 600)');
      source = await readFile(filename, 'utf8');
    }
    let input: unknown;
    try { input = JSON.parse(source); } catch { throw new ConnectorSetupError('HANDOFF_INVALID', 'Download a valid Envoi setup file'); }
    if (options.replaceMcpServer && (input as { runtime?: unknown })?.runtime !== 'hermes') throw new ConnectorSetupError('ARGUMENT_INVALID', '--replace-mcp-server is supported only for Hermes.');
    const managed = !flags.has('--no-service');
    let result: Awaited<ReturnType<typeof setupConnection>>;
    try {
      result = await setupConnection(input, adapterFor, { ...options, stateDir: values.get('--state-dir'),
        installService: managed, executableFile: fileURLToPath(import.meta.url), onProgress: text => process.stderr.write(`${text}…\n`) });
    } catch (error) {
      // Tool discovery can need a first profile reload. Keep the durable owner
      // running while the user approves that reload instead of tearing it down.
      if (!managed || !(error instanceof ConnectorSetupError) || error.code !== 'TOOLS_NOT_READY') throw error;
      const handoff = validateQuickConnectHandoff(input, { allowExpired: true });
      const directory = path.resolve(values.get('--state-dir') ?? connectionDirectory(handoff.apiUrl, handoff.address, handoff.runtime));
      const name = await managedStartup(directory, handoff.runtime, false);
      process.stdout.write(`${JSON.stringify({ stateDir: directory, runtime: handoff.runtime, address: handoff.address, checks: 'pending', startupService: name, waitingFor: 'Hermes MCP configuration reload' })}\n`);
      process.stderr.write('Your saved background connection is running. Hermes needs to load its new Envoi tools once: approve its MCP reload or open a fresh chat. Ask the Gateway owner to reload/restart that selected profile if its API has not loaded the new configuration. No separate connector terminal or new token is required. Setup checks are pending.\n');
      return;
    }
    if (managed) {
      process.stderr.write('Installing and checking the background connection after setup exits its temporary relay…\n');
      const name = await managedStartup(result.stateDir, result.runtime, true);
      process.stdout.write(`${JSON.stringify({ ...result, startupService: name, startsAt: 'user login', backgroundChecks: 'passed' })}\n`);
      process.stderr.write(`Setup and background checks passed. Delete the temporary handoff. You can close this terminal.${result.runtime === 'hermes' ? ' Hermes starts its Envoi tools automatically and can reactivate the saved connector.' : ''} User services do not run while the computer is asleep or off.\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.stderr.write(`Setup checks passed. Delete the temporary handoff.\nStart: ${startCommand(result.stateDir)}\nUse your existing host supervisor for unattended receiving.\n`);
    }
    return;
  }
  if (command === 'mcp' && values.size === 1 && values.has('--state-dir') && !flags.size) { await hermesMcpClient(values.get('--state-dir')!); return; }
  if (!['start', 'status', 'doctor', 'install-service', 'stop', 'uninstall'].includes(command) || !values.get('--state-dir') || values.size !== 1 || flags.size) throw new ConnectorSetupError('ARGUMENT_INVALID', 'Supply a supported command and --state-dir. Run --help');
  const directory = path.resolve(values.get('--state-dir')!);
  if (command === 'status') { process.stdout.write(`${JSON.stringify(await connectionStatus(directory))}\n`); return; }
  if (command === 'doctor') { process.stdout.write(`${JSON.stringify(await doctorConnection(directory, adapterFor))}\n`); return; }
  if (command === 'install-service') { const saved = await readConnection(directory); process.stdout.write(`${JSON.stringify({ startupService: await installConnectorService(directory, saved.runtime), startsAt: 'user login' })}\n`); return; }
  if (command === 'stop') {
    await queryControl(directory, 'stop').catch(() => { throw new ConnectorSetupError('CONNECTOR_UNREACHABLE', 'No responding connector. Use status or stop the installed service through its supervisor'); });
    process.stdout.write(`${JSON.stringify({ status: 'stop requested', note: 'An external supervisor may restart this service. Disable it to keep the connection stopped' })}\n`); return;
  }
  if (command === 'uninstall') {
    const saved = await readConnection(directory);
    await uninstallConnectorService(directory, saved.runtime);
    await queryControl(directory, 'stop').catch(() => null);
    await removeInstalledExecutable(directory);
    process.stdout.write(`${JSON.stringify({ status: 'startup removed', note: 'Credentials and work history are preserved. Revoke access in Envoi to invalidate credentials' })}\n`); return;
  }
  const stop = new AbortController(); const cancel = () => stop.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { await startConnection(directory, stop.signal, adapterFor, { onReady: () => process.stdout.write('Envoi connector started. Waiting for incoming work.\n'),
    onWaiting: code => process.stderr.write(`Connection temporarily unavailable (${code}); retrying automatically.\n`),
    onProgress: text => process.stderr.write(`${text}\n`) }); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
