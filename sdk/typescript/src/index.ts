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
  constructor(private readonly baseUrl: string, private accessToken: string) {}

  setAccessToken(accessToken: string) { this.accessToken = accessToken; }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.accessToken}`, ...init.headers }
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Sinaloa request failed with ${response.status}`);
    return payload as T;
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

export async function rotateAgentToken(baseUrl: string, agentRefreshToken: string): Promise<AgentTokens> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/agent-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grantType: 'refresh_token', agentRefreshToken })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Sinaloa token rotation failed with ${response.status}`);
  return payload as AgentTokens;
}
