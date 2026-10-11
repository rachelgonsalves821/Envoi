import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { contractRegistryPath, loadContractFixture, loadContractRegistry } from '../../integrations/contract-fixtures/setup';
import { ApiError, CSRF_RELOAD_REQUIRED_EVENT, SESSION_EXPIRED_EVENT, api, csrfHeaders, csrfToken, request, setCsrfCookieName, setExpectedHuman } from '../src/api';
import { CsrfReloadNotice, createHumanStreamRecovery, watchCsrfReload } from '../src/browser-session-recovery';
import { invalidateSessionRequests } from '../src/session-lifecycle';

const source = process.env.ENVOI_CONTRACT_FIXTURES_ROOT ?? path.dirname(contractRegistryPath);
const contract = loadContractRegistry(source).contracts.find(item => item.id === 'envoi-browser-names');
if (!contract) throw new Error('Shared browser naming fixtures required');
const fixture = (id: string) => loadContractFixture(contract, id + '.json', source) as any;
const errorResponse = (id: string) => {
  const { response } = fixture(id);
  return Response.json(response.body, { status: response.status });
};
afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfCookieName();
  setExpectedHuman(null);
});

describe('N2 CSRF recovery', () => {
  it.each([undefined, '', 'invalid;name'])('falls back to envoi_csrf for %s without accepting the retired cookie', name => {
    setCsrfCookieName(name);
    expect(csrfHeaders('POST', 'sinaloa_csrf=old; envoi_csrf=new')).toEqual({ 'x-envoi-csrf': 'new' });
    expect(csrfToken('sinaloa_csrf=old')).toBeNull();
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(csrfHeaders(method, 'envoi_csrf=new')).toEqual({});
  });

  it('offers Reload once without replaying an unchanged-token rejection', async () => {
    const browser = new EventTarget(); const onRequired = vi.fn();
    vi.stubGlobal('window', browser);
    const stop = watchCsrfReload(browser, onRequired);
    vi.stubGlobal('document', { cookie: 'envoi_csrf=existing' });
    const fetchMock = vi.fn().mockResolvedValueOnce(errorResponse('csrf-old-header-rejected'))
      .mockResolvedValueOnce(Response.json({ id: 'human_example' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('/api/write', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 403, message: 'CSRF validation failed' });
    expect(onRequired.mock.calls).toEqual([[true]]);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/write', '/api/auth/me']);
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get('x-envoi-csrf')).toBe('existing');
    expect(headers.has('x-sinaloa-csrf')).toBe(false);
    expect(fetchMock.mock.calls[0][1].credentials).toBe('same-origin');
    stop();
  });

  it('retries after restoring the missing token, then offers Reload on a second rejection', async () => {
    const browser = new EventTarget(); const reload = vi.fn();
    browser.addEventListener(CSRF_RELOAD_REQUIRED_EVENT, reload); vi.stubGlobal('window', browser);
    const document = { cookie: '' }; vi.stubGlobal('document', document);
    const fetchMock = vi.fn().mockResolvedValueOnce(errorResponse('csrf-old-header-rejected'))
      .mockImplementationOnce(async () => { document.cookie = 'envoi_csrf=restored'; return Response.json({ id: 'human_example' }); })
      .mockResolvedValueOnce(errorResponse('csrf-old-header-rejected'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('/api/write', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new Headers(fetchMock.mock.calls[2][1].headers).get('x-envoi-csrf')).toBe('restored');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('successful missing-token recovery needs no Reload', async () => {
    const browser = new EventTarget(); const reload = vi.fn();
    browser.addEventListener(CSRF_RELOAD_REQUIRED_EVENT, reload); vi.stubGlobal('window', browser);
    const document = { cookie: '' }; vi.stubGlobal('document', document);
    const fetchMock = vi.fn().mockResolvedValueOnce(errorResponse('csrf-old-header-rejected'))
      .mockImplementationOnce(async () => { document.cookie = 'envoi_csrf=restored'; return Response.json({ id: 'human_example' }); })
      .mockResolvedValueOnce(Response.json({ saved: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('/api/write', { method: 'POST', body: '{}' })).resolves.toEqual({ saved: true });
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([401, 403, 503])('does not offer Reload for an ordinary %s denial', async status => {
    const browser = new EventTarget(); const reload = vi.fn();
    browser.addEventListener(CSRF_RELOAD_REQUIRED_EVENT, reload); vi.stubGlobal('window', browser);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: 'Not authorized' }, { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('/api/write', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status });
    expect(reload).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a late CSRF rejection after the displayed session was invalidated', async () => {
    const browser = new EventTarget(); const reload = vi.fn();
    browser.addEventListener(CSRF_RELOAD_REQUIRED_EVENT, reload); vi.stubGlobal('window', browser);
    let complete!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { complete = resolve; })));
    const pending = request('/api/write', { method: 'POST', body: '{}' });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    invalidateSessionRequests(); complete(errorResponse('csrf-old-header-rejected'));
    await rejected; expect(reload).not.toHaveBeenCalled();
  });

  it('clears the notice on session expiry and removes all listeners on unmount', () => {
    const browser = new EventTarget(); const onRequired = vi.fn();
    const stop = watchCsrfReload(browser, onRequired);
    browser.dispatchEvent(new Event(CSRF_RELOAD_REQUIRED_EVENT));
    browser.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    expect(onRequired.mock.calls).toEqual([[true], [false]]);
    stop(); browser.dispatchEvent(new Event(CSRF_RELOAD_REQUIRED_EVENT));
    expect(onRequired).toHaveBeenCalledTimes(2);
  });

  it('renders an accessible Reload button that reloads the document', () => {
    const reload = vi.fn(); vi.stubGlobal('window', { location: { reload } });
    const markup = renderToStaticMarkup(createElement(CsrfReloadNotice));
    expect(markup).toContain('role="alert"'); expect(markup).toContain('>Reload</button>');
    const notice = CsrfReloadNotice({});
    notice.props.children[1].props.onClick();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('human stream authentication recovery', () => {
  it('ends the current session on the canonical 401 from the stream-error identity probe', async () => {
    const browser = new EventTarget(); const broadcast = vi.fn();
    browser.addEventListener(SESSION_EXPIRED_EVENT, broadcast); vi.stubGlobal('window', browser);
    const fetchMock = vi.fn().mockResolvedValue(errorResponse('me-old-cookies-only'));
    vi.stubGlobal('fetch', fetchMock);
    let current = true; const closeStream = vi.fn(); let screen = 'workspace';
    browser.addEventListener(SESSION_EXPIRED_EVENT, () => { closeStream(); current = false; screen = 'signedOut'; invalidateSessionRequests(); });
    const recover = createHumanStreamRecovery({
      isCurrent: () => current,
      checkSession: () => api.me(undefined, false),
      onExpired: () => browser.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)),
      onUnavailable: vi.fn()
    });
    await recover();
    expect(closeStream).toHaveBeenCalledTimes(1); expect(screen).toBe('signedOut');
    expect(broadcast).toHaveBeenCalledTimes(1); // one event closes the stream and clears the notice
    await recover(); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/me');
    expect(fetchMock.mock.calls[0][1].credentials).toBe('same-origin');
  });

  it.each([new ApiError('Denied', 403), new ApiError('Provider unavailable', 503), new TypeError('Network failed')])('keeps a transient or non-session stream failure recoverable (%s)', async failure => {
    const onExpired = vi.fn(); const onUnavailable = vi.fn();
    const recover = createHumanStreamRecovery({ isCurrent: () => true, checkSession: async () => { throw failure; }, onExpired, onUnavailable });
    await recover(); expect(onExpired).not.toHaveBeenCalled(); expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent errors and ignores a 401 from a previous workspace or session', async () => {
    let current = true; let reject!: (error: Error) => void;
    const checkSession = vi.fn().mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const onExpired = vi.fn(); const onUnavailable = vi.fn();
    const recover = createHumanStreamRecovery({ isCurrent: () => current, checkSession, onExpired, onUnavailable });
    const first = recover(); const second = recover(); expect(first).toBe(second);
    expect(checkSession).toHaveBeenCalledTimes(1); expect(onUnavailable).toHaveBeenCalledTimes(1);
    current = false; reject(new ApiError('Expired', 401)); await first;
    expect(onExpired).not.toHaveBeenCalled();
    await recover(); expect(checkSession).toHaveBeenCalledTimes(1);
  });

  it('can check again after a recoverable failure and sign out on a later 401', async () => {
    const checkSession = vi.fn().mockRejectedValueOnce(new TypeError('Offline')).mockRejectedValueOnce(new ApiError('Expired', 401));
    const onExpired = vi.fn();
    const recover = createHumanStreamRecovery({ isCurrent: () => true, checkSession, onExpired, onUnavailable: vi.fn() });
    await recover(); expect(onExpired).not.toHaveBeenCalled();
    await recover(); expect(onExpired).toHaveBeenCalledTimes(1);
  });
});
