import { describe, expect, it, vi } from 'vitest';
import { approvedProviderFixture as fixture } from '../contract-fixtures/approved-provider-fixture';
import { McpWakeClient, type EventInput } from './mcp-wake-client';
import { HostRequestError } from './private-host-http';

const origin = 'https://envoi.example';
const token = 'private-token-never-in-tool-result';
function responseFor(row: any, init?: RequestInit) {
  const body = structuredClone(row.response.body);
  if (body.jsonrpc && init?.body) body.id = JSON.parse(String(init.body)).id;
  return new Response(JSON.stringify(body), { status: row.response.status, headers: { 'content-type': 'application/json', ...row.response.headers } });
}
function setup(contract: 'mcp-wake' | 'provider-event-wake', name: string, events = false) {
  const row = fixture(contract, name);
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => responseFor(row, init));
  const client = new McpWakeClient({ origin, accessToken: async () => token, fetch: fetcher as typeof fetch, protocolVersion: events ? '2026-07-28' : '2025-11-25' });
  return { row, fetcher, client };
}

describe('private MCP wake tools consume approved wire fixtures', () => {
  it.each(['create-ok', 'activate-ok', 'end-ok', 'status-active', 'status-ended-by-owner'])('%s', async name => {
    const { row, fetcher, client } = setup('mcp-wake', name);
    const { name: tool, arguments: args } = row.request.body.params;
    const result = tool === 'envoi_wake_create' ? await client.create(args) : tool === 'envoi_wake_activate' ? await client.activate(args) : tool === 'envoi_wake_end' ? await client.end(args) : await client.status();
    expect(JSON.stringify(result)).not.toContain(token);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(`${origin}/mcp`);
    const init = fetcher.mock.calls[0][1]!;
    expect(JSON.parse(String(init.body))).toEqual(row.request.body);
    expect(init.redirect).toBe('error'); expect(init.credentials).toBe('omit');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`);
  });
  it.each(['create-paused', 'create-revoked'])('blocks later calls after %s without a REST fallback', async name => {
    const { row, fetcher, client } = setup('mcp-wake', name);
    await expect(client.create(row.request.body.params.arguments)).rejects.toMatchObject({ code: row.response.body.code });
    expect(client.lifecycle).toBe(row.client.lifecycle);
    await expect(client.status()).rejects.toBeInstanceOf(HostRequestError);
    expect(fetcher).toHaveBeenCalledOnce();
    client.ownerResumed();
    if (name === 'create-revoked') { await expect(client.status()).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' }); expect(fetcher).toHaveBeenCalledOnce(); }
  });
  it('keeps flag-off unavailable and does not retry or invent a REST authority', async () => {
    const { row, fetcher, client } = setup('mcp-wake', 'create-flag-off-unknown-tool');
    await expect(client.create(row.request.body.params.arguments)).rejects.toMatchObject({ code: 'RPC_ERROR' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('refuses extra owner/scope fields before sending', async () => {
    const { client, fetcher } = setup('mcp-wake', 'create-ok');
    await expect(client.create({ url: 'https://hooks.example/envoi', ownerId: 'other' } as any)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects mismatched IDs, response authority injection and raw remote messages', async () => {
    const { row } = setup('mcp-wake', 'create-ok');
    const body = row.response.body;
    body.result.content[0].text = JSON.stringify({ ok: true, tool: 'envoi_wake_create', result: { subscription: { ...JSON.parse(body.result.content[0].text).result.subscription, accessToken: token } } });
    const client = new McpWakeClient({ origin, accessToken: async () => token, fetch: vi.fn(async () => responseFor(row)) as typeof fetch });
    await expect(client.create({ url: 'https://hooks.example/envoi' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const secretError = new McpWakeClient({ origin, accessToken: async () => token, fetch: vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: token } }), { headers: { 'content-type': 'application/json' } })) as typeof fetch });
    await expect(secretError.status()).rejects.toThrow('Envoi host request failed (RPC_ERROR)');
  });
});

describe('protocol-bound private MCP Events', () => {
  it.each(['subscribe-created', 'subscribe-renewed-same-identity', 'subscribe-renewed-secret-rotated', 'subscribe-replay-truncated'])('%s', async name => {
    const { row, fetcher, client } = setup('provider-event-wake', name, true);
    const result = await client.subscribe(row.request.body.params);
    expect(result).toEqual(row.response.body.result);
    const init = fetcher.mock.calls[0][1]!;
    expect(JSON.parse(String(init.body))).toEqual(row.request.body);
    expect(new Headers(init.headers).get('mcp-protocol-version')).toBe('2026-07-28');
    expect(JSON.stringify(result)).not.toContain('whsec_');
  });
  it('discovers exact events capability and unsubscribes without the secret', async () => {
    const discover = setup('provider-event-wake', 'discover-events-capability', true);
    await expect(discover.client.discoverEvents()).resolves.toBe(true);
    const unsub = setup('provider-event-wake', 'unsubscribe-ok', true);
    await expect(unsub.client.unsubscribe(unsub.row.request.body.params)).resolves.toBeUndefined();
    expect(String(unsub.fetcher.mock.calls[0][1]!.body)).not.toContain('whsec_');
  });
  it('cannot call events at the old protocol or include extra capability/secret fields', async () => {
    const { row, client, fetcher } = setup('provider-event-wake', 'subscribe-created');
    await expect(client.subscribe(row.request.body.params)).rejects.toMatchObject({ code: 'EVENTS_PROTOCOL_REQUIRED' });
    expect(fetcher).not.toHaveBeenCalled();
    const newer = setup('provider-event-wake', 'subscribe-created', true);
    await expect(newer.client.subscribe({ ...row.request.body.params, ownerId: 'other' } as EventInput)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(newer.client.unsubscribe({ ...row.request.body.params })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(newer.fetcher).not.toHaveBeenCalled();
  });
  it('cancels oversized streamed responses and returns no body or secret in the error', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel });
    const fetcher = vi.fn(async () => new Response(stream, { headers: { 'content-type': 'application/json' } }));
    const client = new McpWakeClient({ origin, accessToken: async () => token, fetch: fetcher as typeof fetch });
    await expect(client.status()).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' }); expect(cancel).toHaveBeenCalledOnce();
  });
});
