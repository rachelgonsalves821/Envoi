import { describe, expect, it, vi } from 'vitest';
import { SinaloaConnector, type ConnectorSession, type ConnectorStore } from '../../sdk/typescript/src/connector';
import { startMcpRelay } from '../agent-bridges/mcp-relay';
import { authorizedHermesReply, authorizedHermesWrite } from './lease-write';

const relayToken = 'hermes-local-mcp-secret-at-least-32-characters';

describe('Hermes loopback MCP lease fence', () => {
  it('permits an interactive first send, fences automatic replies, and denies stale writes', async () => {
    const session: ConnectorSession = {
      agentId: 'hermes_agent', inboxId: 'inbox_hermes', address: 'hermes@sinaloa.mail', cursor: null,
      agentApiToken: 'access', agentRefreshToken: 'refresh',
      agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
    };
    const store: ConnectorStore = { load: async () => session, save: async () => {} };
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (request.method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        result: { tools: ['sinaloa_agent_info', 'sinaloa_send_message', 'sinaloa_start_case']
          .map(name => ({ name })) } }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ status: 202, payload: { id: 'reply_1' } }) }] } }),
      { headers: { 'content-type': 'application/json' } });
    });
    const active = new AbortController();
    const message = { id: 'msg_1', caseId: 'case_1', senderAgentId: 'peer', recipientAgentId: 'hermes_agent',
      text: 'Request', from: { agentId: 'peer', address: 'peer@sinaloa.mail' } };
    let current: { message: typeof message; signal: AbortSignal } | null = null;
    const recorded: string[] = [];
    const relay = await startMcpRelay({
      connector: new SinaloaConnector('https://sinaloa.example.test', store, { fetch: upstream }),
      bearerToken: relayToken, port: 0, allowCollaborationWrites: true,
      collaborationToolNames: ['sinaloa_start_case', 'sinaloa_send_message', 'sinaloa_send_proposal', 'sinaloa_send_decision'],
      authorizeWrite: (name, args) => authorizedHermesWrite(current, name, args),
      onSuccessfulWrite: async (_name, args) => { recorded.push(String(args.idempotencyKey)); }
    });
    const call = (method: string, name?: string, key = 'bridge:msg_1:reply:1', id = 1) => fetch(relay.url, { method: 'POST',
      headers: { authorization: `Bearer ${relayToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method,
        ...(name ? { params: { name, arguments: { recipientAddress: 'peer@sinaloa.mail',
          caseId: 'case_1', text: 'Reply', idempotencyKey: key } } } : {}) }) });
    try {
      const catalog = await call('tools/list');
      expect((await catalog.json()).result.tools.map((tool: { name: string }) => tool.name))
        .toEqual(['sinaloa_agent_info', 'sinaloa_send_message', 'sinaloa_start_case']);
      expect((await call('tools/call', 'sinaloa_start_case', 'interactive:first-case')).status).toBe(200);
      expect((await call('tools/call', 'sinaloa_send_message', 'interactive:follow-up')).status).toBe(200);
      expect((await call('tools/call', 'sinaloa_send_message')).status).toBe(403);
      current = { message, signal: active.signal };
      expect((await call('tools/call', 'sinaloa_start_case', 'interactive:second-case')).status).toBe(403);
      expect((await call('tools/call', 'sinaloa_send_message', 'interactive:follow-up')).status).toBe(403);
      expect((await call('tools/call', 'sinaloa_send_message')).status).toBe(200);
      expect(recorded).toEqual(['interactive:first-case', 'interactive:follow-up', 'bridge:msg_1:reply:1']);
      expect(authorizedHermesReply(current, 'sinaloa_send_message', { idempotencyKey: 'bridge:msg_1:reply:1',
        caseId: 'case_2', recipientAddress: 'peer@sinaloa.mail' })).toBe(false);
      expect(authorizedHermesReply(current, 'sinaloa_send_message', { idempotencyKey: 'bridge:msg_1:reply:1',
        caseId: 'case_1', recipientAddress: 'other@sinaloa.mail' })).toBe(false);
      active.abort();
      expect((await call('tools/call', 'sinaloa_send_message')).status).toBe(403);
      current = null;
      expect((await call('tools/call', 'sinaloa_send_message')).status).toBe(403);
      expect(upstream).toHaveBeenCalledTimes(4);
    } finally { await relay.close(); }
  });
});
