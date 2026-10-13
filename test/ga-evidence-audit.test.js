import test from 'node:test';
import assert from 'node:assert/strict';
import { api, claim, eventually, familyPartsForToken, launch, newRotationId, owner, ownerEvents, refresh, send } from './a3-harness.js';

// Gate GA (v3 §29): the owner's audit feed is the server-side evidence for the hosted run. These
// events are additive (a3 §5, a4 §2: clients ignore unknown types and fields) and carry no secret.
const familyIdFor = async (server, token) => (await familyPartsForToken(server, token)).at(-1).replace(/\.json$/, '');
const noSecrets = (events, ...secrets) => {
  const text = JSON.stringify(events);
  for (const secret of secrets) assert.ok(!text.includes(secret), 'audit events never carry a credential');
  assert.doesNotMatch(text, /envoi_agent_(?:access|refresh)_/, 'audit events never carry a token');
};

test('a recovered lost refresh response is audited with the successor expiry; an ordinary refresh is not', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const agent = await owner(baseUrl, '7101');
  const familyId = await familyIdFor(server, agent.agentApiToken);
  const rotationId = newRotationId();
  const first = await refresh(baseUrl, agent.agentRefreshToken, rotationId);
  assert.equal(first.status, 200, first.text);
  // Steps 13-15: the connector lost the response and retries with the same persisted rotationId.
  const recovered = await refresh(baseUrl, agent.agentRefreshToken, rotationId);
  assert.equal(recovered.status, 200, recovered.text);
  assert.deepEqual(recovered.payload, first.payload);

  const events = await ownerEvents(baseUrl, agent);
  const recoveries = events.filter(event => event.type === 'agent.refresh_recovered');
  assert.equal(recoveries.length, 1, 'only the recovery is audited, not the ordinary rotation');
  const [recovery] = recoveries;
  assert.equal(recovery.agentId, agent.agent.id);
  assert.equal(recovery.credentialFamilyId, familyId, 'the same credential family continues');
  assert.equal(recovery.refreshExpiresAt, first.payload.agentRefreshTokenExpiresAt, 'steps 14-15: the server served the stored successor');
  // Steps 9 and 16 come from the owner agent view: its credential expiry is the successor's.
  const agents = await api(baseUrl, `/api/inboxes/${agent.inbox.id}/agents`, { session: agent.session });
  const view = agents.payload.find(item => item.id === agent.agent.id);
  assert.equal(view.connection.credentialExpiresAt, recovery.refreshExpiresAt, 'the agent view and the recovery agree');
  noSecrets(events, agent.agentRefreshToken, agent.agentApiToken, first.payload.agentRefreshToken, first.payload.agentApiToken, rotationId);
});

test('a refresh replay is audited as replay only, never as a recovery', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const agent = await owner(baseUrl, '7102');
  assert.equal((await refresh(baseUrl, agent.agentRefreshToken, newRotationId())).status, 200);
  assert.equal((await refresh(baseUrl, agent.agentRefreshToken, newRotationId())).status, 401);
  const types = (await ownerEvents(baseUrl, agent)).map(event => event.type);
  assert.equal(types.filter(type => type === 'agent.refresh_recovered').length, 0);
  assert.ok(types.includes('agent.refresh_replay_detected'));
});

test('claims and retryable failures carry attempts, the credential family and the retry time', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const sender = await owner(baseUrl, '7103');
  const recipient = await owner(baseUrl, '7104');
  const familyId = await familyIdFor(server, recipient.agentApiToken);
  const sent = await send(baseUrl, sender, recipient);
  assert.equal(sent.status, 202, sent.text);
  // Delivery is asynchronous (outbox worker), so claim until the work arrives.
  const claimed = await eventually(async () => { const res = await claim(baseUrl, recipient.agentApiToken); return res.payload?.work ? res : null; }, { message: "work to arrive" });
  const { workId, leaseToken } = claimed.payload.work;
  // Step 19: a retryable failure before any external effect.
  const failed = await api(baseUrl, `/api/agent/work/${workId}/fail`, { token: recipient.agentApiToken, body: { leaseToken, retryable: true, reasonCode: 'GA_PRE_EFFECT_FAILURE' } });
  assert.equal(failed.status, 200, failed.text);

  const events = await ownerEvents(baseUrl, recipient);
  const claimEvent = events.find(event => event.type === 'agent.work_claimed' && event.workId === workId);
  assert.deepEqual([claimEvent.fence, claimEvent.attempts, claimEvent.credentialFamilyId], [1, 1, familyId], 'steps 4 and 8: attempts and family are visible');
  const failEvent = events.find(event => event.type === 'agent.work_failed' && event.workId === workId);
  assert.equal(failEvent.retryable, true);
  assert.equal(failEvent.attempts, 1);
  assert.match(failEvent.retryAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'step 19: the server retry time');
  assert.ok(Date.parse(failEvent.retryAt) > Date.parse(failEvent.createdAt));
  noSecrets(events, leaseToken, recipient.agentApiToken, recipient.agentRefreshToken);
});
