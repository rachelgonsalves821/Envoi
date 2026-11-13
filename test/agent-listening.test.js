// agent-listening-status v1 (handoffs.md), task A2: the derivation against every fixture, then both responses on the real
// server (owner agent list and envoi_agent_info) for an OAuth Dot. FileStore always, and PostgreSQL when DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { deriveBackgroundReceiving } from '../src/agent-listening.js';
import { send, waitForMessageStatus } from './a3-harness.js';
import { api, assertTokenResponse, backends, connect, documents, exchange, freshOwner, remoteServer, stored } from './agent-remote-auth-token-harness.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures', 'agent-listening-status');
const index = JSON.parse(await readFile(path.join(dir, '..', 'index.json'), 'utf8')).contracts.find(entry => entry.id === 'agent-listening-status');
const schemas = JSON.parse(await readFile(path.join(dir, 'schemas.json'), 'utf8'));
const fixtures = await Promise.all(index.fixtures.map(async name => JSON.parse(await readFile(path.join(dir, name), 'utf8'))));
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(schemas);
const valid = (name, value) => { const check = ajv.getSchema(`${schemas.$id}#/definitions/${name}`); assert.equal(check(value), true, `${name}: ${ajv.errorsText(check.errors)}`); };

test('agent-listening-status: the server derivation reproduces every fixture', () => {
  for (const fixture of fixtures.filter(entry => !entry.context.scopedCaseId)) {
    const { deliveryMode, wakeAvailable, subscriptions, claimable } = fixture.context;
    const expected = fixture.response.toolResult ? JSON.parse(fixture.response.body.result.content[0].text).backgroundReceiving : fixture.response.body[0].backgroundReceiving;
    assert.deepEqual(deriveBackgroundReceiving({ onDemand: deliveryMode === 'on_demand', wakeAvailable, subscriptions, claimable }), expected, fixture.id);
  }
});

const signingKeys = () => JSON.stringify([{ kid: 'listening-tests', privateKey: crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), activeFrom: '2026-01-01T00:00:00.000Z' }]);
const call = (server, token, name) => api(server.baseUrl, '/mcp', { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }, headers: { accept: 'application/json, text/event-stream' } });
const agentInfo = async (server, token) => {
  const res = await call(server, token, 'envoi_agent_info');
  assert.equal(res.status, 200, res.text);
  const info = JSON.parse(res.payload.result.content[0].text);
  valid('agentInfo', info);
  return info.backgroundReceiving;
};
const ownerView = async (server, who, registration) => {
  const res = await api(server.baseUrl, `/api/inboxes/${registration.agentInboxId}/agents`, { session: who.session });
  assert.equal(res.status, 200, res.text);
  const agent = res.payload.find(entry => entry.id === registration.agentId);
  valid('ownerAgentWithListening', agent);
  return agent.backgroundReceiving;
};
async function connected(server, docs) {
  const who = await freshOwner(server);
  const grant = await connect(server, who);
  const tokens = assertTokenResponse(await exchange(server, grant), 'envoi.agent envoi.send');
  const { registration } = await stored(docs, grant.registrationId);
  return { who, tokens, registration };
}
const none = { count: 0, more: false, oldestAt: null };

for (const backend of backends) {
  test(`[${backend.name}] agent-listening-status: an OAuth Dot that never subscribed, with work waiting, then after a reconnect ended its subscription`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend, { env: { ENVOI_HTTP_WAKE_V1: 'true', ENVOI_WAKE_SIGNING_KEYS: signingKeys() } });
    const docs = documents(t, server);
    const { who, tokens, registration } = await connected(server, docs);

    // owner-dots-never-set-up, before any work: off with nothing to report, identical in both responses.
    const never = { state: 'off', since: null, lastAlertAt: null, endedReason: null, waiting: none };
    assert.deepEqual(await agentInfo(server, tokens.access_token), never);
    assert.deepEqual(await ownerView(server, who, registration), never);

    // A delivered peer message is claimable work: waiting counts it, with its time.
    const sender = await freshOwner(server);
    const recipient = { session: who.session, inbox: { id: registration.agentInboxId }, agent: { address: registration.target.address } };
    const sent = await send(server.baseUrl, sender, recipient, { text: 'Listening status test request' });
    assert.equal(sent.status, 202, sent.text);
    await waitForMessageStatus(server.baseUrl, recipient, sent.payload.id, 'delivered');
    const waiting = (await agentInfo(server, tokens.access_token)).waiting;
    assert.equal(waiting.count, 1);
    assert.equal(waiting.more, false);
    assert.match(waiting.oldestAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(await ownerView(server, who, registration), { ...never, waiting });

    // owner-dots-ended-after-reconnect: the newest ended subscription decides since, lastAlertAt and endedReason.
    const ended = (id, endedAt, endedReason, lastSuccessAt) => ({
      id, inboxId: registration.agentInboxId, agentId: registration.agentId, installationId: 'installation_previous', familyId: 'family_previous', profile: 'mcp_events',
      url: 'https://connectors.example/events', status: 'ended', createdAt: '2026-11-10T10:00:00.000Z', activatedAt: '2026-11-10T10:00:05.000Z', endedAt, endedReason,
      delivery: { state: 'healthy', lastAttemptAt: lastSuccessAt, lastSuccessAt, consecutiveFailures: 0, lastFailureClass: null }
    });
    const subs = ['http-wake', 'agents', registration.agentId, 'wake-subscriptions'];
    await docs.put([...subs, 'wake_sub_listening_old.json'], ended('wake_sub_listening_old', '2026-11-11T09:00:00.000Z', 'expired', '2026-11-11T08:00:00.000Z'));
    await docs.put([...subs, 'wake_sub_listening_new.json'], ended('wake_sub_listening_new', '2026-11-12T19:20:00.000Z', 'credential_ended', '2026-11-12T18:40:00.000Z'));
    const afterReconnect = { state: 'off', since: '2026-11-12T19:20:00.000Z', lastAlertAt: '2026-11-12T18:40:00.000Z', endedReason: 'credential_ended', waiting };
    assert.deepEqual(await agentInfo(server, tokens.access_token), afterReconnect);
    assert.deepEqual(await ownerView(server, who, registration), afterReconnect);
  });

  test(`[${backend.name}] agent-listening-status: wake subscriptions off on this deployment means unavailable`, { timeout: 120000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);
    const { who, tokens, registration } = await connected(server, docs);
    const unavailable = { state: 'unavailable', since: null, lastAlertAt: null, endedReason: null, waiting: none };
    assert.deepEqual(await agentInfo(server, tokens.access_token), unavailable);
    assert.deepEqual(await ownerView(server, who, registration), unavailable);
  });
}
