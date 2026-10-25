import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';
import { WorkOSAuthService } from '../src/workos-auth.js';

async function fixture(t, { signupMode = 'public', publicSignupLimit = 2 } = {}) {
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
    invitedEmails: ' invited@example.test ', signupMode, publicSignupLimit
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
