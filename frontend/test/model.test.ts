import { describe, expect, it } from 'vitest';
import { STATE_META, assetDisplayName, assetStateMeta, canDownloadAsset, caseState, casesForSection, eventSummary, exchangeParties, filterAssets, onboardingSteps, participantIds, resolveParticipant, sectionForCase, timelineForCase } from '../src/model';
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

describe('asset safety model', () => {
  it('keeps downloads locked until a clean scan result exists', () => {
    const baseAsset = { id: 'obj_1', caseId: 'case_acme_q4', filename: 'brief.pdf', mimeType: 'application/pdf', size: 10, createdByAgentId: 'agent_scheduling', createdAt: '2026-09-27T16:00:00.000Z' };
    expect(assetDisplayName(baseAsset)).toBe('brief.pdf');
    expect(canDownloadAsset({ ...baseAsset, state: 'quarantine' })).toBe(false);
    expect(assetStateMeta({ ...baseAsset, state: 'infected' }).label).toBe('Blocked: infected');
    expect(canDownloadAsset({ ...baseAsset, state: 'clean' })).toBe(true);
  });
});

describe('closed beta onboarding', () => {
  it('derives completion only from observable server state', () => {
    const workCase = baseCase({ state: 'completed', receipt: { id: 'receipt_1', result: 'Done', authorityBasis: 'policy_1', humanApprovalStatus: 'notRequired', createdAt: '2026-09-27T17:00:00.000Z' } });
    const view = {
      inbox: { id: 'inbox_1', organizationId: 'org_1', name: 'Workspace', ownerAgentId: null, ownerHumanId: 'human_1', status: 'active', createdAt: '2026-09-27T16:00:00.000Z' },
      mode: 'human-observer' as const,
      canManageInbox: false,
      capabilities: [], summary: { agents: 1, cases: 1, messages: 1, assets: 0, needsMe: 0 }, navigation: { needsMe: 0, activeWork: 1, waiting: 0, completed: 0 },
      participantDirectory: { external_1: { id: 'external_1', type: 'externalAgent' as const, displayName: 'Known agent', accessState: 'active' as const } },
      agents: [{ id: 'agent_1', name: 'My agent', address: 'mine@sinaloa.mail', principalHumanId: 'human_1', status: 'active', onboardingStatus: 'approved', permissions: [] }],
      caseQueue: [workCase], cases: [workCase],
      messages: [{ id: 'message_1', caseId: workCase.id, senderType: 'agent' as const, senderAgentId: 'agent_1', type: 'message', text: 'Processed', createdAt: '2026-09-27T16:30:00.000Z', status: 'processed' }],
      assets: [], calendarProviders: { google: { id: 'google' as const, label: 'Google Calendar', configured: false }, outlook: { id: 'outlook' as const, label: 'Outlook Calendar', configured: false } }, calendarConnectors: [], deliveryReceipts: [], recentEvents: [{ id: 'audit_1', type: 'agent.enrolled', createdAt: '2026-09-27T16:10:00.000Z' }]
    };
    expect(onboardingSteps(view).every(step => step.complete)).toBe(true);
    const sourceView = { ...view, agents: [], summary: { ...view.summary, agents: 0 } };
    const linkedAgentInbox = { ...view.inbox, id: 'inbox_agent_1', name: 'My agent inbox', ownerAgentId: 'agent_1', parentInboxId: view.inbox.id, kind: 'agent' as const };
    expect(onboardingSteps(sourceView).find(step => step.id === 'enroll')?.complete).toBe(false);
    const parentAudit = [{ id: 'audit_parent_1', type: 'agent.inbox_created', createdAt: '2026-09-27T16:10:00.000Z' }];
    const parentSteps = onboardingSteps({ ...sourceView, recentEvents: parentAudit, messages: [], deliveryReceipts: [] }, [linkedAgentInbox]);
    expect(parentSteps.find(step => step.id === 'sdk')?.complete).toBe(true);
    expect(parentSteps.find(step => step.id === 'runtime')?.complete).toBe(false);
    const linkedSteps = onboardingSteps({ ...sourceView, recentEvents: [], messages: [], deliveryReceipts: [] }, [linkedAgentInbox]);
    expect(linkedSteps.find(step => step.id === 'enroll')?.complete).toBe(true);
    expect(linkedSteps.filter(step => ['sdk', 'approve', 'runtime'].includes(step.id)).every(step => !step.complete)).toBe(true);
  });

  it('treats a processed message receipt as runtime activity, not a completed case outcome', () => {
    const workCase = baseCase({ receipt: null });
    const view = {
      inbox: { id: 'inbox_1', organizationId: 'org_1', name: 'Agent inbox', ownerAgentId: 'agent_1', ownerHumanId: 'human_1', status: 'active', createdAt: '2026-09-27T16:00:00.000Z' },
      mode: 'human-observer' as const,
      canManageInbox: false,
      capabilities: [], summary: { agents: 1, cases: 1, messages: 1, assets: 0, needsMe: 0 }, navigation: { needsMe: 0, activeWork: 1, waiting: 0, completed: 0 },
      participantDirectory: { external_1: { id: 'external_1', type: 'externalAgent' as const, displayName: 'Known agent', accessState: 'active' as const } },
      agents: [{ id: 'agent_1', name: 'My agent', address: 'mine@sinaloa.mail', principalHumanId: 'human_1', status: 'active', onboardingStatus: 'approved', permissions: [] }],
      caseQueue: [workCase], cases: [workCase],
      messages: [{ id: 'message_1', caseId: workCase.id, senderType: 'agent' as const, senderAgentId: 'agent_1', type: 'message', text: 'Processed', createdAt: '2026-09-27T16:30:00.000Z', status: 'processed' }],
      assets: [], calendarProviders: { google: { id: 'google' as const, label: 'Google Calendar', configured: false }, outlook: { id: 'outlook' as const, label: 'Outlook Calendar', configured: false } }, calendarConnectors: [],
      deliveryReceipts: [{ id: 'delivery_receipt_1', type: 'delivery' as const, messageId: 'message_1', state: 'processed' as const, createdAt: '2026-09-27T16:35:00.000Z' }], recentEvents: []
    };
    expect(onboardingSteps(view).find(step => step.id === 'runtime')).toMatchObject({ complete: true, description: 'A runtime acknowledged or processed work. This does not claim it is currently online.' });
    expect(onboardingSteps(view).find(step => step.id === 'delivery')).toMatchObject({ complete: false, description: 'Delivery is visible; a completed case with its own outcome receipt is still required.' });
  });

  it('does not infer token redemption or live presence from an enrolled identity', () => {
    const workCase = baseCase();
    const view = {
      inbox: { id: 'inbox_1', organizationId: 'org_1', name: 'Agent inbox', ownerAgentId: 'agent_1', ownerHumanId: 'human_1', status: 'active', createdAt: '2026-09-27T16:00:00.000Z' },
      mode: 'human-observer' as const,
      canManageInbox: true,
      capabilities: [], summary: { agents: 1, cases: 1, messages: 0, assets: 0, needsMe: 0 }, navigation: { needsMe: 0, activeWork: 1, waiting: 0, completed: 0 },
      participantDirectory: {},
      agents: [{ id: 'agent_1', name: 'My agent', address: 'mine@sinaloa.mail', principalHumanId: 'human_1', status: 'active', onboardingStatus: 'approved', permissions: [] }],
      caseQueue: [workCase], cases: [workCase], messages: [], assets: [],
      calendarProviders: { google: { id: 'google' as const, label: 'Google Calendar', configured: false }, outlook: { id: 'outlook' as const, label: 'Outlook Calendar', configured: false } }, calendarConnectors: [], deliveryReceipts: [], recentEvents: []
    };
    expect(onboardingSteps(view).find(step => step.id === 'sdk')).toMatchObject({ complete: false, description: 'An agent identity alone does not confirm that its one-time link was redeemed.' });
    expect(onboardingSteps(view).find(step => step.id === 'runtime')).toMatchObject({ complete: false, description: 'No runtime activity is visible yet. Enrollment alone does not prove a runtime is online.' });
  });

  it('discloses when the completed case outcome may be outside loaded history', () => {
    const workCase = baseCase({ receipt: null });
    const view = {
      inbox: { id: 'inbox_1', organizationId: 'org_1', name: 'Agent inbox', ownerAgentId: 'agent_1', ownerHumanId: 'human_1', status: 'active', createdAt: '2026-09-27T16:00:00.000Z' },
      mode: 'human-observer' as const,
      canManageInbox: true,
      capabilities: [], summary: { agents: 1, cases: 1, messages: 1, assets: 0, needsMe: 0 }, navigation: { needsMe: 0, activeWork: 1, waiting: 0, completed: 0 },
      participantDirectory: { external_1: { id: 'external_1', type: 'externalAgent' as const, displayName: 'Known agent', accessState: 'active' as const } },
      agents: [{ id: 'agent_1', name: 'My agent', address: 'mine@sinaloa.mail', principalHumanId: 'human_1', status: 'active', onboardingStatus: 'approved', permissions: [] }],
      caseQueue: [workCase], cases: [workCase],
      messages: [{ id: 'message_1', caseId: workCase.id, senderType: 'agent' as const, senderAgentId: 'agent_1', type: 'message', text: 'Delivered', createdAt: '2026-09-27T16:30:00.000Z', status: 'delivered' }],
      assets: [], calendarProviders: { google: { id: 'google' as const, label: 'Google Calendar', configured: false }, outlook: { id: 'outlook' as const, label: 'Outlook Calendar', configured: false } }, calendarConnectors: [], deliveryReceipts: [], recentEvents: [],
      history: { cases: { total: 80, hasMore: true, nextCursor: 'case_cursor' } }
    };
    expect(onboardingSteps(view).find(step => step.id === 'delivery')).toMatchObject({ complete: false, description: 'Delivery is visible, but older history is not loaded. Load it to verify a completed case outcome.' });
  });

  it('finds files across cases by name, creator, type and newest timestamp', () => {
    const cases = [baseCase({ id: 'case_one', objective: 'Research brief' }), baseCase({ id: 'case_two', objective: 'Launch copy' })];
    const agents = [{ id: 'agent_scheduling', name: 'Milo', address: 'milo@sinaloa.mail', principalHumanId: 'human_rachel', status: 'active', onboardingStatus: 'approved', permissions: [] }];
    const assets = [
      { id: 'one', caseId: 'case_one', filename: 'brief.pdf', mimeType: 'application/pdf', size: 10, createdByAgentId: 'agent_scheduling', createdAt: '2026-09-27T16:00:00.000Z', state: 'clean' as const },
      { id: 'two', caseId: 'case_two', filename: 'copy.csv', mimeType: 'text/csv', size: 10, createdByAgentId: 'agent_scheduling', createdAt: '2026-09-28T16:00:00.000Z', state: 'scanning' as const }
    ];
    expect(filterAssets(assets, cases, agents, {}).map(item => item.id)).toEqual(['two', 'one']);
    expect(filterAssets(assets, cases, agents, { query: 'research', mimeType: 'application/pdf', creatorId: 'agent_scheduling' }).map(item => item.id)).toEqual(['one']);
    expect(filterAssets(assets, cases, agents, { caseId: 'case_two' }).map(item => item.id)).toEqual(['two']);
    expect(filterAssets(assets, cases, agents, { query: 'unknown' })).toEqual([]);
  });
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

  it('uses the server projection bucket instead of rebuilding workflow state', () => {
    expect(sectionForCase(baseCase({ state: 'tentativeHold', bucket: 'needsMe' }))).toBe('needsMe');
    expect(sectionForCase(baseCase({ state: 'paused', bucket: 'needsMe' }))).toBe('needsMe');
    expect(sectionForCase(baseCase({ state: 'expired', bucket: 'completed' }))).toBe('completed');
  });

  it('filters scheduling and artifact modes without inventing workflow state', () => {
    const schedule = baseCase({ state: 'inProgress', collaborationMode: 'scheduling' });
    const document = baseCase({ state: 'inProgress', collaborationMode: 'artifactCreation' });
    expect(sectionForCase(schedule)).toBe('active');
    expect(sectionForCase(document)).toBe('active');
    expect(casesForSection([schedule, document], 'scheduled')).toEqual([schedule]);
    expect(casesForSection([schedule, document], 'documents')).toEqual([document]);
  });

  it('normalizes legacy active cases without changing the source object', () => {
    const legacy = baseCase({ schemaVersion: undefined, state: undefined, status: 'active' });
    expect(caseState(legacy)).toBe('inProgress');
    expect(legacy.state).toBeUndefined();
  });

  it('prefers the authoritative structured ledger over legacy message records', () => {
    const workCase = baseCase({ events: [{ id: 'evt_2', type: 'stateChange', actor: 'agent_scheduling', createdAt: '2026-09-27T17:00:00.000Z', payload: { from: 'inProgress', to: 'waitingForHuman' }, linkedPolicyEvaluation: null, precedingEventRef: null }] });
    const messages: Message[] = [{ id: 'msg_1', caseId: workCase.id, senderType: 'agent', senderAgentId: 'agent_scheduling', type: 'message', text: 'I found one mutually available time.', createdAt: '2026-09-27T16:30:00.000Z', status: 'delivered' }];
    const timeline = timelineForCase(workCase, messages);
    expect(timeline.map(item => item.id)).toEqual(['evt_2']);
  });

  it('does not duplicate a message already present in the authoritative case ledger', () => {
    const message: Message = { id: 'msg_1', caseId: 'case_acme_q4', senderType: 'agent', senderAgentId: 'agent_scheduling', recipientAgentId: 'agent_acme', type: 'message', text: 'One canonical message.', createdAt: '2026-09-27T16:30:00.000Z', status: 'delivered' };
    const workCase = baseCase({ events: [{ id: 'evt_msg_1', type: 'message', actor: 'agent_scheduling', createdAt: message.createdAt, payload: { messageId: message.id, text: message.text, senderAgentId: message.senderAgentId, recipientAgentId: message.recipientAgentId, deliveryState: message.status }, linkedPolicyEvaluation: null, precedingEventRef: null }] });
    expect(timelineForCase(workCase, [message])).toHaveLength(1);
    expect(timelineForCase(workCase, [message])[0].id).toBe('evt_msg_1');
  });

  it('keeps Inbox as an all-conversation view while workflow buckets stay canonical', () => {
    const needsMe = baseCase({ id: 'case_needs_me', bucket: 'needsMe' });
    const waiting = baseCase({ id: 'case_waiting', state: 'sent', bucket: 'waiting' });
    expect(casesForSection([needsMe, waiting], 'inbox')).toEqual([needsMe, waiting]);
    expect(casesForSection([needsMe, waiting], 'needsMe')).toEqual([needsMe]);
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
