// The legacy pending-agent approve route after A-4.1 moved it onto the shared approval module
// (agent-registration v1 §5.3, §12): same response shape, same permissions, same slot rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentStatus, api, launch, owner } from './a3-harness.js';

async function pendingAgent(baseUrl, who, name) {
  const created = await api(baseUrl, `/api/inboxes/${who.workspace.id}/agent-onboarding`, { session: who.session, body: { name } });
  assert.equal(created.status, 201, created.text);
  return created.payload;
}

test('legacy approve keeps its shape, permissions and the two-slot limit', { timeout: 60000 }, async t => {
  const server = await launch();
  t.after(() => server.stop());
  const base = await owner(server.baseUrl, '6301');
  // The agent's dedicated inbox hangs off the owner's workspace.
  const who = { ...base, workspace: { id: base.inbox.parentInboxId } };
  assert.ok(who.workspace.id, 'the owner has a workspace');

  // The owner already has one active agent (one slot). A second approval fills the other.
  const pending = await pendingAgent(server.baseUrl, who, 'Legacy approved');
  const approved = await api(server.baseUrl, `/api/inboxes/${pending.inbox.id}/agent-onboarding/${pending.agent.id}/approve`, { session: who.session, body: { permissions: ['execute_cases', 'not_a_permission'] } });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.payload.agent.status, 'active');
  assert.deepEqual(approved.payload.agent.permissions, ['execute_cases', 'receive_agent_messages']);
  assert.match(approved.payload.agentApiToken, /^envoi_agent_access_/, 'the legacy route still returns credentials');
  assert.match(approved.payload.agentRefreshToken, /^envoi_agent_refresh_/);
  assert.equal((await agentStatus(server.baseUrl, approved.payload.agentApiToken)).status, 200);

  const third = await pendingAgent(server.baseUrl, who, 'Legacy over limit');
  const limited = await api(server.baseUrl, `/api/inboxes/${third.inbox.id}/agent-onboarding/${third.agent.id}/approve`, { session: who.session, body: {} });
  assert.equal(limited.status, 409, limited.text);
  assert.equal(limited.payload.code, 'ACTIVE_AGENT_LIMIT');
});
