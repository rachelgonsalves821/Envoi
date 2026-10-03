import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, csrfHeaders, csrfToken, request, safeDownloadUrl, setCsrfCookieName, shouldNotifySessionExpired } from '../src/api';
import { invalidateSessionRequests } from '../src/session-lifecycle';

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfCookieName('sinaloa_csrf');
});

describe('human API sessions', () => {
  it('rejects a late successful response after logout even when fetch ignores cancellation', async () => {
    let complete!: (value: Response) => void;
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { complete = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = request('/api/inboxes/private/human-view');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    invalidateSessionRequests();
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    complete(new Response(JSON.stringify({ private: 'old workspace' }), { status: 200 }));
    await rejected;
  });

  it('ignores late 401 responses from a previous session instead of ending a new one', async () => {
    const browserWindow = new EventTarget();
    const expired = vi.fn();
    browserWindow.addEventListener('sinaloa:session-expired', expired);
    vi.stubGlobal('window', browserWindow);
    let complete!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { complete = resolve; })));
    const pending = request('/api/auth/me');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    invalidateSessionRequests();
    complete(new Response(JSON.stringify({ error: 'SESSION_EXPIRED' }), { status: 401 }));
    await rejected;
    expect(expired).not.toHaveBeenCalled();
  });

  it('keeps temporary provider failures recoverable and never replays a mutation', async () => {
    const browserWindow = new EventTarget();
    const expired = vi.fn();
    browserWindow.addEventListener('sinaloa:session-expired', expired);
    vi.stubGlobal('window', browserWindow);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'AUTH_UNAVAILABLE', message: 'Try again shortly.' }), { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('/api/inboxes/private/cases/1/actions', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 503, message: 'Try again shortly.' });
    expect(expired).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses same-origin cookies and never adds a bearer credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'human_1' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await request('/api/auth/me');

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({ credentials: 'same-origin' }));
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(options.headers).has('authorization')).toBe(false);
  });

  it('does not treat verification failures as an expired authenticated session', () => {
    expect(shouldNotifySessionExpired('/api/auth/phone/verify')).toBe(false);
    expect(shouldNotifySessionExpired('/api/auth/totp/verify')).toBe(false);
    expect(shouldNotifySessionExpired('/api/inboxes/inbox_1/human-view')).toBe(true);
  });

  it('notifies the app when an authenticated workspace request returns 401', async () => {
    const browserWindow = new EventTarget();
    const expired = vi.fn();
    browserWindow.addEventListener('sinaloa:session-expired', expired);
    vi.stubGlobal('window', browserWindow);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'SESSION_EXPIRED' }), { status: 401 })));

    await expect(request('/api/inboxes/inbox_1/human-view')).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('adds CSRF protection to mutations without replacing explicit headers', () => {
    expect(csrfToken('theme=light; sinaloa_csrf=csrf%20value')).toBe('csrf value');
    expect(csrfHeaders('POST', 'sinaloa_csrf=csrf-token')).toEqual({ 'x-sinaloa-csrf': 'csrf-token' });
    expect(csrfHeaders('GET', 'sinaloa_csrf=csrf-token')).toEqual({});
  });

  it('uses the CSRF cookie name returned by auth configuration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ provider: 'workos', hosted: true, csrfCookieName: 'custom_csrf' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await api.authConfig();
    expect(csrfToken('sinaloa_csrf=wrong; custom_csrf=right')).toBe('right');
  });

  it('shows the server message rather than its generic error code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'REQUEST_FAILED', message: 'Existing second factor must be verified before replacement' }), { status: 403 })));
    await expect(request('/api/auth/totp/setup', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      message: 'Existing second factor must be verified before replacement',
      code: 'REQUEST_FAILED',
      status: 403
    } satisfies Partial<ApiError>);
  });

  it('preserves the returning-human MFA setup decision', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ human: { id: 'human_1' }, secondFactorRequired: true, mfaSetupRequired: false }), { status: 200 })));
    await expect(api.phoneVerify('challenge_1', '000000')).resolves.toMatchObject({ mfaSetupRequired: false });
  });
});

describe('agent credential controls', () => {
  it('revokes the selected agent with the human session and CSRF token', async () => {
    vi.stubGlobal('document', { cookie: 'sinaloa_csrf=csrf-revoke' });
    const response = { revoked: true, agentId: 'agent/1', credentialFamilyCount: 1, revokedAt: '2026-09-28T18:00:00.000Z' };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.revokeAgentCredentials('inbox one', 'agent/1')).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith('/api/inboxes/inbox%20one/agents/agent%2F1/credentials/revoke', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(options.headers).get('x-sinaloa-csrf')).toBe('csrf-revoke');
    expect(new Headers(options.headers).has('authorization')).toBe(false);
  });

  it('sends newly approved permissions with a re-onboarding handoff', async () => {
    vi.stubGlobal('document', { cookie: 'sinaloa_csrf=csrf-reenroll' });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ agentId: 'agent_1', address: 'milo@agents.envoi-agents.com' }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.reconnectAgentToken('inbox_1', 'agent_1', 'hermes', ['receive_agent_messages']);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/inboxes/inbox_1/agents/agent_1/credentials/reconnect-token');
    expect(JSON.parse(String(options.body))).toEqual({ runtime: 'hermes', permissions: ['receive_agent_messages'] });
    expect(new Headers(options.headers).get('x-sinaloa-csrf')).toBe('csrf-reenroll');
  });
});

describe('enforced human controls', () => {
  it('uses exact protected routes for case actions, pause, native block, and file access', async () => {
    vi.stubGlobal('document', { cookie: 'sinaloa_csrf=csrf-controls' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ case: {}, action: {} }), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'agent/1', pausedAt: '2026-09-29T12:00:00Z' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ agentId: 'agent/peer', blocked: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: { id: 'asset/1' }, download: { url: '/download/once', method: 'GET' } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.action('inbox one', 'case/1', 'approveOnce', { policyEvaluationId: 'policy_1' });
    await api.setAgentPaused('inbox one', 'agent/1', true);
    await api.setNativeContactBlocked('inbox one', 'agent/peer', true);
    await api.downloadAsset('inbox one', 'asset/1');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/inboxes/inbox%20one/cases/case%2F1/actions',
      '/api/inboxes/inbox%20one/agents/agent%2F1/pause',
      '/api/inboxes/inbox%20one/contacts/agent%2Fpeer/block',
      '/api/inboxes/inbox%20one/assets/asset%2F1/download'
    ]);
    for (const [, options] of fetchMock.mock.calls.slice(0, 3)) {
      expect((options as RequestInit).method).toBe('POST');
      expect(new Headers((options as RequestInit).headers).get('x-sinaloa-csrf')).toBe('csrf-controls');
    }
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('idempotency-key')).toMatch(/^approveOnce-case\/1-/);
    expect((fetchMock.mock.calls[3][1] as RequestInit).method).toBeUndefined();
  });
});

describe('signed downloads', () => {
  it('allows relative, http development, and https provider URLs', () => {
    expect(safeDownloadUrl('/api/object-storage/local-download/token', 'http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787/api/object-storage/local-download/token');
    expect(safeDownloadUrl('https://storage.example/file?signature=1', 'https://app.example/')).toBe('https://storage.example/file?signature=1');
  });

  it('rejects active-content, credentialed, and downgrade URLs', () => {
    expect(safeDownloadUrl('javascript:alert(1)', 'https://app.example/')).toBeNull();
    expect(safeDownloadUrl('https://user:secret@storage.example/file', 'https://app.example/')).toBeNull();
    expect(safeDownloadUrl('http://storage.example/file', 'https://app.example/')).toBeNull();
  });
});

describe('agent connection invitations', () => {
  it('loads invitations and sends accept or decline decisions to the exact workspace routes', async () => {
    const invitation = {
      id: 'invite/1',
      fromAddress: 'sender@sinaloa.example',
      toAddress: 'recipient@sinaloa.example',
      senderAgentId: 'agent_sender',
      recipientAgentId: 'agent_recipient',
      direction: 'incoming',
      actionable: true,
      state: 'pending',
      createdAt: '2026-09-27T19:00:00.000Z',
      updatedAt: '2026-09-27T19:00:00.000Z'
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([invitation]), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ invitation: { ...invitation, state: 'accepted', conversationId: 'conversation_1' } }), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...invitation, state: 'declined' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const invitations = await api.invitations('inbox one');
    const accepted = await api.acceptInvitation('inbox one', 'invite/1');
    const declined = await api.declineInvitation('inbox one', 'invite/1');

    expect(invitations).toEqual([invitation]);
    expect(accepted.invitation).toMatchObject({ state: 'accepted', conversationId: 'conversation_1' });
    expect(declined).toMatchObject({ state: 'declined' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/inboxes/inbox%20one/invitations',
      '/api/inboxes/inbox%20one/invitations/invite%2F1/accept',
      '/api/inboxes/inbox%20one/invitations/invite%2F1/decline'
    ]);
    expect(fetchMock.mock.calls.slice(1).map(([, options]) => (options as RequestInit).method)).toEqual(['POST', 'POST']);
  });
});

describe('approved external contacts', () => {
  it('approves and blocks an exact email address with cookie and CSRF protection', async () => {
    vi.stubGlobal('document', { cookie: 'sinaloa_csrf=csrf-contact' });
    const contact = { id: 'external_contact_123', email: 'friend@example.com', displayName: 'Friend', direction: 'both', approved: true, blocked: false, updatedAt: '2026-09-27T19:00:00.000Z' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(contact), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...contact, blocked: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.approveExternalContact('inbox one', { email: contact.email, displayName: contact.displayName, direction: 'both' });
    await api.setExternalContactBlocked('inbox one', contact.id, true);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/inboxes/inbox%20one/external-contacts',
      '/api/inboxes/inbox%20one/external-contacts/external_contact_123/block'
    ]);
    for (const [, options] of fetchMock.mock.calls) {
      expect((options as RequestInit).method).toBe('POST');
      expect(new Headers((options as RequestInit).headers).get('x-sinaloa-csrf')).toBe('csrf-contact');
    }
  });
});
