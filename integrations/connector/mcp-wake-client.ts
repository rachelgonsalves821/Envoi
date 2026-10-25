import { PrivateHostTransport, HostRequestError, closed, dateTime, matches, text, valid } from './private-host-http';
import { webhookSecret } from './webhook-secret';

export type EventName = 'envoi.work_available' | 'envoi.control_changed';
export interface EventSubscription { id: string; refreshBefore: string; cursor: string | null; truncated: boolean }
export interface EventInput { name: EventName; arguments: Record<string, never>; delivery: { mode: 'webhook'; url: string; secret: string }; cursor?: string | null; ttlMs?: number | null }
export interface WakeSubscription {
  id: string; installationId: string; agentId: string; url: string; status: 'pending' | 'active' | 'ended';
  endedReason: string | null; createdAt: string; activatedAt: string | null; expiresAt: string | null;
  endedAt: string | null; challengeExpiresAt: string | null; replacesSubscriptionId: string | null;
  delivery: { state: string; lastAttemptAt: string | null; lastSuccessAt: string | null; consecutiveFailures: number; lastFailureClass: string | null };
}
const subscriptionId = /^wake_sub_[A-Za-z0-9_-]+$/;
const toolErrorCodes = new Set(['WAKE_SUBSCRIPTION_INVALID', 'WAKE_URL_REJECTED', 'WAKE_SUBSCRIPTION_NOT_FOUND', 'WAKE_CHALLENGE_INVALID', 'WAKE_SUBSCRIPTION_ENDED', 'WAKE_ROUTE_NOT_SUPPORTED']);
const cursor = (value: unknown) => value === null || matches(value, /^[0-9]{20}$/);
function callback(value: unknown, max: number) {
  if (!text(value, max)) throw new TypeError('Invalid callback URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError('Invalid callback URL'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) throw new TypeError('Invalid callback URL');
}
function wakeSubscription(value: unknown): WakeSubscription {
  closed(value, ['id', 'installationId', 'agentId', 'url', 'status', 'endedReason', 'createdAt', 'activatedAt', 'expiresAt', 'endedAt', 'challengeExpiresAt', 'replacesSubscriptionId', 'delivery']);
  valid(matches(value.id, subscriptionId) && matches(value.installationId, /^installation_[A-Za-z0-9_-]+$/) && matches(value.agentId, /^agent_[A-Za-z0-9_-]+$/));
  valid(text(value.url) && ['pending', 'active', 'ended'].includes(value.status as string) && dateTime(value.createdAt));
  for (const key of ['activatedAt', 'expiresAt', 'endedAt', 'challengeExpiresAt']) valid(value[key] === null || dateTime(value[key]));
  valid(value.endedReason === null || text(value.endedReason, 80));
  valid(value.replacesSubscriptionId === null || matches(value.replacesSubscriptionId, subscriptionId));
  closed(value.delivery, ['state', 'lastAttemptAt', 'lastSuccessAt', 'consecutiveFailures', 'lastFailureClass']);
  valid(text(value.delivery.state, 80) && Number.isInteger(value.delivery.consecutiveFailures) && Number(value.delivery.consecutiveFailures) >= 0);
  for (const key of ['lastAttemptAt', 'lastSuccessAt']) valid(value.delivery[key] === null || dateTime(value.delivery[key]));
  valid(value.delivery.lastFailureClass === null || text(value.delivery.lastFailureClass, 80));
  return value as unknown as WakeSubscription;
}

/** Private provider backend client; this is deliberately not a model-facing MCP tool catalog. */
export class McpWakeClient {
  #transport: PrivateHostTransport;
  #id = 0;
  #version: '2025-11-25' | '2026-07-28';
  constructor(options: { origin: string; accessToken: () => Promise<string>; protocolVersion?: '2025-11-25' | '2026-07-28'; fetch?: typeof fetch; timeoutMs?: number }) {
    this.#version = options.protocolVersion ?? '2025-11-25';
    if (!['2025-11-25', '2026-07-28'].includes(this.#version)) throw new TypeError('Unsupported MCP protocol version');
    this.#transport = new PrivateHostTransport({ ...options, headers: async () => {
      const token = await options.accessToken();
      if (!token || /[\r\n]/.test(token)) throw new TypeError('Invalid private credential');
      return { authorization: `Bearer ${token}` };
    } });
  }
  get lifecycle() { return this.#transport.lifecycle; }
  ownerResumed() { this.#transport.ownerResumed(); }
  async #rpc(method: string, params: unknown): Promise<unknown> {
    const id = ++this.#id;
    const result = await this.#transport.post('/mcp', { jsonrpc: '2.0', id, method, params }, { 'mcp-protocol-version': this.#version });
    closed(result, ['jsonrpc', 'id'], ['result', 'error']);
    valid(result.jsonrpc === '2.0' && result.id === id && (Object.hasOwn(result, 'result') !== Object.hasOwn(result, 'error')));
    if (Object.hasOwn(result, 'error')) {
      closed(result.error, ['code', 'message'], ['data']);
      valid(Number.isInteger(result.error.code));
      // Remote messages/data can contain supplied secrets; do not propagate either.
      throw new HostRequestError(result.error.code === -32601 ? 'METHOD_UNAVAILABLE' : 'RPC_ERROR');
    }
    return result.result;
  }
  async #tool(name: string, args: unknown): Promise<unknown> {
    const result = await this.#rpc('tools/call', { name, arguments: args });
    closed(result, ['content', 'isError']);
    valid(typeof result.isError === 'boolean' && Array.isArray(result.content) && result.content.length === 1);
    const content = result.content[0];
    closed(content, ['type', 'text']);
    valid(content.type === 'text' && text(content.text, 60000));
    let envelope: unknown;
    try { envelope = JSON.parse(content.text); } catch { throw new HostRequestError('INVALID_RESPONSE'); }
    if (result.isError) {
      closed(envelope, ['ok', 'tool', 'code', 'message', 'retryable'], ['reason']);
      valid(envelope.ok === false && envelope.tool === name && typeof envelope.code === 'string' && toolErrorCodes.has(envelope.code));
      throw new HostRequestError(envelope.code);
    }
    closed(envelope, ['ok', 'tool', 'result']);
    valid(envelope.ok === true && envelope.tool === name);
    return envelope.result;
  }
  async create(input: { url: string }): Promise<WakeSubscription> {
    closed(input, ['url']); callback(input.url, 8192);
    const result = await this.#tool('envoi_wake_create', input);
    closed(result, ['subscription']); return wakeSubscription(result.subscription);
  }
  async activate(input: { subscriptionId: string; challenge: string }): Promise<WakeSubscription> {
    closed(input, ['subscriptionId', 'challenge']);
    if (!matches(input.subscriptionId, subscriptionId) || !matches(input.challenge, /^envoi_wake_challenge_[A-Za-z0-9_-]+$/)) throw new TypeError('Invalid private wake challenge');
    const result = await this.#tool('envoi_wake_activate', input);
    closed(result, ['subscription']); return wakeSubscription(result.subscription);
  }
  async end(input: { subscriptionId: string }): Promise<WakeSubscription> {
    closed(input, ['subscriptionId']);
    if (!matches(input.subscriptionId, subscriptionId)) throw new TypeError('Invalid subscription id');
    const result = await this.#tool('envoi_wake_end', input);
    closed(result, ['subscription']); return wakeSubscription(result.subscription);
  }
  async status(): Promise<{ available: boolean; version: number; subscription: { id: string; status: string; endedReason: string | null; expiresAt: string | null } | null }> {
    const result = await this.#tool('envoi_wake_status', {});
    closed(result, ['httpWake']);
    closed(result.httpWake, ['available', 'version', 'subscription']);
    valid(typeof result.httpWake.available === 'boolean' && result.httpWake.version === 1);
    const sub = result.httpWake.subscription;
    if (sub !== null) {
      closed(sub, ['id', 'status', 'endedReason', 'expiresAt']);
      valid(matches(sub.id, subscriptionId) && ['pending', 'active', 'ended'].includes(sub.status as string));
      valid(sub.endedReason === null || text(sub.endedReason, 80)); valid(sub.expiresAt === null || dateTime(sub.expiresAt));
    }
    return result.httpWake as Awaited<ReturnType<McpWakeClient['status']>>;
  }
  #eventsVersion() { if (this.#version !== '2026-07-28') throw new HostRequestError('EVENTS_PROTOCOL_REQUIRED'); }
  /** Validate discovery on the selected protocol before advertising event support. */
  async discoverEvents(): Promise<boolean> {
    this.#eventsVersion();
    const result = await this.#rpc('server/discover', {});
    closed(result, ['protocolVersion', 'capabilities', 'serverInfo']);
    valid(result.protocolVersion === '2026-07-28');
    closed(result.capabilities, [], ['tools', 'events']);
    if (result.capabilities.events !== undefined) closed(result.capabilities.events, []);
    closed(result.serverInfo, ['name'], ['version']);
    valid(text(result.serverInfo.name, 100));
    return result.capabilities.events !== undefined;
  }
  async subscribe(input: EventInput): Promise<EventSubscription> {
    this.#eventsVersion();
    closed(input, ['name', 'arguments', 'delivery'], ['cursor', 'ttlMs']);
    closed(input.arguments, []); closed(input.delivery, ['mode', 'url', 'secret']);
    if (!['envoi.work_available', 'envoi.control_changed'].includes(input.name) || input.delivery.mode !== 'webhook') throw new TypeError('Invalid event subscription');
    callback(input.delivery.url, 2048);
    const secret = webhookSecret(input.delivery.secret);
    secret.bytes.fill(0); // only the canonical string is needed by this outgoing request
    if (Object.hasOwn(input, 'cursor') && !cursor(input.cursor)) throw new TypeError('Invalid event cursor');
    if (Object.hasOwn(input, 'ttlMs') && input.ttlMs !== null && (!Number.isSafeInteger(input.ttlMs) || Number(input.ttlMs) < 3600000 || Number(input.ttlMs) > 604800000)) throw new TypeError('Event TTL must be between one hour and seven days');
    const result = await this.#rpc('events/subscribe', { ...input, delivery: { ...input.delivery, secret: secret.canonical } });
    closed(result, ['id', 'refreshBefore', 'cursor', 'truncated']);
    valid(matches(result.id, /^evtsub_[0-9a-f]{20}$/) && dateTime(result.refreshBefore) && cursor(result.cursor) && typeof result.truncated === 'boolean');
    return result as unknown as EventSubscription;
  }
  async unsubscribe(input: { name: EventName; arguments: Record<string, never>; delivery: { mode: 'webhook'; url: string } }): Promise<void> {
    this.#eventsVersion(); closed(input, ['name', 'arguments', 'delivery']); closed(input.arguments, []); closed(input.delivery, ['mode', 'url']);
    if (!['envoi.work_available', 'envoi.control_changed'].includes(input.name) || input.delivery.mode !== 'webhook') throw new TypeError('Invalid event subscription');
    callback(input.delivery.url, 2048);
    closed(await this.#rpc('events/unsubscribe', input), []);
  }
}
