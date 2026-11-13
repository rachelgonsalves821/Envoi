// agent-owner-permissions v1 revision 2 (handoffs.md): the owner's choice wins on the approval and Permissions pages behind
// ENVOI_OWNER_PERMISSIONS, and a refresh scope parameter only has to name known scopes in any flag state.
// Every case runs on FileStore, and on PostgreSQL when DATABASE_URL is set (CI test:postgres).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  api, assertOAuthError, assertRemote, assertTokenResponse, backends, connect, documents, exchange, freshOwner, pkce, publicClient, refreshParams,
  remoteServer, stored, tokenPost
} from './agent-remote-auth-token-harness.js';

const enabled = { ENVOI_OWNER_PERMISSIONS: 'true' };
const receive = ['receive_agent_messages'];
const both = ['receive_agent_messages', 'send_agent_messages'];
const scoped = ['receive_agent_messages', 'send_agent_messages', 'create_assets', 'execute_cases'];

// The assistant's authorization request for a scope, without approving it.
async function authorize(server, scope) {
  const { challenge } = pkce();
  const query = new URLSearchParams({ response_type: 'code', client_id: publicClient.clientId, redirect_uri: 'http://127.0.0.1:53682/callback', code_challenge: challenge, code_challenge_method: 'S256', resource: server.resource, scope, state: 'owner-permissions' });
  const authorized = await fetch(`${server.baseUrl}/oauth/authorize?${query}`, { redirect: 'manual' });
  assert.equal(authorized.status, 302);
  return new URL(authorized.headers.get('location')).searchParams.get('request');
}
const consentView = (server, who, handle) => api(server.baseUrl, `/api/oauth/authorization-requests/${encodeURIComponent(handle)}`, { session: who.session });

// A connected agent whose client asked for `scope`, approved with `grantedPermissions`.
async function connected(server, docs, scope, grantedPermissions) {
  const who = await freshOwner(server);
  const grant = await connect(server, who, { scope, grantedPermissions });
  const exchanged = await exchange(server, grant);
  assert.equal(exchanged.status, 200, exchanged.text);
  const { registration } = await stored(docs, grant.registrationId);
  return { who, grant, tokens: exchanged.payload, registration };
}
const setPermissions = (server, agent, permissions, expectedPermissions) => api(server.baseUrl,
  `/api/inboxes/${agent.registration.agentInboxId}/agents/${agent.registration.agentId}/permissions`, { session: agent.who.session, body: { permissions, expectedPermissions } });
const refresh = (server, token, scope) => tokenPost(server, refreshParams(publicClient, token, scope === undefined ? {} : { scope }));

for (const backend of backends) {
  test(`[${backend.name}] flag on: the approval page and Permissions page grant the owner's choice, and renewals keep working`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend, { env: enabled });
    const docs = documents(t, server);

    // §2: the client asked for envoi.agent only; every OAuth-scoped permission is grantable.
    const who = await freshOwner(server);
    const view = await consentView(server, who, await authorize(server, 'envoi.agent'));
    assert.equal(view.status, 200, view.text);
    assertRemote('consentView', view.payload);
    assert.deepEqual(view.payload.requestedPermissions, receive);
    assert.deepEqual(view.payload.grantablePermissions, scoped);

    // §2 and §6.1: the owner grants Send; the token reports it.
    const dot = await connected(server, docs, 'envoi.agent', both);
    assert.deepEqual(dot.grant.approved.effectivePermissions, both);
    assertRemote('consentApproved', dot.grant.approved);
    assertRemote('tokenResponse', dot.tokens);
    assert.equal(dot.tokens.scope, 'envoi.agent envoi.send', 'the code exchange reports the granted scopes');
    const { registration: record } = await stored(docs, dot.grant.registrationId);
    assert.deepEqual(record.requested.permissions, receive, 'the registration still records what the client requested');

    // §4: re-sending the scope it first asked for renews with the current scopes; an unknown scope is refused.
    assertOAuthError(await refresh(server, dot.tokens.refresh_token, 'envoi.agent envoi.email'), 'invalid_scope');
    const renewed = assertTokenResponse(await refresh(server, dot.tokens.refresh_token, 'envoi.agent'), 'envoi.agent envoi.send');

    // §4 recovery: a lost response, then Send removed, then the identical retry gets the identical response;
    // the successor then reports the current scopes.
    const lost = await refresh(server, renewed.refresh_token, 'envoi.agent envoi.send');
    assert.equal(lost.status, 200, lost.text);
    const removed = await setPermissions(server, dot, receive, both);
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(removed.payload.agent.permissions, receive);
    const retried = await refresh(server, renewed.refresh_token, 'envoi.agent envoi.send');
    assert.equal(retried.status, 200, retried.text);
    assert.deepEqual(retried.payload, lost.payload, 'recovery re-delivers the identical response');
    assert.equal(assertTokenResponse(await refresh(server, lost.payload.refresh_token, 'envoi.agent envoi.send'), 'envoi.agent').scope, 'envoi.agent');

    // §3: a receive-only OAuth agent gains Send with no reconnect; a permission without a scope still needs one.
    const plain = await connected(server, docs, 'envoi.agent', receive);
    assert.equal(plain.tokens.scope, 'envoi.agent');
    const added = await setPermissions(server, plain, both, receive);
    assert.equal(added.status, 200, added.text);
    assert.deepEqual(added.payload.agent.permissions, both);
    const unscoped = await setPermissions(server, plain, ['receive_agent_messages', 'send_agent_messages', 'use_email_transport'], both);
    assert.deepEqual([unscoped.status, unscoped.payload.code], [409, 'OAUTH_RECONSENT_REQUIRED']);
    const withoutReceive = await setPermissions(server, plain, ['send_agent_messages'], both);
    assert.equal(withoutReceive.status, 400, 'Receive stays mandatory');
    assert.equal(assertTokenResponse(await refresh(server, plain.tokens.refresh_token, 'envoi.agent'), 'envoi.agent envoi.send').scope, 'envoi.agent envoi.send');
  });

  test(`[${backend.name}] flag off: agent-remote-auth's approval and reconsent rules are unchanged, and §4 still holds`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);

    const who = await freshOwner(server);
    const view = await consentView(server, who, await authorize(server, 'envoi.agent'));
    assert.deepEqual(view.payload.grantablePermissions, receive, 'grantable is requested ∩ organization maximum');
    const plain = await connected(server, docs, 'envoi.agent', both);
    assert.deepEqual(plain.grant.approved.effectivePermissions, receive, 'Send was not requested, so it is not granted');
    const added = await setPermissions(server, plain, both, receive);
    assert.deepEqual([added.status, added.payload.code], [409, 'OAUTH_RECONSENT_REQUIRED']);

    // §4 in any flag state: the owner removes Send and the client still re-sends the wider scope it asked for.
    const dot = await connected(server, docs, 'envoi.agent envoi.send', both);
    assert.equal((await setPermissions(server, dot, receive, both)).status, 200);
    assert.equal(assertTokenResponse(await refresh(server, dot.tokens.refresh_token, 'envoi.agent envoi.send'), 'envoi.agent').scope, 'envoi.agent');
  });
}
