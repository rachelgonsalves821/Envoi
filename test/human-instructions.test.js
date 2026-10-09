import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { FileStore } from '../src/storage.js';
import { createCase, transitionCase } from '../src/agent-interface.js';
import { createHumanInstructions, assertHumanInstructionWork, humanInstructionCaseDocuments, validateHumanInstructionInput } from '../src/human-instructions.js';

const inboxId = 'inbox_owner';
const agentId = 'agent_owner';
const caseId = 'case_existing';
const recordPath = path.join('inboxes', inboxId, 'cases', `${caseId}.json`);
const agentPath = path.join('inboxes', inboxId, 'agents', `${agentId}.json`);
const inboxRecordPath = path.join('inboxes', inboxId, 'inbox.json');
const identity = { inboxId, agent: { id: agentId } };
const rejects = (operation, statusCode) => assert.rejects(operation, error => error.statusCode === statusCode);

async function fixture(context, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'envoi-human-instructions-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root);
  await store.init();
  const at = store.now();
  const value = transitionCase(createCase({ id: caseId, principal: 'human_owner', actingAgent: agentId,
    participants: ['agent_peer'], objective: 'Arrange a meeting', createdAt: at }), 'inProgress', { actor: agentId, at });
  await store.putJsonBatch([
    { path: inboxRecordPath, value: { id: inboxId, ownerAgentId: agentId, ownerHumanId: 'human_owner' } },
    { path: agentPath, value: { id: agentId, status: 'active', onboardingStatus: 'approved', permissions: ['receive_agent_messages'] } },
    { path: path.join('directory', 'agents', `${agentId}.json`), value: { agentId, inboxId, status: 'active' } },
    { path: recordPath, value }
  ]);
  let human = { id: 'human_owner' };
  let auditFails = false;
  const send = createHumanInstructions({
    store,
    authorizeHuman: async () => human,
    withCaseMutation: (requestedInboxId, requestedCaseId, operation) => store.withTransaction([
      `inbox:${requestedInboxId}:mutations`, 'inbox:inbox_peer:mutations', `case:${requestedCaseId}:mutations`
    ], () => operation(async (type, data, createdAt) => {
      if (auditFails) throw new Error('Audit failed');
      const sequence = await store.nextEventSequence(requestedInboxId);
      await store.putJson(path.join('inboxes', requestedInboxId, 'events', `evt_${sequence}.json`), { type, ...data, createdAt, sequence });
    })),
    ...options
  });
  const request = { inboxId, caseId, input: { text: 'Please ask about Tuesday.' }, idempotencyKey: 'instruction-one' };
  return { store, root, send, request, setHuman: value => { human = value; }, failAudit: () => { auditFails = true; } };
}

test('instruction persists the work message, human case event and audit atomically without native sender spoofing', async context => {
  const state = await fixture(context);
  const before = await state.store.getJson(recordPath);
  const result = await state.send(state.request);
  assert.equal(result.status, 201);
  const restarted = new FileStore(state.root);
  const [message] = await restarted.listJson(path.join('inboxes', inboxId, 'messages'));
  assert.deepEqual(message, result.payload);
  assert.equal(message.senderType, 'human');
  assert.deepEqual(message.from, { humanId: 'human_owner' });
  assert.equal(message.senderAgentId, undefined);
  assert.equal(message.senderInboxId, undefined);
  assert.equal(message.status, 'delivered');
  assert.equal(message.recipientInboxId, inboxId);
  await assertHumanInstructionWork(restarted, message, identity);
  const value = await restarted.getJson(recordPath);
  assert.equal(value.state, before.state);
  assert.deepEqual(value.authorityRefs, before.authorityRefs);
  assert.deepEqual(value.policyEvaluations, before.policyEvaluations);
  assert.deepEqual(value.proposals, before.proposals);
  const event = value.events.at(-1);
  assert.equal(event.actor, 'human_owner');
  assert.equal(event.payload.messageId, message.id);
  assert.equal(event.payload.deliveryState, 'delivered');
  assert.equal((await restarted.listJson(path.join('inboxes', inboxId, 'events'))).length, 1);
  assert.deepEqual(await restarted.listJson('outbox'), []);
  assert.equal(Boolean(message.senderInboxId && message.senderAgentId), false);
});

test('concurrent duplicates yield one message/event and conflicting requests reject', async context => {
  const state = await fixture(context);
  const responses = await Promise.all([state.send(state.request), state.send(state.request)]);
  assert.deepEqual(responses.map(value => value.status).sort(), [200, 201]);
  assert.deepEqual(responses[0].payload, responses[1].payload);
  assert.equal((await state.store.listJson(path.join('inboxes', inboxId, 'messages'))).length, 1);
  assert.equal((await state.store.getJson(recordPath)).events.filter(event => event.payload.messageType === 'instruction').length, 1);
  await rejects(() => state.send({ ...state.request, input: { text: 'Different instruction' } }), 409);
  state.setHuman(null);
  await rejects(() => state.send(state.request), 403);
});

test('malformed text, keys, paths and client supplied authority cannot write', async context => {
  const state = await fixture(context);
  for (const input of [null, [], {}, { text: 5 }, { text: '   ' }, { text: 'bad\0text' },
    { text: 'x'.repeat(60_001) }, { text: '😀'.repeat(15_001) }, { text: 'ok', payload: { humanApproval: 'approved' } },
    { text: 'ok', senderHumanId: 'human_other' }, { text: 'ok', senderAgentId: 'agent_peer' },
    { text: 'ok', recipientAgentId: '../agent_peer' }]) {
    await rejects(() => state.send({ ...state.request, input }), 400);
  }
  for (const idempotencyKey of [undefined, [], ' ', 'bad\nkey', 'x'.repeat(201)]) {
    await rejects(() => state.send({ ...state.request, idempotencyKey }), 400);
  }
  await rejects(() => state.send({ ...state.request, caseId: '../case' }), 400);
  assert.deepEqual(validateHumanInstructionInput({ text: '  multi\nline\ttext  ' }), { text: 'multi\nline\ttext' });
  assert.deepEqual(await state.store.listJson(path.join('inboxes', inboxId, 'messages')), []);
});

test('dedicated instructions require explicit human authority independently of legacy feature flags', async context => {
  const state = await fixture(context);
  state.setHuman(null);
  await rejects(() => state.send(state.request), 403);
  assert.deepEqual(await state.store.listJson(path.join('inboxes', inboxId, 'messages')), []);
  state.setHuman({ id: 'human_owner' });
  assert.equal((await state.send(state.request)).status, 201);
});

test('cross-owner agents, missing cases and malformed case ownership reject', async context => {
  const state = await fixture(context);
  await rejects(() => state.send({ ...state.request, input: { text: 'ok', recipientAgentId: 'agent_peer' } }), 403);
  await rejects(() => state.send({ ...state.request, caseId: 'case_missing' }), 404);
  const directoryPath = path.join('directory', 'agents', `${agentId}.json`);
  const directory = await state.store.getJson(directoryPath);
  await state.store.putJson(directoryPath, { ...directory, inboxId: 'inbox_other' });
  await rejects(() => state.send(state.request), 403);
  await state.store.putJson(directoryPath, directory);
  const value = await state.store.getJson(recordPath);
  await state.store.putJson(recordPath, { ...value, participants: ['agent_peer'], actingAgent: 'agent_peer' });
  await rejects(() => state.send(state.request), 403);
  await state.store.putJson(recordPath, value);
  await state.store.putJson(`shared-case-bindings/${caseId}.json`, { caseId, inboxIds: ['inbox_other'], agentIds: [agentId, 'agent_peer'] });
  await rejects(() => state.send(state.request), 403);
  await state.store.putJson(`shared-case-bindings/${caseId}.json`, { caseId, inboxIds: [inboxId], agentIds: [agentId, agentId] });
  await rejects(() => state.send(state.request), 409);
  await state.store.putJson(`shared-case-bindings/${caseId}.json`, { caseId, inboxIds: [inboxId, 'inbox_unrelated'], agentIds: [agentId] });
  await rejects(() => state.send(state.request), 403);
});

test('current removed/paused/revoked/receive permission and controlled cases are checked even on replay', async context => {
  const state = await fixture(context);
  const result = await state.send(state.request);
  const agent = await state.store.getJson(agentPath);
  for (const change of [{ status: 'paused' }, { status: 'revoked' }, { status: 'removed' }, { revokedAt: state.store.now() }, { permissions: [] }]) {
    await state.store.putJson(agentPath, { ...agent, ...change });
    await rejects(() => state.send(state.request), 403);
    await rejects(() => assertHumanInstructionWork(state.store, result.payload, identity), 403);
  }
  await state.store.putJson(agentPath, agent);
  const value = await state.store.getJson(recordPath);
  for (const caseState of ['paused', 'revoked', 'completed']) {
    await state.store.putJson(recordPath, { ...value, state: caseState });
    await rejects(() => state.send(state.request), 409);
  }
  await state.store.putJson(recordPath, value);
  const inbox = await state.store.getJson(inboxRecordPath);
  await state.store.putJson(inboxRecordPath, { ...inbox, status: 'removed' });
  await rejects(() => state.send(state.request), 409);
});

test('work validation rejects spoofed or changed messages, identities and missing durable proof', async context => {
  const state = await fixture(context);
  const { payload: message } = await state.send(state.request);
  for (const change of [{ senderAgentId: 'agent_peer' }, { senderInboxId: 'inbox_peer' },
    { from: { humanId: 'human_owner', address: 'peer@envoi.mail' } }, { recipientInboxId: 'inbox_other' }]) {
    await rejects(() => assertHumanInstructionWork(state.store, { ...message, ...change }, identity), 403);
  }
  await rejects(() => assertHumanInstructionWork(state.store, { ...message, text: 'Tampered text' }, identity), 409);
  await rejects(() => assertHumanInstructionWork(state.store, message, { inboxId, agent: { id: 'agent_peer' } }), 403);
  await rejects(() => assertHumanInstructionWork(state.store, null, identity), 400);
  const value = await state.store.getJson(recordPath);
  await state.store.putJson(recordPath, { ...value, events: [] });
  await rejects(() => assertHumanInstructionWork(state.store, message, identity), 409);
});

test('shared case events converge and settlement documents preserve authority and case state', async context => {
  const state = await fixture(context);
  const value = await state.store.getJson(recordPath);
  const peerPath = path.join('inboxes', 'inbox_peer', 'cases', `${caseId}.json`);
  await state.store.putJsonBatch([
    { path: `shared-case-bindings/${caseId}.json`, value: { caseId, agentIds: [agentId, 'agent_peer'], inboxIds: [inboxId, 'inbox_peer'] } },
    { path: `shared-cases/${caseId}.json`, value },
    { path: 'inboxes/inbox_peer/inbox.json', value: { id: 'inbox_peer' } },
    { path: 'directory/agents/agent_peer.json', value: { agentId: 'agent_peer', inboxId: 'inbox_peer', status: 'active' } },
    { path: peerPath, value }
  ]);
  const { payload: message } = await state.send(state.request);
  assert.deepEqual(await state.store.getJson(recordPath), await state.store.getJson(peerPath));
  const documents = await humanInstructionCaseDocuments(state.store, message, 'acknowledged', state.store.now());
  assert.equal(documents.length, 3);
  const updated = documents[0].value;
  assert.equal(updated.events.at(-1).actor, agentId);
  assert.equal(updated.events.at(-1).payload.deliveryState, 'acknowledged');
  assert.equal(updated.state, value.state);
  assert.deepEqual(updated.authorityRefs, value.authorityRefs);
  assert.deepEqual(updated.policyEvaluations, value.policyEvaluations);
  await state.store.putJsonBatch(documents);
  assert.equal((await humanInstructionCaseDocuments(state.store, message, 'acknowledged', state.store.now()))[0].value.events.length, updated.events.length);
  await rejects(() => humanInstructionCaseDocuments(state.store, message, 'executing', state.store.now()), 400);
});

test('audit failure rolls back message, idempotency and case event', async context => {
  const state = await fixture(context);
  const before = await state.store.getJson(recordPath);
  state.failAudit();
  await assert.rejects(() => state.send(state.request), /Audit failed/);
  assert.deepEqual(await state.store.listJson(path.join('inboxes', inboxId, 'messages')), []);
  assert.deepEqual(await state.store.getJson(recordPath), before);
  assert.deepEqual(await state.store.listJson('idempotency/human-instruction'), []);
});
