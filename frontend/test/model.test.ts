import { describe, expect, it } from 'vitest';
import { STATE_META, caseState, casesForSection, eventSummary, exchangeParties, participantIds, resolveParticipant, sectionForCase, timelineForCase } from '../src/model';
import type { Message, WorkCase } from '../src/types';

const baseCase = (overrides: Partial<WorkCase> = {}): WorkCase => ({
  id: 'case_acme_q4',
  schemaVersion: '1.0',
  objective: 'Schedule Q4 planning with Acme',
  state: 'waitingForHuman',
  principal: 'human_rachel',
  actingAgent: 'agent_scheduling',
  participants: ['agent_scheduling', 'human_morgan'],
  constraints: { workingHoursEnd: '16:00', timezone: 'America/Toronto' },
  deadline: '2026-10-03T03:59:00.000Z',
  authorityRefs: [],
  events: [],
  evidence: [],
  proposals: [],
  policyEvaluations: [],
  receipt: null,
  createdAt: '2026-09-27T16:00:00.000Z',
  updatedAt: '2026-09-27T17:00:00.000Z',
  ...overrides
});

describe('Agent Interface to Human Interface translation', () => {
  it('keeps sent, received, accepted, and completed distinct', () => {
    expect(['sent', 'received', 'accepted', 'completed'].map(state => STATE_META[state as keyof typeof STATE_META].label))
      .toEqual(['Sent', 'Received', 'Accepted', 'Completed']);
  });

  it('uses a dedicated unknown treatment rather than success or failure', () => {
    expect(STATE_META.unknownExternalResult.tone).toBe('unknown');
    expect(STATE_META.unknownExternalResult.description).toContain('did not confirm');
  });

  it('routes human judgment and unknown results to Needs me', () => {
    expect(sectionForCase(baseCase())).toBe('needsMe');
    expect(sectionForCase(baseCase({ state: 'unknownExternalResult' }))).toBe('needsMe');
    expect(sectionForCase(baseCase({ state: 'waitingForExternalParty' }))).toBe('waiting');
  });

  it('classifies schedule and document proposals without inventing case state', () => {
    const schedule = baseCase({ state: 'inProgress', proposals: [{ id: 'proposal_1', kind: 'schedule', status: 'open', expiresAt: null, options: [] }] });
    const document = baseCase({ state: 'inProgress', proposals: [{ id: 'proposal_2', kind: 'document', status: 'open', expiresAt: null, options: [] }] });
    expect(sectionForCase(schedule)).toBe('scheduled');
    expect(sectionForCase(document)).toBe('documents');
    expect(casesForSection([schedule, document], 'scheduled')).toEqual([schedule]);
  });

  it('normalizes legacy active cases without changing the source object', () => {
    const legacy = baseCase({ schemaVersion: undefined, state: undefined, status: 'active' });
    expect(caseState(legacy)).toBe('inProgress');
    expect(legacy.state).toBeUndefined();
  });

  it('merges structured events and legacy messages chronologically', () => {
    const workCase = baseCase({ events: [{ id: 'evt_2', type: 'stateChange', actor: 'agent_scheduling', createdAt: '2026-09-27T17:00:00.000Z', payload: { from: 'inProgress', to: 'waitingForHuman' }, linkedPolicyEvaluation: null, precedingEventRef: null }] });
    const messages: Message[] = [{ id: 'msg_1', caseId: workCase.id, senderType: 'agent', senderAgentId: 'agent_scheduling', type: 'message', text: 'I found one mutually available time.', createdAt: '2026-09-27T16:30:00.000Z', status: 'delivered' }];
    const timeline = timelineForCase(workCase, messages);
    expect(timeline.map(item => item.id)).toEqual(['msg_1', 'evt_2']);
    expect(timeline[0].payload).toMatchObject({ senderAgentId: 'agent_scheduling', deliveryState: 'delivered' });
  });

  it('resolves workspace and case participant directories in map or array form', () => {
    const external = resolveParticipant(baseCase(), 'agent_acme', [], { agent_acme: { id: 'agent_acme', type: 'externalAgent', displayName: 'Acme scheduling agent', accessState: 'active' } });
    const caseDirectory = baseCase({ participantDirectory: [{ id: 'agent_acme', type: 'externalAgent', displayName: 'Acme scheduling agent', accessState: 'active' }] });
    expect(external).toMatchObject({ displayName: 'Acme scheduling agent', relationship: 'counterpartyAgent' });
    expect(resolveParticipant(caseDirectory, 'agent_acme')).toMatchObject({ displayName: 'Acme scheduling agent', relationship: 'counterpartyAgent' });
  });

  it('falls back to event participants and labels unavailable identities explicitly', () => {
    const event = { id: 'evt_offer', type: 'message' as const, actor: 'agent_vendor', createdAt: '2026-09-27T16:40:00.000Z', payload: { messageType: 'proposal', senderAgentId: 'agent_vendor', recipientAgentId: 'agent_scheduling' }, linkedPolicyEvaluation: null, precedingEventRef: null };
    expect(participantIds(baseCase(), [event])).toContain('agent_vendor');
    expect(resolveParticipant(baseCase(), 'agent_vendor')).toMatchObject({ displayName: 'Agent vendor', accessState: 'unavailable', relationship: 'unknown' });
    expect(resolveParticipant(baseCase(), undefined)).toMatchObject({ displayName: 'Unknown external agent', accessState: 'unavailable' });
  });

  it('derives inbound and outbound exchange direction with named parties', () => {
    const directory = {
      agent_scheduling: { id: 'agent_scheduling', type: 'internalAgent' as const, displayName: 'My scheduling agent', accessState: 'active' as const },
      agent_acme: { id: 'agent_acme', type: 'externalAgent' as const, displayName: 'Acme scheduling agent', accessState: 'active' as const }
    };
    const workCase = baseCase({ participants: ['agent_scheduling', 'agent_acme'] });
    const outbound = exchangeParties(workCase, { id: 'evt_out', type: 'message', actor: 'agent_scheduling', createdAt: '2026-09-27T16:30:00.000Z', payload: { senderAgentId: 'agent_scheduling', recipientAgentId: 'agent_acme' }, linkedPolicyEvaluation: null, precedingEventRef: null }, [], directory);
    const inbound = exchangeParties(workCase, { id: 'evt_in', type: 'message', actor: 'agent_acme', createdAt: '2026-09-27T16:35:00.000Z', payload: { senderAgentId: 'agent_acme', recipientAgentId: 'agent_scheduling' }, linkedPolicyEvaluation: null, precedingEventRef: null }, [], directory);
    expect(outbound).toMatchObject({ direction: 'outbound', sender: { displayName: 'My scheduling agent' }, recipient: { displayName: 'Acme scheduling agent' } });
    expect(inbound).toMatchObject({ direction: 'inbound', sender: { displayName: 'Acme scheduling agent' }, recipient: { displayName: 'My scheduling agent' } });
  });

  it('uses the action vocabulary end to end', () => {
    expect(eventSummary({ id: 'evt_approval', type: 'humanAction', actor: 'human_rachel', createdAt: '2026-09-27T17:10:00.000Z', payload: { action: { actionKey: 'approveOnce', outcome: 'ok' } }, linkedPolicyEvaluation: 'policy_1', precedingEventRef: null })).toBe('Approved once.');
  });
});
