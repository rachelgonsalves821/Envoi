// agent-saved-setup v1 (handoffs.md): saved Dots setups that pre-fill the owner approval page, on the real server.
// Every case runs on FileStore, and on PostgreSQL when DATABASE_URL is set (CI test:postgres).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { api, backends, connect, documents, edit, exchange, freshOwner, pkce, publicClient, remoteServer, assertTokenResponse, PAST } from './agent-remote-auth-token-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemas = JSON.parse(await readFile(path.join(here, 'contract-fixtures', 'agent-saved-setup', 'schemas.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schemas);
function assertShape(name, value) {
  const validate = ajv.getSchema(`${schemas.$id}#/definitions/${name}`);
  assert.equal(validate(value), true, `${name}: ${ajv.errorsText(validate.errors)} in ${JSON.stringify(value)}`);
}
function assertCode(res, status, code) {
  assert.equal(res.status, status, res.text);
  assert.equal(res.payload.code, code, res.text);
  assertShape('errorEnvelope', res.payload);
}

const enabled = { ENVOI_SAVED_SETUP: 'true' };
const setupsRoute = who => `/api/inboxes/${who.inbox.parentInboxId}/agent-setups`;
const localPart = () => `milo-${crypto.randomBytes(3).toString('hex')}`;
const save = (server, who, body) => api(server.baseUrl, setupsRoute(who), { session: who.session, body });
const statusOf = (server, who, setupId) => api(server.baseUrl, `${setupsRoute(who)}/${setupId}`, { session: who.session });
const setupParts = (who, setupId) => ['saved-setups', who.human.id, `${setupId}.json`];

// The assistant's authorization request, without approving it: returns its handle and PKCE pair.
async function authorize(server, scope) {
  const { verifier, challenge } = pkce();
  const redirectUri = 'http://127.0.0.1:53682/callback';
  const query = new URLSearchParams({ response_type: 'code', client_id: publicClient.clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', resource: server.resource, scope, state: 'saved-setup-state' });
  const authorized = await fetch(`${server.baseUrl}/oauth/authorize?${query}`, { redirect: 'manual' });
  assert.equal(authorized.status, 302);
  return { handle: new URL(authorized.headers.get('location')).searchParams.get('request'), verifier, redirectUri, client: publicClient };
}
const consentRoute = request => `/api/oauth/authorization-requests/${encodeURIComponent(request.handle)}`;
const approve = (server, who, request, body) => api(server.baseUrl, `${consentRoute(request)}/approve`, { session: who.session, body });
const approveBody = (who, saved, savedSetupId) => ({ target: { kind: 'new_agent', workspaceInboxId: who.inbox.parentInboxId, name: saved.name, localPart: saved.localPart },
  grantedPermissions: ['receive_agent_messages'], policyProfile: 'default', ...(savedSetupId ? { savedSetupId } : {}) });

for (const backend of backends) {
  test(`[${backend.name}] flag off: routes are FEATURE_DISABLED, the consent view is unchanged and savedSetupId never links`, { timeout: 120000 }, async t => {
    const server = await remoteServer(t, backend);
    const who = await freshOwner(server);
    assertCode(await save(server, who, { runtime: 'dots', name: 'Milo', localPart: localPart(), permissions: [] }), 404, 'FEATURE_DISABLED');
    const request = await authorize(server, 'envoi.agent envoi.send');
    const view = await api(server.baseUrl, consentRoute(request), { session: who.session });
    assert.equal(view.status, 200, view.text);
    assert.equal('savedSetup' in view.payload, false);
    const approved = await approve(server, who, request, approveBody(who, { name: 'Milo', localPart: localPart() }, 'setup_never_saved'));
    assert.equal(approved.status, 200, approved.text);
    assert.deepEqual(approved.payload.savedSetup, { setupId: 'setup_never_saved', linked: false });
    assertShape('consentApprovedWithSavedSetup', approved.payload);
  });

  test(`[${backend.name}] save, replace, pre-fill, link, connect: the saved setup follows the approval`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend, { env: enabled });
    const docs = documents(t, server);
    const who = await freshOwner(server);
    const other = await freshOwner(server);

    // §2: save, with receiving added when it is left out; precedence of the body and address checks.
    assertCode(await save(server, who, { runtime: 'openclaw', name: 'Milo', localPart: localPart(), permissions: [] }), 400, 'SETUP_INVALID');
    assertCode(await save(server, who, { runtime: 'dots', name: 'Milo', localPart: 'Not valid!', permissions: [] }), 400, 'SETUP_INVALID');
    assertCode(await save(server, who, { runtime: 'dots', name: 'Milo', localPart: localPart(), permissions: ['spend_money'] }), 400, 'SETUP_INVALID');
    const held = await connect(server, other);
    assertCode(await save(server, who, { runtime: 'dots', name: 'Milo', localPart: held.body.target.localPart, permissions: [] }), 409, 'ADDRESS_TAKEN');
    const first = await save(server, who, { runtime: 'dots', name: 'Milo', localPart: localPart(), permissions: [] });
    assert.equal(first.status, 201, first.text);
    assert.equal(first.headers?.get?.('cache-control') ?? 'no-store', 'no-store');
    assertShape('savedSetup', first.payload);
    assert.equal(first.payload.status, 'waiting');
    assert.deepEqual(first.payload.permissions, ['receive_agent_messages']);

    // One live setup per human per runtime: the next save replaces the first.
    const saved = (await save(server, who, { runtime: 'dots', name: 'Milo', localPart: localPart(), permissions: ['send_agent_messages', 'receive_agent_messages'] })).payload;
    assert.deepEqual(saved.permissions, ['receive_agent_messages', 'send_agent_messages']);
    const replaced = await statusOf(server, who, first.payload.setupId);
    assert.equal(replaced.payload.status, 'replaced');
    assertShape('savedSetup', replaced.payload);

    // §3: only the human who saved it can read it.
    assertCode(await statusOf(server, other, saved.setupId), 404, 'SETUP_NOT_FOUND');
    assertCode(await statusOf(server, who, 'setup_unknown'), 404, 'SETUP_NOT_FOUND');

    // §4: the approval page of a receive-only request carries the newest waiting setup, with notRequested.
    const request = await authorize(server, 'envoi.agent');
    const view = await api(server.baseUrl, consentRoute(request), { session: who.session });
    assert.equal(view.status, 200, view.text);
    assertShape('consentViewWithSavedSetup', view.payload);
    assert.equal(view.payload.savedSetup.setupId, saved.setupId);
    assert.deepEqual(view.payload.savedSetup.notRequested, ['send_agent_messages']);
    assert.equal(view.payload.savedSetup.addressAvailable, true);
    const otherView = await api(server.baseUrl, consentRoute(await authorize(server, 'envoi.agent')), { session: other.session });
    assert.equal('savedSetup' in otherView.payload, false, 'another human never sees this setup');

    // §5: an unusable id never blocks an approval; a usable one links inside the approval.
    const third = await freshOwner(server);
    const stale = await approve(server, third, await authorize(server, 'envoi.agent'), approveBody(third, { name: 'Other', localPart: localPart() }, first.payload.setupId));
    assert.equal(stale.status, 200, stale.text);
    assert.equal(stale.payload.savedSetup.linked, false);
    const approved = await approve(server, who, request, approveBody(who, saved, saved.setupId));
    assert.equal(approved.status, 200, approved.text);
    assertShape('consentApprovedWithSavedSetup', approved.payload);
    assert.deepEqual(approved.payload.savedSetup, { setupId: saved.setupId, linked: true });
    const retry = await approve(server, who, request, approveBody(who, saved, saved.setupId));
    assert.equal(retry.status, 200, retry.text);
    assert.equal(retry.payload.status, 'pending_exchange', 'an identical retry is the unchanged consentDecided');
    const pending = await statusOf(server, who, saved.setupId);
    assertShape('savedSetup', pending.payload);
    assert.equal(pending.payload.status, 'approved');
    assert.equal(pending.payload.agent.address, saved.address);

    // The exchange activates the agent: connected, not yet seen.
    const code = new URL(approved.payload.redirectTo).searchParams.get('code');
    assertTokenResponse(await exchange(server, { ...request, code }), 'envoi.agent');
    const connected = await statusOf(server, who, saved.setupId);
    assertShape('savedSetup', connected.payload);
    assert.equal(connected.payload.status, 'connected');
    assert.equal(connected.payload.agent.lastSeenAt, null);
    assert.deepEqual(connected.payload.effectivePermissions, ['receive_agent_messages']);

    // §3 expiry: a waiting setup past expiresAt reads as expired (not_used) and pre-fills nothing.
    const later = (await save(server, who, { runtime: 'dots', name: 'Later', localPart: localPart(), permissions: [] })).payload;
    await edit(docs, setupParts(who, later.setupId), record => { record.expiresAt = PAST; });
    const expired = await statusOf(server, who, later.setupId);
    assert.equal(expired.payload.status, 'expired');
    assert.equal(expired.payload.reason, 'not_used');
    const afterExpiry = await api(server.baseUrl, consentRoute(await authorize(server, 'envoi.agent')), { session: who.session });
    assert.equal('savedSetup' in afterExpiry.payload, false);
  });
}
