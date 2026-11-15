// agent-work-mode v1 (handoffs.md), task W-A2: the owner route, Off ending a Dot's MCP Events subscriptions, workMode in
// owner views, envoi_agent_info and /api/agent/status, and the connector claim filter, on the real server.
// FileStore always, and PostgreSQL when DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { send, waitForMessageStatus } from './a3-harness.js';
import { api, assertTokenResponse, backends, connect, documents, exchange, freshOwner, remoteServer, stored } from './agent-remote-auth-token-harness.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures');
const listeningSchemas = JSON.parse(await readFile(path.join(fixtures, 'agent-listening-status', 'schemas.json'), 'utf8'));
const modeSchemas = JSON.parse(await readFile(path.join(fixtures, 'agent-work-mode', 'schemas.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(listeningSchemas);
ajv.addSchema(modeSchemas);
const valid = (schema, name, value) => { const check = ajv.getSchema(`${schema.$id}#/definitions/${name}`); assert.equal(check(value), true, `${name}: ${ajv.errorsText(check.errors)}`); };

const signingKeys = () => JSON.stringify([{ kid: 'work-mode-tests', privateKey: crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), activeFrom: '2026-01-01T00:00:00.000Z' }]);
const env = (extra = {}) => ({ ENVOI_HTTP_WAKE_V1: 'true', ENVOI_WAKE_SIGNING_KEYS: signingKeys(), ENVOI_MCP_EVENTS_V1: 'true', ENVOI_MCP_EVENTS_CALLBACK_ORIGINS: 'https://connectors.example', ...extra });
const mcp = (server, token, name) => api(server.baseUrl, '/mcp', { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }, headers: { accept: 'application/json, text/event-stream' } });
const tool = async (server, token, name) => { const res = await mcp(server, token, name); assert.equal(res.status, 200, res.text); return JSON.parse(res.payload.result.content[0].text); };
const putMode = (server, who, inboxId, agentId, body) => api(server.baseUrl, `/api/inboxes/${inboxId}/agents/${agentId}/work-mode`, { method: 'PUT', session: who.session, body });
async function dot(server, docs) {
  const who = await freshOwner(server);
  const grant = await connect(server, who);
  const tokens = assertTokenResponse(await exchange(server, grant), 'envoi.agent envoi.send');
  const { registration, family } = await stored(docs, grant.registrationId);
  return { who, tokens, registration, family };
}

for (const backend of backends) {
  test(`[${backend.name}] agent-work-mode: a Dot's owner sets routine then off; off ends its MCP Events subscription and leaves on-demand claims alone`, { timeout: 240000 }, async t => {
    const server = await remoteServer(t, backend, { env: env({ ENVOI_WORK_MODE: 'true' }) });
    const docs = documents(t, server);
    const { who, tokens, registration, family } = await dot(server, docs);
    const { agentInboxId: inboxId, agentId } = registration;

    // Default before any choice: routine with updatedAt null (agent-info-default).
    assert.deepEqual((await tool(server, tokens.access_token, 'envoi_agent_info')).workMode, { mode: 'routine', updatedAt: null });

    // §2 refusals: invalid body, then another workspace's human.
    const invalid = await putMode(server, who, inboxId, agentId, { mode: 'always' });
    assert.deepEqual([invalid.status, invalid.payload.code], [400, 'WORK_MODE_INVALID'], invalid.text);
    const stranger = await freshOwner(server);
    const forbidden = await putMode(server, stranger, inboxId, agentId, { mode: 'off' });
    assert.deepEqual([forbidden.status, forbidden.payload.code], [403, 'REQUEST_FAILED'], forbidden.text);

    // mode-set-routine: the complete owner agent view plus workMode.
    const routine = await putMode(server, who, inboxId, agentId, { mode: 'routine' });
    assert.equal(routine.status, 200, routine.text);
    assert.equal(routine.headers.get('cache-control'), 'no-store');
    valid(listeningSchemas, 'ownerAgentWithListening', routine.payload);
    valid(modeSchemas, 'workMode', routine.payload.workMode);
    assert.equal(routine.payload.workMode.mode, 'routine');
    assert.ok(routine.payload.workMode.updatedAt);
    assert.equal((await tool(server, tokens.access_token, 'envoi_agent_info')).workMode.mode, 'routine');

    // A live MCP Events subscription for this Dot's installation, as ChatGPT would create it.
    const subParts = ['http-wake', 'agents', agentId, 'wake-subscriptions', 'evtsub_workmode00000000001.json'];
    const at = new Date().toISOString();
    await docs.put(subParts, {
      id: 'evtsub_workmode00000000001', inboxId, agentId, familyId: family.id, installationId: family.installationId, profile: 'mcp_events', eventName: 'envoi.work_available',
      url: 'https://connectors.example/events', status: 'active', generation: crypto.randomUUID(), createdAt: at, activatedAt: at, expiresAt: new Date(Date.now() + 86400000).toISOString(),
      endedReason: null, endedAt: null, delivery: { state: 'healthy', lastAttemptAt: at, lastSuccessAt: at, consecutiveFailures: 0, lastFailureClass: null }
    });
    const before = await api(server.baseUrl, `/api/inboxes/${inboxId}/agents`, { session: who.session });
    assert.equal(before.payload.find(agent => agent.id === agentId).backgroundReceiving.state, 'on', 'the seeded subscription is live');

    // mode-set-off-dots-ends-events: Off ends it with ended_by_owner in the same change.
    const off = await putMode(server, who, inboxId, agentId, { mode: 'off' });
    assert.equal(off.status, 200, off.text);
    valid(listeningSchemas, 'ownerAgentWithListening', off.payload);
    assert.equal(off.payload.workMode.mode, 'off');
    assert.deepEqual([off.payload.backgroundReceiving.state, off.payload.backgroundReceiving.endedReason], ['off', 'ended_by_owner']);
    assert.deepEqual([(await docs.get(subParts)).status, (await docs.get(subParts)).endedReason], ['ended', 'ended_by_owner']);
    // Setting the same mode again is a no-op that still answers 200.
    assert.equal((await putMode(server, who, inboxId, agentId, { mode: 'off' })).status, 200);

    // claim-off-on-demand-unaffected: the owner can still ask the Dot to check Envoi.
    const sender = await freshOwner(server);
    const recipient = { session: who.session, inbox: { id: inboxId }, agent: { address: registration.target.address } };
    const sent = await send(server.baseUrl, sender, recipient, { text: 'Work mode on-demand check' });
    assert.equal(sent.status, 202, sent.text);
    await waitForMessageStatus(server.baseUrl, recipient, sent.payload.id, 'delivered');
    const claimed = await tool(server, tokens.access_token, 'envoi_claim_work');
    assert.ok(claimed.payload?.work ?? claimed.work, `an on-demand claim still offers peer work: ${JSON.stringify(claimed)}`);
  });

  test(`[${backend.name}] agent-work-mode: a connector in off mode gets owner instructions only, and reads its mode from /api/agent/status`, { timeout: 240000 }, async t => {
    const server = await remoteServer(t, backend, { env: env({ ENVOI_WORK_MODE: 'true' }) });
    const own = await freshOwner(server);
    const peer = await freshOwner(server);
    const claim = (body = {}) => api(server.baseUrl, '/api/agent/work/claim', { token: own.agentApiToken, body });

    const off = await putMode(server, own, own.inbox.id, own.agent.id, { mode: 'off' });
    assert.equal(off.status, 200, off.text);
    valid(listeningSchemas, 'ownerAgentWithListening', off.payload);
    assert.equal(off.payload.backgroundReceiving.state, 'connector');
    const status = await api(server.baseUrl, '/api/agent/status', { token: own.agentApiToken });
    assert.equal(status.status, 200, status.text);
    assert.equal(status.payload.workMode.mode, 'off');

    // claim-off-connector-hides-peer-work: peer work waits; the claim is the ordinary idle answer.
    const sent = await send(server.baseUrl, peer, own, { text: 'Work mode connector check' });
    assert.equal(sent.status, 202, sent.text);
    await waitForMessageStatus(server.baseUrl, own, sent.payload.id, 'delivered');
    assert.deepEqual((await claim({ acceptHumanInstructions: true })).payload, { work: null, state: 'idle' });
    const waiting = await api(server.baseUrl, `/api/inboxes/${own.inbox.id}/agents`, { session: own.session });
    assert.equal(waiting.payload.find(agent => agent.id === own.agent.id).backgroundReceiving.waiting.count, 1, 'the skipped peer work still counts as waiting');

    // claim-off-connector-offers-instruction: an owner instruction in that case is still offered, with its lease.
    const instruction = await api(server.baseUrl, `/api/inboxes/${own.inbox.id}/cases/${sent.payload.caseId}/instructions`, { session: own.session, key: 'work-mode-instruction', body: { text: 'Summarize the requests waiting for me.' } });
    assert.ok([200, 201].includes(instruction.status), instruction.text);
    const offered = await claim({ acceptHumanInstructions: true });
    assert.equal(offered.payload.state, 'claimed', offered.text);
    assert.equal(offered.payload.work.message.kind, 'humanInstruction');
    assert.ok(offered.payload.work.leaseToken && offered.payload.work.leaseExpiresAt);

    // Back to routine: the peer work is offered again.
    assert.equal((await putMode(server, own, own.inbox.id, own.agent.id, { mode: 'routine' })).status, 200);
    await api(server.baseUrl, `/api/agent/work/${offered.payload.work.workId}/complete`, { token: own.agentApiToken, key: 'work-mode-settle', body: { leaseToken: offered.payload.work.leaseToken } });
    const peerWork = await claim();
    assert.equal(peerWork.payload.work?.workId, sent.payload.id, peerWork.text);
  });

  test(`[${backend.name}] agent-work-mode: with the flag off there is no route, no field and no filter`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend, { env: env() });
    const docs = documents(t, server);
    const { who, tokens, registration } = await dot(server, docs);
    const disabled = await putMode(server, who, registration.agentInboxId, registration.agentId, { mode: 'off' });
    assert.deepEqual([disabled.status, disabled.payload.code], [404, 'FEATURE_DISABLED'], disabled.text);
    assert.equal('workMode' in await tool(server, tokens.access_token, 'envoi_agent_info'), false);
    const view = await api(server.baseUrl, `/api/inboxes/${registration.agentInboxId}/agents`, { session: who.session });
    assert.equal('workMode' in view.payload.find(agent => agent.id === registration.agentId), false);
  });
}
