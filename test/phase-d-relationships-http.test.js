import test from 'node:test';
import assert from 'node:assert/strict';
import { api, launch, owner, readStored } from './a3-harness.js';

// Every Phase D HTTP check runs on FileStore and, when DATABASE_URL is set (npm run test:postgres),
// on PostgreSQL. PostgreSQL runs use their own owner phone and slug prefix in the shared database.
const backends = [{ name: 'FileStore', env: {}, prefix: '74' }, ...(process.env.DATABASE_URL
  ? [{ name: 'PostgreSQL', env: { DATABASE_URL: process.env.DATABASE_URL }, prefix: '76' }] : [])];

for (const backend of backends) {
  test(`[${backend.name}] Phase D relationships are flagged, managed, directed, and reversible`, { timeout: 60000 }, async t => {
    const server = await launch({ ...backend.env, ENVOI_RELATIONSHIPS_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true' });
    t.after(() => server.stop());
    const [alice, bob] = await Promise.all([owner(server.baseUrl, `${backend.prefix}01`), owner(server.baseUrl, `${backend.prefix}02`)]);
    const route = `/api/inboxes/${alice.inbox.id}`;
    const ownerDiscovery = `${route}/discovery?address=${encodeURIComponent(bob.agent.address)}`;
    const ownerView = await api(server.baseUrl, `${route}/human-view`, { session: alice.session });
    assert.equal(ownerView.status, 200, ownerView.text);
    assert.ok(ownerView.payload.capabilities.includes('manage_agent_relationships'));
    assert.equal((await api(server.baseUrl, `${route}/human-view`)).status, 401);
    const exact = await api(server.baseUrl, `/api/agent/discovery?address=${encodeURIComponent(bob.agent.address)}`, { token: alice.agentApiToken });
    assert.equal(exact.status, 200, exact.text);
    assert.equal(exact.payload.trust, 'exact_address');
    assert.deepEqual(exact.payload.grants, []);
    assert.equal((await api(server.baseUrl, `${route}/discovery`, { session: alice.session })).status, 400);
    assert.equal((await api(server.baseUrl, `${route}/relationships`, { body: { actorAgentId: alice.agent.id, targetAddress: bob.agent.address, grants: ['shareAssets'] } })).status, 403);

    const granted = await api(server.baseUrl, `${route}/relationships`, { session: alice.session, body: { actorAgentId: alice.agent.id, targetAddress: bob.agent.address, grants: ['shareAssets'] } });
    assert.equal(granted.status, 200, granted.text);
    assert.equal(granted.payload.status, 'active');
    const trusted = await api(server.baseUrl, `/api/agent/discovery?address=${encodeURIComponent(bob.agent.address)}`, { token: alice.agentApiToken });
    assert.equal(trusted.status, 200, trusted.text);
    assert.equal(trusted.payload.trust, 'relationship');
    assert.deepEqual(trusted.payload.grants, ['shareAssets']);
    const inferred = await api(server.baseUrl, ownerDiscovery, { session: alice.session });
    assert.equal(inferred.status, 200, inferred.text);
    assert.equal(inferred.payload.trust, 'relationship');
    const withoutOwnerAgent = await api(server.baseUrl, '/api/inboxes', {
      session: alice.session, body: { name: 'Phase D workspace without an owner agent' }
    });
    assert.equal(withoutOwnerAgent.status, 201, withoutOwnerAgent.text);
    assert.equal((await api(server.baseUrl, `/api/inboxes/${withoutOwnerAgent.payload.id}/discovery?address=${encodeURIComponent(bob.agent.address)}`, { session: alice.session })).status, 404);
    const reverse = await api(server.baseUrl, `/api/agent/discovery?address=${encodeURIComponent(alice.agent.address)}`, { token: bob.agentApiToken });
    assert.equal(reverse.status, 200, reverse.text);
    assert.equal(reverse.payload.trust, 'exact_address');

    assert.equal((await api(server.baseUrl, `/api/inboxes/${bob.inbox.id}/contacts/${alice.agent.id}/block`, { session: bob.session, body: {} })).status, 200);
    assert.equal((await api(server.baseUrl, `/api/agent/discovery?address=${encodeURIComponent(bob.agent.address)}`, { token: alice.agentApiToken })).status, 404);
    assert.equal((await api(server.baseUrl, `${route}/discovery?address=${encodeURIComponent(bob.agent.address)}&actorAgentId=${alice.agent.id}`, { session: alice.session })).status, 404);
    assert.equal((await api(server.baseUrl, ownerDiscovery, { session: alice.session })).status, 404);

    const revoked = await api(server.baseUrl, `${route}/relationships/${alice.agent.id}/${bob.agent.id}/revoke`, { session: alice.session, body: {} });
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal(revoked.payload.status, 'revoked');
    assert.equal((await api(server.baseUrl, `/api/agent/discovery?address=${encodeURIComponent(bob.agent.address)}`, { token: alice.agentApiToken })).status, 404);
    const blocked = await api(server.baseUrl, `${route}/relationships`, { session: alice.session, body: { actorAgentId: alice.agent.id, targetAddress: bob.agent.address, grants: ['shareAssets'] } });
    assert.equal(blocked.status, 409, blocked.text);
  });

  test(`[${backend.name}] Phase D discovery is absent when its flag is off`, { timeout: 30000 }, async t => {
    const server = await launch(backend.env);
    t.after(() => server.stop());
    const who = await owner(server.baseUrl, `${backend.prefix}03`);
    const result = await api(server.baseUrl, `/api/agent/discovery?address=${encodeURIComponent(who.agent.address)}`, { token: who.agentApiToken });
    assert.equal(result.status, 404, result.text);
    assert.equal(result.payload.code, 'FEATURE_DISABLED');
    const view = await api(server.baseUrl, `/api/inboxes/${who.inbox.id}/human-view`, { session: who.session });
    assert.equal(view.status, 200, view.text);
    assert.ok(!view.payload.capabilities.includes('manage_agent_relationships'));
    assert.equal((await api(server.baseUrl, '/api/phase-d/availability')).status, 404);
  });

  test(`[${backend.name}] Phase D authorization runs on canonical Case creation and event append`, { timeout: 30000 }, async t => {
    const server = await launch({ ...backend.env, ENVOI_RELATIONSHIPS_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true' });
    t.after(() => server.stop());
    const who = await owner(server.baseUrl, `${backend.prefix}04`);
    const cases = `/api/inboxes/${who.inbox.id}/cases`;
    const created = await api(server.baseUrl, cases, { token: who.agentApiToken, body: { objective: 'Phase D authorization check' } });
    assert.equal(created.status, 201, created.text);
    const event = await api(server.baseUrl, `${cases}/${created.payload.id}/events`, { token: who.agentApiToken, body: { type: 'message', payload: { text: 'Authorized event' } } });
    assert.equal(event.status, 201, event.text);
    const current = await api(server.baseUrl, `${cases}/${created.payload.id}`, { token: who.agentApiToken });
    assert.equal(current.status, 200, current.text);
    assert.equal(current.payload.events.some(item => item.id === event.payload.id), true);
  });

  test(`[${backend.name}] Phase D organization discovery stays inside the caller organization`, { timeout: 30000 }, async t => {
    const server = await launch({ ...backend.env, ENVOI_RELATIONSHIPS_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true' });
    t.after(() => server.stop());
    const alice = await owner(server.baseUrl, `${backend.prefix}05`);
    const outsider = await owner(server.baseUrl, `${backend.prefix}06`);
    const workspace = await api(server.baseUrl, '/api/inboxes', { session: alice.session, body: { name: 'Same org agent', organizationId: alice.inbox.organizationId } });
    assert.equal(workspace.status, 201, workspace.text);
    const enrollment = await api(server.baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { session: alice.session, body: { permissions: ['send_agent_messages', 'receive_agent_messages'] } });
    assert.equal(enrollment.status, 201, enrollment.text);
    const enrolled = await api(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: enrollment.payload.enrollmentToken, name: 'Same org agent', slug: `same-org-agent-${backend.prefix}` } });
    assert.equal(enrolled.status, 201, enrolled.text);
    const other = enrolled.payload;
    const exact = await api(server.baseUrl, `/api/agent/discovery?address=${encodeURIComponent(other.agent.address)}`, { token: alice.agentApiToken });
    assert.equal(exact.status, 200, exact.text);
    assert.equal(exact.payload.trust, 'same_organization');
    const listed = await api(server.baseUrl, '/api/agent/discovery?scope=organization&limit=1', { token: alice.agentApiToken });
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(listed.payload.agents.map(agent => agent.agentId), [other.agent.id]);
    assert.equal(listed.payload.nextCursor, null);
    assert.equal(listed.payload.agents.some(agent => agent.agentId === outsider.agent.id), false);
    assert.equal((await api(server.baseUrl, '/api/agent/discovery?scope=organization&limit=51', { token: alice.agentApiToken })).status, 400);
  });

  test(`[${backend.name}] signed discovery invitations are audience-bound, revocable, and never stored raw`, { timeout: 30000 }, async t => {
    const server = await launch({ ...backend.env, ENVOI_RELATIONSHIPS_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true' });
    t.after(() => server.stop());
    const [alice, bob] = await Promise.all([owner(server.baseUrl, `${backend.prefix}07`), owner(server.baseUrl, `${backend.prefix}08`)]);
    const route = `/api/inboxes/${alice.inbox.id}/discovery-invitations`;
    const issued = await api(server.baseUrl, route, { session: alice.session, body: { actorAgentId: alice.agent.id, recipientAddress: bob.agent.address } });
    assert.equal(issued.status, 201);
    assert.match(issued.payload.invitation, /^envoi_inv1_/);
    const stored = await readStored(server, backend.env.DATABASE_URL, 'inboxes', alice.inbox.id, 'discovery-invitations', `${issued.payload.id}.json`);
    assert.equal(stored.status, 'active');
    assert.equal(JSON.stringify(stored).includes(issued.payload.invitation), false);
    const discover = token => api(server.baseUrl, '/api/agent/discovery/invitation', { token, body: { invitation: issued.payload.invitation } });
    assert.equal((await discover(alice.agentApiToken)).status, 404);
    const accepted = await discover(bob.agentApiToken);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.payload.agentId, alice.agent.id);
    assert.equal(accepted.payload.trust, 'signed_invitation');
    const revoked = await api(server.baseUrl, `${route}/${issued.payload.id}/revoke`, { session: alice.session, body: {} });
    assert.equal(revoked.status, 200);
    assert.equal((await discover(bob.agentApiToken)).status, 404);
  });
}
