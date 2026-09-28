import { describe, expect, it, vi } from 'vitest';
import { ConnectorPersistenceError, enrollConnector, SinaloaConnector, type ConnectorSession, type ConnectorStore } from '@sinaloa/protocol/connector';

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
});
