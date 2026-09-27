import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const schema = JSON.parse(readFileSync(new URL('./agent-interface.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validateCaseSchema = ajv.compile(schema);
const validateActionSchema = ajv.compile({ $ref: `${schema.$id}#/definitions/Action` });

export const CASE_STATES = Object.freeze(schema.definitions.caseState.enum);
export const EVENT_TYPES = Object.freeze(schema.definitions.Event.properties.type.enum);
export const HUMAN_ACTIONS = Object.freeze(['approveOnce', 'decline', 'editProposal', 'pause', 'revoke', 'takeOver']);

const normalTransitions = {
  new: ['classifying', 'inProgress'],
  classifying: ['inProgress', 'waitingForHuman'],
  inProgress: ['waitingForExternalParty', 'waitingForHuman', 'tentativeHold', 'authorized', 'executing'],
  waitingForExternalParty: ['inProgress', 'tentativeHold', 'received'],
  waitingForHuman: ['inProgress', 'authorized'],
  tentativeHold: ['waitingForHuman', 'authorized', 'expired'],
  authorized: ['executing'],
  executing: ['sent'],
  sent: ['received'],
  received: ['accepted'],
  accepted: ['completed']
};
const exceptionStates = new Set(['failed', 'unknownExternalResult', 'expired', 'paused', 'revoked', 'disputed']);
const terminalStates = new Set(['completed', 'failed', 'unknownExternalResult', 'expired', 'revoked']);

const domainError = (message, statusCode = 400, details) => Object.assign(new Error(message), { statusCode, details });
const clone = value => structuredClone(value);

export function assertValidCase(value) {
  if (!validateCaseSchema(value)) throw domainError('Case does not satisfy the Agent Interface schema', 422, validateCaseSchema.errors);
  return value;
}

export function assertValidAction(value) {
  if (!validateActionSchema(value)) throw domainError('Action does not satisfy the Agent Interface schema', 422, validateActionSchema.errors);
  return value;
}

export function createCase({ id, objective, principal, actingAgent, participants = [], constraints = {}, deadline = null, createdAt }) {
  const value = {
    id,
    schemaVersion: '1.0',
    objective: String(objective || '').trim(),
    state: 'new',
    principal,
    actingAgent,
    participants: [...new Set([actingAgent, ...participants].filter(Boolean))],
    constraints: constraints && typeof constraints === 'object' && !Array.isArray(constraints) ? constraints : {},
    deadline: deadline || null,
    authorityRefs: [],
    events: [],
    evidence: [],
    proposals: [],
    policyEvaluations: [],
    receipt: null,
    createdAt,
    updatedAt: createdAt
  };
  return assertValidCase(value);
}

export function canTransition(from, to) {
  if (from === to) return true;
  if (terminalStates.has(from)) return false;
  return Boolean(normalTransitions[from]?.includes(to) || exceptionStates.has(to));
}

export function transitionCase(caseInput, nextState, { actor, at, reasonCode = null } = {}) {
  if (!CASE_STATES.includes(nextState)) throw domainError(`Unknown case state: ${nextState}`);
  if (!canTransition(caseInput.state, nextState)) throw domainError(`Case cannot transition from ${caseInput.state} to ${nextState}`, 409);
  if (nextState === 'completed' && !caseInput.receipt) throw domainError('A durable receipt is required before a case can be completed', 409);
  const value = clone(caseInput);
  const previousState = value.state;
  value.state = nextState;
  value.updatedAt = at;
  if (previousState !== nextState) appendEvent(value, {
    id: `evt_${crypto.randomUUID()}`,
    type: 'stateChange',
    actor,
    createdAt: at,
    payload: { from: previousState, to: nextState, reasonCode },
    linkedPolicyEvaluation: null,
    precedingEventRef: value.events.at(-1)?.id || null
  });
  return assertValidCase(value);
}

export function appendEvent(caseInput, event) {
  if (!EVENT_TYPES.includes(event.type)) throw domainError(`Unknown event type: ${event.type}`);
  if (!event.id || !event.actor || !event.createdAt || !event.payload || typeof event.payload !== 'object') throw domainError('Event id, actor, createdAt, and structured payload are required');
  if (caseInput.events.some(item => item.id === event.id)) return caseInput;
  caseInput.events.push({
    ...event,
    linkedPolicyEvaluation: event.linkedPolicyEvaluation || null,
    precedingEventRef: event.precedingEventRef || caseInput.events.at(-1)?.id || null
  });
  caseInput.updatedAt = event.createdAt;
  return caseInput;
}

export function addPolicyEvaluation(caseInput, evaluation, { eventId, at } = {}) {
  const value = clone(caseInput);
  if (!value.policyEvaluations.some(item => item.id === evaluation.id)) value.policyEvaluations.push(evaluation);
  if (!value.authorityRefs.includes(evaluation.id)) value.authorityRefs.push(evaluation.id);
  appendEvent(value, {
    id: eventId || `evt_${crypto.randomUUID()}`,
    type: 'policyEvaluation',
    actor: evaluation.actor,
    createdAt: at || evaluation.effectiveAt,
    payload: { requestedAction: evaluation.requestedAction, decision: evaluation.decision, reasonCode: evaluation.reasonCode },
    linkedPolicyEvaluation: evaluation.id,
    precedingEventRef: value.events.at(-1)?.id || null
  });
  return assertValidCase(value);
}

export function addProposal(caseInput, proposal) {
  const value = clone(caseInput);
  if (value.proposals.some(item => item.id === proposal.id)) throw domainError('Proposal ID already exists', 409);
  value.proposals.push(proposal);
  value.updatedAt = proposal.updatedAt;
  return assertValidCase(value);
}

export function counterProposal(caseInput, proposalId, { options, at }) {
  const value = clone(caseInput);
  const proposal = value.proposals.find(item => item.id === proposalId);
  if (!proposal) throw domainError('Proposal not found', 404);
  if (!['open', 'countered'].includes(proposal.status)) throw domainError(`Proposal cannot be countered from ${proposal.status}`, 409);
  proposal.options = proposal.options.map(option => ({ ...option, expired: true }));
  proposal.options.push(...options);
  proposal.status = 'countered';
  proposal.updatedAt = at;
  value.updatedAt = at;
  return assertValidCase(value);
}

export function acceptProposal(caseInput, proposalId, optionId, evaluation, { actor, idempotencyKey, actionId, at }) {
  let value = addPolicyEvaluation(caseInput, evaluation, { at });
  const proposal = value.proposals.find(item => item.id === proposalId);
  if (!proposal) throw domainError('Proposal not found', 404);
  const option = proposal.options.find(item => item.id === optionId && !item.expired);
  if (!option) throw domainError('Proposal option is missing or expired', 409);
  if (!['open', 'countered'].includes(proposal.status)) throw domainError(`Proposal cannot be accepted from ${proposal.status}`, 409);
  const action = assertValidAction({
    id: actionId,
    actionKey: 'acceptProposal',
    actor,
    idempotencyKey,
    outcome: evaluation.decision === 'allow' ? 'ok' : evaluation.decision === 'needsHuman' ? 'needsApproval' : 'denied',
    reasonCode: evaluation.reasonCode,
    externalRefs: { proposalId, optionId },
    createdAt: at
  });
  if (action.outcome === 'needsApproval') value = transitionCase(value, 'waitingForHuman', { actor, at, reasonCode: evaluation.reasonCode });
  if (action.outcome === 'ok') {
    proposal.status = 'accepted';
    proposal.acceptedOptionId = optionId;
    proposal.options = proposal.options.map(item => ({ ...item, expired: item.id !== optionId }));
    value = transitionCase(value, 'authorized', { actor, at, reasonCode: evaluation.reasonCode });
  }
  appendEvent(value, {
    id: `evt_${crypto.randomUUID()}`,
    type: 'decision',
    actor,
    createdAt: at,
    payload: { action },
    linkedPolicyEvaluation: evaluation.id,
    precedingEventRef: value.events.at(-1)?.id || null
  });
  return { case: assertValidCase(value), action };
}

export function applyHumanAction(caseInput, actionInput, { at }) {
  if (!HUMAN_ACTIONS.includes(actionInput.actionKey)) throw domainError('Unsupported human action', 400);
  const action = assertValidAction({ ...actionInput, outcome: 'ok', reasonCode: actionInput.reasonCode || null, externalRefs: actionInput.externalRefs || {}, createdAt: at });
  let value = clone(caseInput);
  const existing = value.events.find(event => event.payload?.action?.idempotencyKey === action.idempotencyKey);
  if (existing) return { case: value, action: existing.payload.action, replay: true };
  const targetState = { approveOnce: 'authorized', pause: 'paused', revoke: 'revoked', takeOver: 'paused', decline: 'revoked' }[action.actionKey];
  if (targetState) value = transitionCase(value, targetState, { actor: action.actor, at, reasonCode: action.actionKey });
  appendEvent(value, {
    id: `evt_${crypto.randomUUID()}`,
    type: 'humanAction',
    actor: action.actor,
    createdAt: at,
    payload: { action },
    linkedPolicyEvaluation: action.externalRefs.policyEvaluationId || null,
    precedingEventRef: value.events.at(-1)?.id || null
  });
  return { case: assertValidCase(value), action, replay: false };
}

export function applyAgentAction(caseInput, actionInput, { at, nextState = null }) {
  const action = assertValidAction({ ...actionInput, reasonCode: actionInput.reasonCode || null, externalRefs: actionInput.externalRefs || {}, createdAt: at });
  let value = clone(caseInput);
  const existing = value.events.find(event => event.payload?.action?.idempotencyKey === action.idempotencyKey);
  if (existing) return { case: value, action: existing.payload.action, replay: true };
  const outcomeState = { needsApproval: 'waitingForHuman', failed: 'failed', unknown: 'unknownExternalResult' }[action.outcome];
  if (outcomeState) value = transitionCase(value, outcomeState, { actor: action.actor, at, reasonCode: action.reasonCode || action.outcome });
  else if (action.outcome === 'ok' && nextState) value = transitionCase(value, nextState, { actor: action.actor, at, reasonCode: action.actionKey });
  appendEvent(value, {
    id: `evt_${crypto.randomUUID()}`,
    type: action.outcome === 'failed' || action.outcome === 'unknown' ? 'error' : action.outcome === 'needsApproval' || action.outcome === 'denied' ? 'decision' : 'toolAction',
    actor: action.actor,
    createdAt: at,
    payload: { action },
    linkedPolicyEvaluation: action.externalRefs.policyEvaluationId || null,
    precedingEventRef: value.events.at(-1)?.id || null
  });
  return { case: assertValidCase(value), action, replay: false };
}

export function completeCase(caseInput, receipt, { actor, at }) {
  if (caseInput.receipt) throw domainError('Case already has a receipt', 409);
  const withReceipt = clone(caseInput);
  withReceipt.receipt = receipt;
  let value = transitionCase(withReceipt, 'completed', { actor, at, reasonCode: 'receiptConfirmed' });
  appendEvent(value, { id: `evt_${crypto.randomUUID()}`, type: 'receipt', actor, createdAt: at, payload: { receipt }, linkedPolicyEvaluation: receipt.authorityBasis, precedingEventRef: value.events.at(-1)?.id || null });
  return assertValidCase(value);
}
