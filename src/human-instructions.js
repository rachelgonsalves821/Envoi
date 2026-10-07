import path from 'node:path';
import { appendEvent, assertValidCase, isActiveCase } from './agent-interface.js';
import { assertSafeIdentifier } from './path-safety.js';
import { replayResponse, scopedIdempotencyPath, semanticDigest, validateIdempotencyKey } from './idempotency.js';

const error = (message, statusCode, code) => Object.assign(new Error(message), { statusCode, code });
const inboxPath = inboxId => path.join('inboxes', inboxId, 'inbox.json');
const messagePath = (inboxId, messageId) => path.join('inboxes', inboxId, 'messages', `${messageId}.json`);
const casePath = (inboxId, caseId) => path.join('inboxes', inboxId, 'cases', `${caseId}.json`);
const bindingPath = caseId => path.join('shared-case-bindings', `${caseId}.json`);
const sharedPath = caseId => path.join('shared-cases', `${caseId}.json`);
const states = new Set(['delivered', 'acknowledged', 'processed', 'failed']);

export function validateHumanInstructionInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['text', 'recipientAgentId'].includes(key))) {
    throw error('Only text and optional recipientAgentId are accepted', 400);
  }
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 60_000
    || Buffer.byteLength(input.text, 'utf8') > 60_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text)) {
    throw error('Instruction text must contain 1 to 60000 UTF-8 bytes without control characters', 400);
  }
  return {
    text: input.text.trim(),
    ...(input.recipientAgentId === undefined ? {} : { recipientAgentId: assertSafeIdentifier(input.recipientAgentId, 'recipientAgentId') })
  };
}

export const isHumanInstruction = message => message?.kind === 'humanInstruction' && message.senderType === 'human';

async function instructionContext(store, inboxId, caseId, recipientAgentId) {
  const inbox = await store.getJson(inboxPath(inboxId));
  if (!inbox) throw error('Inbox not found', 404);
  if (inbox.status === 'removed' || inbox.historyDeleted) throw error('Removed agent history is read-only', 409);
  if (!recipientAgentId || inbox.ownerAgentId !== recipientAgentId) throw error('Instruction must target this inbox owner agent', 403, 'CASE_PARTICIPANT_MISMATCH');
  const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${recipientAgentId}.json`));
  const directory = await store.getJson(path.join('directory', 'agents', `${recipientAgentId}.json`));
  if (agent?.id !== recipientAgentId || directory?.agentId !== recipientAgentId || directory.inboxId !== inboxId) {
    throw error('Agent ownership does not match this inbox', 403, 'CASE_PARTICIPANT_MISMATCH');
  }
  if (agent.status !== 'active' || agent.onboardingStatus !== 'approved' || agent.revokedAt
    || !agent.permissions?.includes('receive_agent_messages') || directory.status !== 'active') {
    throw error('Owner agent is not approved to receive instructions', 403);
  }
  const local = await store.getJson(casePath(inboxId, caseId));
  if (!local) throw error('Existing case required', 404);
  if (local.id !== caseId) throw error('Case record identity mismatch', 409);
  const binding = await store.getJson(bindingPath(caseId));
  if (binding && (binding.caseId !== caseId || !Array.isArray(binding.inboxIds) || !binding.inboxIds.includes(inboxId)
    || !Array.isArray(binding.agentIds) || !binding.agentIds.includes(recipientAgentId))) {
    throw error('Case ownership does not match this inbox', 403, 'CASE_PARTICIPANT_MISMATCH');
  }
  if (binding) {
    if (new Set(binding.agentIds).size !== binding.agentIds.length || new Set(binding.inboxIds).size !== binding.inboxIds.length) {
      throw error('Case binding contains duplicate participants', 409);
    }
    for (const participantInboxId of binding.inboxIds) assertSafeIdentifier(participantInboxId, 'participantInboxId');
    const participantInboxes = new Set();
    for (const participantAgentId of binding.agentIds) {
      assertSafeIdentifier(participantAgentId, 'participantAgentId');
      const participantDirectory = await store.getJson(path.join('directory', 'agents', `${participantAgentId}.json`));
      if (participantDirectory?.agentId !== participantAgentId || !binding.inboxIds.includes(participantDirectory.inboxId)) {
        throw error('Case participant directory ownership mismatch', 403, 'CASE_PARTICIPANT_MISMATCH');
      }
      participantInboxes.add(participantDirectory.inboxId);
    }
    if (participantInboxes.size !== binding.inboxIds.length) throw error('Case binding contains an unrelated inbox', 403, 'CASE_PARTICIPANT_MISMATCH');
  }
  const caseRecord = binding ? await store.getJson(sharedPath(caseId)) : local;
  if (!caseRecord || caseRecord.id !== caseId || !caseRecord.schemaVersion) throw error('Existing structured case required', 409);
  assertValidCase(caseRecord);
  if (!caseRecord.participants.includes(recipientAgentId)
    || binding && (binding.agentIds.length !== caseRecord.participants.length || binding.agentIds.some(id => !caseRecord.participants.includes(id)))) {
    throw error('Owner agent must be an existing case participant', 403, 'CASE_PARTICIPANT_MISMATCH');
  }
  if (['paused', 'revoked'].includes(caseRecord.state)) throw error('Case is paused or revoked', 409, 'CASE_CONTROLLED');
  if (!isActiveCase(caseRecord)) throw error('Case is no longer active', 409);
  return { inbox, agent, binding, caseRecord };
}

async function caseDocuments(store, context, message, state, at) {
  const value = structuredClone(context.caseRecord);
  appendEvent(value, {
    id: `evt_${message.id}_${state}`, type: 'message',
    actor: state === 'delivered' ? message.senderHumanId : message.recipientAgentId,
    createdAt: at,
    payload: {
      messageId: message.id, messageType: 'instruction', text: message.text,
      senderType: 'human', senderHumanId: message.senderHumanId,
      recipientAgentId: message.recipientAgentId, deliveryState: state
    },
    linkedPolicyEvaluation: null,
    precedingEventRef: value.events.at(-1)?.id || null
  });
  assertValidCase(value);
  const documents = [{ path: casePath(message.inboxId, message.caseId), value }];
  if (context.binding) {
    documents.push({ path: sharedPath(message.caseId), value });
    for (const participantInboxId of context.binding.inboxIds) {
      assertSafeIdentifier(participantInboxId, 'participantInboxId');
      if (participantInboxId === message.inboxId) continue;
      const participant = await store.getJson(inboxPath(participantInboxId));
      if (participant && !participant.historyDeleted && await store.getJson(casePath(participantInboxId, message.caseId))) {
        documents.push({ path: casePath(participantInboxId, message.caseId), value });
      }
    }
  }
  return documents;
}

export async function assertHumanInstructionWork(store, message, identity) {
  if (!isHumanInstruction(message) || !states.has(message.status)) throw error('Invalid human instruction work', 400);
  for (const field of ['id', 'inboxId', 'caseId', 'senderHumanId', 'recipientInboxId', 'recipientAgentId']) assertSafeIdentifier(message[field], field);
  if (message.senderAgentId !== undefined || message.senderInboxId !== undefined
    || message.from?.humanId !== message.senderHumanId || Object.keys(message.from).some(key => key !== 'humanId')
    || message.type !== 'instruction' || message.inboxId !== message.recipientInboxId
    || identity?.inboxId !== message.inboxId || identity?.agent?.id !== message.recipientAgentId) {
    throw error('Human instruction work ownership mismatch', 403);
  }
  validateHumanInstructionInput({ text: message.text });
  const durable = await store.getJson(messagePath(message.inboxId, message.id));
  if (!durable || semanticDigest(durable) !== semanticDigest(message)) throw error('Instruction has no matching durable record', 409);
  const context = await instructionContext(store, message.inboxId, message.caseId, message.recipientAgentId);
  const event = context.caseRecord.events.find(item => item.id === `evt_${message.id}_delivered`);
  if (event?.actor !== message.senderHumanId || event.payload?.messageId !== message.id
    || event.payload?.senderHumanId !== message.senderHumanId || event.payload?.recipientAgentId !== message.recipientAgentId
    || event.payload?.text !== message.text || event.payload?.deliveryState !== 'delivered') {
    throw error('Instruction has no matching durable human event', 409);
  }
  return context;
}

export async function humanInstructionCaseDocuments(store, message, state, at) {
  if (!states.has(state) || !Number.isFinite(Date.parse(at))) throw error('Invalid instruction delivery state or timestamp', 400);
  const context = await assertHumanInstructionWork(store, message, { inboxId: message.recipientInboxId, agent: { id: message.recipientAgentId } });
  return caseDocuments(store, context, message, state, at);
}

export async function humanInstructionReplyDocuments(store, instruction, reply, at) {
  const context = await assertHumanInstructionWork(store, instruction, { inboxId: instruction.recipientInboxId, agent: { id: instruction.recipientAgentId } });
  const documents = await caseDocuments(store, context, instruction, 'delivered', instruction.deliveredAt);
  const value = documents[0].value;
  appendEvent(value, {
    id: `evt_${reply.id}`, type: 'message', actor: instruction.recipientAgentId, createdAt: at,
    payload: { messageId: reply.id, messageType: 'instructionReply', text: reply.text,
      senderType: 'agent', senderAgentId: reply.senderAgentId, recipientHumanId: reply.recipientHumanId,
      inReplyTo: instruction.id, deliveryState: 'delivered' },
    linkedPolicyEvaluation: null, precedingEventRef: value.events.at(-1)?.id || null
  });
  assertValidCase(value);
  return documents;
}

export function createHumanInstructions({ store, withCaseMutation, authorizeHuman }) {
  if (typeof withCaseMutation !== 'function' || typeof authorizeHuman !== 'function' || typeof store?.putJsonBatch !== 'function') {
    throw new TypeError('Transactional case mutation, authenticated human authorization and durable store are required');
  }
  return async function sendHumanInstruction({ inboxId, caseId, input, idempotencyKey }) {
    assertSafeIdentifier(inboxId, 'inboxId');
    assertSafeIdentifier(caseId, 'caseId');
    const validated = validateHumanInstructionInput(input);
    const key = validateIdempotencyKey(idempotencyKey, { required: true });
    if (!key.trim()) throw error('Idempotency key must not be blank', 400);
    return withCaseMutation(inboxId, caseId, async writeAudit => {
      const inbox = await store.getJson(inboxPath(inboxId));
      if (!inbox) throw error('Inbox not found', 404);
      const human = await authorizeHuman(inbox);
      if (!human?.id) throw error('Authenticated workspace administrator required', 403);
      assertSafeIdentifier(human.id, 'humanId');
      const recipientAgentId = validated.recipientAgentId || assertSafeIdentifier(inbox.ownerAgentId, 'ownerAgentId');
      const context = await instructionContext(store, inboxId, caseId, recipientAgentId);
      const requestDigest = semanticDigest({ inboxId, caseId, recipientAgentId, text: validated.text });
      const keyPath = scopedIdempotencyPath('human-instruction', inboxId, human.id, key);
      const prior = await store.getJson(keyPath);
      const replay = replayResponse(prior, { principalId: human.id, requestDigest });
      if (replay) {
        await assertHumanInstructionWork(store, await store.getJson(messagePath(inboxId, replay.id)), { inboxId, agent: context.agent });
        return { status: 200, payload: replay };
      }
      if (prior) throw error('Instruction request is still in progress', 409);
      const at = store.now();
      const message = {
        id: `msg_instruction_${semanticDigest({ keyPath }).slice(0, 40)}`,
        kind: 'humanInstruction', inboxId, caseId, senderType: 'human', senderHumanId: human.id,
        recipientInboxId: inboxId, recipientAgentId, from: { humanId: human.id },
        type: 'instruction', text: validated.text, status: 'delivered',
        createdAt: at, deliveredAt: at, updatedAt: at
      };
      if (await store.getJson(messagePath(inboxId, message.id))) throw error('Instruction exists without its idempotency record', 409);
      await store.putJsonBatch([
        { path: messagePath(inboxId, message.id), value: message },
        ...await caseDocuments(store, context, message, 'delivered', at),
        { path: keyPath, value: { principalId: human.id, requestDigest, status: 'completed', response: message, createdAt: at } }
      ]);
      await writeAudit('human.instruction_created', { messageId: message.id, caseId, senderHumanId: human.id, recipientAgentId }, at);
      return { status: 201, payload: message };
    });
  };
}
