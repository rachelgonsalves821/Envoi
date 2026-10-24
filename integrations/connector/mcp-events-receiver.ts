import { createHmac, timingSafeEqual } from 'node:crypto';
import { closed, dateTime, matches, valid } from './private-host-http';
import type { EventName } from './mcp-wake-client';

export interface McpEventHint { eventId: string; name: EventName; timestamp: string; data: { reason: string }; cursor: string | null }
export interface McpEventInbox {
  /** Atomic durable insert-if-absent, scoped by subscription AND event ID. Never evict unprocessed hints. */
  accept(subscriptionId: string, event: McpEventHint, receivedAt: number): Promise<'accepted' | 'duplicate' | 'full'>;
}
export interface EventReceiverResponse { status: number; body?: { challenge: string } }

/** Signature receipt only. A separate host drains durable hints and performs canonical claim/delta catch-up. */
export class McpEventsReceiver {
  #keys: Buffer[];
  #subscriptionId: string;
  #inbox: McpEventInbox;
  #now: () => number;
  constructor(options: { subscriptionId: string; secrets: string[]; inbox: McpEventInbox; now?: () => number }) {
    if (!/^evtsub_[0-9a-f]{20}$/.test(options.subscriptionId) || options.secrets.length < 1 || options.secrets.length > 2) throw new TypeError('Invalid private event receiver binding');
    this.#keys = options.secrets.map(secret => {
      if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new TypeError('Invalid private webhook secret');
      const encoded = secret.slice(6), key = Buffer.from(encoded, 'base64');
      if (key.length < 24 || key.length > 64 || key.toString('base64') !== encoded) throw new TypeError('Invalid private webhook secret');
      return key;
    });
    this.#subscriptionId = options.subscriptionId; this.#inbox = options.inbox; this.#now = options.now ?? Date.now;
  }
  /** Adapter must reject duplicate headers and stop reading after 1024 bytes before invoking this method. */
  async receive(input: { method: string; headers: Record<string, string | undefined>; body: Uint8Array }): Promise<EventReceiverResponse> {
    if (input.method !== 'POST') return { status: 405 };
    if (input.body.length > 1024) return { status: 413 };
    const { headers } = input;
    if (!/^application\/json(?:;|$)/i.test(headers['content-type'] ?? '')) return { status: 415 };
    const id = headers['webhook-id'], timestamp = headers['webhook-timestamp'], signatures = headers['webhook-signature'];
    if (!id || !/^wake_evt_[A-Za-z0-9_-]{1,80}$/.test(id) || !timestamp || !/^\d{10}$/.test(timestamp)
      || !signatures || signatures.length > 1024 || headers['x-mcp-subscription-id'] !== this.#subscriptionId) return { status: 401 };
    const seconds = Number(timestamp), now = this.#now();
    if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(now / 1000) - seconds) > 300) return { status: 401 };
    const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`), input.body]);
    let authenticated = false;
    for (const key of this.#keys) {
      const expected = createHmac('sha256', key).update(signed).digest();
      for (const part of signatures.split(' ')) {
        if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(part)) continue;
        const supplied = Buffer.from(part.slice(3), 'base64');
        if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) authenticated = true;
      }
    }
    if (!authenticated) return { status: 401 };
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.body));
      if (value && typeof value === 'object' && 'type' in value) {
        closed(value, ['type', 'challenge']);
        const verification = value as Record<string, unknown>;
        valid(verification.type === 'verification' && matches(verification.challenge, /^envoi_wake_challenge_[A-Za-z0-9_-]{1,128}$/));
        return { status: 200, body: { challenge: verification.challenge } };
      }
      closed(value, ['eventId', 'name', 'timestamp', 'data', 'cursor']);
      valid(value.eventId === id && ['envoi.work_available', 'envoi.control_changed'].includes(value.name as string) && dateTime(value.timestamp));
      closed(value.data, ['reason']);
      valid(matches(value.data.reason, /^[a-z_]{1,80}$/) && (value.cursor === null || matches(value.cursor, /^[0-9]{20}$/)));
    } catch { return { status: 400 }; }
    try {
      const result = await this.#inbox.accept(this.#subscriptionId, value as unknown as McpEventHint, now);
      return { status: result === 'full' ? 503 : 202 };
    } catch { return { status: 503 }; }
  }
  /** Owner unsubscription/revoke cleanup; discard supplied-secret custody immediately. */
  destroy() { for (const key of this.#keys) key.fill(0); this.#keys = []; }
}
