import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';
import { createCsrfToken, csrfCookieHeader, membershipCanManage, parseCookies, providerMembershipCanManage, safeReturnPath, sessionCookieHeader, verifyCsrfRequest, WorkOSAuthService } from '../src/workos-auth.js';

test('management authority follows active provider membership after role changes', () => {
  const membership = { status: 'active', role: { slug: 'admin' } };
  assert.equal(providerMembershipCanManage(membership), true);
  membership.role.slug = 'member';
  assert.equal(providerMembershipCanManage(membership), false);
  assert.equal(providerMembershipCanManage({ status: 'inactive', role: { slug: 'admin' } }), false);
  assert.equal(providerMembershipCanManage({ status: 'active' }), false);
  assert.equal(providerMembershipCanManage(null), false);
});

test('enrollment management requires both current local and provider authority', () => {
  const localAdmin = { status: 'active', role: 'admin', providerMembership: { status: 'active', role: { slug: 'admin' } } };
  assert.equal(membershipCanManage(localAdmin, 'workos'), true);
  assert.equal(membershipCanManage({ ...localAdmin, role: 'member' }, 'workos'), false);
  assert.equal(membershipCanManage({ ...localAdmin, providerMembership: { status: 'active', role: { slug: 'member' } } }, 'workos'), false);
  assert.equal(membershipCanManage({ ...localAdmin, providerMembership: null }, 'workos'), false);
  assert.equal(membershipCanManage({ status: 'active', role: 'owner' }, 'local'), true);
});

test('WorkOS return paths cannot escape the application origin', () => {
  assert.equal(safeReturnPath('/inbox?workspace=one#latest'), '/inbox?workspace=one#latest');
  assert.equal(safeReturnPath('/\\evil.example'), '/');
  assert.equal(safeReturnPath('//evil.example'), '/');
  assert.equal(safeReturnPath('/%5cevil.example'), '/');
  assert.equal(safeReturnPath('/%255cevil.example'), '/');
  assert.equal(safeReturnPath('https://evil.example'), '/');
});

test('WorkOS cookie mutations require a matching CSRF token and exact origin', () => {
  const previousPublicUrl = process.env.SINALOA_PUBLIC_URL;
  process.env.SINALOA_PUBLIC_URL = 'https://app.sinaloa.example';
  try {
    const token = createCsrfToken();
    const cookie = csrfCookieHeader(token).split(';')[0];
    assert.equal(verifyCsrfRequest({ headers: { cookie, origin: 'https://app.sinaloa.example', 'x-sinaloa-csrf': token } }), true);
    assert.equal(verifyCsrfRequest({ headers: { cookie, origin: 'https://evil.example', 'x-sinaloa-csrf': token } }), false);
    assert.equal(verifyCsrfRequest({ headers: { cookie, origin: 'https://app.sinaloa.example', 'x-sinaloa-csrf': 'wrong' } }), false);
  } finally {
    if (previousPublicUrl === undefined) delete process.env.SINALOA_PUBLIC_URL;
    else process.env.SINALOA_PUBLIC_URL = previousPublicUrl;
  }
});

test('malformed cookies do not bypass admission or crash CSRF validation', () => {
  assert.deepEqual(parseCookies('sinaloa_session=%E0%A4%A; sinaloa_csrf=valid'), { sinaloa_csrf: 'valid' });
  assert.equal(verifyCsrfRequest({ headers: { cookie: 'sinaloa_session=%E0%A4%A; sinaloa_csrf=%E0%A4%A', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-sinaloa-csrf': 'valid' } }), false);
});

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
      listOrganizationMemberships: async ({ userId, organizationId, statuses }) => ({ data: userId === user.id && organizationId === 'org_workos_1' && statuses.includes('active') ? [{ id: 'membership_1', userId, organizationId, status: 'active', role: { slug: 'admin' } }] : [] }),
      createOrganizationMembership: async input => { calls.memberships.push(input); return { id: 'membership_1', ...input }; }
    },
    organizations: {
      createOrganization: async (input, options) => { calls.organizations.push({ input, options }); return { id: 'org_workos_1', name: input.name }; }
    }
  };
  const auth = new WorkOSAuthService(store, { clientId: 'client_1', apiKey: 'sk_test_1', cookiePassword: '12345678901234567890123456789012', redirectUri: 'https://sinaloa.test/api/auth/workos/callback', issuer: 'https://issuer.example.test', workos: fakeWorkos, invitedEmails: 'rachel@example.com' });
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
  assert.equal((await auth.getSession({ headers: { cookie } })).assurance, 'provider');
  assert.equal(await auth.getHuman({ headers: { cookie: cookie.replace('sealed_session_1', 'invalid_session') } }), null);
  user.id = 'user_other';
  const otherHuman = await auth.getHuman({ headers: { cookie } });
  assert.notEqual(otherHuman.id, human.id);
  assert.equal(otherHuman.providerUserId, 'user_other');
  user.id = 'user_workos_1';
  const providerMembership = await auth.getOrganizationMembership(human.providerUserId, human.organizationId);
  assert.equal(providerMembership.status, 'active');
  assert.equal(providerMembership.role.slug, 'admin');

  const organization = await auth.createProviderOrganization({ name: 'Sinaloa Test', externalId: 'org_local_1', idempotencyKey: 'org-create-1', userId: human.providerUserId });
  assert.equal(organization.id, 'org_workos_1');
  assert.equal(calls.organizations[0].options.idempotencyKey, 'org-create-1');
  assert.deepEqual(calls.memberships[0], { organizationId: 'org_workos_1', userId: 'user_workos_1', roleSlug: 'admin' });
});

test('WorkOS email verification alone does not admit an uninvited human', async () => {
  const store = new FileStore(await mkdtemp(path.join(tmpdir(), 'sinaloa-workos-uninvited-')));
  await store.init();
  const user = { id: 'user_uninvited', email: 'outsider@example.com', emailVerified: true };
  const workos = { userManagement: {
    getAuthorizationUrlWithPKCE: async () => ({ url: 'https://auth.example.test/', state: 'state_uninvited', codeVerifier: 'verifier_uninvited' }),
    authenticateWithCode: async () => ({ user, sealedSession: 'sealed_uninvited' }),
    loadSealedSession: () => ({ authenticate: async () => ({ authenticated: true, user, sessionId: 'session_uninvited' }) })
  } };
  const auth = new WorkOSAuthService(store, { clientId: 'client_1', apiKey: 'sk_test_1', cookiePassword: '12345678901234567890123456789012', redirectUri: 'https://sinaloa.test/callback', workos, invitedEmails: 'rachel@example.com' });
  await auth.startAuthorization();
  await assert.rejects(() => auth.completeAuthorization({ code: 'code_uninvited', state: 'state_uninvited' }), { statusCode: 403 });
  assert.deepEqual(await store.listJson('humans'), []);
  const req = { headers: { cookie: 'sinaloa_session=sealed' } };
  assert.equal(await auth.getHuman(req), null);
  assert.equal(await auth.getHuman({ headers: { cookie: 'sinaloa_session=%E0%A4%A' } }), null);
});
