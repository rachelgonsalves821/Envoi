import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { authorizationHandle, authorizationSignInPath, authorizationStartError } from '../src/onboarding/consent-state';
import { AuthorizationEntry, AuthorizeAgentPage } from '../src/onboarding/AuthorizeAgentPage';

describe('pre-consent OAuth errors', () => {
  it('shows fixed client guidance with no consent form or misleading expired-request text', () => {
    const search = '?error=invalid_client&error_description=DO_NOT_RENDER&code=DO_NOT_FORWARD';
    const html = renderToStaticMarkup(createElement(AuthorizeAgentPage, {
      humanId: 'owner', handle: authorizationHandle(search), startError: authorizationStartError(search),
      workspaces: [], agents: []
    }));
    expect(html).toContain('could not verify the assistant');
    expect(html).toContain('OAuth client configuration');
    expect(html).toContain('Back to workspace');
    expect(html).not.toContain('no longer available');
    expect(html).not.toContain('Approve access');
    expect(html).not.toContain('Refresh outcome');
    expect(html).not.toContain('DO_NOT_');
  });
  it('carries only one recognized error through sign-in without forwarding untrusted text or codes', () => {
    const path = authorizationSignInPath('/api/auth/workos/sign-in', '?error=invalid_client&error_description=DO_NOT_FORWARD&code=SECRET&state=SECRET');
    expect(new URL(path, 'https://www.envoi-agents.com').searchParams.get('returnTo')).toBe('/authorize-agent?error=invalid_client');
    expect(path).not.toContain('SECRET'); expect(path).not.toContain('DO_NOT_FORWARD');
    for (const search of ['?error=unknown', '?error=invalid_client&error=invalid_request', '?request=valid&error=invalid_client', '?error=__proto__']) {
      expect(authorizationStartError(search)).toBeNull();
    }
    expect(new URL(authorizationSignInPath('/api/auth/workos/sign-in', '?request=valid&error=invalid_client'), 'https://www.envoi-agents.com').searchParams.get('returnTo')).toBe('/authorize-agent?request=valid');
  });
});

describe('signed-out OAuth entry', () => {
  it('reports an invalid client before offering sign-in', () => {
    const html = renderToStaticMarkup(createElement(AuthorizationEntry, {
      search: '?error=invalid_client&error_description=DO_NOT_RENDER',
      signInPath: '/api/auth/workos/sign-in'
    }));
    expect(html).toContain('OAuth client configuration');
    expect(html).not.toContain('Sign in to Envoi');
    expect(html).not.toContain('DO_NOT_RENDER');
  });

  it('preserves a valid request through WorkOS sign-in', () => {
    const html = renderToStaticMarkup(createElement(AuthorizationEntry, {
      search: '?request=valid&code=DO_NOT_FORWARD', signInPath: '/api/auth/workos/sign-in'
    }));
    expect(html).toContain('Sign in to Envoi');
    expect(html).toContain('returnTo=%2Fauthorize-agent%3Frequest%3Dvalid');
    expect(html).not.toContain('DO_NOT_FORWARD');
  });
});
