import { rotateAgentToken, SinaloaClient, SinaloaError, type AgentTokens, type ClientOptions } from './index';

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

export interface InboxEvent {
  id: string;
  type: string;
  cursor: string;
  [key: string]: unknown;
}

export interface ConnectorOptions extends ClientOptions {
  pageSize?: number;
  pollIntervalMs?: number;
  refreshSkewMs?: number;
  /** Observation only. Processing requires the server's future fenced work-claim API. */
  onEvent?: (event: InboxEvent) => Promise<void> | void;
}

export class ConnectorPersistenceError extends Error {
  constructor() {
    super('Connector credential persistence failed; stop this installation and re-enroll if needed');
    this.name = 'ConnectorPersistenceError';
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
  if (!value || !value.agentId || !value.inboxId || !value.agentApiToken || !value.agentRefreshToken || !Number.isFinite(Date.parse(value.agentTokenExpiresAt))) {
    throw new SinaloaError('Connector credentials are missing or invalid');
  }
  return value;
}

function eventFrom(value: Record<string, unknown>): InboxEvent {
  if (typeof value.id !== 'string' || typeof value.type !== 'string' || typeof value.cursor !== 'string' || !value.cursor) {
    throw new SinaloaError('Sinaloa returned an invalid event');
  }
  return value as InboxEvent;
}

/** Redeems the existing one-use code; the server currently ignores installation metadata. */
export async function enrollConnector(baseUrl: string, enrollmentToken: string, store: ConnectorStore, options: ClientOptions & { name?: string } = {}): Promise<ConnectorSession> {
  const origin = apiOrigin(baseUrl);
  if (!enrollmentToken) throw new TypeError('Enrollment token is required');
  const controller = new AbortController();
  const duration = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 300_000) throw new RangeError('timeoutMs must be an integer from 1 to 300000');
  const timer = setTimeout(() => controller.abort(), duration);
  let response: Response;
  try {
    response = await (options.fetch || fetch)(`${origin}/api/agent-enroll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollmentToken, ...(options.name ? { name: options.name } : {}) }), signal: controller.signal
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

  constructor(baseUrl: string, private readonly store: ConnectorStore, private readonly options: ConnectorOptions = {}) {
    this.origin = apiOrigin(baseUrl);
    this.pageSize = options.pageSize ?? 100;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000;
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 200) throw new RangeError('pageSize must be from 1 to 200');
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1) throw new RangeError('pollIntervalMs must be positive');
    if (!Number.isSafeInteger(this.refreshSkewMs) || this.refreshSkewMs < 0) throw new RangeError('refreshSkewMs must be nonnegative');
  }

  private async freshSession(force = false): Promise<ConnectorSession> {
    const current = validSession(await this.store.load());
    if (!force && Date.parse(current.agentTokenExpiresAt) > Date.now() + this.refreshSkewMs) return current;
    const rotated = await rotateAgentToken(this.origin, current.agentRefreshToken, this.options);
    const next = validSession({ ...current, ...rotated });
    // A failed save is fatal: using the consumed refresh token again would replay it.
    try { await this.store.save(next); } catch { throw new ConnectorPersistenceError(); }
    return next;
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
      session = { ...session, cursor: event.cursor };
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
        const page = await this.pollOnce();
        failures = 0;
        if (page.hasMore) continue;
        await delay(this.pollIntervalMs, signal);
      } catch (error) {
        if (signal.aborted) break;
        // Authentication/credential persistence requires operator intervention.
        if (error instanceof ConnectorPersistenceError || (error instanceof SinaloaError && [401, 403].includes(error.status || 0))) throw error;
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
