import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';
import { WorkOSAuthService } from '../src/workos-auth.js';

async function fixture(t, { signupMode = 'public', publicSignupLimit = 2, invitedEmails = ' invited@example.test ' } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'envoi-dual-admission-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileStore(directory);
  await store.init();
  let selectedUser;
  let flow = 0;
  const revoked = [];
  const workos = { userManagement: {
    getAuthorizationUrlWithPKCE: async () => ({ url: 'https://auth.example.test/', state: `state_${++flow}`, codeVerifier: 'fixture_verifier' }),
    authenticateWithCode: async () => ({ user: selectedUser, sealedSession: `sealed_${selectedUser.id}` }),
    loadSealedSession: () => ({ authenticate: async () => ({ authenticated: true, user: selectedUser, sessionId: `session_${selectedUser.id}` }) }),
    revokeSession: async ({ sessionId }) => { revoked.push(sessionId); }
  } };
  const auth = new WorkOSAuthService(store, {
    clientId: 'client_fixture', apiKey: 'sk_fixture', cookiePassword: 'x'.repeat(32),
    redirectUri: 'https://app.example.test/api/auth/workos/callback', workos,
    invitedEmails, signupMode, publicSignupLimit
  });
  const authorize = async user => {
    selectedUser = user;
    const started = await auth.startAuthorization({ screenHint: 'sign-up' });
    return auth.completeAuthorization({ code: 'fixture', state: `state_${flow}`, browserBinding: started.browserBinding });
  };
  return { auth, store, authorize, revoked };
}

const user = (id, email, emailVerified = true) => ({ id, email, emailVerified, name: id });

test('default invite-only admission stays closed and public mode requires an explicit bounded limit', async t => {
  const closed = await fixture(t, { signupMode: 'invite-only', publicSignupLimit: 0 });
  assert.equal(closed.auth.config().inviteOnly, true);
  await assert.rejects(closed.authorize(user('outsider', 'outsider@example.test')), { statusCode: 403 });
  assert.deepEqual(await closed.store.listJson('humans'), []);
  const invited = await closed.authorize(user('invited', 'INVITED@example.test'));
  assert.equal(invited.human.email, 'INVITED@example.test');
  assert.throws(() => new WorkOSAuthService(closed.store, {
    clientId: 'client_fixture', apiKey: 'sk_fixture', cookiePassword: 'x'.repeat(32),
    redirectUri: 'https://app.example.test/callback', workos: {}, signupMode: 'public', publicSignupLimit: 0
  }), /ENVOI_PUBLIC_SIGNUP_LIMIT/);
});

test('invite-only cutover admits the preserved owner alongside all 31 cohort addresses', async t => {
  const cohort = Array.from({ length: 31 }, (_, index) => `person${index}@example.test`);
  const { auth, authorize, store } = await fixture(t, {
    signupMode: 'invite-only', publicSignupLimit: 0,
    invitedEmails: [...cohort, 'existing-owner@example.test'].join(',')
  });
  assert.equal(auth.config().inviteOnly, true);
  const owner = await authorize(user('owner', 'existing-owner@example.test'));
  const invited = await authorize(user('cohort', cohort[30]));
  assert.notEqual(owner.human.id, invited.human.id);
  await assert.rejects(authorize(user('outside', 'outside@example.test')), { statusCode: 403 });
  assert.equal((await store.listJson('humans')).length, 2);
});

test('public admission keeps invited cohort separate and never exceeds its durable concurrent quota', async t => {
  const { auth, store, authorize, revoked } = await fixture(t);
  assert.equal(auth.config().inviteOnly, false);
  assert.equal(auth.admitted(user('missing-email', '', true)), false);
  await assert.rejects(authorize(user('unverified', 'unverified@example.test', false)), { statusCode: 403 });
  const invited = await authorize(user('invited', 'invited@example.test'));
  const first = await authorize(user('first', 'first@example.test'));
  assert.notEqual(invited.human.id, first.human.id);
  const again = await authorize(user('first', 'first@example.test'));
  assert.equal(again.human.id, first.human.id);
  await auth.upsertHuman(user('second', 'second@example.test'));
  await assert.rejects(authorize(user('third', 'third@example.test')), { statusCode: 403, code: 'PUBLIC_SIGNUP_FULL' });
  assert.ok(revoked.includes('session_third'));
  assert.equal((await store.getJson(auth.sessionPath('session_third'))).revokedAt !== null, true);
  assert.deepEqual((await store.getJson('auth/workos-public-admissions.json')).userIds, ['first', 'second']);
  assert.equal((await store.listJson('humans')).length, 3);
  assert.equal((await auth.getStoredHumanForAuthorization(first.human.id)).providerUserId, 'first');
  assert.equal((await auth.getStoredHumanForAuthorization(invited.human.id)).providerUserId, 'invited');
  auth.invitedEmails.delete('invited@example.test');
  await assert.rejects(auth.upsertHuman(user('invited', 'invited@example.test')), { code: 'PUBLIC_SIGNUP_FULL' });
});

test('parallel public creation is atomic across service instances and a failed write does not consume capacity', async t => {
  const { auth, store } = await fixture(t, { publicSignupLimit: 1 });
  const second = new WorkOSAuthService(store, {
    clientId: 'client_fixture', apiKey: 'sk_fixture', cookiePassword: 'x'.repeat(32),
    redirectUri: 'https://app.example.test/callback', workos: {}, invitedEmails: 'invited@example.test',
    signupMode: 'public', publicSignupLimit: 1
  });
  const originalBatch = store.putJsonBatch.bind(store);
  store.putJsonBatch = async documents => { await originalBatch(documents.slice(0, 1)); throw new Error('simulated write failure'); };
  await assert.rejects(auth.upsertHuman(user('failed', 'failed@example.test')), /simulated write failure/);
  store.putJsonBatch = originalBatch;
  assert.deepEqual(await store.listJson('humans'), []);
  assert.equal(await store.getJson('auth/workos-public-admissions.json'), null);
  const results = await Promise.allSettled([
    auth.upsertHuman(user('first', 'first@example.test')),
    second.upsertHuman(user('second', 'second@example.test'))
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'PUBLIC_SIGNUP_FULL').length, 1);
  assert.equal((await store.getJson('auth/workos-public-admissions.json')).userIds.length, 1);
  assert.equal((await store.listJson('humans')).length, 1);
});

test('quota rejection is consistent for existing sessions and background owner authorization', async t => {
  const { auth, authorize, store } = await fixture(t, { publicSignupLimit: 1 });
  const invited = await authorize(user('invited', 'invited@example.test'));
  await auth.upsertHuman(user('public', 'public@example.test'));
  auth.invitedEmails.delete('invited@example.test');
  await assert.rejects(auth.upsertHuman(user('invited', 'invited@example.test')), { code: 'PUBLIC_SIGNUP_FULL' });
  assert.equal(await auth.getStoredHumanForAuthorization(invited.human.id), null);
  assert.equal(await auth.getSession({ headers: { cookie: 'envoi_session=sealed_invited' } }), null);
  assert.deepEqual((await store.getJson('auth/workos-public-admissions.json')).userIds, ['public']);
  assert.equal((await store.getJson('auth/workos-user-index/invited.json')).humanId, invited.human.id);
});

test('the real 100-account boundary retains two invited owners and survives a store restart', async t => {
  const { auth, store } = await fixture(t, { publicSignupLimit: 100, invitedEmails: 'one@example.test,two@example.test' });
  const one = await auth.upsertHuman(user('owner_one', 'one@example.test'));
  const two = await auth.upsertHuman(user('owner_two', 'two@example.test'));
  const anchors = [
    { path: 'organizations/org_one/organization.json', value: { id: 'org_one', ownerHumanId: one.id, status: 'active' } },
    { path: 'organizations/org_two/organization.json', value: { id: 'org_two', ownerHumanId: two.id, status: 'active' } },
    { path: 'inboxes/inbox_one/inbox.json', value: { id: 'inbox_one', organizationId: 'org_one', ownerHumanId: one.id } },
    { path: 'inboxes/inbox_two/inbox.json', value: { id: 'inbox_two', organizationId: 'org_two', ownerHumanId: two.id } }
  ];
  await store.putJsonBatch(anchors);
  const first = await auth.upsertHuman(user('public_0', 'public_0@example.test'));
  await Promise.all(Array.from({ length: 98 }, (_, i) => auth.upsertHuman(user('public_' + (i + 1), 'public_' + (i + 1) + '@example.test'))));
  const boundary = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => auth.upsertHuman(user('last_' + i, 'last_' + i + '@example.test'))));
  assert.equal(boundary.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(boundary.filter(r => r.status === 'rejected' && r.reason.code === 'PUBLIC_SIGNUP_FULL').length, 11);
  assert.equal((await store.getJson('auth/workos-public-admissions.json')).userIds.length, 100);
  const restarted = new WorkOSAuthService(new FileStore(store.root), {
    clientId: 'client_fixture', apiKey: 'sk_fixture', cookiePassword: 'x'.repeat(32), redirectUri: 'https://app.example.test/callback',
    workos: {}, signupMode: 'public', publicSignupLimit: 100, invitedEmails: 'one@example.test,two@example.test'
  });
  assert.equal((await restarted.upsertHuman(user('public_0', 'public_0@example.test'))).id, first.id);
  assert.equal((await restarted.upsertHuman(user('owner_one', 'one@example.test'))).id, one.id);
  assert.equal((await restarted.upsertHuman(user('owner_two', 'two@example.test'))).id, two.id);
  await assert.rejects(restarted.upsertHuman(user('one_too_many', 'one_too_many@example.test')), { code: 'PUBLIC_SIGNUP_FULL' });
  for (const d of anchors) assert.deepEqual(await store.getJson(d.path), d.value);
  assert.equal((await store.listJson('humans')).length, 102);
});
