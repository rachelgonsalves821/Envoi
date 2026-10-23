// agent-remote-auth v1 (approved revision 4) §8, task RA-A2: the single-use bootstrap code for a reviewed provider client
// with a private credential field, and its exchange with HTTP Basic client authentication, on the real server.
// FileStore always, and PostgreSQL when DATABASE_URL is set (CI test:postgres).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  api, assertOAuthError, assertRemote, assertStored, assertTokenResponse, backends, codeParts, confidentialClient, documents, edit, familyParts, installationView, freshOwner, owner,
  plainProviderClient, providerClient, providerSecret, publicClient, registrationParts, remoteFixture, remoteServer, sha256, stored, tokenPost, PAST
} from './agent-remote-auth-token-harness.js';

const grant = 'urn:envoi:params:oauth:grant-type:bootstrap_code';
const newOwner = freshOwner;
const clients = [publicClient, confidentialClient, providerClient, plainProviderClient];
const issueBody = (who, overrides = {}) => ({
  clientId: providerClient.clientId,
  target: { kind: 'new_agent', workspaceInboxId: who.inbox.parentInboxId, name: 'Provider agent', localPart: `provider-${crypto.randomBytes(3).toString('hex')}` },
  grantedPermissions: ['send_agent_messages', 'receive_agent_messages'], policyProfile: 'default', ...overrides
});
const issue = (server, who, overrides) => api(server.baseUrl, '/api/oauth/bootstrap-codes', { session: who.session, body: issueBody(who, overrides) });
const basic = (id = providerClient.clientId, secret = providerSecret) => ({ id, secret });
const bootstrapExchange = (server, code, options = {}, overrides = {}) => tokenPost(server, { grant_type: grant, bootstrap_code: code, resource: server.resource, ...overrides }, { basic: basic(), ...options });

for (const backend of backends) {
  test(`[${backend.name}] bootstrap: the owner issues a code once; the provider exchanges it with its secret`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend, { providers: true, clients });
    const docs = documents(t, server);
    const who = await newOwner(server);

    const issued = await issue(server, who);
    assert.equal(issued.status, 201, issued.text);
    assert.equal(issued.headers.get('cache-control'), 'no-store');
    assertRemote('bootstrapCodeIssued', issued.payload);
    const { bootstrapCode: code, registrationId } = issued.payload;
    assert.match(code, /^envoi_boot_[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.payload.provider, 'Example Provider');
    assert.equal(issued.payload.clientName, 'Example Provider connector');
    const lifetime = Date.parse(issued.payload.expiresAt) - Date.now();
    assert.ok(lifetime > 590_000 && lifetime <= 600_000, `the approval lives 600 s (${lifetime} ms)`);

    // §14.3: the registration is approved, has no handle, redirect, challenge or consent decision, and the code is a hash.
    const registration = await docs.get(registrationParts(registrationId));
    assert.deepEqual([registration.status, registration.connectionRoute, registration.runtime], ['approved', 'provider_connector', { type: 'provider', version: null }]);
    assert.deepEqual([registration.oauth.source, registration.oauth.redirectUri, registration.oauth.codeChallenge, registration.oauth.handleDigest, registration.oauth.codeHash], ['bootstrap', null, null, null, sha256(code)]);
    assert.equal(registration.tokenHash, undefined);
    const index = await docs.get(codeParts(code));
    assert.deepEqual([index.kind, index.clientId, index.usedAt], ['bootstrap_code', providerClient.clientId, null]);
    assertStored('storedOAuthCode', index);
    assertStored('storedOAuthRegistration', registration);
    assert.equal((await docs.list(['auth', 'oauth-consent-decisions'])).length, 0, 'a bootstrap code has no consent decision');
    assert.ok(!JSON.stringify(registration).includes(code) && !JSON.stringify(index).includes(code), 'only the hash is stored');
    // The owner's approvals list shows it as an approval, never the code.
    const claims = await api(server.baseUrl, '/api/agent-claims', { session: who.session });
    assert.ok(claims.payload.claims.some(item => item.registrationId === registrationId && item.status === 'approved'));
    assert.ok(!claims.text.includes(code) && !claims.text.includes('codeHash'));

    // The exchange: Basic authentication, the code, the resource.
    const exchanged = await bootstrapExchange(server, code);
    const tokens = assertTokenResponse(exchanged);
    assert.equal((await remoteFixture('bootstrap-code-exchanged')).response.body.scope, tokens.scope);
    const { registration: activated, family } = await stored(docs, registrationId);
    assert.equal(activated.status, 'activated');
    assert.deepEqual([family.audience, family.oauthClientId], [server.resource, providerClient.clientId]);
    const installation = await installationView(server, who, activated);
    assert.deepEqual([installation.connectionRoute, installation.deliveryMode, installation.status, installation.runtime], ['provider_connector', 'on_demand', 'active', { type: 'provider', version: null }]);
    assert.ok(!JSON.stringify(await docs.get(familyParts(activated.agentInboxId, activated.agentId, activated.credentialFamilyId))).includes(providerSecret));
    // The code is never a bearer token.
    const asBearer = await api(server.baseUrl, '/api/agent/status', { token: code });
    assert.equal(asBearer.status, 401);
    assert.equal(asBearer.payload.code, 'AUTHENTICATION_REQUIRED');
    // And the provider's refresh works with its secret, like any confidential client.
    const refreshed = await tokenPost(server, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }, { basic: basic() });
    assertTokenResponse(refreshed);

    // Issuing again creates a second registration and a different code; it never repeats the first.
    const second = await newOwner(server);
    const again = await issue(server, second);
    assert.equal(again.status, 201, again.text);
    assert.notEqual(again.payload.bootstrapCode, code);
    assert.notEqual(again.payload.registrationId, registrationId);

    const logs = server.stdout + server.stderr;
    assert.ok(![code, tokens.access_token, tokens.refresh_token, providerSecret].some(secret => logs.includes(secret)), 'no code, token or secret in the logs');
  });

  test(`[${backend.name}] bootstrap exchange: authentication, grant rules and the Policy B reuse rows`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend, { providers: true, clients });
    const docs = documents(t, server);
    const issueFresh = async () => {
      const who = await newOwner(server);
      const res = await issue(server, who);
      assert.equal(res.status, 201, res.text);
      return { who, code: res.payload.bootstrapCode, registrationId: res.payload.registrationId };
    };
    const installationOf = async fresh => installationView(server, fresh.who, (await stored(docs, fresh.registrationId)).registration);

    // Client authentication (row 3) and the grant's own rules.
    const fresh = await issueFresh();
    assertOAuthError(await bootstrapExchange(server, fresh.code, { basic: basic(providerClient.clientId, 'wrong-secret') }), 'invalid_client');
    assertOAuthError(await tokenPost(server, { grant_type: grant, bootstrap_code: fresh.code, resource: server.resource, client_id: providerClient.clientId }), 'invalid_client');
    assertOAuthError(await tokenPost(server, { grant_type: grant, bootstrap_code: fresh.code, resource: server.resource, client_id: publicClient.clientId }), 'unauthorized_client');
    assertOAuthError(await bootstrapExchange(server, fresh.code, { basic: basic(plainProviderClient.clientId, providerSecret) }), 'unauthorized_client');
    assertOAuthError(await bootstrapExchange(server, fresh.code, { basic: basic(confidentialClient.clientId, 'confidential-client-secret-for-tests') }), 'unauthorized_client');
    assertOAuthError(await bootstrapExchange(server, '', {}), 'invalid_request');
    assertOAuthError(await bootstrapExchange(server, fresh.code, {}, { resource: undefined }), 'invalid_request');
    assertOAuthError(await bootstrapExchange(server, fresh.code, {}, { resource: `${server.origin}/other` }), 'invalid_target');
    assertOAuthError(await bootstrapExchange(server, `envoi_boot_${'u'.repeat(43)}`), 'invalid_grant');
    // None of that consumed the code.
    assert.equal((await docs.get(codeParts(fresh.code))).usedAt, null);
    assertTokenResponse(await bootstrapExchange(server, fresh.code));

    // A used code: the invalid replays revoke nothing, the genuine one revokes the installation it created.
    assertOAuthError(await bootstrapExchange(server, fresh.code, { basic: basic(providerClient.clientId, 'wrong-secret') }), 'invalid_client');
    assertOAuthError(await bootstrapExchange(server, fresh.code, {}, { resource: `${server.origin}/other` }), 'invalid_target');
    assertOAuthError(await bootstrapExchange(server, fresh.code, { basic: basic(plainProviderClient.clientId, providerSecret) }), 'unauthorized_client');
    assert.equal((await installationOf(fresh)).status, 'active', 'no invalid replay revoked it');
    assertOAuthError(await bootstrapExchange(server, fresh.code), 'invalid_grant');
    const ended = await installationOf(fresh);
    assert.deepEqual([ended.status, ended.endedReason], ['ended', 'activation_replay']);

    // An expired code: row 5, before the reuse check, even though it was used.
    const lapsed = await issueFresh();
    assertTokenResponse(await bootstrapExchange(server, lapsed.code));
    await edit(docs, codeParts(lapsed.code), value => { value.expiresAt = PAST; });
    assertOAuthError(await bootstrapExchange(server, lapsed.code), 'invalid_grant');
    assert.equal((await installationOf(lapsed)).status, 'active');
    // An unused expired code is simply invalid.
    const unused = await issueFresh();
    await edit(docs, codeParts(unused.code), value => { value.expiresAt = PAST; });
    assertOAuthError(await bootstrapExchange(server, unused.code), 'invalid_grant');

    // A bootstrap code is not an authorization code: the code grant refuses its format before any lookup.
    assertOAuthError(await tokenPost(server, { grant_type: 'authorization_code', code: lapsed.code, redirect_uri: 'https://provider.example/callback', code_verifier: 'A'.repeat(43), resource: server.resource }, { basic: basic() }), 'invalid_request');
  });

  // M3 (review 6349153739): an OAuth grant holds only the four permissions that have a scope (§4.3, §8). The bootstrap
  // request enum accepts use_email_transport, but it never reaches the effective grant, the activated agent or the token.
  test(`[${backend.name}] bootstrap grant boundary: use_email_transport never reaches the grant, the agent or the token`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend, { providers: true, clients });
    const docs = documents(t, server);
    const agentOf = async registration => docs.get(['inboxes', registration.agentInboxId, 'agents', `${registration.agentId}.json`]);
    const issueAndExchange = async (grantedPermissions, { scope, beforeExchange } = {}) => {
      const who = await newOwner(server);
      const issued = await issue(server, who, { grantedPermissions });
      assert.equal(issued.status, 201, issued.text);
      assertRemote('bootstrapCodeIssued', issued.payload);
      if (beforeExchange) await beforeExchange(issued.payload.registrationId);
      const tokens = assertTokenResponse(await bootstrapExchange(server, issued.payload.bootstrapCode), scope);
      const { registration } = await stored(docs, issued.payload.registrationId);
      return { issued: issued.payload, tokens, registration, agent: await agentOf(registration) };
    };
    // The reviewer's input: the unsupported permission is dropped at issue, so nothing downstream sees it.
    const widened = await issueAndExchange(['send_agent_messages', 'receive_agent_messages', 'use_email_transport']);
    assert.deepEqual(widened.issued.effectivePermissions, ['send_agent_messages', 'receive_agent_messages'], 'issue response');
    assert.deepEqual(widened.registration.effectivePermissions, ['send_agent_messages', 'receive_agent_messages'], 'stored approval');
    assert.deepEqual(widened.registration.requested.permissions, ['send_agent_messages', 'receive_agent_messages'], 'stored request');
    assert.equal(widened.registration.oauth.scope, 'envoi.agent envoi.send');
    assert.deepEqual([...widened.agent.permissions].sort(), ['receive_agent_messages', 'send_agent_messages'], 'activated agent');
    // receive_agent_messages stays mandatory, and narrowing is honoured.
    const mandatory = await issueAndExchange(['send_agent_messages', 'use_email_transport']);
    assert.deepEqual(mandatory.registration.effectivePermissions, ['send_agent_messages', 'receive_agent_messages']);
    const narrowed = await issueAndExchange(['receive_agent_messages'], { scope: 'envoi.agent' });
    assert.deepEqual([narrowed.registration.effectivePermissions, narrowed.agent.permissions], [['receive_agent_messages'], ['receive_agent_messages']]);
    // Activation is bounded too: even an approval record holding the permission (written before this fix) activates without it.
    const legacy = await issueAndExchange(['send_agent_messages', 'receive_agent_messages'], {
      beforeExchange: id => edit(docs, registrationParts(id), record => { record.effectivePermissions = [...record.effectivePermissions, 'use_email_transport']; })
    });
    assert.ok(!legacy.agent.permissions.includes('use_email_transport'), 'the activated agent never holds it');
    assert.equal(legacy.tokens.scope, 'envoi.agent envoi.send');
  });

  test(`[${backend.name}] bootstrap issue: the same checks as consent, and only for a bootstrap client`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend, { providers: true, clients });
    const who = await newOwner(server);
    const other = await newOwner(server);
    // Every issue request counts toward the 10-an-hour approval limit (§5.2 step 2), refusals included.
    const validator = await newOwner(server);
    const code = res => res.payload?.code;

    // Session first.
    const anonymous = await api(server.baseUrl, '/api/oauth/bootstrap-codes', { body: issueBody(who) });
    assert.equal(anonymous.status, 401);
    // The client must be a bootstrap client of this server: unknown, not bootstrap, a metadata document and a missing id are one answer.
    for (const clientId of ['client_unknown-example', plainProviderClient.clientId, publicClient.clientId, confidentialClient.clientId, 'https://assistant.example.com/oauth/client.json', undefined]) {
      const res = await issue(server, who, { clientId });
      assert.equal(res.status, 404, res.text);
      assert.equal(code(res), 'AUTHORIZATION_REQUEST_INVALID');
    }
    const notObject = await api(server.baseUrl, '/api/oauth/bootstrap-codes', { session: who.session, body: [1] });
    assert.equal(code(notObject), 'AUTHORIZATION_REQUEST_INVALID');
    // The body is the approve body: no verification code, closed fields.
    assert.equal(code(await issue(server, validator, { verificationCode: 'ABCD-EFGH' })), 'CLAIM_INVALID');
    assert.equal(code(await issue(server, validator, { grantedPermissions: [] })), 'CLAIM_INVALID');
    assert.equal(code(await issue(server, validator, { policyProfile: 'other' })), 'CLAIM_INVALID');
    assert.equal(code(await issue(server, validator, { extra: true })), 'CLAIM_INVALID');
    // Another human cannot connect agents to this owner's workspace.
    assert.equal(code(await issue(server, other, { target: { kind: 'new_agent', workspaceInboxId: who.inbox.parentInboxId, name: 'Intruder', localPart: 'intruder-agent' } })), 'CLAIM_FORBIDDEN');
    // Nothing was created by any refusal.
    assert.equal((await api(server.baseUrl, '/api/agent-claims', { session: who.session })).payload.claims.length, 0);
    const ok = await issue(server, who);
    assert.equal(ok.status, 201, ok.text);
    // An address taken by a pending approval is refused for the next one.
    const taken = await issue(server, validator, { target: { kind: 'new_agent', workspaceInboxId: validator.inbox.parentInboxId, name: 'Same', localPart: 'taken-address' } });
    assert.equal(taken.status, 201, taken.text);
    const clash = await issue(server, other, { target: { kind: 'new_agent', workspaceInboxId: other.inbox.parentInboxId, name: 'Same', localPart: 'taken-address' } });
    assert.equal(code(clash), 'ADDRESS_TAKEN');
  });
}

test('[server] bootstrap codes need ENVOI_PROVIDER_CONNECTORS: with it off the route and the grant do not exist', { timeout: 120000 }, async t => {
  const server = await remoteServer(t, backends[0], { providers: false, clients });
  const who = await newOwner(server);
  const res = await issue(server, who);
  assert.equal(res.status, 404, res.text);
  assert.equal(res.payload.code, 'FEATURE_DISABLED');
  assertOAuthError(await bootstrapExchange(server, `envoi_boot_${'a'.repeat(43)}`), 'unsupported_grant_type');
  // A provider client whose route flag is off is unknown, not merely unauthorized.
  const connector = await tokenPost(server, { grant_type: 'refresh_token', refresh_token: `envoi_agent_refresh_${'a'.repeat(43)}` }, { basic: basic() });
  assertOAuthError(connector, 'invalid_client');
});
