// agent-registration v1 revision 4 (§5.3 Owner-UI eligibility, §6.5): after the owner revokes an agent's only
// installation, the owner view reports it revoked (a5-presence v1) but it is not frozen, not even across a restart
// that reruns the startup reconciliation, and an existing_agent approval with replacesInstallationId null reconnects
// the same identity. An agent frozen by the agent-wide revoke stays AGENT_NOT_RECONNECTABLE. Gate B-local row 18
// failed on this at 7baaf63. FileStore always, PostgreSQL when DATABASE_URL is set (CI test:postgres).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { agentStatus, api, owner, revokeAgent, send } from './a3-harness.js';
import { approveBody, approveRequest, assertCode, assertContract, backends, documents, launchRegistration, newAgentTarget, registered } from './agent-registration-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const presence = JSON.parse(await readFile(path.join(here, 'contract-fixtures', 'a5-presence', 'schemas.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(presence);
function assertOwnerAgentList(value) {
  const validate = ajv.getSchema(`${presence.$id}#/definitions/ownerAgentList`);
  assert.ok(validate(value), `ownerAgentList: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}

const suffixes = { FileStore: '88', PostgreSQL: '89' };
const markerParts = ['system', 'agent-revocations-reconciled-v1.json'];
const code = created => created.claim.verificationCode;
const unique = () => `a${Math.random().toString(36).slice(2, 10)}`;
const activate = (baseUrl, created) => api(baseUrl, '/api/agent-installations/activate', {
  token: created.bootstrapToken,
  body: { registrationId: created.registrationId, activationId: `activation_${crypto.randomBytes(6).toString('hex')}`, deliveryMode: 'envoi_link' }
});
const installationsRoute = (inboxId, agentId) => `/api/inboxes/${inboxId}/agents/${agentId}/installations`;
// §5.3, Owner-UI eligibility: the rows "Reconnect an existing agent" offers.
const offersReconnect = agent => agent.onboardingStatus === 'approved' && (['active', 'paused'].includes(agent.status) || agent.credentialRevoked === true);

async function ownerRow(baseUrl, who, inboxId, agentId) {
  const res = await api(baseUrl, `/api/inboxes/${inboxId}/agents`, { session: who.session });
  assert.equal(res.status, 200, res.text);
  assertOwnerAgentList(res.payload);
  const row = res.payload.find(item => item.id === agentId);
  assert.ok(row, `owner view lists ${agentId}`);
  return row;
}

async function history(baseUrl, who, inboxId) {
  const [cases, messages] = await Promise.all([
    api(baseUrl, `/api/inboxes/${inboxId}/cases`, { session: who.session }),
    api(baseUrl, `/api/inboxes/${inboxId}/messages`, { session: who.session })
  ]);
  assert.equal(cases.status, 200, cases.text);
  assert.equal(messages.status, 200, messages.text);
  const list = value => Array.isArray(value) ? value : value.cases || value.messages || value.items;
  return { caseIds: list(cases.payload).map(item => item.id || item.caseId), messageIds: list(messages.payload).map(item => item.id) };
}

for (const backend of backends) {
  const s = suffixes[backend.name];

  test(`[${backend.name}] a revoked-only-installation agent is offered and reconnects as the same identity, also after a restart`, { timeout: 150000 }, async t => {
    let server = await launchRegistration(backend);
    t.after(() => server.stop());
    const who = await owner(server.baseUrl, `${s}01`);

    // Register, approve and activate a new agent through the local_helper route.
    const localPart = unique();
    const created = await registered(server.baseUrl, { requestedLocalPart: localPart });
    const approved = await approveRequest(server.baseUrl, who, created.registrationId, approveBody(code(created), newAgentTarget(who, localPart, 'Reconnect agent')));
    assert.equal(approved.status, 200, approved.text);
    const first = await activate(server.baseUrl, created);
    assert.equal(first.status, 201, first.text);
    assertContract('activated', first.payload);
    const { agent, inboxId, installation } = first.payload;
    assert.equal(installation.connectionRoute, 'local_helper');

    // History to keep: one case with one message from this agent.
    const caseId = `case_rev4_${s}_${crypto.randomBytes(4).toString('hex')}`;
    const sent = await send(server.baseUrl, { inbox: { id: inboxId }, agent, agentApiToken: first.payload.agentApiToken }, who, { caseId, text: 'Before the revoke' });
    assert.equal(sent.status, 202, sent.text);
    const before = await history(server.baseUrl, who, inboxId);
    assert.ok(before.caseIds.includes(caseId), `the case is listed: ${before.caseIds}`);
    assert.ok(before.messageIds.includes(sent.payload.id), 'the message is listed');

    // The owner revokes the only installation (§6.5).
    const revoked = await api(server.baseUrl, `${installationsRoute(inboxId, agent.id)}/${installation.id}/revoke`, { session: who.session, body: {} });
    assert.equal(revoked.status, 200, revoked.text);
    assertContract('installationRevoked', revoked.payload);
    assert.equal((await agentStatus(server.baseUrl, first.payload.agentApiToken)).payload?.code, 'CREDENTIAL_REVOKED');

    // The owner view matches a5-presence v1 (fixture owner-revoked-refresh-replay), and the UI offers the agent.
    const expectedRow = { status: 'revoked', credentialRevoked: true, onboardingStatus: 'approved', permissions: [], paused: false, state: 'revoked' };
    const viewRow = row => ({ status: row.status, credentialRevoked: row.credentialRevoked, onboardingStatus: row.onboardingStatus, permissions: row.permissions, paused: row.paused, state: row.connection?.state });
    const afterRevoke = await ownerRow(server.baseUrl, who, inboxId, agent.id);
    assert.deepEqual(viewRow(afterRevoke), expectedRow);
    assert.equal(offersReconnect(afterRevoke), true, 'revision 4: the owner UI offers it for reconnect');

    // A restart that reruns the startup reconciliation does not freeze it.
    const docs = () => documents(t, backend, server);
    const agentParts = ['inboxes', inboxId, 'agents', `${agent.id}.json`];
    assert.ok(await docs().get(markerParts), 'the reconciliation ran at boot');
    await server.stop(true);
    const dataDir = backend.name === 'FileStore' ? server.dataDir : null;
    await documents(t, backend, server).remove(markerParts);
    server = await launchRegistration(backend, {}, dataDir);
    assert.ok(await docs().get(markerParts), 'the reconciliation ran again after the restart');
    const stored = await docs().get(agentParts);
    assert.deepEqual({ status: stored.status, onboardingStatus: stored.onboardingStatus }, { status: 'active', onboardingStatus: 'approved' }, 'the identity is not frozen');
    const afterRestart = await ownerRow(server.baseUrl, who, inboxId, agent.id);
    assert.deepEqual(viewRow(afterRestart), expectedRow);
    assert.equal(offersReconnect(afterRestart), true, 'still offered after the restart');

    // A new registration attaches to the same identity: replacesInstallationId is null, since none is active.
    const again = await registered(server.baseUrl, { runtime: { type: 'openclaw', version: null } });
    const attach = await approveRequest(server.baseUrl, who, again.registrationId, approveBody(code(again), { kind: 'existing_agent', agentId: agent.id, replacesInstallationId: null }, ['send_agent_messages', 'receive_agent_messages']));
    assert.equal(attach.status, 200, attach.text);
    assertContract('claimApproved', attach.payload);
    assert.deepEqual(attach.payload.agent, { id: agent.id, name: attach.payload.agent.name, address: agent.address });
    const reconnected = await activate(server.baseUrl, again);
    assert.equal(reconnected.status, 201, reconnected.text);
    assertContract('activated', reconnected.payload);
    assert.deepEqual([reconnected.payload.agent.id, reconnected.payload.agent.address, reconnected.payload.inboxId], [agent.id, agent.address, inboxId], 'same agentId, address and inbox');
    assert.equal((await agentStatus(server.baseUrl, reconnected.payload.agentApiToken)).status, 200, 'the new installation connects');

    // The new installation is active, the old one ended by the revoke.
    const listed = await api(server.baseUrl, installationsRoute(inboxId, agent.id), { session: who.session });
    assert.equal(listed.status, 200, listed.text);
    assertContract('ownerInstallationList', listed.payload);
    assert.deepEqual(listed.payload.installations.map(item => [item.id, item.status, item.endedReason]),
      [[reconnected.payload.installation.id, 'active', null], [installation.id, 'ended', 'revoked']]);

    // Earlier cases and messages are still listed.
    const after = await history(server.baseUrl, who, inboxId);
    assert.ok(after.caseIds.includes(caseId), 'the case is still listed');
    assert.ok(after.messageIds.includes(sent.payload.id), 'the message is still listed');

    // The owner's events announce the activation for the same agent.
    const events = await api(server.baseUrl, `/api/inboxes/${inboxId}/events/delta?limit=200`, { session: who.session });
    assert.equal(events.status, 200, events.text);
    const activatedEvent = events.payload.events.find(event => event.type === 'agent.installation_activated' && event.installationId === reconnected.payload.installation.id);
    assert.ok(activatedEvent, events.payload.events.map(event => event.type).join(','));
    assert.deepEqual([activatedEvent.agentId, activatedEvent.target], [agent.id, 'existing_agent']);
    assert.ok(!events.payload.events.some(event => event.type === 'agent.revocation_reconciled'), 'nothing was reconciled');

    const row = await ownerRow(server.baseUrl, who, inboxId, agent.id);
    assert.deepEqual([row.status, row.credentialRevoked, row.onboardingStatus], ['active', false, 'approved']);
  });

  test(`[${backend.name}] an agent frozen by the agent-wide revoke is not offered and gets AGENT_NOT_RECONNECTABLE`, { timeout: 90000 }, async t => {
    const server = await launchRegistration(backend);
    t.after(() => server.stop());
    const who = await owner(server.baseUrl, `${s}11`);
    await revokeAgent(server.baseUrl, who);
    const frozen = await ownerRow(server.baseUrl, who, who.inbox.id, who.agent.id);
    assert.deepEqual([frozen.status, frozen.credentialRevoked, frozen.onboardingStatus], ['revoked', true, 'revoked'], 'a freeze writes onboardingStatus revoked');
    assert.equal(offersReconnect(frozen), false, 'revision 4: the owner UI does not offer a frozen agent');
    const created = await registered(server.baseUrl);
    assertCode(await approveRequest(server.baseUrl, who, created.registrationId, approveBody(code(created), { kind: 'existing_agent', agentId: who.agent.id, replacesInstallationId: null })), 'AGENT_NOT_RECONNECTABLE');
    const stored = await documents(t, backend, server).get(['inboxes', who.inbox.id, 'agents', `${who.agent.id}.json`]);
    assert.deepEqual({ status: stored.status, onboardingStatus: stored.onboardingStatus }, { status: 'revoked', onboardingStatus: 'revoked' });
  });
}
