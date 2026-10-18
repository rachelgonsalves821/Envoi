import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, request, setCsrfCookieName, setExpectedHuman } from '../src/api';

afterEach(() => {
  vi.unstubAllGlobals();
  setExpectedHuman(null);
  setCsrfCookieName('envoi_csrf');
});

describe('beta mutation recovery boundaries', () => {
  it('preserves instruction body and idempotency key across one CSRF recovery', async () => {
    const cookieDocument = { cookie: 'envoi_csrf=old' };
    vi.stubGlobal('document', cookieDocument);
    setExpectedHuman('human_one');
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'CSRF validation failed' }, { status: 403 }))
      .mockImplementationOnce(async () => {
        cookieDocument.cookie = 'envoi_csrf=new';
        return Response.json({ id: 'human_one' });
      })
      .mockResolvedValueOnce(Response.json({ accepted: true }));
    vi.stubGlobal('fetch', fetcher);
    await api.sendInstruction('inbox/one', 'case/one', 'Keep this exact instruction.', 'instruction-one');
    expect(fetcher).toHaveBeenCalledTimes(3);
    const writes = [fetcher.mock.calls[0], fetcher.mock.calls[2]];
    for (const [url, options] of writes) {
      expect(url).toBe('/api/inboxes/inbox%2Fone/cases/case%2Fone/instructions');
      expect(JSON.parse(options.body)).toEqual({ text: 'Keep this exact instruction.' });
      expect(new Headers(options.headers).get('idempotency-key')).toBe('instruction-one');
      expect(new Headers(options.headers).get('x-envoi-expected-human')).toBe('human_one');
      expect(new Headers(options.headers).has('authorization')).toBe(false);
    }
    expect(new Headers(writes[0][1].headers).get('x-envoi-csrf')).toBe('old');
    expect(new Headers(writes[1][1].headers).get('x-envoi-csrf')).toBe('new');
  });

  it('does not replay a mutation when its caller cancels during identity recovery', async () => {
    const cookieDocument = { cookie: 'envoi_csrf=old' };
    vi.stubGlobal('document', cookieDocument);
    setExpectedHuman('human_one');
    const controller = new AbortController();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'CSRF validation failed' }, { status: 403 }))
      .mockImplementationOnce(async () => {
        controller.abort();
        cookieDocument.cookie = 'envoi_csrf=new';
        return Response.json({ id: 'human_one' });
      });
    vi.stubGlobal('fetch', fetcher);
    await expect(request('/api/write', { method: 'POST', body: '{}', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not replay even with a rotated CSRF cookie when the account changed', async () => {
    const cookieDocument = { cookie: 'envoi_csrf=old' };
    vi.stubGlobal('document', cookieDocument);
    setExpectedHuman('human_one');
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'CSRF validation failed' }, { status: 403 }))
      .mockImplementationOnce(async () => {
        cookieDocument.cookie = 'envoi_csrf=new';
        return Response.json({ id: 'human_two' });
      });
    vi.stubGlobal('fetch', fetcher);
    await expect(api.updateInboxPreference('inbox_one', 'case_one', { archive: true })).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not attempt automatic recovery for a non-replayable body', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: 'CSRF validation failed' }, { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(request('/api/write', { method: 'POST', body: new FormData() })).rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('keeps removal history choice %s explicit and bound to the displayed human', async deleteHistory => {
    vi.stubGlobal('document', { cookie: 'envoi_csrf=remove' });
    setExpectedHuman('human_one');
    const fetcher = vi.fn().mockResolvedValue(Response.json({ removed: true }));
    vi.stubGlobal('fetch', fetcher);
    await api.removeAgent('inbox/one', 'agent/one', deleteHistory, deleteHistory ? 'Planner' : '');
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('/api/inboxes/inbox%2Fone/agents/agent%2Fone/remove');
    expect(JSON.parse(options.body)).toEqual({ deleteHistory, confirmation: deleteHistory ? 'Planner' : '' });
    expect(new Headers(options.headers).get('x-envoi-expected-human')).toBe('human_one');
    expect(new Headers(options.headers).get('x-envoi-csrf')).toBe('remove');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
