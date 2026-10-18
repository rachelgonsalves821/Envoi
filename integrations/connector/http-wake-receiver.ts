import { verify } from 'node:crypto';
import { HttpWakeKeys, type WakeKeysOptions } from './http-wake-keys';

export interface WakeNotification {
  version: 1;
  type: string;
  id: string;
  subscriptionId: string;
  sequence?: number;
  reason?: string;
  createdAt?: string;
  challenge?: string;
  expiresAt?: string;
}

export interface WakeState {
  version: 1;
  subscriptions: Record<string, { url: string; status: 'pending' | 'active'; installationId: string }>;
  accepted: Record<string, { receivedAt: number; expiresAt: number; notification: WakeNotification; pending: boolean; acknowledged: boolean }>;
  endedReasons: Record<string, string>;
}

export interface WakeStore {
  read(): Promise<WakeState>;
  update(mutator: (state: WakeState) => void): Promise<void>;
}

export const WAKE_MAX_ACCEPTED = 4096;
export const WAKE_MAX_PENDING = 256;
export const WAKE_MAX_STATE_BYTES = 4 * 1024 * 1024;

export interface WakeRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
}

export interface WakeResponse {
  status: number;
  headers: Record<string, string>;
  notification?: WakeNotification;
  acceptedId?: string;
}

export interface HttpWakeReceiverOptions extends WakeKeysOptions {
  registeredUrl: string;
  store: WakeStore;
}

const wakeIdPattern = /^wake_evt_[A-Za-z0-9_-]{16,64}$/;
const subscriptionIdPattern = /^wake_sub_[A-Za-z0-9_-]{3,64}$/;
const keyIdPattern = /^[A-Za-z0-9._-]{1,64}$/;
const knownTypes = new Set(['wake.challenge', 'wake.work_available', 'wake.control_changed']);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseNotification(value: unknown): WakeNotification | undefined {
  if (!record(value) || value.version !== 1 || typeof value.type !== 'string' || !value.type.length
    || typeof value.id !== 'string' || !wakeIdPattern.test(value.id)
    || typeof value.subscriptionId !== 'string' || !subscriptionIdPattern.test(value.subscriptionId)) return undefined;
  const notification: WakeNotification = { version: 1, type: value.type, id: value.id, subscriptionId: value.subscriptionId };
  if (Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0) notification.sequence = value.sequence as number;
  if (typeof value.reason === 'string') notification.reason = value.reason;
  for (const field of ['createdAt', 'expiresAt'] as const) {
    if (typeof value[field] === 'string' && Number.isFinite(Date.parse(value[field]))) notification[field] = value[field];
  }
  if (typeof value.challenge === 'string' && /^envoi_wake_challenge_[A-Za-z0-9_-]{43}$/.test(value.challenge)
    && Buffer.from(value.challenge.slice(21), 'base64url').toString('base64url') === value.challenge.slice(21)) {
    notification.challenge = value.challenge;
  }
  return notification;
}

function actionable(notification: WakeNotification): boolean {
  return knownTypes.has(notification.type) && (notification.type !== 'wake.challenge' || !!notification.challenge && !!notification.expiresAt);
}

function canonicalUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return value.length <= 2048 && parsed.protocol === 'https:' && parsed.href === value
      && !parsed.username && !parsed.password && !value.includes('?') && !value.includes('#')
      && !/[\r\n]/.test(value) && (!parsed.port || parsed.port === '443');
  } catch {
    return false;
  }
}

export function isWakeState(value: unknown): value is WakeState {
  if (!record(value) || value.version !== 1 || !record(value.subscriptions) || !record(value.accepted) || !record(value.endedReasons)) return false;
  if (Object.keys(value).some(field => !['version', 'subscriptions', 'accepted', 'endedReasons'].includes(field))
    || Object.keys(value.subscriptions).length > 64 || Object.keys(value.accepted).length > WAKE_MAX_ACCEPTED
    || Object.keys(value.endedReasons).length > 64) return false;
  if (!Object.entries(value.subscriptions).every(([subscriptionId, subscription]) => subscriptionIdPattern.test(subscriptionId)
    && record(subscription) && typeof subscription.url === 'string' && canonicalUrl(subscription.url)
    && (subscription.status === 'pending' || subscription.status === 'active')
    && Object.keys(subscription).every(field => ['url', 'status', 'installationId'].includes(field))
    && typeof subscription.installationId === 'string' && /^installation_[A-Za-z0-9_-]{3,128}$/.test(subscription.installationId))) return false;
  let pending = 0;
  for (const [notificationId, entry] of Object.entries(value.accepted)) {
    if (!wakeIdPattern.test(notificationId) || !record(entry) || typeof entry.pending !== 'boolean' || typeof entry.acknowledged !== 'boolean'
      || typeof entry.receivedAt !== 'number' || !Number.isSafeInteger(entry.receivedAt) || entry.receivedAt < 0
      || typeof entry.expiresAt !== 'number' || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt < entry.receivedAt + 3_900_000
      || !record(entry.notification) || !parseNotification(entry.notification) || entry.notification.id !== notificationId
      || Object.keys(entry).some(field => !['receivedAt', 'expiresAt', 'notification', 'pending', 'acknowledged'].includes(field))) return false;
    const sanitized = parseNotification(entry.notification)!;
    if (Object.entries(entry.notification).some(([field, member]) => !Object.hasOwn(sanitized, field) || sanitized[field as keyof WakeNotification] !== member)
      || Buffer.byteLength(JSON.stringify(sanitized)) > 1024) return false;
    if (entry.pending) pending++;
  }
  return pending <= WAKE_MAX_PENDING && Object.entries(value.endedReasons).every(([installationId, reason]) =>
    /^installation_[A-Za-z0-9_-]{3,128}$/.test(installationId) && typeof reason === 'string'
    && ['superseded', 'replaced', 'challenge_expired', 'ended_by_host', 'revoked_by_owner', 'credential_ended', 'receiver_gone', 'delivery_failed', 'expired', 'feature_disabled'].includes(reason))
    && Buffer.byteLength(JSON.stringify(value)) <= WAKE_MAX_STATE_BYTES;
}

function headersFor(request: WakeRequest): Record<string, string> | undefined {
  const headers: Record<string, string> = Object.create(null);
  let size = 0;
  const entries = Object.entries(request.headers);
  if (entries.length > 64) return undefined;
  for (const [name, value] of entries) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || Object.hasOwn(headers, name.toLowerCase()) || /[\r\n]/.test(value)) return undefined;
    size += name.length + value.length;
    if (size > 8192) return undefined;
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

export class HttpWakeReceiver {
  private readonly registeredUrl: string;
  private readonly store: WakeStore;
  private readonly keys: HttpWakeKeys;
  private readonly now: () => number;
  private inFlight = 0;

  constructor(options: HttpWakeReceiverOptions) {
    if (typeof options.registeredUrl !== 'string' || !canonicalUrl(options.registeredUrl)) throw new Error('Wake receiver requires its registered canonical HTTPS URL');
    if (!options.store || typeof options.store.read !== 'function' || typeof options.store.update !== 'function'
      || (options.now !== undefined && typeof options.now !== 'function')) throw new Error('Invalid wake receiver configuration');
    this.registeredUrl = options.registeredUrl;
    this.store = options.store;
    this.keys = new HttpWakeKeys(options);
    this.now = options.now ?? Date.now;
  }

  async receive(request: WakeRequest): Promise<WakeResponse> {
    const reply = (status: number): WakeResponse => ({ status, headers: {} });
    const headers = headersFor(request);
    const signatureEntries = headers?.['envoi-wake-signature']?.split(' ').filter(entry => entry.startsWith('v1=')) ?? [];
    const signatureText = signatureEntries[0]?.slice(3) ?? '';
    if (request.method !== 'POST' || !(request.body instanceof Uint8Array) || request.body.byteLength > 1024 || !headers
      || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(headers['content-type'] ?? '')
      || !wakeIdPattern.test(headers['envoi-wake-id'] ?? '') || !keyIdPattern.test(headers['envoi-wake-key-id'] ?? '')
      || !/^[1-9][0-9]{0,11}$/.test(headers['envoi-wake-timestamp'] ?? '')
      || !Number.isSafeInteger(Number(headers['envoi-wake-timestamp']))
      || signatureEntries.length !== 1 || !/^[A-Za-z0-9_-]{86}$/.test(signatureText)
      || Buffer.from(signatureText, 'base64url').toString('base64url') !== signatureText) return reply(400);
    if (this.inFlight >= 16) return reply(503);
    const body = Buffer.from(request.body);
    this.inFlight++;
    try {
      const key = await this.keys.get(headers['envoi-wake-key-id']);
      if (!key) return { status: 503, headers: { 'retry-after': '60' } };
      const current = this.now();
      if (!Number.isSafeInteger(current) || current < 0) return reply(503);
      if (key.notAfter !== undefined && key.notAfter <= current) return reply(401);
      if (Math.abs(Number(headers['envoi-wake-timestamp']) * 1000 - current) > 300_000) return reply(400);
      const prefix = `envoi-wake/1\n${headers['envoi-wake-key-id']}\n${headers['envoi-wake-timestamp']}\n${headers['envoi-wake-id']}\n${this.registeredUrl}\n`;
      if (!verify(null, Buffer.concat([Buffer.from(prefix, 'utf8'), body]), key.key, Buffer.from(signatureText, 'base64url'))) return reply(401);
      let decoded: unknown;
      try {
        decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      } catch {
        return reply(400);
      }
      const notification = parseNotification(decoded);
      if (!notification || notification.id !== headers['envoi-wake-id']) return reply(400);
      let response: WakeResponse = reply(503);
      await this.store.update(state => {
        if (!isWakeState(state)) throw new Error('Invalid wake state');
        const subscription = Object.hasOwn(state.subscriptions, notification.subscriptionId) ? state.subscriptions[notification.subscriptionId] : undefined;
        if (!subscription || subscription.url !== this.registeredUrl || state.endedReasons[subscription.installationId] === 'revoked_by_owner') {
          response = reply(notification.type === 'wake.challenge' ? 503 : 400);
          return;
        }
        const acceptedAt = this.now();
        if (!Number.isSafeInteger(acceptedAt) || acceptedAt < current || Math.abs(Number(headers['envoi-wake-timestamp']) * 1000 - acceptedAt) > 300_000) return;
        if (key.notAfter !== undefined && key.notAfter <= acceptedAt) return;
        for (const [notificationId, entry] of Object.entries(state.accepted)) {
          if ((!entry.pending || !entry.acknowledged) && entry.expiresAt <= acceptedAt) delete state.accepted[notificationId];
        }
        if (Object.hasOwn(state.accepted, notification.id)) {
          response = actionable(state.accepted[notification.id].notification) ? { status: 200, headers: {}, acceptedId: notification.id } : reply(200);
          return;
        }
        const pending = actionable(notification);
        if (Object.keys(state.accepted).length >= WAKE_MAX_ACCEPTED
          || (pending && Object.values(state.accepted).filter(entry => entry.pending).length >= WAKE_MAX_PENDING)) return;
        state.accepted[notification.id] = { receivedAt: acceptedAt, expiresAt: acceptedAt + 3_900_000, notification: { ...notification }, pending, acknowledged: false };
        if (Buffer.byteLength(JSON.stringify(state)) > WAKE_MAX_STATE_BYTES) {
          delete state.accepted[notification.id];
          return;
        }
        response = pending ? { status: 200, headers: {}, notification: { ...notification }, acceptedId: notification.id } : reply(200);
      });
      return response;
    } catch {
      return reply(503);
    } finally {
      this.inFlight--;
    }
  }
}
