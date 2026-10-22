// agent-remote-auth v1 (approved revision 4) §9 and §11, with a5-presence-on-demand v1 and agent-registration revision 5
// §14.2, task RA-A3: /mcp as the resource server for OAuth tokens, scope enforcement, pause, the challenge, the owner's honest
// on_demand projection, and flags-off rollback, on the real server. FileStore always, and PostgreSQL when DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  accessParts, api, assertOAuthError, assertOnDemand, assertRemote, assertTokenResponse, backends, confidentialClient, connect, documents, edit, exchange, familyParts, installationView, owner, providerClient, providerSecret, publicClient,
  recoveryParts, refreshParams, refreshParts, registrationParts, remoteFixture, remoteServer, restart, stored, tokenPost, PAST
} from './agent-remote-auth-token-harness.js';

let ownerSerial = 8600;
const newOwner = server => owner(server.baseUrl, String(ownerSerial += 1));
const rpc = (server, token, method, params = {}, id = 1) => api(server.baseUrl, '/mcp', { token, body: { jsonrpc: '2.0', id, method, params }, headers: { accept: 'application/json, text/event-stream' } });
const call = (server, token, name, args = {}) => rpc(server, token, 'tools/call', { name, arguments: args });
const toolResult = res => JSON.parse(res.payload.result.content[0].text);
const agentUrl = (registration, action) => `/api/inboxes/${registration.agentInboxId}/agents/${registration.agentId}/${action}`;
const ownerView = async (server, who, registration, { schema = true } = {}) => {
  const res = await api(server.baseUrl, `/api/inboxes/${registration.agentInboxId}/agents`, { session: who.session });
  assert.equal(res.status, 200, res.text);
  if (schema) assertOnDemand('ownerAgentList', res.payload);
  return res.payload.find(agent => agent.id === registration.agentId);
};
// The fixtures name the canonical origin; a test server is a loopback origin.
const challenge = (server, text) => text.replaceAll('https://www.envoi-agents.com', server.origin);

async function connected(server, docs, options = {}) {
  const who = await newOwner(server);
  const grant = await connect(server, who, options);
  const tokens = assertTokenResponse(await exchange(server, grant), options.scope || 'envoi.agent envoi.send');
  const { registration } = await stored(docs, grant.registrationId);
  return { who, grant, tokens, registration, familyPath: familyParts(registration.agentInboxId, registration.agentId, registration.credentialFamilyId) };
}

for (const backend of backends) {
  test(`[${backend.name}] /mcp: the challenge, an accepted token, tool calls through the internal dispatch, and the first-use write`, { timeout: 180000 }, async t => {
    // HTTP wake is on only so that its route exists: an OAuth token must be an unrecognized bearer there too (§9, audience).
    const server = await remoteServer(t, backend, { env: { ENVOI_HTTP_WAKE_V1: 'true', ENVOI_WAKE_SIGNING_KEYS: JSON.stringify([{ kid: 'mcp-tests', privateKey: crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), activeFrom: '2026-01-01T00:00:00.000Z' }]) } });
    const docs = documents(t, server);
    const connection = await connected(server, docs);
    const { tokens } = connection;

    // §9 "Challenge": every 401 from /mcp, with the starting scope set; error="invalid_token" only when a token failed.
    const unauthenticated = await rpc(server, null, 'tools/list');
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.payload.code, 'AUTHENTICATION_REQUIRED');
    assertRemote('errorEnvelope', unauthenticated.payload);
    assert.equal(unauthenticated.headers.get('www-authenticate'), challenge(server, (await remoteFixture('mcp-challenge-unauthenticated')).response.headers['www-authenticate']));
    const invalidHeader = challenge(server, (await remoteFixture('mcp-challenge-invalid-token')).response.headers['www-authenticate']);
    for (const bad of ['envoi_agent_access_unknownunknownunknownunknownunknownunknown', `envoi_boot_${'a'.repeat(43)}`, 'garbage']) {
      const res = await rpc(server, bad, 'tools/list');
      assert.deepEqual([res.status, res.payload.code, res.headers.get('www-authenticate')], [401, 'AUTHENTICATION_REQUIRED', invalidHeader], bad);
    }
    // The bearer is the bootstrap code of a provider: never accepted at /mcp (bootstrap-code-at-mcp).
    const expiredToken = await connected(server, docs);
    await edit(docs, accessParts(expiredToken.tokens.access_token), value => { value.expiresAt = PAST; });
    const expired = await rpc(server, expiredToken.tokens.access_token, 'tools/list');
    assert.deepEqual([expired.status, expired.payload.code, expired.headers.get('www-authenticate')], [401, 'ACCESS_TOKEN_EXPIRED', invalidHeader]);

    // An accepted token: the identity of its own agent, the permissions it was granted, and nothing secret.
    const initialize = await rpc(server, tokens.access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(initialize.status, 200, initialize.text);
    assert.equal((await docs.get(accessParts(tokens.access_token))).usedAt !== null, true, 'initialize authenticated the token, so the first-use write happened');
    const listed = await rpc(server, tokens.access_token, 'tools/list');
    assert.equal(listed.status, 200, listed.text);
    const names = listed.payload.result.tools.map(tool => tool.name);
    for (const name of ['envoi_agent_info', 'envoi_claim_work', 'envoi_start_case', 'envoi_list_cases']) assert.ok(names.includes(name), name);
    assert.ok(!names.includes('envoi_begin_asset_upload'), 'envoi.files was not granted');
    const info = toolResult(await call(server, tokens.access_token, 'envoi_agent_info'));
    assert.deepEqual([info.agentId, info.inboxId, info.address], [connection.registration.agentId, connection.registration.agentInboxId, connection.registration.target.address]);
    assert.deepEqual([...info.permissions].sort(), ['receive_agent_messages', 'send_agent_messages']);
    // Tool calls that the server performs through its own REST routes work: the internal dispatch is authenticated, not open.
    assert.equal((await call(server, tokens.access_token, 'envoi_list_cases')).payload.result.isError, false);
    assert.deepEqual(toolResult(await call(server, tokens.access_token, 'envoi_claim_work')).payload.work, null);
    assert.equal((await call(server, tokens.access_token, 'envoi_list_messages')).payload.result.isError, false);
    const firstUse = (await docs.get(accessParts(tokens.access_token))).usedAt;
    await call(server, tokens.access_token, 'envoi_agent_info');
    assert.equal((await docs.get(accessParts(tokens.access_token))).usedAt, firstUse, 'usedAt is written once');

    // Nothing an owner or the model can read holds a code, token, verifier, handle, audience or client: the owner views, the audit
    // feed, and every tool result.
    const inboxId = connection.registration.agentInboxId;
    const readable = [
      (await api(server.baseUrl, `/api/inboxes/${inboxId}/agents`, { session: connection.who.session })).text,
      (await api(server.baseUrl, `${agentUrl(connection.registration, 'installations')}`, { session: connection.who.session })).text,
      (await api(server.baseUrl, '/api/agent-claims', { session: connection.who.session })).text,
      (await api(server.baseUrl, `/api/inboxes/${inboxId}/events/delta?limit=200`, { session: connection.who.session })).text,
      (await api(server.baseUrl, '/api/onboarding/routes')).text,
      JSON.stringify([listed.payload, info, (await call(server, tokens.access_token, 'envoi_list_cases')).payload, (await call(server, tokens.access_token, 'envoi_claim_work')).payload])
    ];
    for (const text of readable) {
      for (const secret of [tokens.access_token, tokens.refresh_token, connection.grant.code, connection.grant.verifier, connection.grant.handle, publicClient.clientId, server.resource]) assert.ok(!text.includes(secret), `a readable view holds ${secret.slice(0, 18)}…`);
      assert.doesNotMatch(text, /envoi_oauth_code_|envoi_boot_|envoi_agent_(?:access|refresh)_|"audience"|oauthClientId|codeHash|handleDigest|codeChallenge/);
    }

    // The same token is an unrecognized bearer everywhere else, and a forged dispatch marker opens nothing.
    for (const [route, headers] of [['/api/agent/status', {}], [`/api/inboxes/${connection.registration.agentInboxId}/messages`, {}], ['/api/agent/status', { 'x-envoi-mcp-dispatch': 'a'.repeat(32) }],
      ['/api/agent/work/claim', { 'x-envoi-mcp-dispatch': 'b'.repeat(32) }], ['/api/agent/wake-subscriptions', {}]]) {
      const res = await api(server.baseUrl, route, { token: tokens.access_token, headers, ...(route.endsWith('claim') ? { body: {} } : {}) });
      assert.deepEqual([res.status, res.payload?.code, res.headers.get('www-authenticate')], [401, 'AUTHENTICATION_REQUIRED', null], route);
    }
    const asInvalid = await api(server.baseUrl, '/api/agent-token', { body: { agentRefreshToken: tokens.access_token, rotationId: 'rotation-id-for-test' } });
    assert.equal(asInvalid.status, 401);

    // Revoked: CREDENTIAL_REVOKED with the reason, and the challenge (revoke-refresh-token step 2).
    const revoke = await api(server.baseUrl, `${agentUrl(connection.registration, 'installations')}/${connection.registration.installationId}/revoke`, { session: connection.who.session, body: {} });
    assert.equal(revoke.status, 200, revoke.text);
    const revoked = await rpc(server, tokens.access_token, 'tools/list');
    assert.deepEqual([revoked.status, revoked.payload.code, revoked.payload.reason, revoked.headers.get('www-authenticate')], [401, 'CREDENTIAL_REVOKED', 'revoked', invalidHeader]);

    const logs = server.stdout + server.stderr;
    assert.ok(![tokens.access_token, tokens.refresh_token, connection.grant.code, connection.grant.verifier].some(secret => logs.includes(secret)), 'no secret in the logs');
  });

  test(`[${backend.name}] /mcp: scope is enforced per tool with 403 INSUFFICIENT_SCOPE, and the grant can be narrower than the request`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);
    const narrow = await connected(server, docs, { scope: 'envoi.agent', grantedPermissions: ['receive_agent_messages'] });
    assert.equal((await docs.get(registrationParts(narrow.grant.registrationId))).oauth.scope, 'envoi.agent');
    const { access_token: token } = narrow.tokens;

    const listed = await rpc(server, token, 'tools/list');
    const names = listed.payload.result.tools.map(tool => tool.name);
    assert.ok(names.includes('envoi_claim_work') && names.includes('envoi_list_cases'), 'receive and read tools stay');
    assert.ok(!names.includes('envoi_start_case') && !names.includes('envoi_begin_asset_upload'));
    // mcp-insufficient-scope: before the arguments are looked at (the fixture sends an empty object).
    const fixture = await remoteFixture('mcp-insufficient-scope');
    const denied = await call(server, token, 'envoi_start_case', {});
    assert.equal(denied.status, 403, denied.text);
    assert.equal(denied.payload.code, 'INSUFFICIENT_SCOPE');
    assert.equal(denied.payload.error, 'INSUFFICIENT_SCOPE');
    assertRemote('errorEnvelope', denied.payload);
    assert.equal(denied.headers.get('www-authenticate'), challenge(server, fixture.response.headers['www-authenticate']));
    const files = await call(server, token, 'envoi_begin_asset_upload', {});
    assert.equal(files.status, 403);
    assert.match(files.headers.get('www-authenticate'), /^Bearer error="insufficient_scope", scope="envoi\.files", resource_metadata="[^"]+"$/);
    // Tools the family does hold, and an unknown tool, are unchanged.
    assert.equal((await call(server, token, 'envoi_claim_work')).status, 200);
    const unknown = await call(server, token, 'envoi_not_a_tool', {});
    assert.deepEqual([unknown.status, unknown.payload.error.code], [200, -32602]);
    // The refusal is a request the credential authenticated: it counts as presence.
    assert.ok((await ownerView(server, narrow.who, narrow.registration)).connection.presence.lastSeenAt);

    // The token response named the narrower grant, and a refresh with the wider set is invalid_scope.
    assertOAuthError(await tokenPost(server, refreshParams(publicClient, narrow.tokens.refresh_token, { scope: 'envoi.agent envoi.send' })), 'invalid_scope');
    assert.equal(assertTokenResponse(await tokenPost(server, refreshParams(publicClient, narrow.tokens.refresh_token)), 'envoi.agent').scope, 'envoi.agent');

    // A credential of another kind with a missing permission keeps today's answer: no scope error, no challenge.
    const helper = await newOwner(server);
    await edit(docs, ['inboxes', helper.inbox.id, 'agents', `${helper.agent.id}.json`], value => { value.permissions = ['receive_agent_messages']; });
    const noScope = await call(server, helper.agentApiToken, 'envoi_start_case', {});
    assert.equal(noScope.status, 200);
    assert.equal(noScope.headers.get('www-authenticate'), null);
  });

  test(`[${backend.name}] /mcp: pause is 409 AGENT_PAUSED, refresh keeps working, and installations are isolated`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);
    const first = await connected(server, docs);
    const second = await connected(server, docs);

    const pause = await api(server.baseUrl, agentUrl(first.registration, 'pause'), { session: first.who.session, body: {} });
    assert.equal(pause.status, 200, pause.text);
    const paused = await call(server, first.tokens.access_token, 'envoi_agent_info');
    assert.equal(paused.status, 409);
    assert.equal(paused.payload.code, 'AGENT_PAUSED');
    assertRemote('errorEnvelope', paused.payload);
    assert.equal(paused.headers.get('www-authenticate'), null, 'a pause is not an authentication failure');
    const refreshed = assertTokenResponse(await tokenPost(server, refreshParams(publicClient, first.tokens.refresh_token)));
    assert.equal((await call(server, refreshed.access_token, 'envoi_agent_info')).status, 409, 'the new token is paused too');
    const view = await ownerView(server, first.who, first.registration);
    assert.deepEqual([view.status, view.paused, view.connection.state], ['paused', true, 'on_demand'], 'pause is the agent label; the connection stays on_demand');
    const resume = await api(server.baseUrl, agentUrl(first.registration, 'resume'), { session: first.who.session, body: {} });
    assert.equal(resume.status, 200, resume.text);
    assert.equal((await call(server, refreshed.access_token, 'envoi_agent_info')).status, 200);

    // Cross-installation isolation: each token sees its own inbox only, and never the other's.
    const infoFirst = toolResult(await call(server, first.tokens.access_token, 'envoi_agent_info'));
    const infoSecond = toolResult(await call(server, second.tokens.access_token, 'envoi_agent_info'));
    assert.notEqual(infoFirst.agentId, infoSecond.agentId);
    assert.equal(infoSecond.inboxId, second.registration.agentInboxId);
    const crossed = await api(server.baseUrl, `/api/inboxes/${second.registration.agentInboxId}/messages`, { token: first.tokens.access_token });
    assert.equal(crossed.status, 401);
    // Ending one installation changes nothing for the other.
    const end = await api(server.baseUrl, `${agentUrl(first.registration, 'installations')}/${first.registration.installationId}/revoke`, { session: first.who.session, body: {} });
    assert.equal(end.status, 200, end.text);
    assert.equal((await call(server, first.tokens.access_token, 'envoi_agent_info')).status, 401);
    assert.equal((await call(server, second.tokens.access_token, 'envoi_agent_info')).status, 200);
    assert.equal((await docs.get(second.familyPath)).revokedAt, null);
  });

  test(`[${backend.name}] /mcp: a successor's first use retires the recovery envelope, and the old refresh token is then replay`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);
    const connection = await connected(server, docs);
    const successor = assertTokenResponse(await tokenPost(server, refreshParams(publicClient, connection.tokens.refresh_token)));
    assert.ok(await docs.get(recoveryParts(connection.tokens.refresh_token)), 'the envelope exists before any successor is used');
    // Before use, a lost response is still recoverable.
    assert.equal(assertTokenResponse(await tokenPost(server, refreshParams(publicClient, connection.tokens.refresh_token))).refresh_token, successor.refresh_token);

    // token-refresh-replay: the successor is used (the outer /mcp request), which deletes the envelope.
    assert.equal((await call(server, successor.access_token, 'envoi_agent_info')).status, 200);
    assert.equal(await docs.get(recoveryParts(connection.tokens.refresh_token)), null, 'the envelope is deleted at the first use');
    assert.equal((await docs.get(accessParts(successor.access_token))).recoveryTokenHash, null);
    assert.equal((await docs.get(refreshParts(successor.refresh_token))).recoveryTokenHash, null, 'cleared on both successors');
    assertOAuthError(await tokenPost(server, refreshParams(publicClient, connection.tokens.refresh_token)), 'invalid_grant');
    const family = await docs.get(connection.familyPath);
    assert.equal(family.revokedReason, 'refresh_replay');
    const afterReplay = await call(server, successor.access_token, 'envoi_agent_info');
    assert.deepEqual([afterReplay.status, afterReplay.payload.code, afterReplay.payload.reason], [401, 'CREDENTIAL_REVOKED', 'refresh_replay']);
    const installation = await installationView(server, connection.who, connection.registration);
    assert.deepEqual([installation.status, installation.endedReason], ['ended', 'refresh_replay']);
  });

  test(`[${backend.name}] /mcp: audience, kind and client are checked on every request, and a mismatch is refused like an unknown token`, { timeout: 240000 }, async t => {
    let server = await remoteServer(t, backend);
    const docs = documents(t, server);
    const connection = await connected(server, docs);
    const { access_token: token } = connection.tokens;
    const ok = async () => (await call(server, token, 'envoi_agent_info')).status;
    assert.equal(await ok(), 200);

    // Another resource: the origin changed, so the user connects again (agent-registration §14.1).
    await edit(docs, connection.familyPath, value => { value.audience = 'https://elsewhere.example/mcp'; });
    assert.equal(await ok(), 401);
    await edit(docs, connection.familyPath, value => { value.audience = server.resource; });
    assert.equal(await ok(), 200);
    // A record that disagrees with its family (an A1 `access` record on an audience family) is refused, and logged without the token.
    const original = await docs.get(accessParts(token));
    await edit(docs, accessParts(token), value => { value.tokenType = 'access'; });
    assert.equal(await ok(), 401);
    assert.ok(!(server.stdout + server.stderr).includes(token));
    assert.match(server.stderr, /Credential kind does not match its family/);
    await docs.put(accessParts(token), original);
    assert.equal(await ok(), 200);
    // An A1 access token of a family with an audience is refused too (the family decides), so rotation cannot launder kinds.
    await edit(docs, connection.familyPath, value => { delete value.audience; delete value.oauthClientId; });
    assert.equal(await ok(), 401, 'an oauth_access record on a family with no audience');
    await edit(docs, connection.familyPath, value => { value.audience = server.resource; value.oauthClientId = publicClient.clientId; });
    assert.equal(await ok(), 200);

    // A client the operator removed is unknown, so its tokens stop working with it. Nothing is deleted.
    const configured = server.serverEnv.ENVOI_OAUTH_CLIENTS;
    server = await restart(t, server, { ENVOI_OAUTH_CLIENTS: '[]' });
    assert.equal(await ok(), 401, 'its client is no longer configured');
    assert.equal((await docs.get(connection.familyPath)).revokedAt, null, 'nothing was revoked');
    server = await restart(t, server, { ENVOI_OAUTH_CLIENTS: configured });
    assert.equal(await ok(), 200, 'the same configuration again, the same token');
  });

  test(`[${backend.name}] local-helper and legacy credentials are unchanged at /mcp, with the challenge added to a 401`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);
    const who = await newOwner(server);
    const info = toolResult(await call(server, who.agentApiToken, 'envoi_agent_info'));
    assert.equal(info.agentId, who.agent.id);
    assert.equal((await api(server.baseUrl, '/api/agent/status', { token: who.agentApiToken })).status, 200);
    await edit(docs, accessParts(who.agentApiToken), value => { value.expiresAt = PAST; });
    const expired = await call(server, who.agentApiToken, 'envoi_agent_info');
    assert.deepEqual([expired.status, expired.payload.code], [401, 'ACCESS_TOKEN_EXPIRED']);
    assert.match(expired.headers.get('www-authenticate'), /^Bearer resource_metadata="[^"]+", scope="envoi\.agent envoi\.send", error="invalid_token"$/);
    // REST never carried a challenge.
    const rest = await api(server.baseUrl, '/api/agent/status', { token: who.agentApiToken });
    assert.equal(rest.status, 401);
    assert.equal(rest.headers.get('www-authenticate'), null);
  });

  test(`[${backend.name}] owner presence: on_demand is honest, neutral and independent of age and flags`, { timeout: 240000 }, async t => {
    let server = await remoteServer(t, backend);
    const docs = documents(t, server);
    const connection = await connected(server, docs);
    const { access_token: token } = connection.tokens;
    const { registration, who } = connection;
    const presencePath = ['auth', 'agent-presence', registration.agentInboxId, registration.agentId, `${registration.credentialFamilyId}.json`];
    const waitFor = async (check, message) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const view = await ownerView(server, who, registration);
        if (check(view)) return view;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.fail(message);
    };

    // The exchange wrote no presence: "No requests yet", never never_seen.
    const none = await ownerView(server, who, registration);
    assert.deepEqual([none.connection.state, none.connection.seenAt], ['on_demand', null]);
    assert.equal(Object.values(none.connection.presence).every(value => value === null), true, 'activation writes no presence');
    // A /mcp request records lastSeenAt; the state does not become seen_recently.
    await call(server, token, 'envoi_agent_info');
    const seen = await waitFor(view => view.connection.presence.lastSeenAt, 'lastSeenAt');
    assert.equal(seen.connection.state, 'on_demand');
    assert.equal(seen.connection.seenAt, seen.connection.presence.lastSeenAt, 'the basis is lastSeenAt');
    // A refresh records lastSeenAt and lastSuccessfulRefreshAt.
    assertTokenResponse(await tokenPost(server, refreshParams(publicClient, connection.tokens.refresh_token)));
    const refreshed = await waitFor(view => view.connection.presence.lastSuccessfulRefreshAt, 'lastSuccessfulRefreshAt');
    assert.equal(refreshed.connection.state, 'on_demand');
    // Idle for nine days: still on_demand, never not_seen_recently.
    const nineDays = new Date(Date.now() - 9 * 86_400_000).toISOString();
    await edit(docs, presencePath, value => { for (const field of Object.keys(value)) if (value[field]) value[field] = nineDays; });
    assert.equal((await ownerView(server, who, registration)).connection.state, 'on_demand');
    // The three precedence rows: the rolling refresh lifetime passed, then revoked.
    const familyBefore = await docs.get(connection.familyPath);
    await edit(docs, connection.familyPath, value => { value.refreshExpiresAt = PAST; });
    assert.equal((await ownerView(server, who, registration)).connection.state, 'needs_reconnect');
    await docs.put(connection.familyPath, familyBefore);
    // Pause is the agent label, not the connection.
    await api(server.baseUrl, agentUrl(registration, 'pause'), { session: who.session, body: {} });
    const paused = await ownerView(server, who, registration);
    assert.deepEqual([paused.status, paused.connection.state], ['paused', 'on_demand']);
    await api(server.baseUrl, agentUrl(registration, 'resume'), { session: who.session, body: {} });

    // Flags off: the state is derived from the declared mode, not from configuration.
    server = await restart(t, server, { ENVOI_REMOTE_MCP_OAUTH: undefined });
    assert.equal((await ownerView(server, who, registration)).connection.state, 'on_demand');
    server = await restart(t, server, { ENVOI_REMOTE_MCP_OAUTH: 'true' });

    // An unreadable installation omits the connection and the response still succeeds; it never falls back to a running host.
    const installationPath = ['auth', 'agent-installations', registration.agentInboxId, registration.agentId, `${registration.installationId}.json`];
    const installationDoc = await docs.get(installationPath);
    await docs.remove(installationPath);
    const omitted = await ownerView(server, who, registration, { schema: false });
    assert.equal('connection' in omitted, false);
    await docs.put(installationPath, installationDoc);
    // Revoked by the client: revoked, not on_demand.
    const revokeRes = await fetch(`${server.baseUrl}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '2001:db8:77::1' }, body: new URLSearchParams({ token: token, client_id: publicClient.clientId }).toString() });
    assert.equal(revokeRes.status, 200);
    const revoked = await ownerView(server, who, registration);
    assert.deepEqual([revoked.credentialRevoked, revoked.connection.state], [true, 'revoked']);
    assertOnDemand('ownerAgentList', [revoked]);
  });

  test(`[${backend.name}] flags off is a rollback, not a deletion: tokens are refused, everything is kept, and turning a flag on restores them`, { timeout: 300000 }, async t => {
    let server = await remoteServer(t, backend);
    const docs = documents(t, server);
    const connection = await connected(server, docs);
    const spare = await connected(server, docs);
    const { access_token: token, refresh_token: refreshToken } = connection.tokens;
    assert.equal((await call(server, token, 'envoi_agent_info')).status, 200);
    const before = JSON.stringify([await docs.get(connection.familyPath), await docs.get(accessParts(token)), await docs.get(refreshParts(refreshToken))]);

    server = await restart(t, server, { ENVOI_REMOTE_MCP_OAUTH: undefined });
    // §11: 401 AUTHENTICATION_REQUIRED at /mcp, without the challenge; every endpoint is 404 FEATURE_DISABLED.
    const refused = await call(server, token, 'envoi_agent_info');
    assert.deepEqual([refused.status, refused.payload.code, refused.headers.get('www-authenticate')], [401, 'AUTHENTICATION_REQUIRED', 'Bearer realm="Envoi agent MCP"']);
    for (const route of ['/oauth/token', '/oauth/revoke']) {
      const res = await fetch(`${server.baseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=1' });
      assert.equal(res.status, 404, route);
      assert.equal((await res.json()).code, 'FEATURE_DISABLED');
    }
    assert.equal((await fetch(`${server.baseUrl}/.well-known/oauth-authorization-server`)).status, 404);
    // Nothing was revoked or deleted, and the installation stays listed, active and revocable.
    assert.equal(JSON.stringify([await docs.get(connection.familyPath), await docs.get(accessParts(token)), await docs.get(refreshParts(refreshToken))]), before, 'no stored record changed');
    const installation = await installationView(server, connection.who, connection.registration);
    assert.deepEqual([installation.status, installation.connectionRoute, installation.deliveryMode], ['active', 'remote_mcp_oauth', 'on_demand']);
    const end = await api(server.baseUrl, `${agentUrl(spare.registration, 'installations')}/${spare.registration.installationId}/revoke`, { session: spare.who.session, body: {} });
    assert.equal(end.status, 200, end.text);
    assert.equal((await installationView(server, spare.who, spare.registration)).endedReason, 'revoked');

    // Turning the flag on again restores every family that has not expired or been revoked, and refresh continues.
    server = await restart(t, server, { ENVOI_REMOTE_MCP_OAUTH: 'true' });
    assert.equal((await call(server, token, 'envoi_agent_info')).status, 200);
    assertTokenResponse(await tokenPost(server, refreshParams(publicClient, refreshToken)));
    assert.equal((await call(server, spare.tokens.access_token, 'envoi_agent_info')).status, 401, 'the revoked one stays revoked');
  });
}

test('[server] the bootstrap grant and provider clients behave like any OAuth family at /mcp, and the code never does', { timeout: 180000 }, async t => {
  const server = await remoteServer(t, backends[0], { providers: true, clients: [publicClient, confidentialClient, providerClient] });
  const docs = documents(t, server);
  const who = await newOwner(server);
  const issued = await api(server.baseUrl, '/api/oauth/bootstrap-codes', { session: who.session, body: { clientId: providerClient.clientId, target: { kind: 'new_agent', workspaceInboxId: who.inbox.parentInboxId, name: 'Provider agent', localPart: 'provider-mcp-agent' }, grantedPermissions: ['send_agent_messages', 'receive_agent_messages'], policyProfile: 'default' } });
  assert.equal(issued.status, 201, issued.text);
  const code = issued.payload.bootstrapCode;
  const asBearer = await rpc(server, code, 'tools/list');
  assert.deepEqual([asBearer.status, asBearer.payload.code], [401, 'AUTHENTICATION_REQUIRED']);
  assert.match(asBearer.headers.get('www-authenticate'), /error="invalid_token"$/);
  const exchanged = await tokenPost(server, { grant_type: 'urn:envoi:params:oauth:grant-type:bootstrap_code', bootstrap_code: code, resource: server.resource }, { basic: { id: providerClient.clientId, secret: providerSecret } });
  const tokens = assertTokenResponse(exchanged);
  assert.equal((await call(server, tokens.access_token, 'envoi_agent_info')).status, 200);
  const { family } = await stored(docs, issued.payload.registrationId);
  assert.deepEqual([family.audience, family.oauthClientId], [server.resource, providerClient.clientId]);
});
