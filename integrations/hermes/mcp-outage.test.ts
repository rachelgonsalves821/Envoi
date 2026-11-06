import { describe, expect, it, vi } from 'vitest';
import { EnvoiConnector, type ConnectorSession } from '../../sdk/typescript/src/connector';
import { startMcpRelay } from '../agent-bridges/mcp-relay';
import { EnvoiError } from '../../sdk/typescript/src/index';
import pausedMcp from '../../test/contract-fixtures/a3-pause-auth/agent-paused-mcp.json';

const bearer = 'private-local-test-relay-bearer-32-characters';
async function fixture(allowWrites = false) {
  let session: ConnectorSession = { agentId: 'agent_one', inboxId: 'inbox_one', address: 'one@envoi.test', cursor: null,
    agentApiToken: 'private-access', agentRefreshToken: 'private-refresh',
    agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  let offline = false;
  let denial: { status: number; body: Record<string, unknown> } | undefined;
  const upstream = vi.fn<typeof fetch>(async (_url, init) => {
    if (offline) throw new TypeError('private upstream diagnostic');
    if (denial) return Response.json(denial.body, { status: denial.status, headers: { 'retry-after': '7' } });
    const request = JSON.parse(String(init?.body));
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'initialize'
      ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'Envoi', version: '1' } }
      : request.method === 'tools/list' ? { tools: [{ name: 'envoi_agent_info' }, { name: 'envoi_send_message' }, { name: 'not_allowed' }] }
      : { content: [{ type: 'text', text: 'actual upstream result' }] } });
  });
  const connector = new EnvoiConnector('https://envoi.test', {
    load: async () => structuredClone(session), save: async value => { session = structuredClone(value); }
  }, { fetch: upstream });
  const success = vi.fn();
  const relay = await startMcpRelay({ connector, bearerToken: bearer, port: 0, onSuccessfulToolCall: success,
    allowCollaborationWrites: allowWrites });
  const call = (method: string, id = 1, params?: unknown) => fetch(relay.url, { method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', ...(method.startsWith('notifications/') ? {} : { id }), method,
      params: params ?? (method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Hermes', version: '1' } } : {}) }) });
  return { relay, connector, upstream, success, call, setOffline: () => { offline = true; }, setOnline: () => { offline = false; },
    deny: (status: number, code: string) => { denial = { status, body: { error: code, code, message: 'Denied', requestId: 'request_test' } }; },
    clearDenial: () => { denial = undefined; }, session: () => session, replace: (value: ConnectorSession) => { session = value; } };
}

describe('Hermes relay outage isolation', () => {
  it('keeps proven initialize, ping and filtered discovery local during a network outage', async () => {
    const f = await fixture();
    try {
      expect((await f.call('initialize')).status).toBe(200);
      expect((await f.call('tools/list')).status).toBe(200);
      const requests = f.upstream.mock.calls.length;
      f.setOffline();
      expect((await f.call('initialize', 21)).status).toBe(200);
      expect((await f.call('ping', 22)).status).toBe(200);
      expect((await f.call('notifications/initialized')).status).toBe(202);
      const catalog = await f.call('tools/list', 23);
      expect(catalog.status).toBe(200);
      expect(await catalog.json()).toEqual({ jsonrpc: '2.0', id: 23, result: { tools: [{ name: 'envoi_agent_info' }] } });
      expect(f.upstream).toHaveBeenCalledTimes(requests);
      const error = await f.call('tools/call', 24, { name: 'envoi_agent_info', arguments: {} });
      expect(error.status).toBe(200);
      const body = await error.json();
      expect(body).toMatchObject({ jsonrpc: '2.0', id: 24, result: { isError: true } });
      expect(JSON.stringify(body)).not.toMatch(/private-access|private-refresh|private upstream/);
      expect(f.success).not.toHaveBeenCalled();
      expect((await f.call('ping', 25)).status).toBe(200);
      f.setOnline();
      const recovered = await f.call('tools/call', 26, { name: 'envoi_agent_info', arguments: {} });
      expect((await recovered.json()).result.content[0].text).toBe('actual upstream result');
      expect(f.success).toHaveBeenCalledOnce();
    } finally { await f.relay.close(); }
  });

  it.each([[409, 'AGENT_PAUSED'], [401, 'CREDENTIAL_REVOKED'], [401, 'ROTATION_ID_REQUIRED'], [403, 'INSUFFICIENT_SCOPE'], [429, 'RATE_LIMITED']] as const)
    ('preserves upstream %s %s instead of masking it as HTTP502', async (status, code) => {
      const f = await fixture();
      try {
        f.deny(status, code);
        const response = await f.call('tools/call', 1, { name: 'envoi_agent_info', arguments: {} });
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ code, requestId: 'request_test' });
        if (status === 429) expect(response.headers.get('retry-after')).toBe('7');
        if (status === 401) expect((await f.call('ping', 2)).status).toBe(401);
        expect(f.success).not.toHaveBeenCalled();
      } finally { await f.relay.close(); }
    });

  it('consumes the approved paused-MCP vector and blocks cached health until resume', async () => {
    const f = await fixture();
    try {
      await f.call('initialize'); await f.call('tools/list');
      await f.connector.observeError(new EnvoiError(pausedMcp.response.body.message, pausedMcp.response.status, pausedMcp.response.body.code));
      for (const method of ['initialize', 'ping', 'tools/list']) {
        const response = await f.call(method);
        expect(response.status).toBe(pausedMcp.response.status);
        expect((await response.json()).code).toBe(pausedMcp.response.body.code);
      }
      const before = f.upstream.mock.calls.length;
      await f.connector.observeEvent({ type: 'agent.resumed', agentId: 'agent_one' });
      expect((await f.call('initialize')).status).toBe(200);
      expect(f.upstream.mock.calls.length).toBeGreaterThan(before);
    } finally { await f.relay.close(); }
  });

  it('does not invent a handshake or catalog when first started offline', async () => {
    const f = await fixture();
    try {
      f.setOffline();
      for (const method of ['initialize', 'tools/list', 'ping']) {
        const response = await f.call(method);
        expect(response.status).toBe(503);
        expect((await response.json()).code).toBe('NETWORK_ERROR');
      }
    } finally { await f.relay.close(); }
  });

  it('preserves a proven cache across ordinary token rotation but not identity replacement', async () => {
    const f = await fixture();
    try {
      await f.call('initialize'); await f.call('tools/list');
      f.replace({ ...f.session(), agentApiToken: 'rotated-access' });
      f.setOffline();
      expect((await f.call('tools/list')).status).toBe(200);
      f.replace({ ...f.session(), agentId: 'replacement-agent' });
      expect((await f.call('tools/list')).status).toBe(503);
      expect((await f.call('ping')).status).toBe(503);
    } finally { await f.relay.close(); }
  });

  it('refreshes catalog metadata, falls back only for transient outages, and clears on a permission denial', async () => {
    const f = await fixture();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now');
    try {
      await f.call('initialize'); await f.call('tools/list');
      clock.mockReturnValue(now + 61_000);
      f.setOffline();
      expect((await f.call('tools/list', 31)).status).toBe(200);
      expect((await f.call('ping', 32)).status).toBe(200);
      clock.mockReturnValue(now + 122_000);
      f.setOnline(); f.deny(403, 'INSUFFICIENT_SCOPE');
      const denied = await f.call('tools/list', 33);
      expect(denied.status).toBe(403);
      f.setOffline();
      expect((await f.call('tools/list', 34)).status).toBe(503);
    } finally { clock.mockRestore(); await f.relay.close(); }
  });

  it('returns a tool error for an upstream 503 and never confirms or retries a write', async () => {
    const f = await fixture(true);
    try {
      await f.call('initialize'); await f.call('tools/list');
      f.deny(503, 'AUTH_UNAVAILABLE');
      const before = f.upstream.mock.calls.length;
      const response = await f.call('tools/call', 41, { name: 'envoi_send_message', arguments: { idempotencyKey: 'stable-write-1' } });
      expect(response.status).toBe(200);
      expect((await response.json()).result.isError).toBe(true);
      expect(f.upstream).toHaveBeenCalledTimes(before + 1);
      expect(f.success).not.toHaveBeenCalled();
      expect((await f.call('ping', 42)).status).toBe(200);
    } finally { await f.relay.close(); }
  });

  it('keeps refresh-then-retry behavior before passing a real MCP response through', async () => {
    const f = await fixture();
    try {
      f.upstream.mockImplementationOnce(async () => Response.json({ code: 'ACCESS_TOKEN_EXPIRED', error: 'ACCESS_TOKEN_EXPIRED' }, { status: 401 }))
        .mockImplementationOnce(async () => Response.json({ agentApiToken: 'fresh-access', agentRefreshToken: 'fresh-refresh',
          agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() }));
      const response = await f.call('tools/call', 61, { name: 'envoi_agent_info', arguments: {} });
      expect(response.status).toBe(200);
      expect(f.session().agentApiToken).toBe('fresh-access');
      expect(f.upstream).toHaveBeenCalledTimes(3);
      expect(f.success).toHaveBeenCalledOnce();
    } finally { await f.relay.close(); }
  });

  it('reports a refresh revocation instead of reusing the earlier expired-token response', async () => {
    const f = await fixture();
    try {
      f.upstream.mockImplementationOnce(async () => Response.json({ code: 'ACCESS_TOKEN_EXPIRED', error: 'ACCESS_TOKEN_EXPIRED', requestId: 'old_expired' }, { status: 401 }))
        .mockImplementationOnce(async () => Response.json({ code: 'CREDENTIAL_REVOKED', error: 'CREDENTIAL_REVOKED', requestId: 'new_revocation' }, { status: 401 }));
      const response = await f.call('tools/call', 62, { name: 'envoi_agent_info', arguments: {} });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'CREDENTIAL_REVOKED' });
      expect(f.success).not.toHaveBeenCalled();
      expect((await f.call('ping', 63)).status).toBe(401);
    } finally { await f.relay.close(); }
  });

  it('does not downgrade a concurrent pause to a transient tool error', async () => {
    const f = await fixture();
    try {
      await f.call('initialize'); await f.call('tools/list');
      f.upstream.mockImplementationOnce(async () => {
        await f.connector.observeError(new EnvoiError('Paused', 409, 'AGENT_PAUSED'));
        throw new TypeError('network changed during pause');
      });
      const response = await f.call('tools/call', 64, { name: 'envoi_agent_info', arguments: {} });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe('AGENT_PAUSED');
      expect((await f.call('ping', 65)).status).toBe(409);
    } finally { await f.relay.close(); }
  });

  it('does not use cache for an unproven protocol or bypass the local bearer/origin checks', async () => {
    const f = await fixture();
    try {
      await f.call('initialize'); await f.call('tools/list'); f.setOffline();
      const headers = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };
      const body = JSON.stringify({ jsonrpc: '2.0', id: 51, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
      expect((await fetch(f.relay.url, { method: 'POST', headers, body })).status).toBe(503);
      expect((await fetch(f.relay.url, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' }, body })).status).toBe(401);
      expect((await fetch(f.relay.url, { method: 'POST', headers: { ...headers, origin: 'https://outside.test' }, body })).status).toBe(403);
    } finally { await f.relay.close(); }
  });
});
