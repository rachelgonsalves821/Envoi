import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserSession } from './browser-session.js';
import { documents, launchRegistration } from './agent-registration-harness.js';

export async function workosActivationFixture(t, backend) {
  const directory = await mkdtemp(path.join(tmpdir(), 'envoi-workos-activation-'));
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + 'envoi-workos-activation-'));
  let server;
  t.after(async () => { await server?.stop(); await rm(directory, { recursive: true, force: true }); });
  const tag = crypto.randomBytes(8).toString('hex');
  const humanId = `human_workos_${tag}`, organizationId = `org_workos_${tag}`, inboxId = `inbox_workos_${tag}`;
  const stateFile = path.join(directory, 'provider.json');
  const state = { userId: `user_workos_${tag}`, workosOrganizationId: `org_provider_${tag}`, active: true, role: 'admin' };
  await writeFile(stateFile, JSON.stringify(state));
  server = await launchRegistration(backend, {
    ENVOI_HUMAN_AUTH_PROVIDER: 'workos', WORKOS_CLIENT_ID: 'client_activation_fixture', WORKOS_API_KEY: 'synthetic_only',
    WORKOS_COOKIE_PASSWORD: 'fixture-cookie-password-32-characters-long', WORKOS_REDIRECT_URI: 'https://fixture.example/callback',
    ENVOI_BETA_INVITED_EMAILS: 'activation@example.test', ENVOI_PUBLIC_URL: '',
    ENVOI_TEST_WORKOS_FIXTURE_FILE: stateFile,
    NODE_OPTIONS: `--import=${new URL('./workos-activation-provider.mjs', import.meta.url).href}`
  });
  const docs = documents(t, backend, server);
  const at = new Date().toISOString();
  const humanParts = ['humans', `${humanId}.json`];
  const indexParts = ['auth', 'workos-user-index', `${state.userId}.json`];
  const membershipParts = ['organizations', organizationId, 'members', `${humanId}.json`];
  await docs.put(humanParts, { id: humanId, workosUserId: state.userId, email: 'activation@example.test', emailVerified: true, authProvider: 'workos', displayName: 'Fixture owner', verifiedAt: at, createdAt: at });
  await docs.put(indexParts, { humanId });
  await docs.put(['organizations', organizationId, 'organization.json'], { id: organizationId, name: 'Fixture workspace', ownerHumanId: humanId, workosOrganizationId: state.workosOrganizationId, status: 'active', createdAt: at });
  await docs.put(membershipParts, { organizationId, humanId, status: 'active', role: 'admin', createdAt: at });
  await docs.put(['inboxes', inboxId, 'inbox.json'], { id: inboxId, organizationId, name: 'Fixture workspace', ownerHumanId: humanId, kind: 'workspace', status: 'active', createdAt: at });
  const session = new BrowserSession();
  session.cookies.set('envoi_session', 'activation_fixture_cookie'); session.cookies.set('envoi_csrf', 'activation_fixture_csrf');
  const calls = async () => (await readFile(stateFile + '.calls', 'utf8').catch(() => '')).split('\n').filter(Boolean).map(value => JSON.parse(value));
  return { server, docs, state, humanParts, indexParts, membershipParts, calls,
    who: { session, inbox: { parentInboxId: inboxId } },
    async changeProvider(change) { Object.assign(state, change); await writeFile(stateFile, JSON.stringify(state)); },
    async assertNoTransientIdentityPersisted() { const stored = await docs.get(humanParts); assert.equal(stored.workosUserId, state.userId); assert.equal(stored.providerUserId, undefined); }
  };
}
