import { responsePayload, rotateAgentToken, SinaloaClient, SinaloaError, type AgentTokens, type AssetUploadInput, type CaseMessageInput, type ClientOptions, type NativeMessageInput } from './index';
import { lifecyclePolicy, retryDelay, guidanceText, type ConnectorLifecycle, type ConnectorState } from './lifecycle';
export type { ConnectorLifecycle, ConnectorState } from './lifecycle';
import { CONNECTOR_RUNTIMES, type ConnectorRuntime } from './quick-connect';

/** Persist the whole record atomically, including each replacement refresh token. */
export interface ConnectorSession extends AgentTokens {
  agentId: string;
  inboxId: string;
  address: string;
  cursor: string | null;
  lifecycle?: ConnectorLifecycle;
  pendingRotation?: {
    rotationId: string;
    refreshTokenFingerprint: string;
    startedAt: string;
  };
}

export interface ConnectorStore {
  load(): Promise<ConnectorSession | null>;
  save(session: ConnectorSession): Promise<void>;
}

export interface McpReadToken {
  mcpAccessToken: string;
  tokenType: 'Bearer';
  scope: 'case_read';
  caseId: string | null;
  expiresAt: string;
}

export interface InboxEvent {
  id: string;
  type: string;
  cursor: string;
  [key: string]: unknown;
}

export interface NativeWorkMessage extends Record<string, unknown> {
  kind?: 'nativeAgentMessage';
  id: string;
  senderAgentId: string;
  recipientAgentId: string;
  from: { agentId: string; address: string };
  caseId?: string | null;
  text: string;
}

export interface HumanInstructionWorkMessage extends Record<string, unknown> {
  id: string;
  kind: 'humanInstruction';
  senderType: 'human';
  senderHumanId: string;
  senderAgentId?: never;
  senderInboxId?: never;
  recipientAgentId: string;
  recipientInboxId: string;
  from: { humanId: string; agentId?: never; address?: never };
  caseId: string;
  type: 'instruction';
  text: string;
}

export type WorkMessage = NativeWorkMessage | HumanInstructionWorkMessage;

export interface HumanInstructionReply extends Record<string, unknown> {
  id: string;
  kind: 'humanInstructionReply';
  inboxId: string;
  caseId: string;
  senderType: 'agent';
  senderAgentId: string;
  senderInboxId: string;
  recipientInboxId: string;
  recipientHumanId: string;
  from: { agentId: string; address: string };
  inReplyTo: string;
  type: 'message';
  text: string;
  status: 'delivered';
}

export function isHumanInstructionMessage(message: WorkMessage): message is HumanInstructionWorkMessage {
  return message.kind === 'humanInstruction';
}

function assertHumanInstructionMessage(message: HumanInstructionWorkMessage) {
  const safeId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
  if (message.senderType !== 'human' || message.type !== 'instruction' || !safeId(message.senderHumanId)
    || !safeId(message.recipientInboxId) || !safeId(message.caseId) || typeof message.text !== 'string' || !message.text.trim()
    || !message.from || typeof message.from !== 'object' || Array.isArray(message.from) || message.from.humanId !== message.senderHumanId
    || Object.keys(message.from).some(key => key !== 'humanId') || 'senderAgentId' in message || 'senderInboxId' in message || 'senderEmail' in message) {
    throw new SinaloaError('Envoi returned an invalid human instruction');
  }
}

export interface WorkLease {
  workId: string;
  message: WorkMessage;
  leaseToken: string;
  leaseExpiresAt: string;
}

interface WorkSettlement {
  workId: string;
  status: 'acknowledged' | 'processed';
  receipt: { messageId: string; state: 'acknowledged' | 'processed'; [key: string]: unknown };
}

export interface WorkContext {
  /** Aborts on shutdown or if the connector can no longer renew its lease. */
  signal: AbortSignal;
  /** Use a stable idempotency key for each logical reply; retries may run the handler again. */
  reply(text: string, idempotencyKey: string, extra?: Omit<NativeMessageInput, 'senderAgentId' | 'recipientEmail' | 'text' | 'caseId'>): Promise<unknown>;
}

export interface WorkHandler {
  /** Must durably admit by message.id before resolving; may be called again after a crash. */
  admit(message: WorkMessage): Promise<void>;
  /** Must be idempotent by message.id and honor context.signal for long work. */
  process(message: WorkMessage, context: WorkContext): Promise<void>;
}

export interface ConnectorOptions extends ClientOptions {
  pageSize?: number;
  pollIntervalMs?: number;
  refreshSkewMs?: number;
  /** Observation only. Processing uses the separate fenced work-claim API. */
  onEvent?: (event: InboxEvent) => Promise<void> | void;
  /** Enables fenced work processing when the server work routes are available. */
  handler?: WorkHandler;
  onState?: (lifecycle: ConnectorLifecycle) => void;
}

export class ConnectorPersistenceError extends Error {
  constructor(public readonly requestId?: string, public readonly status?: number) {
    super('Connector credential persistence failed; stop this installation and recover its saved rotation state');
    this.name = 'ConnectorPersistenceError';
  }
}

/** Safe enrollment diagnostics; never includes a response body or credentials. */
export class ConnectorEnrollmentError extends SinaloaError {
  constructor(code: string, public readonly requestId: string, status?: number) {
    super(`Envoi enrollment failed (${code}${status ? `; HTTP ${status}` : ''})`, status, code);
    this.name = 'ConnectorEnrollmentError';
  }
}

function enrollmentRejectionCode(payload: Record<string, unknown> | null) {
  if (payload?.code === 'ACTIVE_AGENT_LIMIT' || payload?.error === 'ACTIVE_AGENT_LIMIT') return 'ENROLLMENT_AGENT_LIMIT';
  if (payload?.error === 'AUTH_UNAVAILABLE') return 'ENROLLMENT_AUTH_UNAVAILABLE';
  switch (payload?.error === 'REQUEST_FAILED' ? payload.message : payload?.error) {
    case 'Enrollment token is invalid, expired, or already used': return 'ENROLLMENT_TOKEN_REJECTED';
    case 'Setup runtime does not match this enrollment': return 'ENROLLMENT_RUNTIME_MISMATCH';
    case 'Enrollment owner is invalid':
    case 'Reconnect owner is invalid': return 'ENROLLMENT_OWNER_INVALID';
    case 'That agent address is already taken': return 'ENROLLMENT_ADDRESS_TAKEN';
    default: return 'ENROLLMENT_HTTP_ERROR';
  }
}

export class ConnectorContractError extends Error {
  constructor() {
    super('Envoi fenced work API is unavailable; agent processing cannot start');
    this.name = 'ConnectorContractError';
  }
}

export class ConnectorCredentialsError extends SinaloaError {
  constructor() {
    super('Connector credentials are missing or expired; ask the owner to reconnect this existing agent', undefined, 'CREDENTIAL_EXPIRED');
    this.name = 'ConnectorCredentialsError';
  }
}

function apiOrigin(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new TypeError('Connector API URL must use HTTPS (or local HTTP for development)');
  }
  if (url.username || url.password || url.search || url.hash) throw new TypeError('Connector API URL cannot contain credentials or a query');
  return url.toString().replace(/\/$/, '');
}

function validSession(value: ConnectorSession | null): ConnectorSession {
  if (!value || !value.agentId || !value.inboxId || !value.agentApiToken || !value.agentRefreshToken ||
    !Number.isFinite(Date.parse(value.agentTokenExpiresAt)) || !Number.isFinite(Date.parse(value.agentRefreshTokenExpiresAt))) {
    throw new ConnectorCredentialsError();
  }
  return value;
}

async function refreshFingerprint(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function eventFrom(value: Record<string, unknown>): InboxEvent {
  if (typeof value.id !== 'string' || typeof value.type !== 'string' || typeof value.cursor !== 'string' || !value.cursor) {
    throw new SinaloaError('Envoi returned an invalid event');
  }
  return value as InboxEvent;
}

/** Redeems a one-use code; optional runtime binding is checked before consumption. */
export async function enrollConnector(baseUrl: string, enrollmentToken: string, store: ConnectorStore, options: ClientOptions & { name?: string; runtime?: ConnectorRuntime } = {}): Promise<ConnectorSession> {
  const origin = apiOrigin(baseUrl);
  if (!enrollmentToken) throw new TypeError('Enrollment token is required');
  if (options.runtime !== undefined && !CONNECTOR_RUNTIMES.includes(options.runtime)) throw new TypeError('Unsupported connector runtime');
  const controller = new AbortController();
  const duration = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 300_000) throw new RangeError('timeoutMs must be an integer from 1 to 300000');
  const requestId = crypto.randomUUID();
  const timer = setTimeout(() => controller.abort(), duration);
  try {
    let response: Response;
    try {
      response = await (options.fetch || fetch)(`${origin}/api/agent-enroll`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': requestId },
        body: JSON.stringify({ enrollmentToken, ...(options.name ? { name: options.name } : {}), ...(options.runtime ? { runtime: options.runtime } : {}) }), signal: controller.signal
      });
    } catch {
      throw new ConnectorEnrollmentError(controller.signal.aborted ? 'ENROLLMENT_TIMEOUT' : 'ENROLLMENT_TRANSPORT_FAILED', requestId);
    }
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      if (controller.signal.aborted) throw new ConnectorEnrollmentError('ENROLLMENT_TIMEOUT', requestId, response.status);
      /* Never expose provider response bodies. */
    }
    if (!response.ok) throw new ConnectorEnrollmentError(enrollmentRejectionCode(payload), requestId, response.status);
    const agent = payload?.agent as Record<string, unknown> | undefined;
    const inbox = payload?.inbox as Record<string, unknown> | undefined;
    let session: ConnectorSession;
    try {
      session = validSession({
        agentId: String(agent?.id || ''), inboxId: String(inbox?.id || ''), address: String(agent?.address || ''),
        agentApiToken: String(payload?.agentApiToken || ''), agentRefreshToken: String(payload?.agentRefreshToken || ''),
        agentTokenExpiresAt: String(payload?.agentTokenExpiresAt || ''),
        agentRefreshTokenExpiresAt: String(payload?.agentRefreshTokenExpiresAt || ''), cursor: null,
        lifecycle: { state: agent?.status === 'paused' ? 'PAUSED' : 'STARTING', paused: agent?.status === 'paused', changedAt: new Date().toISOString(), failures: 0 }
      });
    } catch { throw new ConnectorEnrollmentError('ENROLLMENT_RESPONSE_INVALID', requestId, response.status); }
    if (!session.address) throw new ConnectorEnrollmentError('ENROLLMENT_RESPONSE_INVALID', requestId, response.status);
    try { await store.save(session); } catch { throw new ConnectorPersistenceError(requestId, response.status); }
    return session;
  } finally { clearTimeout(timer); }
}

export class SinaloaConnector {
  private readonly origin: string;
  private readonly pageSize: number;
  private readonly pollIntervalMs: number;
  private readonly refreshSkewMs: number;
  private writes: Promise<unknown> = Promise.resolve();
  private actionEpoch = 0;
  private persistenceFailed = false;
  private readonly observedErrors = new WeakSet<SinaloaError>();
  private wake = new AbortController();
  private readonly activeActions = new Set<AbortController>();
  private readonly activeRefresh = new Set<AbortController>();
  private readonly activeWork = new Set<AbortController>();
  private stateObserver?: (lifecycle: ConnectorLifecycle) => void;
  private refreshInFlight: Promise<ConnectorSession> | null = null;

  constructor(baseUrl: string, private readonly store: ConnectorStore, private readonly options: ConnectorOptions = {}) {
    this.origin = apiOrigin(baseUrl);
    this.pageSize = options.pageSize ?? 100;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000;
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 200) throw new RangeError('pageSize must be from 1 to 200');
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1) throw new RangeError('pollIntervalMs must be positive');
    if (!Number.isSafeInteger(this.refreshSkewMs) || this.refreshSkewMs < 0) throw new RangeError('refreshSkewMs must be nonnegative');
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300_000)) throw new RangeError('timeoutMs must be an integer from 1 to 300000');
  }

  /** Diagnostics contain no tokens. Lifecycle updates share the atomic credential record. */
  async lifecycle(): Promise<ConnectorLifecycle> {
    await this.writes;
    const session = validSession(await this.store.load());
    return session.lifecycle ?? { state: 'STARTING', paused: false, changedAt: new Date().toISOString(), failures: 0 };
  }

  /** Check saved terminal state before allocating a runtime or contacting a service. */
  async assertActive() { await this.guard(); }

  async start(): Promise<void> {
    await this.guard();
    const state = await this.lifecycle();
    if (!(await this.store.load())?.lifecycle) await this.transition('STARTING');
    if (state.state === 'STOPPED') await this.transition(state.paused ? 'PAUSED' : 'STARTING');
  }

  onState(observer: (lifecycle: ConnectorLifecycle) => void) { this.stateObserver = observer; }

  private mutate(update: (current: ConnectorSession) => ConnectorSession): Promise<ConnectorSession> {
    const write = this.writes.then(async () => {
      if (this.persistenceFailed) throw new ConnectorPersistenceError();
      const current = validSession(await this.store.load());
      const next = update(current);
      if (next === current) return current;
      try { await this.store.save(next); } catch {
        this.persistenceFailed = true;
        this.actionEpoch++;
        for (const controller of [...this.activeActions, ...this.activeWork, ...this.activeRefresh]) controller.abort();
        throw new ConnectorPersistenceError();
      }
      return next;
    });
    this.writes = write.then(() => undefined, () => undefined);
    return write;
  }

  private async transition(state: ConnectorState, patch: Partial<ConnectorLifecycle> = {}): Promise<void> {
    let applied = false;
    const next = await this.mutate(current => {
      const previous = current.lifecycle ?? { state: 'STARTING', paused: false, changedAt: new Date().toISOString(), failures: 0 };
      // A terminal installation can only be replaced by explicit owner enrollment.
      if (['REVOKED', 'NEEDS_RECONNECT'].includes(previous.state)) return current;
      if (['REVOKED', 'NEEDS_RECONNECT'].includes(state)) for (const controller of this.activeRefresh) controller.abort();
      applied = true;
      const lifecycle = { ...previous, ...patch, state, changedAt: new Date().toISOString() };
      if (lifecycle.paused || ['REVOKED', 'NEEDS_RECONNECT', 'STOPPED'].includes(state)) {
        this.actionEpoch++;
        for (const controller of [...this.activeActions, ...this.activeWork]) controller.abort();
      }
      return { ...current, lifecycle };
    });
    if (applied && next.lifecycle) {
      // Observation hooks cannot bypass persistence or change request outcomes.
      try { this.options.onState?.(next.lifecycle); this.stateObserver?.(next.lifecycle); } catch { /* diagnostic only */ }
    }
  }

  /** Apply a stable response code. Unknown auth statuses never imply revoke or refresh. */
  async observeError(error: unknown): Promise<void> {
    if (!(error instanceof SinaloaError) || this.observedErrors.has(error)) return;
    this.observedErrors.add(error);
    const policy = lifecyclePolicy(error);
    if (policy.lifecycle === 'UNCHANGED' || policy.lifecycle === 'NOT_APPLICABLE') return;
    const previous = await this.lifecycle();
    const failures = policy.lifecycle === 'DEGRADED' ? previous.failures + 1 : 0;
    await this.transition(policy.lifecycle, { code: error.code, reason: error.reason, guidance: guidanceText(policy.guidance),
      paused: policy.lifecycle === 'PAUSED' || previous.paused, failures,
      retryAt: failures ? new Date(Date.now() + retryDelay(failures, Math.random(), error.retryAfterSeconds)).toISOString() : undefined });
  }

  /** Accept delta/SSE lifecycle events; credential.ended has no observation cursor. */
  async observeEvent(event: Record<string, unknown>, type = String(event.type ?? '')): Promise<void> {
    if (type === 'credential.ended') {
      if (typeof event.code === 'string') await this.observeError(new SinaloaError('Credential ended', undefined, event.code,
        { reason: typeof event.reason === 'string' ? event.reason : undefined }));
      return;
    }
    const session = validSession(await this.store.load());
    if (event.agentId !== session.agentId) return;
    if (type === 'agent.paused') await this.observeError(new SinaloaError('Paused', undefined, 'AGENT_PAUSED'));
    if (type === 'agent.resumed') {
      await this.transition('RUNNING', { paused: false, failures: 0, retryAt: undefined, code: undefined, reason: undefined, guidance: undefined });
      this.wake.abort();
    }
  }

  private async guard(action = false): Promise<void> {
    if (this.persistenceFailed) throw new ConnectorPersistenceError();
    const lifecycle = await this.lifecycle();
    if (['REVOKED', 'NEEDS_RECONNECT'].includes(lifecycle.state))
      throw new SinaloaError(lifecycle.guidance ?? 'Ask the owner to reconnect this installation', undefined, lifecycle.code ?? 'CREDENTIAL_EXPIRED');
    if (action && (lifecycle.paused || lifecycle.state === 'STOPPED'))
      throw new SinaloaError(lifecycle.guidance ?? 'Connector actions are stopped', undefined, lifecycle.paused ? 'AGENT_PAUSED' : 'CONNECTOR_STOPPED');
  }

  private async healthy(): Promise<void> {
    const current = await this.lifecycle();
    if (current.state === 'STARTING' || current.state === 'DEGRADED')
      await this.transition(current.paused ? 'PAUSED' : 'RUNNING', { failures: 0, retryAt: undefined, code: current.paused ? 'AGENT_PAUSED' : undefined,
        guidance: current.paused ? guidanceText('wait_for_resume') : undefined });
  }

  private async freshSession(force = false): Promise<ConnectorSession> {
    await this.guard();
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const current = validSession(await this.store.load());
      if (!force && !current.pendingRotation && Date.parse(current.agentTokenExpiresAt) > Date.now() + this.refreshSkewMs) return current;
      if (Date.parse(current.agentRefreshTokenExpiresAt) <= Date.now()) throw new ConnectorCredentialsError();
      const fingerprint = await refreshFingerprint(current.agentRefreshToken);
      if (current.pendingRotation && current.pendingRotation.refreshTokenFingerprint !== fingerprint) throw new ConnectorCredentialsError();
      const pendingRotation = current.pendingRotation || { rotationId: crypto.randomUUID(), refreshTokenFingerprint: fingerprint, startedAt: new Date().toISOString() };
      if (!current.pendingRotation) await this.mutate(latest => ({ ...latest, pendingRotation }));
      await this.guard();
      const controller = new AbortController();
      this.activeRefresh.add(controller);
      let rotated: AgentTokens;
      try {
        rotated = await rotateAgentToken(this.origin, current.agentRefreshToken, pendingRotation.rotationId, {
          ...this.options, fetch: (input, init) => (this.options.fetch || fetch)(input, { ...init,
            signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal }) });
      } finally { this.activeRefresh.delete(controller); }
      await this.guard();
      // Read the latest record under the write queue: late rotations cannot erase a pause or cursor.
      return this.mutate(latest => {
        if (['REVOKED', 'NEEDS_RECONNECT'].includes(latest.lifecycle?.state ?? ''))
          throw new SinaloaError(latest.lifecycle?.guidance ?? 'Credential ended', undefined, latest.lifecycle?.code);
        const { pendingRotation: _completed, ...saved } = latest;
        return validSession({ ...saved, ...rotated });
      });
    })();
    try { return await this.refreshInFlight; }
    catch (error) { await this.observeError(error); throw error; }
    finally { this.refreshInFlight = null; }
  }

  private async withFreshSession<T>(run: (session: ConnectorSession, signal?: AbortSignal) => Promise<T>, action = false): Promise<T> {
    await this.guard(action);
    const session = await this.freshSession();
    await this.guard(action);
    const epoch = this.actionEpoch;
    const controller = new AbortController();
    if (action) this.activeActions.add(controller);
    const invoke = async (current: ConnectorSession) => {
      await this.guard(action);
      if (action && epoch !== this.actionEpoch) throw new SinaloaError('Connector action was interrupted', undefined, 'REQUEST_CANCELLED');
      const result = await run(current, controller.signal);
      await this.guard(action);
      if (action && epoch !== this.actionEpoch) throw new SinaloaError('Connector action was interrupted');
      await this.healthy();
      return result;
    };
    try {
      try { return await invoke(session); }
      catch (error) {
        if (!(error instanceof SinaloaError) || lifecyclePolicy(error).retry !== 'refresh_then_retry_once') throw error;
        await this.guard(action);
        const current = validSession(await this.store.load());
        return await invoke(current.agentApiToken === session.agentApiToken ? await this.freshSession(true) : current);
      }
    } catch (error) {
      if (action && controller.signal.aborted) {
        await this.guard(action);
        throw new SinaloaError('Connector action was interrupted', undefined, 'REQUEST_CANCELLED');
      }
      await this.observeError(error); throw error;
    } finally { this.activeActions.delete(controller); }
  }

  private withFreshClient<T>(operation: (client: SinaloaClient, session: ConnectorSession) => Promise<T>, action = true): Promise<T> {
    return this.withFreshSession((session, signal) => operation(new SinaloaClient(this.origin, session.agentApiToken,
      { ...this.options, fetch: (input, init) => (this.options.fetch || fetch)(input, { ...init,
        signal: init?.signal && signal ? AbortSignal.any([init.signal, signal]) : signal }) }), session), action);
  }

  /** Trusted bridge code may pass only this short-lived access token to a remote MCP provider. */
  async currentAccessToken(minValidityMs = this.refreshSkewMs): Promise<string> {
    if (!Number.isSafeInteger(minValidityMs) || minValidityMs < 0 || minValidityMs > 300_000) {
      throw new RangeError('minValidityMs must be an integer from 0 to 300000');
    }
    let session = await this.freshSession();
    if (Date.parse(session.agentTokenExpiresAt) <= Date.now() + minValidityMs) session = await this.freshSession(true);
    if (Date.parse(session.agentTokenExpiresAt) <= Date.now() + minValidityMs) {
      throw new ConnectorCredentialsError();
    }
    return session.agentApiToken;
  }

  /** Mint a short-lived MCP read credential for a single provider turn. Never send refresh credentials to a provider. */
  mintMcpReadToken(caseId: string | null = null): Promise<McpReadToken> {
    if (caseId !== null && (typeof caseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(caseId))) {
      throw new TypeError('A safe case ID is required for an MCP read token');
    }
    return this.withFreshSession(async (session, actionSignal) => {
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
      let response: Response;
      try {
        response = await (this.options.fetch || fetch)(`${this.origin}/api/agent/mcp-read-token`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.any([timeout, actionSignal!]),
          headers: { authorization: `Bearer ${session.agentApiToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(caseId === null ? {} : { caseId })
        });
      } catch { throw new SinaloaError(timeout.aborted ? 'Envoi MCP token request timed out' : 'Envoi MCP token service could not be reached', undefined, actionSignal?.aborted ? 'REQUEST_CANCELLED' : 'NETWORK_ERROR'); }
      if (!response.ok) await responsePayload(response, 'Envoi MCP read credential was denied');
      let payload: Record<string, unknown>;
      try { payload = await response.json() as Record<string, unknown>; }
      catch { throw new SinaloaError('Envoi returned an invalid MCP read credential'); }
      if (!payload || typeof payload.mcpAccessToken !== 'string' || !payload.mcpAccessToken ||
          payload.tokenType !== 'Bearer' || payload.scope !== 'case_read' || payload.caseId !== caseId ||
          typeof payload.expiresAt !== 'string' || Date.parse(payload.expiresAt) <= Date.now() + 120_000) {
        throw new SinaloaError('Envoi returned an invalid or short-lived MCP read credential');
      }
      return payload as unknown as McpReadToken;
    }, true);
  }

  /** Trusted host only: forwards MCP JSON-RPC without exposing the rotating refresh token. */
  forwardMcpRequest(body: string, { protocolVersion, signal }: { protocolVersion?: string; signal?: AbortSignal } = {}): Promise<Response> {
    if (protocolVersion && !/^\d{4}-\d{2}-\d{2}$/.test(protocolVersion)) throw new TypeError('Invalid MCP protocol version');
    return this.withFreshSession(async (session, actionSignal) => {
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
      const requestSignal = AbortSignal.any([timeout, actionSignal!, ...(signal ? [signal] : [])]);
      let response: Response;
      try {
        response = await (this.options.fetch || fetch)(`${this.origin}/mcp`, {
          method: 'POST', redirect: 'error', signal: requestSignal, body,
          headers: {
            authorization: `Bearer ${session.agentApiToken}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {})
          }
        });
      } catch {
        throw new SinaloaError(requestSignal.aborted ? 'Envoi MCP request timed out or canceled' : 'Envoi MCP could not be reached', undefined, actionSignal?.aborted ? 'REQUEST_CANCELLED' : 'NETWORK_ERROR');
      }
      if (!response.ok) await responsePayload(response.clone(), 'Envoi MCP request failed');
      return response;
    }, true);
  }

  /** Status reporting remains available while paused and observes the same credential codes. */
  reportConnectionStatus(body: Record<string, unknown>): Promise<void> {
    return this.withFreshSession(async session => {
      let response: Response;
      try { response = await (this.options.fetch || fetch)(`${this.origin}/api/agent/connection-status`, {
        method: 'POST', headers: { authorization: `Bearer ${session.agentApiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000) }); }
      catch { throw new SinaloaError('Envoi status service could not be reached', undefined, 'NETWORK_ERROR'); }
      if (!response.ok) await responsePayload(response, 'Envoi could not record setup checks');
      else await response.body?.cancel();
    });
  }

  /** First message of a new case; persist the ID and idempotency key before calling. */
  startCase(idempotencyKey: string, input: Omit<CaseMessageInput, 'senderAgentId'>) {
    return this.withFreshClient((client, session) => client.startCase(session.inboxId, idempotencyKey, { ...input, senderAgentId: session.agentId }));
  }

  sendCaseEvent(idempotencyKey: string, input: Omit<CaseMessageInput, 'senderAgentId'>) {
    return this.withFreshClient((client, session) => client.sendCaseEvent(session.inboxId, idempotencyKey, { ...input, senderAgentId: session.agentId }));
  }

  listCases(limit = 50, before?: string) {
    return this.withFreshClient((client, session) => client.listCases(session.inboxId, limit, before), false);
  }

  getCase(caseId: string) {
    return this.withFreshClient((client, session) => client.getCase(session.inboxId, caseId), false);
  }

  listCaseMessages(caseId: string, limit = 50, before?: string) {
    return this.withFreshClient((client, session) => client.listCaseMessages(session.inboxId, caseId, limit, before), false);
  }

  beginAssetUpload(idempotencyKey: string, input: AssetUploadInput) {
    return this.withFreshClient((client, session) => client.beginAssetUpload(session.inboxId, idempotencyKey, input));
  }

  completeAssetUpload(assetId: string) {
    return this.withFreshClient((client, session) => client.completeAssetUpload(session.inboxId, assetId));
  }

  grantCaseAsset(assetId: string, caseId: string, recipientAgentId: string, idempotencyKey: string) {
    return this.withFreshClient((client, session) => client.grantCaseAsset(session.inboxId, assetId, caseId, recipientAgentId, idempotencyKey));
  }

  listAssets() {
    return this.withFreshClient((client, session) => client.listAssets(session.inboxId), false);
  }

  getCleanAssetDownload(assetId: string) {
    return this.withFreshClient((client, session) => client.getCleanAssetDownload(session.inboxId, assetId), false);
  }

  private async postWork<T>(path: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    return this.withFreshSession(async (session, actionSignal) => {
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
      let response: Response;
      try {
        response = await (this.options.fetch || fetch)(`${this.origin}${path}`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.agentApiToken}`,
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
          body: JSON.stringify(body), signal: AbortSignal.any([timeout, actionSignal!])
        });
      } catch { throw new SinaloaError(timeout.aborted ? 'Envoi request timed out' : 'Envoi could not be reached', undefined, actionSignal?.aborted ? 'REQUEST_CANCELLED' : timeout.aborted ? 'TIMEOUT' : 'NETWORK_ERROR'); }
      return responsePayload<T>(response, 'Envoi work request failed');
    }, true);
  }

  private async reply(message: WorkMessage, text: string, idempotencyKey: string, extra: Omit<NativeMessageInput, 'senderAgentId' | 'recipientEmail' | 'text' | 'caseId'> = {}, leaseToken?: string): Promise<unknown> {
    if (isHumanInstructionMessage(message)) {
      assertHumanInstructionMessage(message);
      if (!idempotencyKey || idempotencyKey.length > 200 || /[\x00-\x1f\x7f]/.test(idempotencyKey)) throw new TypeError('A stable reply idempotency key is required');
      if (Object.keys(extra).length) throw new TypeError('Human instruction replies accept text only');
      if (!leaseToken) throw new TypeError('A current work lease token is required for a human instruction reply');
      const reply = await this.postWork<HumanInstructionReply>(`/api/agent/instructions/${encodeURIComponent(message.id)}/reply`, { text, leaseToken }, idempotencyKey);
      if (typeof reply.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(reply.id)
        || reply.kind !== 'humanInstructionReply' || reply.inReplyTo !== message.id || reply.caseId !== message.caseId
        || reply.inboxId !== message.recipientInboxId || reply.senderInboxId !== message.recipientInboxId || reply.recipientInboxId !== message.recipientInboxId
        || reply.senderType !== 'agent' || reply.senderAgentId !== message.recipientAgentId || reply.recipientHumanId !== message.senderHumanId
        || reply.from?.agentId !== message.recipientAgentId || typeof reply.from?.address !== 'string' || !reply.from.address
        || reply.type !== 'message' || reply.status !== 'delivered' || reply.text !== text.trim()) {
        throw new SinaloaError('Envoi returned an invalid human instruction reply');
      }
      return reply;
    }
    if (!idempotencyKey || !message.from?.address) throw new TypeError('A stable reply idempotency key and sender address are required');
    return this.withFreshClient((client, session) => client.sendMessage(
      session.inboxId, idempotencyKey,
      { ...extra, senderAgentId: session.agentId, recipientEmail: message.from.address, text, ...(message.caseId ? { caseId: message.caseId } : {}) }
    ));
  }

  /** Claims and processes one canonical message. Requires the server's fenced work routes. */
  async processWorkOnce(signal?: AbortSignal): Promise<boolean> {
    const handler = this.options.handler;
    if (!handler) throw new TypeError('A durable work handler is required');
    if (signal?.aborted) return false;
    await this.guard();
    if ((await this.lifecycle()).paused) return false;
    let claimed: { work: WorkLease | null; state?: string };
    try { claimed = await this.postWork<{ work: WorkLease | null; state?: string }>('/api/agent/work/claim', { acceptHumanInstructions: true }); }
    catch (error) {
      if (error instanceof SinaloaError && [404, 405, 501].includes(error.status || 0)) throw new ConnectorContractError();
      throw error;
    }
    if (claimed.state === 'paused') { await this.observeError(new SinaloaError('Paused', undefined, 'AGENT_PAUSED')); return false; }
    if (claimed.work === null) return false;
    const work = claimed.work;
    if (!work || typeof work.workId !== 'string' || typeof work.leaseToken !== 'string' || !Number.isFinite(Date.parse(work.leaseExpiresAt)) || typeof work.message?.id !== 'string' || !work.message.id) {
      throw new SinaloaError('Envoi returned an invalid work claim');
    }
    const session = validSession(await this.store.load());
    if (isHumanInstructionMessage(work.message)) {
      assertHumanInstructionMessage(work.message);
      if (work.message.recipientInboxId !== session.inboxId) throw new SinaloaError('Envoi returned work for the wrong inbox');
    } else if (work.message.senderType === 'human' || 'senderHumanId' in work.message || (work.message.from && 'humanId' in work.message.from) || !work.message.from?.address) {
      throw new SinaloaError('Envoi returned an invalid native work sender');
    }
    if (work.message.recipientAgentId !== session.agentId || work.message.status === 'processed') {
      throw new SinaloaError('Envoi returned work for the wrong recipient');
    }
    const workPath = `/api/agent/work/${encodeURIComponent(work.workId)}`;
    // The server scopes idempotency by agent, so a reclaimed lease needs new
    // request keys; reuse these keys only within this claim attempt.
    const attemptId = globalThis.crypto.randomUUID();
    const acknowledgeKey = `connector:${work.message.id}:${attemptId}:ack`;
    const completeKey = `connector:${work.message.id}:${attemptId}:complete`;
    const workAbort = new AbortController();
    this.activeWork.add(workAbort);
    const onAbort = () => workAbort.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) workAbort.abort();
    let leaseExpiresAt = work.leaseExpiresAt;
    let renewalError: unknown = null;
    const renewal = (async () => {
      while (!workAbort.signal.aborted) {
        const remaining = Date.parse(leaseExpiresAt) - Date.now();
        await delay(Math.max(100, Math.min(30_000, Math.floor(remaining / 3))), workAbort.signal);
        if (workAbort.signal.aborted) break;
        try {
          const renewed = await this.postWork<{ workId: string; leaseToken: string; leaseExpiresAt: string }>(`${workPath}/renew`, { leaseToken: work.leaseToken });
          if (renewed.workId !== work.workId || renewed.leaseToken !== work.leaseToken || !Number.isFinite(Date.parse(renewed.leaseExpiresAt))) throw new SinaloaError('Envoi returned an invalid lease renewal');
          leaseExpiresAt = renewed.leaseExpiresAt;
        } catch (error) { renewalError = error; workAbort.abort(); break; }
      }
    })();
    const stopRenewal = async () => { workAbort.abort(); await renewal; };
    let settled = false;
    let humanReplyError: unknown = null;
    try {
      if (workAbort.signal.aborted) throw new SinaloaError('Work claim was interrupted before admission');
      await this.guard(true);
      await handler.admit(work.message);
      if (workAbort.signal.aborted) throw new SinaloaError('Work lease was interrupted before acknowledgement');
      const acknowledged = await this.postWork<WorkSettlement>(`${workPath}/acknowledge`, { leaseToken: work.leaseToken }, acknowledgeKey);
      if (acknowledged.workId !== work.workId || acknowledged.status !== 'acknowledged' || acknowledged.receipt?.state !== 'acknowledged' || acknowledged.receipt.messageId !== work.message.id) {
        throw new SinaloaError('Envoi returned an invalid acknowledgement');
      }
      if (workAbort.signal.aborted) throw new SinaloaError('Work lease was interrupted before processing');
      await handler.process(work.message, {
        signal: workAbort.signal,
        reply: async (text, key, extra) => {
          if (workAbort.signal.aborted || signal?.aborted || Date.parse(leaseExpiresAt) <= Date.now()) {
            throw new SinaloaError('Work lease is no longer valid for a reply');
          }
          try {
            const reply = await this.reply(work.message, text, key, extra, work.leaseToken);
            if (isHumanInstructionMessage(work.message)) humanReplyError = null;
            return reply;
          } catch (error) {
            if (isHumanInstructionMessage(work.message)) humanReplyError = error;
            throw error;
          }
        }
      });
      if (humanReplyError) throw humanReplyError;
      if (renewalError) throw renewalError;
      if (workAbort.signal.aborted || signal?.aborted || Date.parse(leaseExpiresAt) <= Date.now()) throw new SinaloaError('Work lease expired before completion');
      const completed = await this.postWork<WorkSettlement>(`${workPath}/complete`, { leaseToken: work.leaseToken }, completeKey);
      if (completed.workId !== work.workId || completed.status !== 'processed' || completed.receipt?.state !== 'processed' || completed.receipt.messageId !== work.message.id) {
        throw new SinaloaError('Envoi returned an invalid completion');
      }
      settled = true;
      await stopRenewal();
      return true;
    } catch (error) {
      const interrupted = workAbort.signal.aborted;
      await stopRenewal();
      if (!interrupted && !renewalError && !settled && !signal?.aborted && !(await this.lifecycle()).paused
        && !['REVOKED', 'NEEDS_RECONNECT', 'STOPPED'].includes((await this.lifecycle()).state)
        && !(error instanceof SinaloaError && error.code === 'CASE_CONTROLLED') && Date.parse(leaseExpiresAt) > Date.now()) {
        await this.postWork(`${workPath}/fail`, { leaseToken: work.leaseToken, retryable: true, reasonCode: 'HANDLER_FAILED' }).catch(() => {});
      }
      if (interrupted && !renewalError && error instanceof SinaloaError && !error.code)
        throw new SinaloaError(error.message, error.status, 'REQUEST_CANCELLED');
      if (!(error instanceof SinaloaError)) await this.observeError(new SinaloaError('Work handler failed', undefined, 'HANDLER_FAILED'));
      throw error;
    } finally {
      this.activeWork.delete(workAbort);
      signal?.removeEventListener('abort', onAbort);
      await stopRenewal();
    }
  }

  /** Reads one durable delta page. The callback must complete before its cursor is committed. */
  async pollOnce(): Promise<{ count: number; hasMore: boolean }> {
    let session = validSession(await this.store.load());
    const page = await this.withFreshSession(async current => {
      session = current;
      return new SinaloaClient(this.origin, current.agentApiToken, this.options).delta(current.inboxId, current.cursor || undefined, this.pageSize);
    });
    if (!Array.isArray(page.events) || typeof page.hasMore !== 'boolean') throw new SinaloaError('Envoi returned an invalid event page');
    if (page.hasMore && page.events.length === 0) throw new SinaloaError('Envoi returned an invalid event page');
    let count = 0;
    for (const raw of page.events) {
      const event = eventFrom(raw);
      if (session.cursor && event.cursor <= session.cursor) throw new SinaloaError('Envoi event cursor did not advance');
      await this.observeEvent(event);
      await this.options.onEvent?.(event);
      // An event callback may send a reply and rotate credentials. Preserve its
      // new refresh token when committing the observation cursor.
      const current = validSession(await this.store.load());
      if (current.agentId !== session.agentId || current.inboxId !== session.inboxId) throw new SinaloaError('Connector session changed while reading events');
      session = await this.mutate(latest => ({ ...latest, cursor: event.cursor }));
      count += 1;
    }
    return { count, hasMore: page.hasMore };
  }

  /** Polls until stopped; failures retry with bounded exponential backoff and jitter. */
  async run(signal: AbortSignal): Promise<void> {
    await this.start();
    const onAbort = () => { this.actionEpoch++; for (const controller of [...this.activeActions, ...this.activeWork, ...this.activeRefresh]) controller.abort(); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (!signal.aborted) {
        const state = await this.lifecycle();
        if (state.retryAt) await delay(Math.max(0, Date.parse(state.retryAt) - Date.now()), signal);
        if (signal.aborted) break;
        try {
          if (this.options.handler && await this.processWorkOnce(signal)) continue;
          const page = await this.pollOnce();
          if (page.hasMore || this.wake.signal.aborted) { this.wake = new AbortController(); continue; }
          await delay(this.pollIntervalMs, AbortSignal.any([signal, this.wake.signal]));
          this.wake = new AbortController();
        } catch (error) {
          if (signal.aborted) break;
          if (error instanceof ConnectorPersistenceError || error instanceof ConnectorContractError) throw error;
          const current = await this.lifecycle();
          if (['REVOKED', 'NEEDS_RECONNECT'].includes(current.state)) throw error;
          if (error instanceof SinaloaError && (error.code === 'REQUEST_CANCELLED' || current.paused && error.code === 'AGENT_PAUSED')) continue;
          if (current.retryAt && current.state === 'DEGRADED' && (!(error instanceof SinaloaError) || lifecyclePolicy(error).lifecycle === 'DEGRADED')) continue;
          if (error instanceof SinaloaError && error.code === 'CASE_CONTROLLED') { await delay(this.pollIntervalMs, signal); continue; }
          throw error;
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      onAbort();
      const current = await this.lifecycle();
      if (!['REVOKED', 'NEEDS_RECONNECT'].includes(current.state)) await this.transition('STOPPED');
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener('abort', done); clearTimeout(timer); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}
