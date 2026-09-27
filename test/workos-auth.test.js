import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';
import { sessionCookieHeader, WorkOSAuthService } from '../src/workos-auth.js';

test('WorkOS auth uses one-time PKCE state and maps provider users to stable humans', async () => {
  const store = new FileStore(await mkdtemp(path.join(tmpdir(), 'sinaloa-workos-')));
  await store.init();
  const calls = { organizations: [], memberships: [] };
  const user = { id: 'user_workos_1', email: 'rachel@example.com', emailVerified: true, name: 'Rachel Gonsalves', firstName: 'Rachel', lastName: 'Gonsalves' };
  const fakeWorkos = {
    userManagement: {
      getAuthorizationUrlWithPKCE: async options => ({ url: `https://auth.example.test/?state=state_1&screen=${options.screenHint}`, state: 'state_1', codeVerifier: 'verifier_1' }),
      authenticateWithCode: async options => {
        assert.equal(options.codeVerifier, 'verifier_1');
        assert.equal(options.session.sealSession, true);
        return { user, accessToken: 'access', refreshToken: 'refresh', sealedSession: 'sealed_session_1' };
      },
      loadSealedSession: ({ sessionData }) => ({
        authenticate: async () => sessionData === 'sealed_session_1' ? { authenticated: true, user, sessionId: 'session_1', organizationId: 'org_workos_1', role: 'admin', permissions: ['workspace:manage'] } : { authenticated: false, reason: 'invalid_session_cookie' },
        getLogoutUrl: async () => 'https://auth.example.test/logout'
      }),
      createOrganizationMembership: async input => { calls.memberships.push(input); return { id: 'membership_1', ...input }; }
    },
    organizations: {
      createOrganization: async (input, options) => { calls.organizations.push({ input, options }); return { id: 'org_workos_1', name: input.name }; }
    }
  };
  const auth = new WorkOSAuthService(store, { clientId: 'client_1', apiKey: 'sk_test_1', cookiePassword: '12345678901234567890123456789012', redirectUri: 'https://sinaloa.test/api/auth/workos/callback', issuer: 'https://issuer.example.test', workos: fakeWorkos });
  const started = await auth.startAuthorization({ screenHint: 'sign-up', returnTo: '/onboarding' });
  assert.match(started.url, /screen=sign-up/);
  const completed = await auth.completeAuthorization({ code: 'code_1', state: 'state_1', ipAddress: '127.0.0.1', userAgent: 'test' });
  assert.equal(completed.sealedSession, 'sealed_session_1');
  assert.equal(completed.returnTo, '/onboarding');
  assert.equal(completed.human.email, 'rachel@example.com');
  await assert.rejects(() => auth.completeAuthorization({ code: 'code_1', state: 'state_1' }), /already used/);

  const cookie = sessionCookieHeader('sealed_session_1');
  const human = await auth.getHuman({ headers: { cookie } });
  assert.equal(human.id, completed.human.id);
  assert.equal(human.providerUserId, 'user_workos_1');
  assert.equal(human.organizationId, 'org_workos_1');
  assert.equal(human.role, 'admin');

  const organization = await auth.createProviderOrganization({ name: 'Sinaloa Test', externalId: 'org_local_1', idempotencyKey: 'org-create-1', userId: human.providerUserId });
  assert.equal(organization.id, 'org_workos_1');
  assert.equal(calls.organizations[0].options.idempotencyKey, 'org-create-1');
  assert.deepEqual(calls.memberships[0], { organizationId: 'org_workos_1', userId: 'user_workos_1', roleSlug: 'admin' });
});
