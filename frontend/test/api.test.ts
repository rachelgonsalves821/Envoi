import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, csrfHeaders, csrfToken, request, safeDownloadUrl, setCsrfCookieName, shouldNotifySessionExpired } from '../src/api';

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfCookieName('sinaloa_csrf');
});

describe('human API sessions', () => {
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
