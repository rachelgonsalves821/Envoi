import test from 'node:test';
import assert from 'node:assert/strict';
import { api, launch, owner } from './a3-harness.js';

test('[FileStore] Phase D relationships are flagged, managed, directed, and reversible', { timeout: 60000 }, async t => {
  const server = await launch({ ENVOI_RELATIONSHIPS_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true' });
  t.after(() => server.stop());
  const [alice, bob] = await Promise.all([owner(server.baseUrl, '7401'), owner(server.baseUrl, '7402')]);
  const route = `/api/inboxes/${alice.inbox.id}`;
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
  const reverse = await api(server.baseUrl, `/api/agent/discovery?address=${encodeURIComponent(alice.agent.address)}`, { token: bob.agentApiToken });
  assert.equal(reverse.status, 200, reverse.text);
  assert.equal(reverse.payload.trust, 'exact_address');

  assert.equal((await api(server.baseUrl, `/api/inboxes/${bob.inbox.id}/contacts/${alice.agent.id}/block`, { session: bob.session, body: {} })).status, 200);
  assert.equal((await api(server.baseUrl, `/api/agent/discovery?address=${encodeURIComponent(bob.agent.address)}`, { token: alice.agentApiToken })).payload.trust, 'exact_address');

  const revoked = await api(server.baseUrl, `${route}/relationships/${alice.agent.id}/${bob.agent.id}/revoke`, { session: alice.session, body: {} });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal(revoked.payload.status, 'revoked');
  assert.equal((await api(server.baseUrl, `/api/agent/discovery?address=${encodeURIComponent(bob.agent.address)}`, { token: alice.agentApiToken })).payload.trust, 'exact_address');
  const blocked = await api(server.baseUrl, `${route}/relationships`, { session: alice.session, body: { actorAgentId: alice.agent.id, targetAddress: bob.agent.address, grants: ['shareAssets'] } });
  assert.equal(blocked.status, 409, blocked.text);
});

test('[FileStore] Phase D discovery is absent when its flag is off', { timeout: 30000 }, async t => {
  const server = await launch();
  t.after(() => server.stop());
  const who = await owner(server.baseUrl, '7403');
  const result = await api(server.baseUrl, `/api/agent/discovery?address=${encodeURIComponent(who.agent.address)}`, { token: who.agentApiToken });
  assert.equal(result.status, 404, result.text);
  assert.equal(result.payload.code, 'FEATURE_DISABLED');
});
