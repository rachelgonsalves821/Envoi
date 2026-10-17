// agent-registration v1 §6.5 authorization: any workspace member may list an agent's
// installations, but only a manager (owner or admin) may end one. FileStore, through the HTTP API.
//
// There is no member-invitation route in local development mode (organization members are written
// only when an organization is created), so the second human joins the owner's organization as a
// plain member by writing the membership documents, as inbox-preferences-integration.test.js does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, launch, owner, readData, writeData } from './a3-harness.js';

const installationsRoute = who => `/api/inboxes/${who.inbox.id}/agents/${who.agent.id}/installations`;

async function addMember(server, who, member, role) {
  const organizationId = who.inbox.organizationId;
  assert.ok(organizationId, 'the agent inbox names its organization');
  await writeData(server, ['organizations', organizationId, 'members', `${member.human.id}.json`], { organizationId, humanId: member.human.id, role, status: 'active', createdAt: new Date().toISOString() });
  await writeData(server, ['humans', member.human.id, 'organizations', `${organizationId}.json`], { organizationId, role });
}

test('[FileStore] a member who is not a manager can list installations but cannot end one', { timeout: 60000 }, async t => {
  const server = await launch({ ENVOI_INSTALLATIONS_V2: 'true' });
  t.after(() => server.stop());
  const [who, member] = await Promise.all([owner(server.baseUrl, '6301'), owner(server.baseUrl, '6302')]);

  // Before joining, the other human sees nothing.
  assert.equal((await api(server.baseUrl, installationsRoute(who), { session: member.session })).status, 403);
  await addMember(server, who, member, 'member');

  const listed = await api(server.baseUrl, installationsRoute(who), { session: member.session });
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.payload.agentId, who.agent.id);
  const [installation] = listed.payload.installations;
  assert.equal(installation.status, 'active');

  const revoke = await api(server.baseUrl, `${installationsRoute(who)}/${installation.id}/revoke`, { session: member.session, body: {} });
  assert.equal(revoke.status, 403, revoke.text);
  // An unknown installation gets the same answer: a non-manager learns nothing from revoke.
  assert.equal((await api(server.baseUrl, `${installationsRoute(who)}/installation_unknown/revoke`, { session: member.session, body: {} })).status, 403);

  // Nothing ended: the installation is still active, its family is not revoked, and the agent still works.
  const after = await api(server.baseUrl, installationsRoute(who), { session: who.session });
  assert.equal(after.status, 200, after.text);
  assert.deepEqual(after.payload.installations.map(item => [item.id, item.status, item.endedAt]), [[installation.id, 'active', null]]);
  const agent = await readData(server, 'inboxes', who.inbox.id, 'agents', `${who.agent.id}.json`);
  assert.equal(agent.status, 'active');
  assert.equal((await api(server.baseUrl, '/api/agent/status', { token: who.agentApiToken })).status, 200);

  // The same human as an admin may end it, so the 403 was the role and nothing else.
  await addMember(server, who, member, 'admin');
  const managed = await api(server.baseUrl, `${installationsRoute(who)}/${installation.id}/revoke`, { session: member.session, body: {} });
  assert.equal(managed.status, 200, managed.text);
  assert.equal(managed.payload.installation.status, 'ended');
});
