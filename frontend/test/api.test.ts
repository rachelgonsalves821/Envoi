import { afterEach, describe, expect, it, vi } from 'vitest';
import { csrfHeaders, csrfToken, request, safeDownloadUrl, shouldNotifySessionExpired } from '../src/api';

afterEach(() => {
  vi.unstubAllGlobals();
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
