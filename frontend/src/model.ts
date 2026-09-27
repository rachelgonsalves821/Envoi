import type { Agent, AuditEvent, CaseEvent, CaseState, HumanView, Message, NavSection, ParticipantIdentity, PolicyEvaluation, WorkCase } from './types';

export interface ResolvedParticipant extends ParticipantIdentity {
  relationship: 'localAgent' | 'counterpartyAgent' | 'principal' | 'participant' | 'unknown';
}

export const STATE_META: Record<CaseState, { label: string; tone: 'neutral' | 'attention' | 'waiting' | 'success' | 'danger' | 'unknown' | 'tentative'; description: string }> = {
  new: { label: 'New', tone: 'neutral', description: 'Ready to be classified' }, classifying: { label: 'Classifying', tone: 'neutral', description: 'Agent is identifying the work' }, inProgress: { label: 'In progress', tone: 'neutral', description: 'Agent is advancing the objective' }, waitingForExternalParty: { label: 'Waiting for external party', tone: 'waiting', description: 'Another participant needs to respond' }, waitingForHuman: { label: 'Waiting for human', tone: 'attention', description: 'Your judgment is required' }, tentativeHold: { label: 'Tentative hold', tone: 'tentative', description: 'Reserved but not confirmed' }, authorized: { label: 'Authorized', tone: 'success', description: 'Authority has been granted' }, executing: { label: 'Executing', tone: 'neutral', description: 'An approved action is underway' }, sent: { label: 'Sent', tone: 'neutral', description: 'Sent to the external party' }, received: { label: 'Received', tone: 'waiting', description: 'The external party received it' }, accepted: { label: 'Accepted', tone: 'success', description: 'The outcome was accepted' }, completed: { label: 'Completed', tone: 'success', description: 'A durable receipt is available' }, failed: { label: 'Failed', tone: 'danger', description: 'The action did not succeed' }, unknownExternalResult: { label: 'Unknown external result', tone: 'unknown', description: 'The external system did not confirm a result' }, expired: { label: 'Expired', tone: 'danger', description: 'The available action is no longer valid' }, paused: { label: 'Paused', tone: 'tentative', description: 'Conversation paused by a human' }, revoked: { label: 'Revoked', tone: 'danger', description: 'Authority has been withdrawn' }, disputed: { label: 'Disputed', tone: 'danger', description: 'The outcome is under dispute' }
};

export function caseState(workCase: WorkCase): CaseState {
  if (workCase.state && STATE_META[workCase.state]) return workCase.state;
  if (workCase.status === 'completed') return 'completed';
  if (workCase.status === 'failed') return 'failed';
  if (workCase.status === 'paused') return 'paused';
  return 'inProgress';
}

export function sectionForCase(workCase: WorkCase): NavSection {
  const state = caseState(workCase);
  if (['waitingForHuman', 'failed', 'unknownExternalResult', 'disputed'].includes(state)) return 'needsMe';
  if (state === 'waitingForExternalParty' || state === 'tentativeHold') return 'waiting';
  if (state === 'completed') return 'completed';
  if (workCase.proposals?.some(proposal => proposal.kind === 'schedule')) return 'scheduled';
  if (workCase.proposals?.some(proposal => ['form', 'document'].includes(proposal.kind))) return 'documents';
  return 'active';
}

export function casesForSection(cases: WorkCase[], section: NavSection) {
  if (['policies', 'integrations', 'activity'].includes(section)) return [];
  return cases.filter(workCase => sectionForCase(workCase) === section);
}

export function decisionPolicy(workCase: WorkCase): PolicyEvaluation | undefined {
  return workCase.policyEvaluations?.slice().reverse().find(item => item.decision === 'needsHuman') || workCase.policyEvaluations?.at(-1);
}

export function messagesForCase(messages: Message[], caseId: string) {
  return messages.filter(message => message.caseId === caseId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function timelineForCase(workCase: WorkCase, messages: Message[]): CaseEvent[] {
  const structured = workCase.events || [];
  const messageEvents: CaseEvent[] = messagesForCase(messages, workCase.id).map(message => ({ id: message.id, type: 'message', actor: message.senderAgentId || message.senderHumanId || 'external', createdAt: message.createdAt, payload: { text: message.text, messageType: message.type, deliveryState: message.status, senderAgentId: message.senderAgentId, senderHumanId: message.senderHumanId, recipientAgentId: message.recipientAgentId }, linkedPolicyEvaluation: null, precedingEventRef: null }));
  const ids = new Set(structured.map(event => event.id));
  return [...structured, ...messageEvents.filter(event => !ids.has(event.id))].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function participantIds(workCase: WorkCase, events: CaseEvent[] = []): string[] {
  const eventParticipants = events.flatMap(event => [event.payload.senderAgentId, event.payload.senderHumanId, event.payload.recipientAgentId, isExchangeEvent(event) ? event.actor : undefined]);
  return [...new Set([workCase.actingAgent, ...(workCase.participants || []), ...(workCase.participantAgentIds || []), ...(workCase.participantHumanIds || []), ...eventParticipants].filter((value): value is string => Boolean(value)))];
}

export function resolveParticipant(workCase: WorkCase, participantId: string | undefined, agents: Agent[] = [], participantDirectory?: Record<string, ParticipantIdentity> | ParticipantIdentity[]): ResolvedParticipant {
  const id = participantId || 'unknown-external-agent';
  const sourceDirectory = participantDirectory || workCase.participantDirectory;
  const directory = Array.isArray(sourceDirectory)
    ? sourceDirectory
    : Object.entries(sourceDirectory || {}).map(([key, value]) => ({ ...value, id: value.id || key }));
  const listed = directory.find(item => item.id === id);
  const agent = agents.find(item => item.id === id);
  const relationship = id === workCase.actingAgent
    ? 'localAgent'
    : id === workCase.principal
      ? 'principal'
      : listed?.type === 'internalAgent' || listed?.type === 'externalAgent' || agent
        ? 'counterpartyAgent'
        : listed
          ? 'participant'
          : 'unknown';
  if (listed) return { ...listed, relationship };
  if (agent) return { id, type: id === workCase.actingAgent ? 'internalAgent' : 'externalAgent', displayName: agent.name, accessState: agent.status === 'active' ? 'active' : 'unavailable', address: agent.address, relationship };
  if (id === workCase.principal) return { id, type: 'human', displayName: 'Human principal', accessState: 'active', relationship: 'principal' };
  return { id, type: id === workCase.actingAgent ? 'internalAgent' : 'externalAgent', displayName: id === 'unknown-external-agent' ? 'Unknown external agent' : humanize(id), accessState: 'unavailable', relationship };
}

export function exchangeParties(workCase: WorkCase, event: CaseEvent, agents: Agent[] = [], participantDirectory?: Record<string, ParticipantIdentity> | ParticipantIdentity[]) {
  const senderId = event.payload.senderAgentId || event.payload.senderHumanId || event.actor;
  const knownIds = participantIds(workCase, [event]);
  const inferredRecipient = knownIds.find(id => id !== senderId && (senderId === workCase.actingAgent ? id !== workCase.principal : id === workCase.actingAgent))
    || knownIds.find(id => id !== senderId && id !== workCase.principal);
  const recipientId = event.payload.recipientAgentId || inferredRecipient;
  const sender = resolveParticipant(workCase, senderId, agents, participantDirectory);
  const recipient = resolveParticipant(workCase, recipientId, agents, participantDirectory);
  return {
    sender,
    recipient,
    direction: sender.id === workCase.actingAgent ? 'outbound' as const : recipient.id === workCase.actingAgent ? 'inbound' as const : 'betweenParties' as const
  };
}

export function isExchangeEvent(event: CaseEvent) {
  const exchangeTypes = ['request', 'proposal', 'counterproposal', 'acceptance', 'rejection', 'message'];
  return event.type === 'message' || Boolean(event.payload.proposalId) || exchangeTypes.includes(String(event.payload.messageType || '').toLowerCase());
}

export function eventSummary(event: CaseEvent): string {
  const action = event.payload.action;
  if (action?.actionKey) {
    const labels: Record<string, string> = { approveOnce: 'Approved once', decline: 'Declined', editProposal: 'Requested proposal edits', pause: 'Paused conversation', revoke: 'Revoked authority', takeOver: 'Took over this conversation', acceptProposal: 'Attempted to accept the proposal' };
    const outcome = action.outcome === 'unknown' ? ' The external result is unknown.' : action.outcome === 'failed' ? ' The action failed.' : '';
    return `${labels[action.actionKey] || action.actionKey}.${outcome}`;
  }
  if (event.type === 'stateChange') return `State changed from ${stateLabel(event.payload.from)} to ${stateLabel(event.payload.to)}.`;
  if (event.type === 'policyEvaluation') return `Policy checked ${humanize(event.payload.requestedAction)}: ${humanize(event.payload.decision)}.`;
  if (event.type === 'receipt') return event.payload.receipt?.result || 'A durable receipt was recorded.';
  if (event.payload.text) return String(event.payload.text);
  if (event.payload.message) return String(event.payload.message);
  return humanize(event.type);
}

export function auditSummary(event: AuditEvent): string {
  const subject = event.caseId || event.agentId || event.messageId || event.assetId || '';
  return `${humanize(event.type)}${subject ? ` · ${subject}` : ''}`;
}

export function stateLabel(value: unknown) {
  return typeof value === 'string' && value in STATE_META ? STATE_META[value as CaseState].label : humanize(value);
}

export function humanize(value: unknown) {
  return String(value || 'Update').replace(/[._-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, character => character.toUpperCase());
}

export function caseCounts(view: HumanView) {
  return view.cases.reduce<Record<NavSection, number>>((counts, item) => { counts[sectionForCase(item)] += 1; return counts; }, { needsMe: 0, active: 0, waiting: 0, scheduled: 0, documents: 0, completed: 0, policies: 0, integrations: view.agents.length, activity: view.recentEvents.length });
}
