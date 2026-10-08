import { copyFile, lstat, readFile, rm, rename, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { enrollConnector, SinaloaConnector, type ConnectorSession } from '../../sdk/typescript/src/connector';
import { CONNECTOR_RUNTIMES, quickConnectOrigin, validateQuickConnectHandoff, type ConnectorRuntime } from '../../sdk/typescript/src/quick-connect';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { ConnectorSetupError, type AdapterOptions, type ConnectorAdapter, type RuntimeBridge } from './adapter';
import { privateDirectory, privateJson, acquireConnectorLock } from './store';
import { checkServiceManager } from './service';
import { startControl, queryControl } from './control';
import { enrollmentSetupError, readEnrollmentDiagnostic } from './enrollment-error';

export interface InstalledConnection {
  version: 1;
  runtime: ConnectorRuntime;
  apiUrl: string;
  address: string;
  agentName: string;
  configuration: unknown;
  lastReconnectId?: string;
}
export interface SetupOptions extends AdapterOptions {
  stateDir?: string;
  executableFile?: string;
  secureDirectory?: typeof privateDirectory;
  installService?: boolean;
  onProgress?: (phase: string) => void;
}
export type AdapterResolver = (runtime: ConnectorRuntime) => ConnectorAdapter<any>;

export function connectionDirectory(apiUrl: string, address: string, runtime: ConnectorRuntime, options: AdapterOptions = {}) {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const id = createHash('sha256').update(`${quickConnectOrigin(apiUrl)}\n${address.toLowerCase()}`).digest('hex').slice(0, 24);
  const base = platform === 'win32' ? (env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
      : env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state');
  return path.join(base, 'sinaloa', runtime, id);
}
export function startCommand(stateDir: string, platform = process.platform) {
  const args = [process.execPath, path.join(stateDir, 'connector.mjs'), 'start', '--state-dir', stateDir];
  return platform === 'win32' ? `& ${args.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')}`
    : args.map(value => `'${value.replaceAll("'", "'\"'\"'")}'`).join(' ');
}
export const noRedirectFetch = (fetcher: typeof fetch = fetch): typeof fetch => (input, init) => fetcher(input, { ...init, redirect: 'error' });

async function saveExecutable(directory: string, source?: string) {
  if (!source || path.resolve(source) === path.join(directory, 'connector.mjs')) return;
  const temporary = path.join(directory, `.connector-${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary);
    if (process.platform !== 'win32') await chmod(temporary, 0o600);
    await rename(temporary, path.join(directory, 'connector.mjs'));
  } finally { await rm(temporary, { force: true }); }
}

async function savedSession(directory: string): Promise<ConnectorSession | null> {
  const filename = path.join(directory, 'session.json');
  const stat = await lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000) throw new ConnectorSetupError('STATE_INVALID', 'Saved credentials must be a regular private file');
  let value: ConnectorSession | null;
  try { value = await new FileBridgeStore(directory).load(); }
  catch { throw new ConnectorSetupError('STATE_INVALID', 'Saved credentials are invalid; preserve the connection directory for recovery'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ['agentId', 'inboxId', 'address', 'agentApiToken', 'agentRefreshToken'].some(key => typeof value![key as keyof ConnectorSession] !== 'string' || !value![key as keyof ConnectorSession])
    || !Number.isFinite(Date.parse(value.agentTokenExpiresAt)) || !Number.isFinite(Date.parse(value.agentRefreshTokenExpiresAt))) {
    throw new ConnectorSetupError('STATE_INVALID', 'Saved credentials are invalid; preserve the connection directory for recovery');
  }
  return value;
}

export async function readConnection(directory: string): Promise<InstalledConnection> {
  const filename = path.join(directory, 'connection.json');
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000) throw new ConnectorSetupError('STATE_INVALID', 'Choose a regular private saved connection');
  let saved: InstalledConnection & { openclaw?: unknown };
  try { saved = JSON.parse(await readFile(filename, 'utf8')); }
  catch { throw new ConnectorSetupError('STATE_INVALID', 'The saved connection is invalid; preserve it and inspect the private state directory'); }
  // OpenClaw v1 installations upgrade without another enrollment.
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new ConnectorSetupError('STATE_INVALID', 'The saved connection is invalid');
  if (saved.runtime === 'openclaw' && !saved.configuration && saved.openclaw) saved.configuration = saved.openclaw;
  if (saved.version !== 1 || !CONNECTOR_RUNTIMES.includes(saved.runtime) || !saved.configuration || typeof saved.configuration !== 'object' || Array.isArray(saved.configuration)
      || typeof saved.address !== 'string' || typeof saved.agentName !== 'string') throw new ConnectorSetupError('STATE_INVALID', 'The saved connection is invalid');
  saved.apiUrl = quickConnectOrigin(saved.apiUrl);
  return saved;
}
export async function checkSinaloa(apiUrl: string, fetcher: typeof fetch) {
  let response: Response;
  try { response = await fetcher(`${quickConnectOrigin(apiUrl)}/health`, { signal: AbortSignal.timeout(10_000) }); }
  catch { throw new ConnectorSetupError('ENVOI_UNREACHABLE', 'Envoi is unreachable from this host. A remote agent cannot reach another computer’s localhost URL; use the correct public HTTPS deployment'); }
  try {
    if (!response.ok || (await response.json() as { service?: string }).service !== 'sinaloa') throw new Error();
  } catch { throw new ConnectorSetupError('ENVOI_UNREACHABLE', 'The selected URL did not return Envoi health. Check the deployment origin before enrolling'); }
}
async function report(saved: InstalledConnection, connector: SinaloaConnector, phase: 'ready' | 'error', fetcher: typeof fetch, errorCode?: string) {
  const response = await fetcher(`${saved.apiUrl}/api/agent/connection-status`, {
    method: 'POST', headers: { authorization: `Bearer ${await connector.currentAccessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, runtime: saved.runtime, phase, runtimeTest: phase === 'ready' ? 'passed' : 'failed', ...(errorCode ? { errorCode } : {}) }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new ConnectorSetupError(response.status === 429 || response.status >= 500 ? 'ENVOI_UNREACHABLE' : 'CONNECTION_TEST_FAILED', `Envoi could not record setup checks (HTTP ${response.status}). The saved connection can be resumed`);
  await response.body?.cancel();
}

/** Report startup failure without becoming a second rotating credential owner. */
export async function reportBackgroundFailure(directory: string, code: 'BACKGROUND_NOT_READY' | 'BACKGROUND_START_FAILED', fetcher: typeof fetch = fetch) {
  const saved = await readConnection(directory);
  const session = await savedSession(directory);
  if (!session) return;
  const response = await noRedirectFetch(fetcher)(`${saved.apiUrl}/api/agent/connection-status`, {
    method: 'POST', headers: { authorization: `Bearer ${session.agentApiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, runtime: saved.runtime, phase: 'error', runtimeTest: 'failed', errorCode: code }),
    signal: AbortSignal.timeout(10_000)
  });
  await response.body?.cancel();
}

export async function prepareConnection(runtime: ConnectorRuntime, apiUrl: string, resolveAdapter: AdapterResolver, options: AdapterOptions = {}) {
  const fetcher = noRedirectFetch(options.fetch);
  await checkSinaloa(apiUrl, fetcher);
  const adapter = resolveAdapter(runtime);
  const config = await adapter.discover({ ...options, fetch: fetcher });
  await adapter.preflight(config, { ...options, fetch: fetcher });
  return { runtime, checks: 'passed', ...adapter.describe(config), note: 'Preparation did not enroll an agent or prove unattended receiving' };
}

export async function setupConnection(input: unknown, resolveAdapter: AdapterResolver, options: SetupOptions = {}) {
  const handoff = validateQuickConnectHandoff(input, { allowExpired: true });
  const directory = await (options.secureDirectory ?? privateDirectory)(options.stateDir ?? connectionDirectory(handoff.apiUrl, handoff.address, handoff.runtime, options));
  const live = await queryControl(directory, 'status').catch(() => null);
  if (live?.status === 'running' && live.runtimeChecks === 'passed') {
    const existing = await readConnection(directory);
    const session = await savedSession(directory);
    if (existing.apiUrl !== handoff.apiUrl || existing.address !== handoff.address || existing.runtime !== handoff.runtime || session?.address !== handoff.address) {
      throw new ConnectorSetupError('STATE_MISMATCH', 'The running connection belongs to another identity. Use its own agent-specific state directory.');
    }
    const reconnectId = handoff.operation === 'reconnect' ? createHash('sha256').update(handoff.enrollmentToken).digest('hex') : undefined;
    if (!reconnectId || existing.lastReconnectId === reconnectId || (session as ConnectorSession & { setupRedemptionId?: string }).setupRedemptionId === reconnectId) {
      // Stage a newly downloaded bundle for future starts and repair this
      // identity's MCP entry without interrupting the live credential owner.
      if (options.executableFile) {
        await saveExecutable(directory, options.executableFile);
        await resolveAdapter(existing.runtime).configure?.(existing.configuration, {
          ...options, apiUrl: existing.apiUrl, stateDir: directory, fetch: noRedirectFetch(options.fetch)
        });
      }
      return { stateDir: directory, runtime: existing.runtime, address: session.address, agentId: session.agentId, checks: 'passed' as const };
    }
  }
  const unlock = await acquireConnectorLock(directory);
  const fetcher = noRedirectFetch(options.fetch);
  let bridge: RuntimeBridge | undefined;
  let saved: InstalledConnection | undefined;
  let enrolledConnector: SinaloaConnector | undefined;
  let control: Awaited<ReturnType<typeof startControl>> | undefined;
  try {
    const store = new FileBridgeStore(directory); await store.init();
    let session = await savedSession(directory);
    const prior = await readConnection(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (prior && (prior.apiUrl !== handoff.apiUrl || prior.address !== handoff.address || prior.runtime !== handoff.runtime)
      || session && session.address !== handoff.address) throw new ConnectorSetupError('STATE_MISMATCH', 'This directory belongs to another connection. Use a separate agent-specific directory');
    if (session && !prior) throw new ConnectorSetupError('STATE_INVALID', 'Saved credentials have no connection configuration; preserve this directory and inspect it');
    // Record only a nonreversible digest to distinguish a retry from a new reconnect request.
    const reconnectId = handoff.operation === 'reconnect' ? createHash('sha256').update(handoff.enrollmentToken).digest('hex') : undefined;
    const sessionRedemptionId = (session as (ConnectorSession & { setupRedemptionId?: string }) | null)?.setupRedemptionId;
    const needsEnrollment = !session || !!reconnectId && sessionRedemptionId !== reconnectId && prior?.lastReconnectId !== reconnectId;
    if (needsEnrollment) validateQuickConnectHandoff(input);
    if (options.installService) await checkServiceManager();
    options.onProgress?.('Checking Envoi reachability');
    await checkSinaloa(handoff.apiUrl, fetcher);
    const adapter = resolveAdapter(handoff.runtime);
    const context = { ...options, apiUrl: handoff.apiUrl, stateDir: directory, fetch: fetcher,
      ...(options.installService ? { verificationTimeoutMs: 30_000 } : {}) };
    options.onProgress?.(`Connection state directory: ${directory}`);
    options.onProgress?.(`Preparing ${handoff.runtime}`);
    const config = await adapter.discover(context, prior?.configuration);
    await adapter.preflight(config, context);
    saved = { version: 1, runtime: handoff.runtime, apiUrl: handoff.apiUrl, address: handoff.address,
      agentName: handoff.agentName, configuration: config, ...(prior?.lastReconnectId ? { lastReconnectId: prior.lastReconnectId } : {}) };
    await privateJson(path.join(directory, 'connection.json'), saved);
    await saveExecutable(directory, options.executableFile);
    if (needsEnrollment) {
      options.onProgress?.(handoff.operation === 'reconnect' ? 'Reconnecting the existing agent' : 'Enrolling the agent');
      // Save the retry marker in the SAME atomic write as the new credentials. A crash
      // before connection.json is updated must not redeem a consumed token again.
      const enrollmentStore = { load: () => store.load(), save: (value: ConnectorSession) => store.save({ ...value, ...(reconnectId ? { setupRedemptionId: reconnectId } : {}) }) };
      try { session = await enrollConnector(handoff.apiUrl, handoff.enrollmentToken, enrollmentStore, { name: handoff.agentName, runtime: handoff.runtime, fetch: fetcher }); }
      catch (error) { throw await enrollmentSetupError(error, directory); }
      if (reconnectId) { saved.lastReconnectId = reconnectId; await privateJson(path.join(directory, 'connection.json'), saved); }
    }
    if (!session || session.address !== handoff.address) throw new ConnectorSetupError('STATE_MISMATCH', 'The enrolled address differs from this handoff. Inspect Agent connections before starting');
    await rm(path.join(directory, 'enrollment-error.json'), { force: true });
    enrolledConnector = new SinaloaConnector(saved.apiUrl, store, { fetch: fetcher });
    if (options.installService) await privateJson(path.join(directory, 'startup-request.json'), { version: 1, managed: true });
    await adapter.configure?.(config, context);
    // Adapters may allocate a local relay port during configure. Save it before service start.
    await privateJson(path.join(directory, 'connection.json'), saved);
    options.onProgress?.('Verifying runtime tools and Envoi access');
    options.onProgress?.(`Saved connection recovery command: ${startCommand(directory)}`);
    bridge = await adapter.createBridge(config, context);
    // A stdio MCP client opened during setup attaches to this owner instead of
    // spawning a competing process that cannot acquire the enrollment lock.
    control = await startControl(directory, { runtime: saved.runtime, address: saved.address }, () => {},
      () => ({ status: 'starting', runtimeChecks: 'pending', phase: 'setup' }));
    await bridge.connector.pollOnce();
    await bridge.verify?.();
    // Managed setup is ready only after its durable process passes checks.
    // startConnection reports that result; temporary verification is insufficient.
    if (!options.installService) await report(saved, bridge.connector, 'ready', fetcher);
    await privateJson(path.join(directory, 'setup-check.json'), { runtime: saved.runtime, checkedAt: new Date().toISOString(), checks: 'passed' });
    return { stateDir: directory, runtime: saved.runtime, address: session.address, agentId: session.agentId, checks: 'passed' as const };
  } catch (error) {
    if (saved && (bridge || enrolledConnector)) await report(saved, bridge?.connector ?? enrolledConnector!, 'error', fetcher,
      error instanceof ConnectorSetupError ? error.code : 'CONNECTION_TEST_FAILED').catch(() => {});
    throw error;
  } finally { try { try { await control?.close(); } finally { await bridge?.close(); } } finally { await unlock(); } }
}

export async function startConnection(stateDir: string, signal: AbortSignal, resolveAdapter: AdapterResolver,
  options: AdapterOptions & { secureDirectory?: typeof privateDirectory; pollIntervalMs?: number; onReady?: () => void; onWaiting?: (code: string) => void; retryDelayMs?: number; control?: boolean } = {}) {
  const directory = await (options.secureDirectory ?? privateDirectory)(stateDir);
  const unlock = await acquireConnectorLock(directory);
  const fetcher = noRedirectFetch(options.fetch);
  const stop = new AbortController();
  const cancel = () => stop.abort(); signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) stop.abort();
  let bridge: RuntimeBridge | undefined;
  let control: Awaited<ReturnType<typeof startControl>> | undefined;
  let saved: InstalledConnection | undefined;
  let diagnostics: Record<string, unknown> = { status: 'starting', runtimeChecks: 'pending' };
  try {
    saved = await readConnection(directory);
    if (!await savedSession(directory)) throw new ConnectorSetupError('STATE_INVALID', 'Saved credentials are missing; reconnect through Envoi before starting');
    const adapter = resolveAdapter(saved.runtime);
    const context = { ...options, signal: stop.signal, apiUrl: saved.apiUrl, stateDir: directory, fetch: fetcher };
    if (options.control !== false) control = await startControl(directory, { runtime: saved.runtime, address: saved.address }, cancel, () => diagnostics);
    let attempt = 0;
    while (!stop.signal.aborted) {
      try {
        await checkSinaloa(saved.apiUrl, fetcher);
        const config = await adapter.discover(context, saved.configuration);
        if (!bridge) {
          // Bring the saved relay online before Gateway preflight. Otherwise a
          // Gateway starting at login can park MCP discovery while we wait for it.
          await adapter.configure?.(config, context);
          saved.configuration = config;
          await privateJson(path.join(directory, 'connection.json'), saved);
          bridge = await adapter.createBridge(config, context);
        }
        await adapter.preflight(config, context);
        await bridge.connector.pollOnce(); await bridge.verify?.();
        await report(saved, bridge.connector, 'ready', fetcher);
        diagnostics = { status: 'running', runtimeChecks: 'passed', checkedAt: new Date().toISOString(), ...adapter.describe(config) };
        break;
      } catch (error) {
        if (stop.signal.aborted) return;
        const status = (error as { status?: number })?.status;
        const transient = error instanceof ConnectorSetupError && ['ENVOI_UNREACHABLE', 'GATEWAY_UNREACHABLE', 'PROVIDER_UNREACHABLE', 'TOOLS_NOT_READY'].includes(error.code)
          || typeof status === 'number' && (status === 429 || status >= 500) || error instanceof TypeError && /fetch|network/i.test(error.message);
        if (!transient) throw error;
        // Retain the same relay through recoverable outages and discovery retries.
        // Closing it here recreates the startup deadlock we are recovering from.
        const code = error instanceof ConnectorSetupError ? error.code : 'CONNECTION_TEMPORARILY_UNAVAILABLE';
        diagnostics = { status: 'waiting', runtimeChecks: 'pending', errorCode: code };
        options.onWaiting?.(code);
        await delay(options.retryDelayMs ?? Math.min(60_000, 1_000 * 2 ** Math.min(attempt++, 6)), undefined, { signal: stop.signal }).catch(error => { if (!stop.signal.aborted) throw error; });
      }
    }
    if (stop.signal.aborted || !bridge) return;
    options.onReady?.();
    await bridge.connector.run(stop.signal);
  } catch (error) {
    if (saved && bridge && !stop.signal.aborted) await report(saved, bridge.connector, 'error', fetcher, 'CONNECTOR_START_FAILED').catch(() => {});
    if (!stop.signal.aborted) throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    try { try { await control?.close(); } finally { await bridge?.close(); } } finally { await unlock(); }
  }
}

export async function connectionStatus(stateDir: string) {
  const directory = path.resolve(stateDir);
  const saved = await readConnection(directory);
  const session = await savedSession(directory);
  const live = await queryControl(directory, 'status').catch(() => null);
  const checks = await readFile(path.join(directory, 'setup-check.json'), 'utf8').then(text => JSON.parse(text) as { checkedAt?: string }).catch(() => null);
  const enrollmentError = await readEnrollmentDiagnostic(directory);
  return { runtime: saved.runtime, address: saved.address, apiUrl: saved.apiUrl, agentId: session?.agentId,
    credentialState: session ? 'saved' : 'missing', ...(enrollmentError ? { enrollmentError } : {}),
    stateDir: directory, status: live?.status ?? 'stopped', checkedAt: live?.checkedAt ?? checks?.checkedAt,
    credentialExpiresAt: session?.agentTokenExpiresAt, refreshExpiresAt: session?.agentRefreshTokenExpiresAt,
    note: 'A running connector is not proof of successful message delivery. Verify a real agent exchange' };
}
export async function doctorConnection(stateDir: string, resolveAdapter: AdapterResolver, options: AdapterOptions = {}) {
  const directory = path.resolve(stateDir);
  const live = await queryControl(directory, 'doctor').catch(() => null);
  // Ask the owner process for its latest checks. A second process must not rotate
  // shared credentials or claim queued work while the durable bridge owns them.
  if (live) return { ...await connectionStatus(directory), ...live, note: 'Checks are from the running connector; verify a real message exchange' };
  const unlock = await acquireConnectorLock(directory);
  try {
    const saved = await readConnection(directory);
    const adapter = resolveAdapter(saved.runtime);
    const fetcher = noRedirectFetch(options.fetch);
    await checkSinaloa(saved.apiUrl, fetcher);
    const context = { ...options, apiUrl: saved.apiUrl, stateDir: directory, fetch: fetcher };
    const config = await adapter.discover(context, saved.configuration);
    await adapter.preflight(config, context);
    const store = new FileBridgeStore(directory);
    await new SinaloaConnector(saved.apiUrl, store, { fetch: fetcher }).pollOnce();
    return { ...await connectionStatus(directory), runtimeChecks: 'passed', ...adapter.describe(config) };
  } finally { await unlock(); }
}
export async function removeInstalledExecutable(stateDir: string) {
  const directory = path.resolve(stateDir);
  let unlock: (() => Promise<void>) | undefined;
  const deadline = Date.now() + 15_000;
  while (!unlock) {
    try { unlock = await acquireConnectorLock(directory); }
    catch (error) { if (!(error instanceof Error) || !error.message.includes('already running') || Date.now() >= deadline) throw error; await delay(100); }
  }
  try { await rm(path.join(directory, 'connector.mjs'), { force: true }); }
  finally { await unlock(); }
}
