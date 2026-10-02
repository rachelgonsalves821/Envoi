import { rotateAgentToken, SinaloaClient, SinaloaError, type AgentTokens, type AssetUploadInput, type CaseMessageInput, type ClientOptions, type NativeMessageInput } from './index';
import { CONNECTOR_RUNTIMES, type ConnectorRuntime } from './quick-connect';

/** Persist the whole record atomically, including each replacement refresh token. */
export interface ConnectorSession extends AgentTokens {
  agentId: string;
  inboxId: string;
  address: string;
  cursor: string | null;
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

export interface WorkMessage extends Record<string, unknown> {
  id: string;
  senderAgentId: string;
  recipientAgentId: string;
  from: { agentId: string; address: string };
  caseId?: string | null;
  text: string;
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
}

export class ConnectorPersistenceError extends Error {
  constructor() {
    super('Connector credential persistence failed; stop this installation and re-enroll if needed');
    this.name = 'ConnectorPersistenceError';
  }
}

export class ConnectorContractError extends Error {
  constructor() {
    super('Sinaloa fenced work API is unavailable; agent processing cannot start');
    this.name = 'ConnectorContractError';
  }
}

export class ConnectorCredentialsError extends Error {
  constructor() {
    super('Connector credentials are missing or expired; re-enrollment is required');
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

function eventFrom(value: Record<string, unknown>): InboxEvent {
  if (typeof value.id !== 'string' || typeof value.type !== 'string' || typeof value.cursor !== 'string' || !value.cursor) {
    throw new SinaloaError('Sinaloa returned an invalid event');
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
  const timer = setTimeout(() => controller.abort(), duration);
  let response: Response;
  try {
    response = await (options.fetch || fetch)(`${origin}/api/agent-enroll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollmentToken, ...(options.name ? { name: options.name } : {}), ...(options.runtime ? { runtime: options.runtime } : {}) }), signal: controller.signal
    });
  } catch {
    throw new SinaloaError(controller.signal.aborted ? 'Sinaloa request timed out' : 'Sinaloa could not be reached');
  } finally {
    clearTimeout(timer);
  }
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch { /* Never expose provider response bodies. */ }
  if (!response.ok) {
    const remote = payload?.error;
    throw new SinaloaError(typeof remote === 'string' && remote.length <= 500 ? remote : `Sinaloa enrollment failed with HTTP ${response.status}`, response.status);
  }
  const agent = payload?.agent as Record<string, unknown> | undefined;
  const inbox = payload?.inbox as Record<string, unknown> | undefined;
  const session = validSession({
    agentId: String(agent?.id || ''), inboxId: String(inbox?.id || ''), address: String(agent?.address || ''),
    agentApiToken: String(payload?.agentApiToken || ''), agentRefreshToken: String(payload?.agentRefreshToken || ''),
    agentTokenExpiresAt: String(payload?.agentTokenExpiresAt || ''),
    agentRefreshTokenExpiresAt: String(payload?.agentRefreshTokenExpiresAt || ''), cursor: null
  });
  if (!session.address) throw new SinaloaError('Sinaloa enrollment response is missing the agent address');
  try { await store.save(session); } catch { throw new ConnectorPersistenceError(); }
  return session;
}

export class SinaloaConnector {
  private readonly origin: string;
  private readonly pageSize: number;
  private readonly pollIntervalMs: number;
  private readonly refreshSkewMs: number;
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

  private async freshSession(force = false): Promise<ConnectorSession> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const current = validSession(await this.store.load());
      if (!force && Date.parse(current.agentTokenExpiresAt) > Date.now() + this.refreshSkewMs) return current;
      if (Date.parse(current.agentRefreshTokenExpiresAt) <= Date.now()) throw new ConnectorCredentialsError();
      const rotated = await rotateAgentToken(this.origin, current.agentRefreshToken, this.options);
      const next = validSession({ ...current, ...rotated });
      // A failed save is fatal: using the consumed refresh token again would replay it.
      try { await this.store.save(next); } catch { throw new ConnectorPersistenceError(); }
      return next;
    })();
    try { return await this.refreshInFlight; } finally { this.refreshInFlight = null; }
  }

  private async withFreshSession<T>(run: (session: ConnectorSession) => Promise<T>): Promise<T> {
    const session = await this.freshSession();
    try { return await run(session); }
    catch (error) {
      if (!(error instanceof SinaloaError) || error.status !== 401) throw error;
      const current = validSession(await this.store.load());
      return run(current.agentApiToken === session.agentApiToken ? await this.freshSession(true) : current);
    }
  }

  private withFreshClient<T>(operation: (client: SinaloaClient, session: ConnectorSession) => Promise<T>): Promise<T> {
    return this.withFreshSession(session => operation(new SinaloaClient(this.origin, session.agentApiToken, this.options), session));
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
    return this.withFreshSession(async session => {
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
      let response: Response;
      try {
        response = await (this.options.fetch || fetch)(`${this.origin}/api/agent/mcp-read-token`, {
          method: 'POST', redirect: 'error', signal: timeout,
          headers: { authorization: `Bearer ${session.agentApiToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(caseId === null ? {} : { caseId })
        });
      } catch { throw new SinaloaError(timeout.aborted ? 'Sinaloa MCP token request timed out' : 'Sinaloa MCP token service could not be reached'); }
      if (!response.ok) throw new SinaloaError('Sinaloa MCP read credential was denied', response.status);
      let payload: Record<string, unknown>;
      try { payload = await response.json() as Record<string, unknown>; }
      catch { throw new SinaloaError('Sinaloa returned an invalid MCP read credential'); }
      if (!payload || typeof payload.mcpAccessToken !== 'string' || !payload.mcpAccessToken ||
          payload.tokenType !== 'Bearer' || payload.scope !== 'case_read' || payload.caseId !== caseId ||
          typeof payload.expiresAt !== 'string' || Date.parse(payload.expiresAt) <= Date.now() + 120_000) {
        throw new SinaloaError('Sinaloa returned an invalid or short-lived MCP read credential');
      }
      return payload as unknown as McpReadToken;
    });
  }

  /** Trusted host only: forwards MCP JSON-RPC without exposing the rotating refresh token. */
  forwardMcpRequest(body: string, { protocolVersion, signal }: { protocolVersion?: string; signal?: AbortSignal } = {}): Promise<Response> {
    if (protocolVersion && !/^\d{4}-\d{2}-\d{2}$/.test(protocolVersion)) throw new TypeError('Invalid MCP protocol version');
    return this.withFreshSession(async session => {
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
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
        throw new SinaloaError(requestSignal.aborted ? 'Sinaloa MCP request timed out or canceled' : 'Sinaloa MCP could not be reached');
      }
      if (response.status === 401) throw new SinaloaError('Sinaloa MCP credential was rejected', 401);
      return response;
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
    return this.withFreshClient((client, session) => client.listCases(session.inboxId, limit, before));
  }

  getCase(caseId: string) {
    return this.withFreshClient((client, session) => client.getCase(session.inboxId, caseId));
  }

  listCaseMessages(caseId: string, limit = 50, before?: string) {
    return this.withFreshClient((client, session) => client.listCaseMessages(session.inboxId, caseId, limit, before));
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
    return this.withFreshClient((client, session) => client.listAssets(session.inboxId));
  }

  getCleanAssetDownload(assetId: string) {
    return this.withFreshClient((client, session) => client.getCleanAssetDownload(session.inboxId, assetId));
  }

  private async postWork<T>(path: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const send = async (accessToken: string): Promise<T> => {
      const controller = new AbortController();
      const duration = this.options.timeoutMs ?? 30_000;
      const timer = setTimeout(() => controller.abort(), duration);
      let response: Response;
      try {
        response = await (this.options.fetch || fetch)(`${this.origin}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json', authorization: `Bearer ${accessToken}`,
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
          },
          body: JSON.stringify(body), signal: controller.signal
        });
      } catch {
        throw new SinaloaError(controller.signal.aborted ? 'Sinaloa request timed out' : 'Sinaloa could not be reached');
      } finally { clearTimeout(timer); }
      let payload: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = await response.json();
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
      } catch { /* Never expose a raw provider body. */ }
      if (!response.ok) {
        const remote = payload?.error;
        throw new SinaloaError(typeof remote === 'string' && remote.length <= 500 ? remote : `Sinaloa work request failed with HTTP ${response.status}`, response.status);
      }
      if (!payload) throw new SinaloaError('Sinaloa returned an invalid work response', response.status);
      return payload as T;
    };
    const session = await this.freshSession();
    try { return await send(session.agentApiToken); }
    catch (error) {
      if (!(error instanceof SinaloaError) || error.status !== 401) throw error;
      const current = validSession(await this.store.load());
      const next = current.agentApiToken === session.agentApiToken ? await this.freshSession(true) : current;
      return send(next.agentApiToken);
    }
  }

  private async reply(message: WorkMessage, text: string, idempotencyKey: string, extra: Omit<NativeMessageInput, 'senderAgentId' | 'recipientEmail' | 'text' | 'caseId'> = {}): Promise<unknown> {
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
    let claimed: { work: WorkLease | null };
    try { claimed = await this.postWork<{ work: WorkLease | null }>('/api/agent/work/claim', {}); }
    catch (error) {
      if (error instanceof SinaloaError && [404, 405, 501].includes(error.status || 0)) throw new ConnectorContractError();
      throw error;
    }
    if (claimed.work === null) return false;
    const work = claimed.work;
    if (!work || typeof work.workId !== 'string' || typeof work.leaseToken !== 'string' || !Number.isFinite(Date.parse(work.leaseExpiresAt)) || typeof work.message?.id !== 'string' || !work.message.id) {
      throw new SinaloaError('Sinaloa returned an invalid work claim');
    }
    const session = validSession(await this.store.load());
    if (work.message.recipientAgentId !== session.agentId || work.message.status === 'processed' || !work.message.from?.address) {
      throw new SinaloaError('Sinaloa returned work for the wrong recipient');
    }
    const workPath = `/api/agent/work/${encodeURIComponent(work.workId)}`;
    // The server scopes idempotency by agent, so a reclaimed lease needs new
    // request keys; reuse these keys only within this claim attempt.
    const attemptId = globalThis.crypto.randomUUID();
    const acknowledgeKey = `connector:${work.message.id}:${attemptId}:ack`;
    const completeKey = `connector:${work.message.id}:${attemptId}:complete`;
    const workAbort = new AbortController();
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
          if (renewed.workId !== work.workId || renewed.leaseToken !== work.leaseToken || !Number.isFinite(Date.parse(renewed.leaseExpiresAt))) throw new SinaloaError('Sinaloa returned an invalid lease renewal');
          leaseExpiresAt = renewed.leaseExpiresAt;
        } catch (error) { renewalError = error; workAbort.abort(); break; }
      }
    })();
    const stopRenewal = async () => { workAbort.abort(); await renewal; };
    let settled = false;
    try {
      if (workAbort.signal.aborted) throw new SinaloaError('Work claim was interrupted before admission');
      await handler.admit(work.message);
      if (workAbort.signal.aborted) throw new SinaloaError('Work lease was interrupted before acknowledgement');
      const acknowledged = await this.postWork<WorkSettlement>(`${workPath}/acknowledge`, { leaseToken: work.leaseToken }, acknowledgeKey);
      if (acknowledged.workId !== work.workId || acknowledged.status !== 'acknowledged' || acknowledged.receipt?.state !== 'acknowledged' || acknowledged.receipt.messageId !== work.message.id) {
        throw new SinaloaError('Sinaloa returned an invalid acknowledgement');
      }
      await handler.process(work.message, {
        signal: workAbort.signal,
        reply: async (text, key, extra) => {
          if (workAbort.signal.aborted || signal?.aborted || Date.parse(leaseExpiresAt) <= Date.now()) {
            throw new SinaloaError('Work lease is no longer valid for a reply');
          }
          return this.reply(work.message, text, key, extra);
        }
      });
      if (renewalError) throw new SinaloaError('Work lease renewal failed');
      if (signal?.aborted || Date.parse(leaseExpiresAt) <= Date.now()) throw new SinaloaError('Work lease expired before completion');
      const completed = await this.postWork<WorkSettlement>(`${workPath}/complete`, { leaseToken: work.leaseToken }, completeKey);
      if (completed.workId !== work.workId || completed.status !== 'processed' || completed.receipt?.state !== 'processed' || completed.receipt.messageId !== work.message.id) {
        throw new SinaloaError('Sinaloa returned an invalid completion');
      }
      settled = true;
      await stopRenewal();
      return true;
    } catch (error) {
      await stopRenewal();
      if (!renewalError && !settled && !signal?.aborted && Date.parse(leaseExpiresAt) > Date.now()) {
        await this.postWork(`${workPath}/fail`, { leaseToken: work.leaseToken, retryable: true, reasonCode: 'HANDLER_FAILED' }).catch(() => {});
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await stopRenewal();
    }
  }

  /** Reads one durable delta page. The callback must complete before its cursor is committed. */
  async pollOnce(): Promise<{ count: number; hasMore: boolean }> {
    let session = await this.freshSession();
    const client = new SinaloaClient(this.origin, session.agentApiToken, this.options);
    let page: { events: Array<Record<string, unknown>>; nextCursor: string | null; hasMore: boolean };
    try {
      page = await client.delta(session.inboxId, session.cursor || undefined, this.pageSize);
    } catch (error) {
      if (!(error instanceof SinaloaError) || error.status !== 401) throw error;
      session = await this.freshSession(true);
      client.setAccessToken(session.agentApiToken);
      page = await client.delta(session.inboxId, session.cursor || undefined, this.pageSize);
    }
    if (!Array.isArray(page.events) || typeof page.hasMore !== 'boolean') throw new SinaloaError('Sinaloa returned an invalid event page');
    if (page.hasMore && page.events.length === 0) throw new SinaloaError('Sinaloa returned an invalid event page');
    let count = 0;
    for (const raw of page.events) {
      const event = eventFrom(raw);
      if (session.cursor && event.cursor <= session.cursor) throw new SinaloaError('Sinaloa event cursor did not advance');
      await this.options.onEvent?.(event);
      // An event callback may send a reply and rotate credentials. Preserve its
      // new refresh token when committing the observation cursor.
      const current = validSession(await this.store.load());
      if (current.agentId !== session.agentId || current.inboxId !== session.inboxId) throw new SinaloaError('Connector session changed while reading events');
      session = { ...current, cursor: event.cursor };
      await this.store.save(session);
      count += 1;
    }
    return { count, hasMore: page.hasMore };
  }

  /** Polls until stopped; failures retry with bounded exponential backoff and jitter. */
  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        if (this.options.handler && await this.processWorkOnce(signal)) { failures = 0; continue; }
        const page = await this.pollOnce();
        failures = 0;
        if (page.hasMore) continue;
        await delay(this.pollIntervalMs, signal);
      } catch (error) {
        if (signal.aborted) break;
        // Authentication/credential persistence requires operator intervention.
        if (error instanceof ConnectorPersistenceError || error instanceof ConnectorContractError || error instanceof ConnectorCredentialsError || (error instanceof SinaloaError && [401, 403].includes(error.status || 0))) throw error;
        failures += 1;
        const ceiling = Math.min(30_000, 500 * 2 ** Math.min(failures, 6));
        await delay(Math.round(ceiling / 2 + Math.random() * ceiling / 2), signal);
      }
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
