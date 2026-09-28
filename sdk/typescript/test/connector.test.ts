import { describe, expect, it, vi } from 'vitest';
import { ConnectorContractError, ConnectorPersistenceError, enrollConnector, SinaloaConnector, type ConnectorSession, type ConnectorStore } from '@sinaloa/protocol/connector';

const session = (): ConnectorSession => ({
  agentId: 'agent_one', inboxId: 'inbox_one', address: 'one@sinaloa.mail',
  agentApiToken: 'access-one', agentRefreshToken: 'refresh-one',
  agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), cursor: null
});

function memoryStore(initial: ConnectorSession | null = null) {
  let value = initial;
  const store: ConnectorStore = {
    load: async () => value,
    save: async next => { value = structuredClone(next); }
  };
  return { store, current: () => value };
}

describe('Sinaloa outbound connector', () => {
  it('redeems the existing one-use code and persists credentials before returning', async () => {
    const memory = memoryStore();
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ enrollmentToken: 'one-time-code', name: 'Worker' });
      return new Response(JSON.stringify({ agent: { id: 'agent_one', address: 'one@sinaloa.mail' }, inbox: { id: 'inbox_one' }, ...session() }), { status: 201 });
    });
    const enrolled = await enrollConnector('https://api.example/', 'one-time-code', memory.store, { name: 'Worker', fetch: fetcher as typeof fetch });
    expect(enrolled.cursor).toBeNull();
    expect(memory.current()).toEqual(enrolled);
    expect(String(fetcher.mock.calls[0][0])).toBe('https://api.example/api/agent-enroll');
  });

  it('replays an offline delivered event and commits the cursor only after the callback', async () => {
    const memory = memoryStore(session());
    const seen: string[] = [];
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      events: [{ id: 'evt_one', type: 'message.delivered', cursor: '0001', messageId: 'msg_one' }],
      nextCursor: '0001', hasMore: false
    }), { status: 200 }));
    const connector = new SinaloaConnector('https://api.example', memory.store, {
      fetch: fetcher as typeof fetch,
      onEvent: event => { expect(memory.current()?.cursor).toBeNull(); seen.push(event.id); }
    });
    expect(await connector.pollOnce()).toEqual({ count: 1, hasMore: false });
    expect(seen).toEqual(['evt_one']);
    expect(memory.current()?.cursor).toBe('0001');
    expect(String(fetcher.mock.calls[0][0])).toContain('/events/delta?limit=100');
  });

  it('leaves the cursor in place when the callback fails so restart can replay', async () => {
    const memory = memoryStore(session());
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ events: [{ id: 'evt_one', type: 'message.delivered', cursor: '0001' }], nextCursor: '0001', hasMore: false }), { status: 200 }));
    const connector = new SinaloaConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch, onEvent: () => { throw new Error('handler unavailable'); } });
    await expect(connector.pollOnce()).rejects.toThrow('handler unavailable');
    expect(memory.current()?.cursor).toBeNull();
  });

  it('rotates expiring credentials, stores the new refresh token, then resumes from the saved cursor', async () => {
    const old = { ...session(), agentTokenExpiresAt: new Date(Date.now() + 5_000).toISOString(), cursor: '0001' };
    const memory = memoryStore(old);
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/agent-token')) {
        expect(JSON.parse(String(init?.body)).agentRefreshToken).toBe('refresh-one');
        return new Response(JSON.stringify({ agentApiToken: 'access-two', agentRefreshToken: 'refresh-two', agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), agentRefreshTokenExpiresAt: old.agentRefreshTokenExpiresAt }), { status: 200 });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-two');
      expect(String(url)).toContain('cursor=0001');
      return new Response(JSON.stringify({ events: [], nextCursor: '0001', hasMore: false }), { status: 200 });
    });
    const connector = new SinaloaConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch });
    expect(await connector.pollOnce()).toEqual({ count: 0, hasMore: false });
    expect(memory.current()?.agentRefreshToken).toBe('refresh-two');
  });

  it('rotates once after a 401 on delta and retries with the new access token', async () => {
    const memory = memoryStore(session());
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/agent-token')) return new Response(JSON.stringify({
        agentApiToken: 'access-two', agentRefreshToken: 'refresh-two',
        agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
      }), { status: 200 });
      if (new Headers(init?.headers).get('authorization') === 'Bearer access-one') return new Response(JSON.stringify({ error: 'Expired' }), { status: 401 });
      return new Response(JSON.stringify({ events: [], nextCursor: null, hasMore: false }), { status: 200 });
    });
    const connector = new SinaloaConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch });
    expect(await connector.pollOnce()).toEqual({ count: 0, hasMore: false });
    expect(memory.current()?.agentRefreshToken).toBe('refresh-two');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('stops after a rotated token cannot be persisted', async () => {
    const old = { ...session(), agentTokenExpiresAt: new Date(Date.now() - 1_000).toISOString() };
    const store: ConnectorStore = { load: async () => old, save: async () => { throw new Error('disk full'); } };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ agentApiToken: 'next', agentRefreshToken: 'next-refresh', agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), agentRefreshTokenExpiresAt: old.agentRefreshTokenExpiresAt }), { status: 200 }));
    const connector = new SinaloaConnector('https://api.example', store, { fetch: fetcher as typeof fetch });
    await expect(connector.pollOnce()).rejects.toBeInstanceOf(ConnectorPersistenceError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects non-TLS remote endpoints before sending an enrollment secret', async () => {
    const fetcher = vi.fn();
    await expect(enrollConnector('http://api.example', 'secret', memoryStore().store, { fetch: fetcher as typeof fetch })).rejects.toThrow(/HTTPS/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('claims, durably admits, acknowledges, invokes the handler, replies, and completes under one fence', async () => {
    const memory = memoryStore(session());
    const order: string[] = [];
    const message = { id: 'msg_one', senderAgentId: 'agent_two', recipientAgentId: 'agent_one', from: { agentId: 'agent_two', address: 'two@sinaloa.mail' }, caseId: 'case_one', text: 'Can we meet?', status: 'delivered' };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      const body = JSON.parse(String(init?.body));
      if (path.endsWith('/work/claim')) { order.push('claim'); return new Response(JSON.stringify({ work: { workId: 'work_one', message, leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } })); }
      if (path.endsWith('/work/work_one/acknowledge')) {
        order.push('ack'); expect(body).toEqual({ leaseToken: 'fence_one' });
        expect(new Headers(init?.headers).get('Idempotency-Key')).toMatch(/^connector:msg_one:[a-f0-9-]+:ack$/);
        return new Response(JSON.stringify({ workId: 'work_one', status: 'acknowledged', receipt: { id: 'receipt_ack', messageId: 'msg_one', state: 'acknowledged' } }));
      }
      if (path.endsWith('/messages')) {
        order.push('reply'); expect(body).toMatchObject({ senderAgentId: 'agent_one', recipientEmail: 'two@sinaloa.mail', caseId: 'case_one', text: 'Yes' });
        expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('reply-msg-one-1');
        return new Response(JSON.stringify({ id: 'msg_reply' }));
      }
      if (path.endsWith('/work/work_one/complete')) {
        order.push('complete'); expect(body).toEqual({ leaseToken: 'fence_one' });
        expect(new Headers(init?.headers).get('Idempotency-Key')).toMatch(/^connector:msg_one:[a-f0-9-]+:complete$/);
        return new Response(JSON.stringify({ workId: 'work_one', status: 'processed', receipt: { id: 'receipt_processed', messageId: 'msg_one', state: 'processed' } }));
      }
      throw new Error(`Unexpected route ${path}`);
    });
    const connector = new SinaloaConnector('https://api.example', memory.store, {
      fetch: fetcher as typeof fetch,
      handler: {
        admit: async () => { order.push('admit'); },
        process: async (_message, context) => { order.push('process'); await context.reply('Yes', 'reply-msg-one-1'); }
      }
    });
    expect(await connector.processWorkOnce()).toBe(true);
    expect(order).toEqual(['claim', 'admit', 'ack', 'process', 'reply', 'complete']);
  });

  it('reports handler failure through a retryable fenced fail without sending raw error text', async () => {
    const memory = memoryStore(session());
    const paths: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      paths.push(path);
      if (path.endsWith('/work/claim')) return new Response(JSON.stringify({ work: { workId: 'work_one', message: { id: 'msg_one', recipientAgentId: 'agent_one', from: { address: 'two@sinaloa.mail' }, text: 'hello', status: 'delivered' }, leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } }));
      if (path.endsWith('/work/work_one/acknowledge')) return new Response(JSON.stringify({ workId: 'work_one', status: 'acknowledged', receipt: { messageId: 'msg_one', state: 'acknowledged' } }));
      if (path.endsWith('/work/work_one/fail')) {
        expect(JSON.parse(String(init?.body))).toEqual({ leaseToken: 'fence_one', retryable: true, reasonCode: 'HANDLER_FAILED' });
        return new Response(JSON.stringify({ workId: 'work_one', status: 'retryable' }));
      }
      throw new Error(`Unexpected route ${path}`);
    });
    const connector = new SinaloaConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch, handler: {
      admit: async () => {}, process: async () => { throw new Error('private-agent-secret'); }
    } });
    await expect(connector.processWorkOnce()).rejects.toThrow('private-agent-secret');
    expect(paths.some(path => path.endsWith('/work/work_one/fail'))).toBe(true);
    expect(paths.some(path => path.endsWith('/work/work_one/complete'))).toBe(false);
  });

  it('does not invoke the runtime when no canonical work is claimable', async () => {
    const memory = memoryStore(session());
    const admit = vi.fn();
    const process = vi.fn();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ work: null })));
    const connector = new SinaloaConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch, handler: { admit, process } });
    expect(await connector.processWorkOnce()).toBe(false);
    expect(admit).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });

  it('stops instead of treating a missing claim endpoint as an empty inbox', async () => {
    const memory = memoryStore(session());
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }));
    const connector = new SinaloaConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch, handler: { admit: async () => {}, process: async () => {} } });
    await expect(connector.processWorkOnce()).rejects.toBeInstanceOf(ConnectorContractError);
  });

  it('renews the same fence while a long handler is running', async () => {
    const memory = memoryStore(session());
    let renewals = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/work/claim')) return new Response(JSON.stringify({ work: {
        workId: 'work_one', message: { id: 'msg_one', recipientAgentId: 'agent_one', from: { address: 'two@sinaloa.mail' }, text: 'hello', status: 'delivered' },
        leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 250).toISOString()
      } }));
      if (path.endsWith('/work/work_one/renew')) {
        renewals += 1;
        return new Response(JSON.stringify({ workId: 'work_one', leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 250).toISOString() }));
      }
      if (path.endsWith('/work/work_one/acknowledge')) return new Response(JSON.stringify({ workId: 'work_one', status: 'acknowledged', receipt: { messageId: 'msg_one', state: 'acknowledged' } }));
      if (path.endsWith('/work/work_one/complete')) return new Response(JSON.stringify({ workId: 'work_one', status: 'processed', receipt: { messageId: 'msg_one', state: 'processed' } }));
      throw new Error(`Unexpected route ${path}`);
    });
    const connector = new SinaloaConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch, handler: {
      admit: async () => {},
      process: async () => { await new Promise(resolve => setTimeout(resolve, 500)); }
    } });
    expect(await connector.processWorkOnce()).toBe(true);
    expect(renewals).toBeGreaterThan(0);
  });

  it('runs the claim and processing loop until graceful shutdown', async () => {
    const memory = memoryStore(session());
    const stop = new AbortController();
    let claims = 0;
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const route = String(url);
      if (route.endsWith('/work/claim')) {
        claims += 1;
        if (claims === 2) setTimeout(() => stop.abort(), 0);
        return new Response(JSON.stringify({ work: claims === 1 ? {
          workId: 'work_one', message: { id: 'msg_one', recipientAgentId: 'agent_one', from: { address: 'two@sinaloa.mail' }, text: 'hello', status: 'delivered' },
          leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
        } : null }));
      }
      if (route.endsWith('/work/work_one/acknowledge')) return new Response(JSON.stringify({ workId: 'work_one', status: 'acknowledged', receipt: { messageId: 'msg_one', state: 'acknowledged' } }));
      if (route.endsWith('/work/work_one/complete')) {
        return new Response(JSON.stringify({ workId: 'work_one', status: 'processed', receipt: { messageId: 'msg_one', state: 'processed' } }));
      }
      if (route.includes('/events/delta')) return new Response(JSON.stringify({ events: [], nextCursor: null, hasMore: false }));
      throw new Error(`Unexpected route ${route}`);
    });
    const connector = new SinaloaConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch, pollIntervalMs: 100, handler: {
      admit: async () => { calls.push('admit'); }, process: async () => { calls.push('process'); }
    } });
    await connector.run(stop.signal);
    expect(calls).toEqual(['admit', 'process']);
    expect(claims).toBeGreaterThan(1);
  });
});
