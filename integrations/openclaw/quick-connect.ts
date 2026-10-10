import { QuickConnectError } from './quick-connect-error';
import { copyFile, lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { enrollConnector, SinaloaConnector, type ConnectorSession } from '../../sdk/typescript/src/connector';
import { quickConnectOrigin, validateQuickConnectHandoff } from '../../sdk/typescript/src/quick-connect';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { discoverOpenClaw, preflightOpenClaw, type DiscoverOpenClawOptions, type OpenClawConfiguration } from './quick-connect-config';
import { privateDirectory, privateJson, acquireConnectorLock } from './quick-connect-store';
import { checkServiceManager, installConnectorService } from './quick-connect-service';
import { createOpenClawBridge } from './runtime';

interface InstalledConnection {
  version: 1;
  runtime: 'openclaw';
  apiUrl: string;
  address: string;
  agentName: string;
  openclaw: OpenClawConfiguration;
}

export interface SetupOptions extends DiscoverOpenClawOptions {
  stateDir?: string;
  platform?: string;
  fetch?: typeof fetch;
  executableFile?: string;
  secureDirectory?: typeof privateDirectory;
  onProgress?: (phase: string) => void;
}

export function defaultConnectionDirectory(apiUrl: string, address: string, options: { home?: string; env?: NodeJS.ProcessEnv; platform?: string } = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const id = createHash('sha256').update(`${quickConnectOrigin(apiUrl)}\n${address.toLowerCase()}`).digest('hex').slice(0, 24);
  const base = platform === 'win32' ? (env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
      : (env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state'));
  return path.join(base, 'sinaloa', 'openclaw', id);
}

export function connectorStartCommand(stateDir: string, platform = process.platform, node = process.execPath) {
  const args = [node, path.join(stateDir, 'connector.mjs'), 'start', '--state-dir', stateDir];
  if (platform === 'win32') return `& ${args.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')}`;
  return args.map(value => `'${value.replaceAll("'", "'\"'\"'")}'`).join(' ');
}

/** Never follow redirects carrying enrollment or runtime credentials. */
function connectionFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return (input, init) => fetcher(input, { ...init, redirect: 'error' });
}

async function reportChecks(apiUrl: string, connector: SinaloaConnector, phase: 'ready' | 'error', fetcher: typeof fetch, errorCode?: string) {
  const token = await connector.currentAccessToken();
  const response = await fetcher(`${apiUrl}/api/agent/connection-status`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, runtime: 'openclaw', phase, gatewayTest: phase === 'ready' ? 'passed' : 'failed', ...(errorCode ? { errorCode } : {}) }),
    signal: AbortSignal.timeout(30_000), redirect: 'error'
  });
  if (!response.ok) throw new QuickConnectError(`Envoi could not record setup checks (HTTP ${response.status}). Your connection is saved; retry start`);
  await response.body?.cancel();
}

async function readConnection(directory: string): Promise<InstalledConnection> {
  const filename = path.join(directory, 'connection.json');
  if ((await lstat(filename)).isSymbolicLink()) throw new QuickConnectError('The saved connection must not be a symbolic link');
  const saved = JSON.parse(await readFile(filename, 'utf8')) as InstalledConnection;
  if (saved.version !== 1 || saved.runtime !== 'openclaw' || typeof saved.address !== 'string' || !saved.openclaw) throw new QuickConnectError('The saved connection is invalid. Inspect the private state directory');
  saved.apiUrl = quickConnectOrigin(saved.apiUrl);
  return saved;
}

function resumeDiscovery(previous: OpenClawConfiguration, options: DiscoverOpenClawOptions = {}): DiscoverOpenClawOptions {
  const env = options.env ?? process.env;
  const result: DiscoverOpenClawOptions = { ...options, env, allowMissingConfig: true, fallbackConfiguration: previous,
    configPath: options.configPath || env.OPENCLAW_CONFIG_PATH || previous.configPath,
    agentId: options.agentId || env.OPENCLAW_AGENT_ID || previous.agentId };
  // Fresh local configuration supplies rotated credentials. A previously selected remote
  // endpoint keeps its explicit credential pair, never a token discovered for local use.
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(previous.gatewayUrl).hostname)) {
    const gatewayUrl = options.gatewayUrl || env.OPENCLAW_GATEWAY_URL || previous.gatewayUrl;
    const gatewayToken = options.gatewayToken || env.OPENCLAW_GATEWAY_TOKEN;
    if (new URL(gatewayUrl).origin !== new URL(previous.gatewayUrl).origin && !gatewayToken) {
      throw new QuickConnectError('Changing the saved Gateway origin requires its own explicit local Gateway credential. Set OPENCLAW_GATEWAY_TOKEN for the selected Gateway');
    }
    result.gatewayUrl = gatewayUrl;
    result.gatewayToken = gatewayToken || previous.gatewayToken;
  }
  return result;
}

/** Pure setup orchestration with injectable I/O for credential/restart integration tests. */
export async function setupQuickConnect(input: unknown, options: SetupOptions = {}) {
  const fetcher = connectionFetch(options.fetch);
  // An expired file may resume an already enrolled installation; it must never be redeemed again.
  const handoff = validateQuickConnectHandoff(input, { allowExpired: true });
  if (handoff.runtime !== 'openclaw' || handoff.operation === 'reconnect') throw new QuickConnectError('Use the unified Envoi connector for this runtime or reconnect handoff');
  const requested = options.stateDir || defaultConnectionDirectory(handoff.apiUrl, handoff.address, { home: options.homeDir, env: options.env, platform: options.platform });
  const stateDir = await (options.secureDirectory ?? privateDirectory)(requested);
  const unlock = await acquireConnectorLock(stateDir);
  try {
    const store = new FileBridgeStore(stateDir);
    await store.init();
    let session = await store.load();
    let prior: InstalledConnection | undefined;
    if (session) {
      prior = await readConnection(stateDir);
      if (prior.apiUrl !== handoff.apiUrl || prior.address !== handoff.address || session.address !== handoff.address) {
        throw new QuickConnectError('This state directory belongs to another connection. Choose a separate private directory');
      }
    } else validateQuickConnectHandoff(input);
    options.onProgress?.('Detecting OpenClaw');
    const openclaw = await discoverOpenClaw(prior ? resumeDiscovery(prior.openclaw, options) : options);
    options.onProgress?.('Testing OpenClaw before enrollment');
    await preflightOpenClaw(openclaw, { fetch: fetcher });
    const saved: InstalledConnection = { version: 1, runtime: 'openclaw', apiUrl: handoff.apiUrl,
      address: handoff.address, agentName: handoff.agentName, openclaw };
    // Write the restart configuration before redeeming so interrupted setup can resume safely.
    await privateJson(path.join(stateDir, 'connection.json'), saved);
    if (options.executableFile) {
      const target = path.join(stateDir, 'connector.mjs');
      if (path.resolve(options.executableFile) !== path.resolve(target)) await copyFile(options.executableFile, target);
    }
    options.onProgress?.(session ? 'Resuming saved connection' : 'Enrolling Envoi agent');
    if (!session) {
      try { session = await enrollConnector(handoff.apiUrl, handoff.enrollmentToken, store, { name: handoff.agentName, fetch: fetcher }); }
      catch (error) {
        const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 0;
        if (status === 401) throw new QuickConnectError('The enrollment token is expired or already used. Check Agent connections in Envoi and create a new setup prompt if no saved connection exists');
        throw new QuickConnectError('Envoi enrollment did not finish. Check Agent connections before retrying; the token may have been consumed. Keep this state directory');
      }
    }
    if (session.address !== handoff.address) throw new QuickConnectError('The enrolled address differs from the setup address. Inspect Agent connections before starting');
    const connector = new SinaloaConnector(handoff.apiUrl, store, { fetch: fetcher });
    options.onProgress?.('Checking Envoi access');
    try { await connector.checkStatus(); await reportChecks(handoff.apiUrl, connector, 'ready', fetcher); }
    catch (error) {
      await reportChecks(handoff.apiUrl, connector, 'error', fetcher, 'CONNECTION_TEST_FAILED').catch(() => {});
      throw error;
    }
    return { stateDir, address: session.address, agentId: session.agentId, checks: 'passed' as const };
  } finally { await unlock(); }
}

/** Starts the same bridge as manual onboarding, using saved state and enforcing one process. */
export async function startQuickConnect(stateDir: string, signal: AbortSignal, options: { fetch?: typeof fetch; secureDirectory?: typeof privateDirectory; env?: NodeJS.ProcessEnv; pollIntervalMs?: number; onReady?: () => void } = {}) {
  const directory = await (options.secureDirectory ?? privateDirectory)(stateDir);
  const unlock = await acquireConnectorLock(directory);
  const fetcher = connectionFetch(options.fetch);
  let bridge: Awaited<ReturnType<typeof createOpenClawBridge>> | undefined;
  try {
    const saved = await readConnection(directory);
    const openclaw = await discoverOpenClaw(resumeDiscovery(saved.openclaw, { env: options.env }));
    await preflightOpenClaw(openclaw, { fetch: fetcher, signal });
    bridge = await createOpenClawBridge({ ...openclaw, apiUrl: saved.apiUrl, stateDir: directory }, { ...options, fetch: fetcher });
    await bridge.connector.checkStatus();
    await reportChecks(saved.apiUrl, bridge.connector, 'ready', fetcher);
    options.onReady?.();
    await bridge.connector.run(signal);
  } catch (error) {
    if (bridge) {
      const saved = await readConnection(directory).catch(() => null);
      if (saved) await reportChecks(saved.apiUrl, bridge.connector, 'error', fetcher, 'CONNECTOR_START_FAILED').catch(() => {});
    }
    throw error;
  } finally { try { await bridge?.close(); } finally { await unlock(); } }
}

export async function savedConnectionStatus(stateDir: string) {
  const saved = await readConnection(path.resolve(stateDir));
  const session: ConnectorSession | null = await new FileBridgeStore(path.resolve(stateDir)).load();
  if (!session) throw new QuickConnectError('No saved enrollment. Run setup with a fresh Envoi handoff');
  return { address: session.address, apiUrl: saved.apiUrl, agentId: session.agentId, openclawAgentId: saved.openclaw.agentId,
    stateDir: path.resolve(stateDir), credentialExpiresAt: session.agentTokenExpiresAt,
    refreshExpiresAt: session.agentRefreshTokenExpiresAt, status: 'configured', note: 'Saved configuration does not establish live presence. Use start and a real agent exchange to verify receiving' };
}

const usage = `Envoi OpenClaw Quick Connect (Node.js 22+)\n\nsetup --handoff <private JSON file> [--install-service]\nsetup --handoff-stdin [--install-service]\nstart --state-dir <directory>\nstatus --state-dir <directory>\ninstall-service --state-dir <directory>\n\nOptional setup overrides: --config <openclaw.json> --agent <id> --gateway-url <origin> --state-dir <private directory>\nGateway credentials are resolved locally; never pass secrets as arguments.\n`;

export async function quickConnectMain(args = process.argv.slice(2)) {
  if (!args.length || args.includes('--help')) { process.stdout.write(usage); return; }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new QuickConnectError('Install Node.js 22 or newer before connecting OpenClaw');
  const [command, ...rest] = args;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (['--install-service', '--handoff-stdin'].includes(key)) { if (flags.has(key)) throw new QuickConnectError('Duplicate option'); flags.add(key); continue; }
    if (!['--handoff', '--config', '--agent', '--gateway-url', '--state-dir'].includes(key) || !rest[i + 1] || rest[i + 1].startsWith('--') || values.has(key)) throw new QuickConnectError('Unknown, duplicate or incomplete option. Run --help');
    values.set(key, rest[++i]);
  }
  if (command === 'setup') {
    if (values.has('--handoff') === flags.has('--handoff-stdin')) throw new QuickConnectError('Supply either --handoff <file> or --handoff-stdin');
    if (flags.has('--install-service')) await checkServiceManager();
    let source: string;
    if (flags.has('--handoff-stdin')) {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of process.stdin) { length += chunk.length; if (length > 16_384) throw new QuickConnectError('Setup input is too large'); chunks.push(Buffer.from(chunk)); }
      source = Buffer.concat(chunks).toString('utf8');
    } else {
      const filename = path.resolve(values.get('--handoff')!);
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new QuickConnectError('Choose a regular private setup file of at most 16 KB');
      if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new QuickConnectError('Restrict the setup file to your account (chmod 600) before connecting');
      source = await readFile(filename, 'utf8');
    }
    let input: unknown;
    try { input = JSON.parse(source); } catch { throw new QuickConnectError('The setup file is not valid JSON. Download a fresh setup file from Envoi'); }
    const result = await setupQuickConnect(input, {
      stateDir: values.get('--state-dir'), configPath: values.get('--config'), agentId: values.get('--agent'), gatewayUrl: values.get('--gateway-url'),
      executableFile: fileURLToPath(import.meta.url), onProgress: phase => process.stderr.write(`${phase}…\n`)
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.stderr.write(`Setup checks passed. Remove the temporary handoff file.\nStart: ${connectorStartCommand(result.stateDir)}\n`);
    if (flags.has('--install-service')) process.stdout.write(`${JSON.stringify({ startupService: await installConnectorService(result.stateDir), startsAt: 'user login' })}\n`);
    else process.stderr.write('Configure automatic startup with install-service --state-dir <reported directory>, or run start under your host process supervisor. A real exchange with another agent verifies unattended receiving.\n');
    return;
  }
  if (!['start', 'status', 'install-service'].includes(command) || !values.get('--state-dir') || values.size !== 1 || flags.size) throw new QuickConnectError('Supply a supported command and --state-dir. Run --help');
  const stateDir = path.resolve(values.get('--state-dir')!);
  if (command === 'status') { process.stdout.write(`${JSON.stringify(await savedConnectionStatus(stateDir))}\n`); return; }
  if (command === 'install-service') {
    await savedConnectionStatus(stateDir);
    process.stdout.write(`${JSON.stringify({ startupService: await installConnectorService(stateDir), startsAt: 'user login' })}\n`); return;
  }
  const stop = new AbortController();
  const cancel = () => stop.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { await startQuickConnect(stateDir, stop.signal, { onReady: () => process.stdout.write('Envoi connector started. Waiting for agent messages.\n') }); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
