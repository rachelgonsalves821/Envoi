import { describe, expect, it, vi } from 'vitest';
import { SinaloaConnector, type ConnectorSession, type ConnectorStore } from '../../sdk/typescript/src/connector';
import { probeOpenClawMcp } from './mcp-smoke';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const relayToken = 'gateway-probe-relay-token-at-least-32-chars';

describe('OpenClaw hosted MCP invocation probe', () => {
  it('requires a successful relay-observed tool call, not only a plausible Gateway answer', async () => {
    const session: ConnectorSession = {
      agentId: 'agent_probe', inboxId: 'inbox_probe', address: 'probe@sinaloa.mail', cursor: null,
      agentApiToken: 'access-token', agentRefreshToken: 'private-refresh',
      agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
    };
    const store: ConnectorStore = { load: async () => session, save: async () => {} };
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-token');
      const request = JSON.parse(String(init?.body));
      return json({ jsonrpc: '2.0', id: request.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ address: session.address }) }] } });
    });
    const connector = new SinaloaConnector('https://sinaloa.example.test', store, { fetch: upstream });
    const options = { connector, expectedAddress: session.address,
      gatewayUrl: 'http://127.0.0.1:18789', gatewayToken: 'private-gateway-token',
      agentId: 'sinaloa-agent', relayToken, relayPort: 0 };
    const answer = (content: string) => json({ choices: [{ finish_reason: 'stop', message: { content } }] });

    await expect(probeOpenClawMcp({ ...options, dispatchGateway: async (_url, init, relayUrl) => {
      const request = JSON.parse(String(init.body));
      expect(request.model).toBe('openclaw/sinaloa-agent');
      expect(JSON.stringify(request)).not.toContain('private-refresh');
      const tool = await fetch(relayUrl, { method: 'POST', headers: {
        authorization: `Bearer ${relayToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'sinaloa_agent_info', arguments: {} } }) });
      const payload = await tool.json();
      return answer(JSON.parse(payload.result.content[0].text).address);
    } })).resolves.toBeUndefined();
    expect(upstream).toHaveBeenCalledTimes(1);

    await expect(probeOpenClawMcp({ ...options,
      dispatchGateway: async () => answer(session.address) }))
      .rejects.toThrow('no successful Envoi MCP invocation');
  });
});
