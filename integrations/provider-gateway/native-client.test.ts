import { describe, expect, it, vi } from 'vitest';
import { approvedProviderFixture as fixture } from '../contract-fixtures/approved-provider-fixture';
import { NativeGatewayClient } from './native-client';

function setup(name: string) {
  const row = fixture('provider-gateway-native', name);
  const fetcher = vi.fn(async () => new Response(JSON.stringify(row.response.body), { status: row.response.status, headers: { 'content-type': 'application/json' } }));
  const client = new NativeGatewayClient({ origin: 'https://www.envoi-agents.com', csrf: async () => 'private-csrf', fetch: fetcher as typeof fetch });
  return { row, client, fetcher };
}
describe('native work private host client', () => {
  it.each(['claim-work', 'claim-idle', 'claim-lost-response-replay', 'claim-lost-response-after-restart', 'claim-summary-truncated-on-code-point', 'claim-run-budget-reached'])('%s', async name => {
    const { row, fetcher, client } = setup(name);
    await expect(client.claim(row.request.body)).resolves.toEqual(row.response.body);
    const init = fetcher.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual(row.request.body);
    expect(init.credentials).toBe('same-origin'); expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('x-envoi-gateway-csrf')).toBe('private-csrf');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });
  it.each(['reply-sent', 'reply-replayed-same-key', 'reply-replay-after-run-expiry', 'request-owner', 'defer-releases-lease', 'reply-text-multibyte-at-byte-limit'])('%s', async name => {
    const { row, fetcher, client } = setup(name);
    await expect(client.act(row.request.body)).resolves.toEqual(row.response.body);
    expect(JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body))).toEqual(row.request.body);
  });
  it('renews only an explicit claimed work and validates the exhausted renewal result', async () => {
    const { row, client } = setup('renew-once');
    await expect(client.renew(row.request.body)).resolves.toEqual(row.response.body);
  });
  it('accepts server-bounded Unicode code points while retaining the separate UTF-8 summary cap', async () => {
    const test = setup('claim-work');
    const snapshot = test.row.response.body.packet.snapshot;
    snapshot.objective = '😀'.repeat(500);
    snapshot.participants[0].displayName = '😀'.repeat(80);
    snapshot.recentEvents[0].summary = '😀'.repeat(512);
    await expect(test.client.claim(test.row.request.body)).resolves.toMatchObject({ state: 'work' });
    snapshot.objective += '😀';
    await expect(test.client.claim(test.row.request.body)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('accepts an 80-code-point idempotency key, matching the native server schema', async () => {
    const test = setup('reply-sent'); test.row.request.body.idempotencyKey = '😀'.repeat(80);
    await expect(test.client.act(test.row.request.body)).resolves.toMatchObject({ state: 'sent' });
    test.row.request.body.idempotencyKey += '😀';
    await expect(test.client.act(test.row.request.body)).rejects.toThrow('Invalid native action');
  });
  it.each(['reply-text-multibyte-over-byte-limit', 'reply-text-one-byte-over-limit'])('rejects %s before transport', async name => {
    const { row, client, fetcher } = setup(name);
    await expect(client.act(row.request.body)).rejects.toThrow('4096 UTF-8 bytes'); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['claim-paused', 'claim-revoked', 'claim-session-expired'])('stops later work after %s', async name => {
    const { row, client, fetcher } = setup(name);
    await expect(client.claim(row.request.body)).rejects.toMatchObject({ code: row.response.body.code });
    expect(client.lifecycle).toBe(row.client.lifecycle);
    await expect(client.claim(row.request.body)).rejects.toBeInstanceOf(Error); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects an authority field and an over-byte snapshot, preserving the untrusted boundary', async () => {
    const scenario = setup('claim-work');
    await expect(scenario.client.claim({ ...scenario.row.request.body, ownerId: 'other' } as any)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    scenario.row.response.body.packet.snapshot.recentEvents[0].summary = '😀'.repeat(513);
    await expect(scenario.client.claim(scenario.row.request.body)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    scenario.row.response.body.packet.snapshot.recentEvents[0].summary = 'safe';
    scenario.row.response.body.packet.leaseToken = 'must-not-reach-the-model';
    await expect(scenario.client.claim(scenario.row.request.body)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('retries uncertain actions only when the caller repeats the persisted input', async () => {
    const row = fixture('provider-gateway-native', 'reply-replayed-same-key');
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('network with private information')).mockResolvedValueOnce(new Response(JSON.stringify(row.response.body), { headers: { 'content-type': 'application/json' } }));
    const client = new NativeGatewayClient({ origin: 'https://www.envoi-agents.com', csrf: async () => 'private-csrf', fetch: fetcher });
    await expect(client.act(row.request.body)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(client.act(row.request.body)).resolves.toMatchObject({ replayed: true });
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
  });
});
