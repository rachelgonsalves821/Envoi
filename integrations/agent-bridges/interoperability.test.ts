import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SinaloaConnector, type ConnectorSession, type WorkMessage } from '../../sdk/typescript/src/connector';
import { putSignedAsset } from '../../sdk/typescript/src/index';
import { openClawTurn } from '../openclaw/turn';
import { bridgeHandler } from './bridge';
import { FileBridgeStore } from './file-store';
import { xaiTurn } from './providers';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const workMessage = (id: string, caseId: string, intent = 'request'): WorkMessage => ({
  id, caseId, intent, text: `Unsolicited work ${id}`,
  status: 'delivered', senderAgentId: 'agent_sender', recipientAgentId: 'agent_bridge',
  from: { agentId: 'agent_sender', address: 'sender@sinaloa.mail' }
});

class MockHost {
  readonly messages: WorkMessage[] = [];
  readonly replies = new Map<string, Record<string, unknown>>();
  readonly providerCalls: string[] = [];
  readonly xaiMcpTools: Array<Record<string, unknown>> = [];
  readonly mcpReadTokens: Array<{ token: string; caseId: string | null }> = [];
  readonly calls: Array<{ method: string; path: string; token: string | null }> = [];
  readonly signedBytes = new Map<string, Uint8Array>();
  readonly objects = new Map<string, Record<string, unknown>>();
  accessToken = 'access_before_rotation';
  refreshToken = 'refresh_before_rotation';
  revoked = false;
  rotationCount = 0;
  failCompletionOnceFor: string | null = null;
  private readonly claims = new Map<string, { leaseToken: string; state: 'claimed' | 'acknowledged' | 'retryable' | 'processed'; attempt: number }>();
  private readonly sentByKey = new Map<string, Record<string, unknown>>();
  private readonly uploadsByKey = new Map<string, Record<string, unknown>>();

  queue(message: WorkMessage) { this.messages.push(message); }

  fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = init.method || 'GET';
    const headers = new Headers(init.headers);
    const token = headers.get('authorization')?.replace(/^Bearer /, '') || null;
    this.calls.push({ method, path: url.pathname, token });
    if (url.hostname === 'gateway.example.test') {
      const request = JSON.parse(String(init.body));
      const prompt = String(request.messages[0].content);
      const messageId = prompt.includes('msg_a') ? 'msg_a' : 'msg_b';
      this.providerCalls.push(`openclaw:${messageId}`);
      const answer = messageId === 'msg_a'
        ? { text: 'Proposal for A', intent: 'offer', proposal: { value: 'A' } }
        : { text: 'Decision for B', intent: 'accept', decision: { proposalMessageId: 'msg_prior_b' } };
      return json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] });
    }
    if (url.hostname === 'api.x.ai') {
      const request = JSON.parse(String(init.body));
      if (request.tools?.[0]) this.xaiMcpTools.push(request.tools[0]);
      const prompt = String(request.input);
      const messageId = prompt.includes('msg_a') ? 'msg_a' : 'msg_b';
      this.providerCalls.push(`xai:${messageId}`);
      const answer = messageId === 'msg_a'
        ? { text: 'Grok proposal for A', intent: 'offer', proposal: { value: 'A' } }
        : { text: 'Grok decision for B', intent: 'accept', decision: { proposalMessageId: 'msg_prior_b' } };
      return json({ status: 'completed', output: [
        { type: 'mcp_call', name: 'sinaloa.sinaloa_read_case', server_label: 'sinaloa', status: 'completed' },
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }
      ] });
    }
    if (url.hostname === 'signed.example.test') {
      const assetId = url.pathname.slice(1);
      if (method === 'PUT') {
        this.signedBytes.set(assetId, new Uint8Array(init.body as Uint8Array));
        return new Response(null, { status: 204 });
      }
      const bytes = this.signedBytes.get(assetId);
      return bytes ? new Response(bytes as BodyInit, { status: 200 }) : json({ error: 'Missing asset' }, 404);
    }
    if (url.hostname !== 'sinaloa.example.test') throw new Error('Unexpected network target');
    if (url.pathname === '/api/agent-token') {
      const body = JSON.parse(String(init.body));
      if (this.revoked || body.agentRefreshToken !== this.refreshToken) return json({ error: 'Invalid refresh token' }, 401);
      this.rotationCount += 1;
      this.accessToken = `access_after_rotation_${this.rotationCount}`;
      this.refreshToken = `refresh_after_rotation_${this.rotationCount}`;
      return json({ agentApiToken: this.accessToken, agentRefreshToken: this.refreshToken, agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    }
    if (this.revoked || token !== this.accessToken) return json({ error: 'Agent credential is revoked or expired' }, 401);
    if (url.pathname === '/api/agent/mcp-read-token' && method === 'POST') {
      const caseId = JSON.parse(String(init.body)).caseId || null;
      const issued = `mcp-read-${this.mcpReadTokens.length + 1}`;
      this.mcpReadTokens.push({ token: issued, caseId });
      return json({ mcpAccessToken: issued, tokenType: 'Bearer', scope: 'case_read', caseId,
        expiresAt: new Date(Date.now() + 300_000).toISOString() }, 201);
    }
    if (url.pathname === '/api/agent/work/claim' && method === 'POST') {
      const message = this.messages.find(candidate => !this.claims.has(candidate.id) || this.claims.get(candidate.id)?.state === 'retryable');
      if (!message) return json({ work: null });
      const prior = this.claims.get(message.id);
      const leaseToken = `lease_${message.id}_${(prior?.attempt || 0) + 1}`;
      this.claims.set(message.id, { leaseToken, state: 'claimed', attempt: (prior?.attempt || 0) + 1 });
      return json({ work: { workId: message.id, message, leaseToken, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } });
    }
    const settlement = url.pathname.match(/^\/api\/agent\/work\/([^/]+)\/(renew|acknowledge|complete|fail)$/);
    if (settlement && method === 'POST') {
      const [, workId, action] = settlement;
      const body = JSON.parse(String(init.body));
      const claim = this.claims.get(workId);
      if (!claim || claim.leaseToken !== body.leaseToken) return json({ error: 'Stale lease' }, 409);
      if (action === 'renew') return json({ workId, leaseToken: claim.leaseToken, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
      if (action === 'fail') {
        claim.state = body.retryable ? 'retryable' : 'processed';
        return json({ workId, status: body.retryable ? 'retryable' : 'failed' });
      }
      if (action === 'complete' && this.failCompletionOnceFor === workId) {
        this.failCompletionOnceFor = null;
        return json({ error: 'Temporary settlement failure' }, 503);
      }
      claim.state = action === 'acknowledge' ? 'acknowledged' : 'processed';
      const state = action === 'acknowledge' ? 'acknowledged' : 'processed';
      return json({ workId, status: state, receipt: { messageId: workId, state } }, 201);
    }
    if (url.pathname === '/api/inboxes/inbox_bridge/messages' && method === 'GET') {
      const caseId = url.searchParams.get('caseId');
      return json([...this.messages, ...this.replies.values()].filter(message => !caseId || message.caseId === caseId));
    }
    if (url.pathname === '/api/inboxes/inbox_bridge/messages' && method === 'POST') {
      const body = JSON.parse(String(init.body));
      const key = headers.get('idempotency-key');
      if (!key) return json({ error: 'Idempotency key required' }, 400);
      const existing = this.sentByKey.get(key);
      if (existing) return json(existing);
      const reply = { id: `reply_${key.replace(/[^A-Za-z0-9_-]/g, '_')}`, ...body, caseId: body.caseId, status: 'queued' };
      this.sentByKey.set(key, reply);
      this.replies.set(reply.id, reply);
      return json(reply, 202);
    }
    if (url.pathname === '/api/inboxes/inbox_bridge/asset-uploads' && method === 'POST') {
      const key = headers.get('idempotency-key');
      if (!key) return json({ error: 'Idempotency key required' }, 400);
      const existing = this.uploadsByKey.get(key);
      if (existing) return json(existing);
      const body = JSON.parse(String(init.body));
      const id = `obj_${this.objects.size + 1}`;
      const object = { id, workspaceId: 'inbox_bridge', ...body, state: 'quarantine' };
      this.objects.set(id, object);
      const result = { object, upload: { method: 'PUT', url: `https://signed.example.test/${id}`, headers: { 'content-type': body.mimeType } } };
      this.uploadsByKey.set(key, result);
      return json(result, 201);
    }
    const assetRoute = url.pathname.match(/^\/api\/inboxes\/inbox_bridge\/assets\/([^/]+)\/(complete|download)$/);
    if (assetRoute) {
      const [, id, action] = assetRoute;
      const object = this.objects.get(id);
      if (!object) return json({ error: 'Asset not found' }, 404);
      if (action === 'complete') {
        const bytes = this.signedBytes.get(id);
        if (!bytes || crypto.createHash('sha256').update(bytes).digest('base64') !== object.checksumSha256) return json({ error: 'Upload checksum mismatch' }, 422);
        object.state = 'clean';
        return json(object);
      }
      return object.state === 'clean'
        ? json({ object, download: { method: 'GET', url: `https://signed.example.test/${id}` } })
        : json({ error: 'Object is quarantined' }, 423);
    }
    if (url.pathname === '/api/inboxes/inbox_bridge/events/delta') return json({ events: [], nextCursor: null, hasMore: false });
    return json({ error: 'Mock route not found' }, 404);
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'sinaloa-bridge-interoperability-'));
  const store = new FileBridgeStore(directory);
  await store.init();
  const host = new MockHost();
  const session: ConnectorSession = {
    agentId: 'agent_bridge', inboxId: 'inbox_bridge', address: 'bridge@sinaloa.mail',
    agentApiToken: host.accessToken, agentRefreshToken: host.refreshToken,
    agentTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), cursor: null
  };
  await store.save(session);
  return { store, host, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function exerciseBridge(provider: 'openclaw' | 'xai') {
  const state = await fixture();
  try {
    state.host.queue(workMessage('msg_a', 'case_a'));
    state.host.queue(workMessage('msg_b', 'case_b', 'offer'));
    state.host.failCompletionOnceFor = 'msg_a';
    let connector: SinaloaConnector;
    const options = { fetch: state.host.fetch };
    const turn = provider === 'openclaw'
      ? openClawTurn({ gatewayUrl: 'https://gateway.example.test', gatewayToken: 'gateway-secret', agentId: 'bridge-agent', fetch: state.host.fetch, history: caseId => connector.listCaseMessages(caseId) })
      : xaiTurn({ apiKey: 'xai-secret', model: 'grok-test', fetch: state.host.fetch, history: caseId => connector.listCaseMessages(caseId),
        mcp: { serverUrl: 'https://sinaloa.example.test/mcp', accessToken: async caseId =>
          (await connector.mintMcpReadToken(caseId)).mcpAccessToken } });
    connector = new SinaloaConnector('https://sinaloa.example.test', state.store, { ...options, handler: bridgeHandler(state.store, turn) });
    await expect(connector.processWorkOnce()).rejects.toThrow('Temporary settlement failure');
    expect(state.host.rotationCount).toBe(1);
    expect(state.host.replies.size).toBe(1);
    expect(state.host.providerCalls).toEqual([`${provider}:msg_a`]);
    const saved = await state.store.replyFor('msg_a');
    expect(saved).toEqual({ text: provider === 'openclaw' ? 'Proposal for A' : 'Grok proposal for A', intent: 'offer', proposal: { value: 'A' } });
    // A new connector/handler uses the same persisted session and decision.
    connector = new SinaloaConnector('https://sinaloa.example.test', state.store, { ...options, handler: bridgeHandler(state.store, turn) });
    await expect(connector.processWorkOnce()).resolves.toBe(true);
    expect(state.host.replies.size).toBe(1);
    expect(state.host.providerCalls).toEqual([`${provider}:msg_a`]);
    await expect(connector.processWorkOnce()).resolves.toBe(true);
    expect(state.host.replies.size).toBe(2);
    expect(state.host.providerCalls).toEqual([`${provider}:msg_a`, `${provider}:msg_b`]);
    if (provider === 'xai') {
      expect(state.host.xaiMcpTools).toHaveLength(2);
      expect(state.host.mcpReadTokens.map(item => item.caseId)).toEqual(['case_a', 'case_b']);
      expect(state.host.xaiMcpTools[0]).toMatchObject({ type: 'mcp', server_url: 'https://sinaloa.example.test/mcp', authorization: 'Bearer mcp-read-1' });
      expect(state.host.xaiMcpTools[1]).toMatchObject({ authorization: 'Bearer mcp-read-2' });
      expect(state.host.xaiMcpTools[0].allowed_tools).toEqual(['sinaloa_agent_info', 'sinaloa_read_case', 'sinaloa_list_messages']);
    }
    const replies = [...state.host.replies.values()];
    expect(replies.map(reply => reply.caseId).sort()).toEqual(['case_a', 'case_b']);
    expect(replies.find(reply => reply.caseId === 'case_a')?.payload).toEqual({ proposal: { value: 'A' } });
    expect(replies.find(reply => reply.caseId === 'case_b')?.payload).toEqual({ decision: { proposalMessageId: 'msg_prior_b' } });
    expect(replies.every(reply => reply.senderAgentId === 'agent_bridge' && reply.recipientEmail === 'sender@sinaloa.mail')).toBe(true);
    expect((await state.store.load())?.agentRefreshToken).toBe(state.host.refreshToken);
    state.host.queue(workMessage('msg_c', 'case_a'));
    state.host.revoked = true;
    await expect(connector.processWorkOnce()).rejects.toThrow();
    expect(state.host.replies.size).toBe(2);
    expect(state.host.providerCalls).toHaveLength(2);
  } finally { await state.cleanup(); }
}

describe('A4 bridge interoperability with deterministic hosts', () => {
  it('OpenClaw handles two unsolicited cases, reuses a persisted typed reply on restart, rotates credentials and stops on revoke', async () => exerciseBridge('openclaw'));
  it('Grok through xAI Responses handles the same two-case and credential fixture', async () => exerciseBridge('xai'));

  it('does not send a Grok reply when xAI only claims to have read Sinaloa MCP', async () => {
    const turn = xaiTurn({ apiKey: 'xai-secret', model: 'grok-test',
      mcp: { serverUrl: 'https://sinaloa.example.test/mcp', accessToken: async () => 'scoped-read-token' },
      fetch: async () => json({ status: 'completed', output: [
        { type: 'message', content: [{ type: 'output_text', text: '{"text":"I checked","intent":"message"}' }] }
      ] }) });
    await expect(turn(workMessage('msg_a', 'case_a'), new AbortController().signal))
      .rejects.toThrow('did not complete the required Sinaloa MCP sinaloa_read_case call');
  });

  it('uses SDK asset helpers for owner-side signed upload and scanner-gated download without proxying bytes through the model', async () => {
    const state = await fixture();
    try {
      const connector = new SinaloaConnector('https://sinaloa.example.test', state.store, { fetch: state.host.fetch });
      const bytes = new TextEncoder().encode('safe owner-side asset');
      const checksumSha256 = crypto.createHash('sha256').update(bytes).digest('base64');
      const begun = await connector.beginAssetUpload('asset-case-a-answer-1', { filename: 'answer.txt', mimeType: 'text/plain', size: bytes.length, checksumSha256, caseId: 'case_a' });
      const replay = await connector.beginAssetUpload('asset-case-a-answer-1', { filename: 'answer.txt', mimeType: 'text/plain', size: bytes.length, checksumSha256, caseId: 'case_a' });
      expect(replay.object.id).toBe(begun.object.id);
      await expect(connector.getCleanAssetDownload(begun.object.id)).rejects.toThrow('quarantined');
      await putSignedAsset(begun.upload, bytes, { fetch: state.host.fetch });
      const clean = await connector.completeAssetUpload(begun.object.id);
      expect(clean.state).toBe('clean');
      const signed = await connector.getCleanAssetDownload(begun.object.id);
      expect(signed.download.url).toBe(begun.upload.url);
      const downloaded = await state.host.fetch(signed.download.url);
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
      const signedPut = state.host.calls.find(call => call.method === 'PUT');
      expect(signedPut?.token).toBeNull();
    } finally { await state.cleanup(); }
  });
});
