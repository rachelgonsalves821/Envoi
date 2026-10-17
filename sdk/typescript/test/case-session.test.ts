import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaseSessionChannel, caseSessionResponse, type CaseSessionBinding, type CaseSessionChannelOptions } from '../src/case-session';
import { EnvoiConnector, type ConnectorSession, type WorkLease } from '../src/connector';
import { contractRegistry, loadContractFixture } from '../../../integrations/contract-fixtures/setup';

const contract = contractRegistry.contracts.find(entry => entry.id === 'case-session')!;
const fixture = (id: string) => loadContractFixture(contract, `${id}.json`) as Record<string, any>;
const channels: CaseSessionChannel[] = [];
const call = (name = 'envoi_case_snapshot', arguments_: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } });
const binding = (): CaseSessionBinding => ({ agentId: 'agent_example', workId: 'msg_example', caseId: 'case_example', workKind: 'agent_message', counterpartyAddress: 'counterparty@envoi.mail', agentAddress: 'example@envoi.mail' });
function channel(payload = fixture('session-created').response.body, options: Partial<CaseSessionChannelOptions> = {}, bound = binding()) {
  const value = new CaseSessionChannel(payload, bound, { origin: 'https://envoi.example', ...options });
  channels.push(value);
  return value;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T12:00:06.000Z')); });
afterEach(() => { for (const value of channels.splice(0)) value.invalidate(); vi.useRealTimers(); });

describe('approved CaseSession custody and transport', () => {
  it.each(['session-created', 'session-created-receive-only', 'session-created-human-instruction'])('consumes %s without exposing operational scope', id => {
    const source = fixture(id);
    const bound = { ...binding(), workId: source.response.body.session.workId, caseId: source.response.body.session.caseId, workKind: source.response.body.session.workKind };
    const value = channel(source.response.body, {}, bound);
    expect(value.modelContext()).toEqual(source.client.modelVisible);
    expect(JSON.stringify(value)).not.toMatch(/envoi_case_session_|lease_PLACEHOLDER|case_session_example|installation_example|msg_example|case_example/);
    expect(Object.keys(value)).toEqual([]);
    expect(Object.isFrozen(value.modelContext().allowedTools)).toBe(true);
  });

  it('sends only the private session bearer to the pinned MCP origin', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ jsonrpc: '2.0', id: 1, result: {} }));
    const value = channel(undefined, { fetch: fetcher });
    await expect(value.forward(call())).resolves.toBeInstanceOf(Response);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://envoi.example/mcp');
    expect(options.redirect).toBe('error'); expect(options.credentials).toBe('omit');
    expect(new Headers(options.headers).get('authorization')).toBe(`Bearer ${fixture('session-created').response.body.session.token}`);
    expect(options.body).toBe(call());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['https://other.example/mcp', 'https://envoi.example/mcp?token=private', 'https://user:secret@envoi.example/mcp', 'https://envoi.example/api/agent/work/claim'])('refuses a server-supplied alternate transport %s', url => {
    const payload = fixture('session-created').response.body; payload.session.transport.url = url;
    expect(() => channel(payload)).toThrow('invalid case session');
  });

  it.each(['agentId', 'workId', 'caseId'])('rejects another %s binding', key => {
    const payload = fixture('session-created').response.body; payload.session[key] += '_other';
    expect(() => channel(payload)).toThrow('invalid case session');
  });

  it('checks an explicitly known installation and rejects invalid fences or extended TTL', () => {
    expect(() => channel(undefined, {}, { ...binding(), installationId: 'installation_other' })).toThrow('invalid case session');
    for (const update of [{ fence: 0 }, { fence: 1.5 }, { expiresAt: '2026-10-17T12:16:05.000Z' }, { token: 'access-secret' }, { allowedTools: ['envoi_claim_work'] }]) {
      const payload = fixture('session-created').response.body; Object.assign(payload.session, update);
      expect(() => channel(payload)).toThrow('invalid case session');
    }
  });

  it('does not share mutable server payload or caller binding state with a running channel', () => {
    const payload = fixture('session-created').response.body; const bound = binding();
    const value = channel(payload, {}, bound);
    payload.session.allowedTools.push('envoi_claim_work'); payload.session.counterparty.address = 'wrong@example.com'; bound.agentAddress = 'wrong@example.com';
    expect(value.modelContext()).toEqual(fixture('session-created').client.modelVisible);
  });

  it.each(['envoi_claim_work', 'envoi_send_message', 'envoi_agent_info'])('never forwards legacy or host tool %s', async name => {
    const fetcher = vi.fn(); const value = channel(undefined, { fetch: fetcher });
    await expect(value.forward(call(name))).rejects.toMatchObject({ code: 'TOOL_NOT_IN_SESSION' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['caseId', 'workId', 'recipientEmail', 'sessionId'])('rejects %s scope override before network access', async key => {
    const fetcher = vi.fn(); const value = channel(undefined, { fetch: fetcher });
    await expect(value.forward(call('envoi_case_reply', { [key]: 'other' }))).rejects.toMatchObject({ code: 'TOOL_ARGUMENTS_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['CASE_SESSION_ENDED', 'CASE_SESSION_EXPIRED', 'AUTHENTICATION_REQUIRED'])('invalidates on transport %s without refreshing or privileged fallback', async code => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ code, reason: 'credential_ended', message: 'PRIVATE_SENTINEL' }, { status: 401 }));
    const invalidated = vi.fn(); const value = channel(undefined, { fetch: fetcher, onInvalidated: invalidated });
    await expect(value.forward(call())).rejects.toMatchObject({ code, message: 'Envoi case session request failed' });
    expect(value.signal.aborted).toBe(true); expect(invalidated).toHaveBeenCalledTimes(1);
    await expect(value.forward(call())).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(value)).toEqual('{"state":"ended"}');
  });

  it('retries an identical transport request with backoff without refreshing the session credential', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('PRIVATE_SENTINEL')).mockResolvedValueOnce(Response.json({ result: {} }));
    const value = channel(undefined, { fetch: fetcher });
    const pending = value.forward(call());
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toBeInstanceOf(Response);
    expect(value.signal.aborted).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
    vi.restoreAllMocks();
  });

  it('treats JSON-RPC tool refusal as a tool result, not installation revocation', async () => {
    const source = fixture('session-tool-not-in-session');
    const fetcher = vi.fn().mockResolvedValue(Response.json(source.response.body));
    const value = channel(undefined, { fetch: fetcher });
    const response = await value.forward(call());
    expect(await response.json()).toEqual(source.response.body);
    expect(value.signal.aborted).toBe(false);
  });

  it('cancels at the absolute expiry and discards a late response even when fetch ignores abort', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const value = channel(undefined, { fetch: fetcher }); const pending = value.forward(call());
    await Promise.resolve();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CASE_SESSION_EXPIRED' });
    await vi.advanceTimersByTimeAsync(899_000);
    finish(Response.json({ private: 'late' })); await rejected;
    expect(value.signal.aborted).toBe(true);
  });

  it('does not deliver a response body that completes after cancellation', async () => {
    const parent = new AbortController(); let body!: ReadableStreamDefaultController<Uint8Array>;
    const fetcher = vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) { body = controller; } })));
    const value = channel(undefined, { fetch: fetcher, signal: parent.signal });
    const rejected = expect(value.forward(call())).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    await Promise.resolve(); await Promise.resolve(); parent.abort(); await rejected;
    expect(() => body.enqueue(new TextEncoder().encode('late private body'))).toThrow();
  });

  it('matches session-ended events to the full private scope, not another work or case', () => {
    const value = channel(); const event = fixture('event-case-session-ended-agent-paused').event.data;
    expect(value.observeEvent({ ...event, caseId: 'case_other' })).toBe(false);
    expect(value.signal.aborted).toBe(false);
    expect(value.observeEvent(event)).toBe(true);
    expect(value.signal.aborted).toBe(true);
    expect(() => value.modelContext()).toThrow('Case session ended');
  });

  it('ends only through the trusted host callback after erasing local access', async () => {
    const end = vi.fn(async () => { expect(value.signal.aborted).toBe(true); expect(JSON.stringify(value)).not.toContain('envoi_case_session_'); });
    const value = channel(undefined, { end });
    await value.end(); expect(end).toHaveBeenCalledWith('case_session_example');
  });

  it('preserves bounded Retry-After metadata without invalidating a rate-limited session', async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ code: 'RATE_LIMITED', retryAfterSeconds: 3, message: 'PRIVATE_SENTINEL' }, { status: 429, headers: { 'retry-after': '5' } }));
    const value = channel(undefined, { fetch: fetcher });
    const pending = expect(value.forward(call())).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 5, message: 'Envoi case session request failed' });
    await vi.advanceTimersByTimeAsync(15_000); await pending;
    expect(value.signal.aborted).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['WORK_LEASE_STALE', 'other_installation'], ['WORK_LEASE_STALE', 'released'],
    ['WORK_NOT_ELIGIBLE', 'instruction_authority_lost'], ['CASE_SESSION_ENDED', 'lease_lost']
  ])('preserves %s reason %s for host cancellation/recovery policy', async (code, reason) => {
    await expect(caseSessionResponse(Response.json({ code, reason, message: 'PRIVATE_SENTINEL' }, { status: 409 })))
      .rejects.toMatchObject({ code, reason, message: 'Envoi case session request failed' });
  });

  it('does not echo an arbitrary credential-shaped remote error code', async () => {
    await expect(caseSessionResponse(Response.json({ code: 'envoi_case_session_PRIVATE_SENTINEL', message: 'PRIVATE_SENTINEL' }, { status: 401 })))
      .rejects.toMatchObject({ code: 'CASE_SESSION_TRANSPORT_ERROR', message: 'Envoi case session request failed' });
  });
});

describe('connector CaseSession mint and end', () => {
  function setup(available: unknown = { available: true, version: 1 }) {
    let saved: ConnectorSession = {
      agentId: 'agent_example', inboxId: 'inbox_example', address: 'example@envoi.mail',
      agentApiToken: 'HOST_ACCESS_SENTINEL', agentRefreshToken: 'HOST_REFRESH_SENTINEL',
      agentTokenExpiresAt: '2026-10-17T13:00:00.000Z', agentRefreshTokenExpiresAt: '2026-11-17T12:00:00.000Z', cursor: null
    };
    const save = vi.fn(async (next: ConnectorSession) => { saved = structuredClone(next); });
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/status')) return Response.json({ state: 'active', inboxId: saved.inboxId, agent: { id: saved.agentId }, ...(available === undefined ? {} : { caseSessions: available }) });
      if (String(url).endsWith('/session/end')) return Response.json(fixture('session-end').response.body);
      if (String(url).endsWith('/session')) return Response.json(fixture('session-created').response.body, { status: 201 });
      if (String(url).endsWith('/mcp')) return Response.json({ result: {} });
      throw new Error('Unexpected request');
    });
    const connector = new EnvoiConnector('https://envoi.example', { load: async () => saved, save }, { fetch: fetcher as typeof fetch });
    const work: WorkLease = { workId: 'msg_example', leaseToken: 'lease_PRIVATE_SENTINEL', leaseExpiresAt: '2026-10-17T12:01:00.000Z', message: {
      id: 'msg_example', caseId: 'case_example', senderAgentId: 'agent_counterparty', recipientAgentId: 'agent_example', text: 'untrusted inbound', from: { agentId: 'agent_counterparty', address: 'counterparty@envoi.mail' }
    } };
    return { connector, work, fetcher, save };
  }

  it('mints and ends with host access only, and never stores the case bearer', async () => {
    const { connector, work, fetcher, save } = setup();
    const value = await connector.mintCaseSession(work); channels.push(value);
    await value.forward(call()); await value.end();
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual(['https://envoi.example/api/agent/status', 'https://envoi.example/api/agent/work/msg_example/session', 'https://envoi.example/mcp', 'https://envoi.example/api/agent/work/msg_example/session/end']);
    for (const index of [0, 1, 3]) expect(new Headers(calls[index][1].headers).get('authorization')).toBe('Bearer HOST_ACCESS_SENTINEL');
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ leaseToken: work.leaseToken });
    expect(JSON.parse(String(calls[3][1].body))).toEqual({ leaseToken: work.leaseToken, sessionId: 'case_session_example' });
    expect(JSON.stringify(save.mock.calls)).not.toContain('envoi_case_session_');
    expect(JSON.stringify(value)).not.toMatch(/HOST_|lease_PRIVATE/);
  });

  it.each([null, false, { available: false, version: 1 }, { available: true, version: 2 }])('fails closed with unavailable status %j rather than using legacy access', async availability => {
    const { connector, work, fetcher } = setup(availability);
    await expect(connector.mintCaseSession(work)).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('invalidates a live case channel on agent pause without reviving it on resume', async () => {
    const { connector, work, fetcher } = setup();
    const value = await connector.mintCaseSession(work); channels.push(value);
    await connector.observeEvent({ agentId: 'agent_example', type: 'agent.paused' });
    await connector.observeEvent({ agentId: 'agent_example', type: 'agent.resumed' });
    await expect(value.forward(call())).rejects.toMatchObject({ code: 'CASE_SESSION_ENDED', reason: 'agent_paused' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
