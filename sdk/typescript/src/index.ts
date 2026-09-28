export const SINALOA_PROTOCOL_VERSION = '1.0' as const;

export type SinaloaIntent = 'request' | 'offer' | 'counteroffer' | 'accept' | 'reject' | 'clarify' | 'commit' | 'cancel' | 'status' | 'receipt' | 'message';
export type DeliveryState = 'pendingContactApproval' | 'queued' | 'retrying' | 'accepted' | 'delivered' | 'acknowledged' | 'processed' | 'declined' | 'deadLettered';

export interface AgentRef { agentId: string; address: string }
export interface ContentPart { type: 'text' | 'json' | 'artifactRef'; text?: string; data?: unknown; artifactRef?: string }
export interface Authority { scope: string; humanApproval: 'notRequired' | 'pending' | 'approved' | 'denied'; policyEvaluationId?: string | null }
export interface AgentMessage {
  schemaVersion: typeof SINALOA_PROTOCOL_VERSION;
  messageId: string;
  conversationId: string;
  taskId?: string | null;
  correlationId: string | null;
  causationId: string | null;
  from: AgentRef;
  to: AgentRef[];
  intent: SinaloaIntent;
  content: ContentPart[];
  proposal?: Record<string, unknown> | null;
  authority: Authority;
  artifactRefs: string[];
  requiresAck: boolean;
  traceparent?: string | null;
  signature?: string | null;
  createdAt: string;
}

export interface AgentTokens {
  agentApiToken: string;
  agentRefreshToken: string;
  agentTokenExpiresAt: string;
  agentRefreshTokenExpiresAt: string;
}

export interface NativeMessageInput {
  senderAgentId: string;
  recipientEmail: string;
  text: string;
  intent?: SinaloaIntent;
  caseId?: string;
  content?: ContentPart[];
  payload?: Record<string, unknown> | null;
  artifactRefs?: string[];
  requiresAck?: boolean;
}

export interface ClientOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class SinaloaError extends Error {
  constructor(message: string, public readonly status?: number, public readonly code?: string) {
    super(message);
    this.name = 'SinaloaError';
  }
}

const timeoutMs = (value = 30_000) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) throw new RangeError('timeoutMs must be an integer from 1 to 300000');
  return value;
};

const safePayload = (text: string): Record<string, unknown> | null => {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

async function responsePayload<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  const payload = safePayload(text);
  if (!response.ok) {
    const remoteMessage = typeof payload?.error === 'string' ? payload.error : typeof payload?.message === 'string' ? payload.message : null;
    const message = remoteMessage && remoteMessage.length <= 500 ? remoteMessage : `${fallback} with HTTP ${response.status}`;
    throw new SinaloaError(message, response.status, typeof payload?.code === 'string' ? payload.code : undefined);
  }
  if (!text) throw new SinaloaError('Sinaloa returned an empty response', response.status);
  if (payload === null) throw new SinaloaError('Sinaloa returned an invalid JSON response', response.status);
  return payload as T;
}

async function fetchWithTimeout(fetcher: typeof fetch, url: string, init: RequestInit, duration: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(duration));
  const onAbort = () => controller.abort();
  init.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !init.signal?.aborted) throw new SinaloaError('Sinaloa request timed out');
    throw new SinaloaError('Sinaloa could not be reached');
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onAbort);
  }
}

export interface ContactInvitation {
  id: string;
  fromAddress: string;
  toAddress: string;
  state: 'pending' | 'accepted' | 'declined';
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SendMessageResult = (AgentMessage & { status: DeliveryState; transport: 'native'; recipientEmail: string }) | {
  invitation: ContactInvitation;
  message: AgentMessage & { status: 'pendingContactApproval'; transport: 'native'; recipientEmail: string };
  contactState: 'pending';
};

export class SinaloaClient {
  private readonly requestTimeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly baseUrl: string, private accessToken: string, options: ClientOptions = {}) {
    this.requestTimeoutMs = timeoutMs(options.timeoutMs);
    this.fetcher = options.fetch || fetch;
  }

  setAccessToken(accessToken: string) { this.accessToken = accessToken; }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchWithTimeout(this.fetcher, `${this.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.accessToken}`, ...init.headers }
    }, this.requestTimeoutMs);
    return responsePayload<T>(response, 'Sinaloa request failed');
  }

  sendMessage(inboxId: string, idempotencyKey: string, input: NativeMessageInput) {
    return this.request<SendMessageResult>(`/api/inboxes/${encodeURIComponent(inboxId)}/messages`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input)
    });
  }

  acknowledge(inboxId: string, messageId: string, state: 'acknowledged' | 'processed', idempotencyKey: string) {
    return this.request(`/api/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}/acknowledgements`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ state })
    });
  }

  delta(inboxId: string, cursor?: string, limit = 100) {
    const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    return this.request<{ events: Array<Record<string, unknown>>; nextCursor: string | null; hasMore: boolean }>(`/api/inboxes/${encodeURIComponent(inboxId)}/events/delta?${query}`);
  }
}

export async function rotateAgentToken(baseUrl: string, agentRefreshToken: string, options: ClientOptions = {}): Promise<AgentTokens> {
  const response = await fetchWithTimeout(options.fetch || fetch, `${baseUrl.replace(/\/$/, '')}/api/agent-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grantType: 'refresh_token', agentRefreshToken })
  }, timeoutMs(options.timeoutMs));
  return responsePayload<AgentTokens>(response, 'Sinaloa token rotation failed');
}
