import { describe, expect, it, vi } from 'vitest';
import { SinaloaConnector, type ConnectorSession, type ConnectorStore } from '../../sdk/typescript/src/connector';
import { startOpenClawMcpRelay } from '../openclaw/mcp-relay';
import { probeXaiMcp } from './mcp-smoke';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('xAI MCP invocation smoke path', () => {
  it('requires an actual successful MCP call and an address read from it', async () => {
    const session: ConnectorSession = {
      agentId: 'agent_one', inboxId: 'inbox_one', address: 'one@sinaloa.example', cursor: null,
      agentApiToken: 'short-lived-access-token-at-least-32-char', agentRefreshToken: 'local-only-refresh',
      agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
    };
    const store: ConnectorStore = { load: async () => session, save: async () => {} };
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${session.agentApiToken}`);
      const request = JSON.parse(String(init?.body));
      return json({ jsonrpc: '2.0', id: request.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ address: session.address }) }] } });
    });
    const connector = new SinaloaConnector('https://sinaloa.example.test', store, { fetch: upstream });
    const relayToken = session.agentApiToken;
    const relay = await startOpenClawMcpRelay({ connector, bearerToken: relayToken, port: 0 });
    const provider = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request.tools[0].authorization).toBe(`Bearer ${session.agentApiToken}`);
      expect(request.tools[0].allowed_tools).toEqual(['sinaloa_agent_info']);
      expect(JSON.stringify(request)).not.toContain('local-only-refresh');
      const call = await fetch(request.tools[0].server_url, {
        method: 'POST',
        headers: { authorization: request.tools[0].authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'sinaloa_agent_info', arguments: {} } })
      });
      const payload = await call.json();
      const address = JSON.parse(payload.result.content[0].text).address;
      return json({ status: 'completed', output: [
        { type: 'mcp_call', name: 'sinaloa.sinaloa_agent_info', server_label: 'sinaloa', status: 'completed' },
        { type: 'message', content: [{ type: 'output_text', text: address }] }
      ] });
    });
    try {
      await expect(probeXaiMcp({ apiKey: 'xai-test-key', model: 'grok-test',
        mcpUrl: relay.url, accessToken: session.agentApiToken, expectedAddress: session.address,
        fetch: provider, endpoint: 'http://127.0.0.1:8788/v1/responses' })).resolves.toBeUndefined();
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(provider).toHaveBeenCalledTimes(1);
      await expect(probeXaiMcp({ apiKey: 'xai-test-key', model: 'grok-test',
        mcpUrl: relay.url, accessToken: session.agentApiToken, expectedAddress: session.address,
        fetch: async () => json({ status: 'completed', output: [
          { type: 'message', content: [{ type: 'output_text', text: session.address }] }
        ] }), endpoint: 'http://127.0.0.1:8788/v1/responses' }))
        .rejects.toThrow('no successful sinaloa_agent_info MCP call');
      await expect(probeXaiMcp({ apiKey: 'xai-test-key', model: 'grok-test',
        mcpUrl: relay.url, accessToken: session.agentApiToken, expectedAddress: session.address,
        fetch: async () => json({ status: 'completed', output: [
          { type: 'mcp_call', name: 'sinaloa_agent_info', server_label: 'sinaloa', status: 'failed', error: 'upstream unavailable' },
          { type: 'message', content: [{ type: 'output_text', text: session.address }] }
        ] }), endpoint: 'http://127.0.0.1:8788/v1/responses' }))
        .rejects.toThrow('no successful sinaloa_agent_info MCP call');
    } finally { await relay.close(); }
  });
});
