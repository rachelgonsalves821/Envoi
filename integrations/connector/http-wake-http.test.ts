import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createWakeHttpHandler } from './http-wake-http';

async function serve(run: (origin: string, receiver: ReturnType<typeof vi.fn>, dispatch: ReturnType<typeof vi.fn>) => Promise<void>, stopped = false) {
  const abort = new AbortController(); if (stopped) abort.abort();
  let responseFinished = false;
  let acknowledged = false;
  const receive = vi.fn(async () => ({ status: 200, headers: {}, acceptedId: 'wake_evt_abcdefghijklmnop' }));
  const dispatch = vi.fn(async () => { expect(responseFinished).toBe(true); expect(acknowledged).toBe(true); });
  const handler = createWakeHttpHandler({ path: '/envoi/wake', receiver: { receive }, host: { dispatchPending: dispatch, acknowledge: async identifier => {
    expect(identifier).toBe('wake_evt_abcdefghijklmnop'); expect(responseFinished).toBe(true); acknowledged = true;
  } }, signal: abort.signal });
  const server = createServer((request, response) => { response.once('finish', () => { responseFinished = true; }); handler(request, response); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, receive, dispatch); }
  finally { abort.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe('bounded reference HTTP handler', () => {
  it('acknowledges before dispatch and never starts a listener by itself', () => serve(async (origin, receive, dispatch) => {
    expect((await fetch(`${origin}/envoi/wake`, { method: 'POST', body: '{}' })).status).toBe(200);
    expect(receive).toHaveBeenCalledOnce(); await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  }));
  it('bounds streaming bodies and refuses wrong paths and methods before verification', () => serve(async (origin, receive, dispatch) => {
    expect((await fetch(`${origin}/other`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${origin}/envoi/wake`)).status).toBe(400);
    expect((await fetch(`${origin}/envoi/wake`, { method: 'POST', body: 'a'.repeat(1025) })).status).toBe(400);
    expect(receive).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  }));
  it('does not accept or dispatch after shutdown', () => serve(async (origin, receive, dispatch) => {
    expect((await fetch(`${origin}/envoi/wake`, { method: 'POST', body: '{}' })).status).toBe(503);
    expect(receive).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  }, true));
});
