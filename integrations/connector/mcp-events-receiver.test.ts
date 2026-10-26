import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { approvedProviderFixture as fixture } from '../contract-fixtures/approved-provider-fixture';
import { McpEventsReceiver, type McpEventHint } from './mcp-events-receiver';

const secret = fixture('provider-event-wake', 'subscribe-created').request.body.params.delivery.secret;
const subscriptionId = 'evtsub_0f3a9c2e51b84d7aa6c1';
function setup(name = 'delivery-work-available') {
  const row = fixture('provider-event-wake', name);
  const ids = new Set<string>();
  const accept = vi.fn(async (_subscription: string, event: McpEventHint) => {
    if (ids.has(event.eventId)) return 'duplicate' as const;
    ids.add(event.eventId); return 'accepted' as const;
  });
  const receiver = new McpEventsReceiver({ subscriptionId, secrets: [secret], inbox: { accept }, now: () => Date.parse(row.delivery.receiver.asOf) });
  const request = { method: 'POST', headers: row.delivery.request.headers, body: Buffer.from(row.delivery.request.bodyText) };
  return { receiver, request, row, accept };
}
describe('MCP events receiver consumes signed canonical bytes', () => {
  it.each(['verification-request', 'delivery-work-available', 'delivery-control-changed', 'delivery-clock-edge-300s-accepted', 'delivery-clock-edge-301s-rejected', 'delivery-future-timestamp-rejected', 'delivery-replayed-stale'])('%s', async name => {
    const { receiver, request, row, accept } = setup(name);
    const result = await receiver.receive(request);
    expect(result.status).toBe(row.delivery.response.status);
    if (name === 'verification-request') { expect(result.body).toEqual(row.delivery.response.body); expect(accept).not.toHaveBeenCalled(); }
    if (result.status >= 400) expect(accept).not.toHaveBeenCalled();
  });
  it('receipts duplicates without executing model work or losing the pending item', async () => {
    const { receiver, request, accept } = setup();
    await expect(receiver.receive(request)).resolves.toEqual({ status: 202 });
    await expect(receiver.receive(request)).resolves.toEqual({ status: 202 });
    expect(accept).toHaveBeenCalledTimes(2); expect(accept.mock.results).toHaveLength(2);
    expect(accept.mock.calls[0][1].cursor).toBe('00000000000000000105');
  });
  it('binds subscription identity and raw bytes before writing', async () => {
    const { receiver, request, accept } = setup();
    await expect(receiver.receive({ ...request, headers: { ...request.headers, 'x-mcp-subscription-id': 'evtsub_ffffffffffffffffffff' } })).resolves.toEqual({ status: 401 });
    await expect(receiver.receive({ ...request, body: Buffer.concat([request.body, Buffer.from(' ')]) })).resolves.toEqual({ status: 401 });
    expect(accept).not.toHaveBeenCalled();
  });
  it('retries durable-write failure and capacity exhaustion, and rejects closed-body authority injection', async () => {
    const { request, row } = setup();
    const receiver = new McpEventsReceiver({ subscriptionId, secrets: [secret], inbox: { accept: async () => 'full' }, now: () => Date.parse(row.delivery.receiver.asOf) });
    await expect(receiver.receive(request)).resolves.toEqual({ status: 503 });
    const modified = { ...JSON.parse(request.body.toString()), accessToken: 'must-not-be-accepted' };
    const body = Buffer.from(JSON.stringify(modified));
    const signature = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${request.headers['webhook-id']}.${request.headers['webhook-timestamp']}.`).update(body).digest('base64');
    await expect(receiver.receive({ ...request, body, headers: { ...request.headers, 'webhook-signature': `v1,${signature}` } })).resolves.toEqual({ status: 400 });
  });
  it('accepts bounded dual signatures and forgets keys on revoke', async () => {
    const { receiver, request } = setup();
    request.headers['webhook-signature'] = `v1,${Buffer.alloc(32).toString('base64')} ${request.headers['webhook-signature']}`;
    await expect(receiver.receive(request)).resolves.toEqual({ status: 202 });
    receiver.destroy(); await expect(receiver.receive(request)).resolves.toEqual({ status: 401 });
  });
  it('verifies the same canonical wire signature with unpadded private secret storage', async () => {
    const { request, row, accept } = setup();
    const receiver = new McpEventsReceiver({ subscriptionId, secrets: [secret.replace(/=+$/, '')], inbox: { accept }, now: () => Date.parse(row.delivery.receiver.asOf) });
    await expect(receiver.receive(request)).resolves.toEqual({ status: 202 });
    expect(accept).toHaveBeenCalledOnce();
  });
});
