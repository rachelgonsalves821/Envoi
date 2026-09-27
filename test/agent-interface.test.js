import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptProposal,
  addProposal,
  applyHumanAction,
  assertValidCase,
  canTransition,
  completeCase,
  counterProposal,
  createCase,
  transitionCase
} from '../src/agent-interface.js';

const at = minute => `2026-10-01T${String(13 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.000Z`;
const option = (id, start, flags = []) => ({ id, value: { start, end: start.replace('20:30', '21:00'), timezone: 'America/Toronto' }, sourceConfidence: 'fromVerifiedProfile', expired: false, outOfPolicyFlags: flags });

test('agent interface executes an approval-gated scheduling negotiation end to end', () => {
  let work = createCase({
    id: 'case_schedule_acme',
    objective: 'Schedule Q4 planning with Acme',
    principal: 'human_rachel',
    actingAgent: 'agent_scheduling',
    participants: ['external_morgan'],
    constraints: { durationMinutes: 30, workingHours: { start: '09:00', end: '16:00', timezone: 'America/Toronto' } },
    deadline: '2026-10-03T03:59:00.000Z',
    createdAt: at(0)
  });
  assertValidCase(work);
  work = transitionCase(work, 'classifying', { actor: 'agent_scheduling', at: at(1) });
  work = transitionCase(work, 'inProgress', { actor: 'agent_scheduling', at: at(2) });
  work = addProposal(work, {
    id: 'proposal_acme_time',
    kind: 'schedule',
    options: [option('option_1630', '2026-10-01T20:30:00.000Z', ['outsideWorkingHours'])],
    status: 'open',
    acceptedOptionId: null,
    expiresAt: '2026-10-01T21:00:00.000Z',
    createdAt: at(3),
    updatedAt: at(3)
  });
  work = transitionCase(work, 'tentativeHold', { actor: 'agent_scheduling', at: at(4) });

  const policyNeedsHuman = {
    id: 'policy_eval_outside_hours',
    requestedAction: 'calendar.confirmMeeting',
    actor: 'agent_scheduling',
    matchedPolicyId: 'policy_scheduling_hours',
    decision: 'needsHuman',
    grantType: 'oneTime',
    effectiveAt: at(5),
    expiresAt: '2026-10-01T21:00:00.000Z',
    reasonCode: 'outsidePreferredWorkingHours'
  };
  const blocked = acceptProposal(work, 'proposal_acme_time', 'option_1630', policyNeedsHuman, { actor: 'agent_scheduling', idempotencyKey: 'accept-acme-1', actionId: 'action_accept_1', at: at(5) });
  work = blocked.case;
  assert.equal(blocked.action.outcome, 'needsApproval');
  assert.equal(work.state, 'waitingForHuman');

  const approvalInput = { id: 'action_human_approval', actionKey: 'approveOnce', actor: 'human_rachel', idempotencyKey: 'approve-acme-1', externalRefs: { policyEvaluationId: policyNeedsHuman.id } };
  const approved = applyHumanAction(work, approvalInput, { at: at(6) });
  work = approved.case;
  assert.equal(work.state, 'authorized');
  const replay = applyHumanAction(work, approvalInput, { at: at(7) });
  assert.equal(replay.replay, true);
  assert.equal(replay.case.events.length, work.events.length);

  const allowed = acceptProposal(work, 'proposal_acme_time', 'option_1630', { ...policyNeedsHuman, id: 'policy_eval_one_time_grant', decision: 'allow', effectiveAt: at(7), reasonCode: 'humanApprovedOnce' }, { actor: 'agent_scheduling', idempotencyKey: 'accept-acme-2', actionId: 'action_accept_2', at: at(7) });
  work = allowed.case;
  assert.equal(allowed.action.outcome, 'ok');
  assert.equal(work.proposals[0].status, 'accepted');
  assert.equal(work.proposals[0].acceptedOptionId, 'option_1630');

  work = transitionCase(work, 'executing', { actor: 'agent_scheduling', at: at(8) });
  work = transitionCase(work, 'sent', { actor: 'calendar_service', at: at(9) });
  work = transitionCase(work, 'received', { actor: 'calendar_service', at: at(10) });
  work = transitionCase(work, 'accepted', { actor: 'external_morgan', at: at(11) });
  assert.throws(() => transitionCase(work, 'completed', { actor: 'calendar_service', at: at(12) }), /receipt is required/);
  work = completeCase(work, {
    id: 'receipt_cal_83921',
    result: 'Meeting confirmed for Thursday, October 1 at 4:30 PM Eastern',
    counterparties: ['external_morgan'],
    externalIds: { calendarEventId: 'cal_83921' },
    authorityBasis: 'policy_eval_one_time_grant',
    humanApprovalStatus: 'approved',
    evidenceRefs: [],
    createdAt: at(12)
  }, { actor: 'calendar_service', at: at(12) });

  assert.equal(work.state, 'completed');
  assert.equal(work.receipt.externalIds.calendarEventId, 'cal_83921');
  assert.equal(work.events.at(-1).type, 'receipt');
  assert.throws(() => transitionCase(work, 'inProgress', { actor: 'agent_scheduling', at: at(13) }), /cannot transition/);
});

test('counteroffers preserve prior options as expired audit history', () => {
  let work = createCase({ id: 'case_negotiation', objective: 'Negotiate supplier renewal', principal: 'human_rachel', actingAgent: 'agent_procurement', createdAt: at(0) });
  work = addProposal(work, { id: 'proposal_terms', kind: 'negotiation', options: [option('option_original', '2026-10-01T20:30:00.000Z')], status: 'open', acceptedOptionId: null, expiresAt: null, createdAt: at(1), updatedAt: at(1) });
  work = counterProposal(work, 'proposal_terms', { options: [option('option_counter', '2026-10-02T20:30:00.000Z')], at: at(2) });
  assert.equal(work.proposals[0].status, 'countered');
  assert.equal(work.proposals[0].options[0].expired, true);
  assert.equal(work.proposals[0].options[1].expired, false);
  assertValidCase(work);
});

test('state machine preserves unknown external results as a distinct terminal state', () => {
  let work = createCase({ id: 'case_unknown', objective: 'Submit annual benefits enrollment', principal: 'human_rachel', actingAgent: 'agent_forms', createdAt: at(0) });
  work = transitionCase(work, 'inProgress', { actor: 'agent_forms', at: at(1) });
  work = transitionCase(work, 'unknownExternalResult', { actor: 'benefits_service', at: at(2), reasonCode: 'providerReturnedNoConfirmation' });
  assert.equal(work.state, 'unknownExternalResult');
  assert.equal(canTransition('unknownExternalResult', 'completed'), false);
  assert.throws(() => transitionCase(work, 'completed', { actor: 'agent_forms', at: at(3) }), /cannot transition/);
});
