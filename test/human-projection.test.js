import test from 'node:test';
import assert from 'node:assert/strict';
import { createCase, addPolicyEvaluation, addProposal, transitionCase } from '../src/agent-interface.js';
import { projectCaseForHuman, projectWorkspaceForHuman } from '../src/human-projection.js';

test('human projection translates authoritative agent state without inventing parallel state', () => {
  let value = createCase({ id: 'case_1', objective: 'Schedule Q4 planning with Acme', principal: 'human_rachel', actingAgent: 'agent_scheduler', participants: ['external_morgan'], deadline: '2026-10-03T03:59:00.000Z', createdAt: '2026-10-01T13:00:00.000Z' });
  value = transitionCase(value, 'inProgress', { actor: 'agent_scheduler', at: '2026-10-01T13:01:00.000Z' });
  value = addProposal(value, { id: 'proposal_1', kind: 'schedule', options: [{ id: 'option_1', value: { start: '2026-10-01T20:30:00.000Z', timezone: 'America/Toronto' }, sourceConfidence: 'fromVerifiedProfile', expired: false, outOfPolicyFlags: ['outsideWorkingHours'] }], status: 'open', acceptedOptionId: null, expiresAt: '2026-10-01T21:00:00.000Z', createdAt: '2026-10-01T13:02:00.000Z', updatedAt: '2026-10-01T13:02:00.000Z' });
  value = transitionCase(value, 'tentativeHold', { actor: 'agent_scheduler', at: '2026-10-01T13:03:00.000Z' });
  value = addPolicyEvaluation(value, { id: 'policy_eval_1', requestedAction: 'calendar.confirmMeeting', actor: 'agent_scheduler', matchedPolicyId: 'policy_hours', decision: 'needsHuman', grantType: 'oneTime', effectiveAt: '2026-10-01T13:04:00.000Z', expiresAt: '2026-10-01T21:00:00.000Z', reasonCode: 'outsidePreferredWorkingHours' });
  value = transitionCase(value, 'waitingForHuman', { actor: 'agent_scheduler', at: '2026-10-01T13:05:00.000Z' });

  const projected = projectCaseForHuman(value);
  assert.equal(projected.state, value.state);
  assert.equal(projected.stateLabel, 'Waiting for you');
  assert.equal(projected.bucket, 'needsMe');
  assert.equal(projected.needsAttention, true);
  assert.equal(projected.decision.policyEvaluationId, 'policy_eval_1');
  assert.deepEqual(projected.decision.availableActions, ['approveOnce', 'editProposal', 'decline', 'takeOver']);
  assert.ok(projected.timeline.some(event => event.summary.includes('Waiting for you')));
  assert.equal(projected.authority[0].decision, 'needsHuman');
  const workspace = projectWorkspaceForHuman([value]);
  assert.equal(workspace.counts.needsMe, 1);
  assert.equal(workspace.counts.activeWork, 0);
});
