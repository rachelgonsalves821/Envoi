import type { Agent, Asset, AssetState, AuditEvent, CaseEvent, CaseState, HumanView, Inbox, Message, NavSection, ParticipantIdentity, PolicyEvaluation, WorkCase } from './types';
import { collapseMessageProgress } from './conversation-timeline';

export interface ResolvedParticipant extends ParticipantIdentity {
  relationship: 'localAgent' | 'counterpartyAgent' | 'principal' | 'participant' | 'unknown';
}

export const STATE_META: Record<CaseState, { label: string; tone: 'neutral' | 'attention' | 'waiting' | 'success' | 'danger' | 'unknown' | 'tentative'; description: string }> = {
  new: { label: 'New', tone: 'neutral', description: 'Ready to be classified' }, classifying: { label: 'Classifying', tone: 'neutral', description: 'Agent is identifying the work' }, inProgress: { label: 'In progress', tone: 'neutral', description: 'Agent is advancing the objective' }, waitingForExternalParty: { label: 'Waiting for external party', tone: 'waiting', description: 'Another participant needs to respond' }, waitingForHuman: { label: 'Waiting for human', tone: 'attention', description: 'Your judgment is required' }, tentativeHold: { label: 'Tentative hold', tone: 'tentative', description: 'Reserved but not confirmed' }, authorized: { label: 'Authorized', tone: 'success', description: 'Authority has been granted' }, executing: { label: 'Executing', tone: 'neutral', description: 'An approved action is underway' }, sent: { label: 'Sent', tone: 'waiting', description: 'Sent to the external party' }, received: { label: 'Received', tone: 'waiting', description: 'The external party received it' }, accepted: { label: 'Accepted', tone: 'success', description: 'The outcome was accepted' }, completed: { label: 'Completed', tone: 'success', description: 'A durable receipt is available' }, failed: { label: 'Failed', tone: 'danger', description: 'The action did not succeed' }, unknownExternalResult: { label: 'Unknown external result', tone: 'unknown', description: 'The external system did not confirm a result' }, expired: { label: 'Expired', tone: 'danger', description: 'The available action is no longer valid' }, paused: { label: 'Paused', tone: 'tentative', description: 'Agent work is paused for this case' }, revoked: { label: 'Revoked', tone: 'danger', description: 'New agent work is blocked for this case' }, disputed: { label: 'Disputed', tone: 'danger', description: 'The outcome is under dispute' }
};

export const ASSET_STATE_META: Record<AssetState | 'unknown', { label: string; description: string; tone: 'waiting' | 'success' | 'danger' | 'unknown' }> = {
  quarantine: { label: 'Quarantined', description: 'Uploaded and isolated until its safety scan begins.', tone: 'waiting' },
  quarantined: { label: 'Quarantined', description: 'Uploaded and isolated until its safety scan begins.', tone: 'waiting' },
  scanning: { label: 'Scanning', description: 'A malware scan is in progress. Download remains locked.', tone: 'waiting' },
  clean: { label: 'Ready to download', description: 'The safety scan completed without detecting malware.', tone: 'success' },
  infected: { label: 'Blocked: infected', description: 'Malware was detected. This file cannot be downloaded.', tone: 'danger' },
  error: { label: 'Scan failed', description: 'The safety service could not verify this file. Download remains locked.', tone: 'unknown' },
  unknown: { label: 'Safety status unavailable', description: 'This file has no verified scan result. Download remains locked.', tone: 'unknown' }
};

export function assetDisplayName(asset: Asset) { return asset.filename || asset.name || 'Untitled file'; }
export function assetStateMeta(asset: Asset) { return ASSET_STATE_META[asset.state || 'unknown']; }
export function canDownloadAsset(asset: Asset) { return asset.state === 'clean'; }

export function filterAssets(assets: Asset[], cases: WorkCase[], agents: Agent[], filters: { query?: string; caseId?: string; creatorId?: string; mimeType?: string }) {
  const query = (filters.query || '').trim().toLowerCase();
  return assets.filter(asset => {
    const workCase = cases.find(item => item.id === asset.caseId);
    const creator = agents.find(item => item.id === asset.createdByAgentId);
    return (!filters.caseId || asset.caseId === filters.caseId)
      && (!filters.creatorId || asset.createdByAgentId === filters.creatorId)
      && (!filters.mimeType || asset.mimeType === filters.mimeType)
      && (!query || `${assetDisplayName(asset)} ${workCase?.objective || asset.caseId || ''} ${creator?.name || asset.createdByAgentId || ''} ${asset.mimeType}`.toLowerCase().includes(query));
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function onboardingSteps(view: HumanView, agentInboxes: Inbox[] = []) {
  const directory = Array.isArray(view.participantDirectory) ? view.participantDirectory : Object.values(view.participantDirectory || {});
  const hasAgent = view.agents.length > 0 || agentInboxes.length > 0;
  // An inbox-created event also exists for legacy pending-agent creation;
  // only the agent inbox's enrollment event proves one-use redemption.
  const hasRedeemedEnrollment = view.recentEvents.some(event => event.type === 'agent.enrolled');
  const hasApprovedAgent = view.agents.some(agent => agent.onboardingStatus === 'approved' && agent.status === 'active');
  const hasRuntimeActivity = view.deliveryReceipts.some(receipt => ['acknowledged', 'processed'].includes(receipt.state))
    || view.messages.some(message => ['acknowledged', 'processed'].includes(message.status));
  const hasCounterparty = directory.some(participant => participant.type === 'externalAgent' && participant.accessState === 'active');
  const deliveryStates = ['delivered', 'acknowledged', 'processed', 'received'];
  const hasDelivery = view.deliveryReceipts.some(receipt => deliveryStates.includes(receipt.state))
    || view.messages.some(message => deliveryStates.includes(message.status));
  const deliveredMessageIds = new Set(view.deliveryReceipts.filter(receipt => deliveryStates.includes(receipt.state)).map(receipt => receipt.messageId));
  const hasCompletedCaseOutcome = view.caseQueue.some(workCase => caseState(workCase) === 'completed'
    && Boolean(workCase.receipt)
    && view.messages.some(message => message.caseId === workCase.id
      && (deliveredMessageIds.has(message.id) || ['delivered', 'acknowledged', 'processed'].includes(message.status))));
  const redemptionDescription = hasRedeemedEnrollment
    ? 'The one-time token was redeemed and runtime credentials were issued.'
    : hasAgent && view.history?.recentEvents?.hasMore
      ? 'An agent identity exists, but older activity is not loaded, so token redemption is not confirmed.'
      : agentInboxes.length > 0
        ? 'Open the agent inbox to verify its enrollment audit. Inbox creation alone does not confirm that a one-time token was redeemed.'
      : 'An agent identity alone does not confirm that its one-time token was redeemed.';
  const runtimeDescription = hasRuntimeActivity
    ? 'A runtime acknowledged or processed work. This does not claim it is currently online.'
    : 'No runtime activity is visible yet. Enrollment alone does not prove a runtime is online.';
  const hasOlderExchangeHistory = Boolean(view.history?.cases?.hasMore || view.history?.messages?.hasMore || view.history?.deliveryReceipts?.hasMore);
  const deliveryDescription = hasCompletedCaseOutcome
    ? 'Delivery evidence and a completed case outcome are visible to the human.'
    : hasDelivery && hasOlderExchangeHistory
      ? 'Delivery is visible, but older history is not loaded. Load it to verify a completed case outcome.'
      : hasDelivery
        ? 'Delivery is visible; a completed case with its own outcome receipt is still required.'
        : 'No delivery evidence or completed case outcome is visible yet.';
  return [
    { id: 'workspace', label: 'Create your workspace', description: 'Your human control plane and agent inbox are ready.', complete: true },
    { id: 'enroll', label: 'Enroll an agent identity', description: hasAgent ? 'An agent identity and dedicated inbox are visible.' : 'Create a one-time token and wait for the dedicated identity and inbox to appear.', complete: hasAgent },
    { id: 'sdk', label: 'Redeem the one-time token', description: redemptionDescription, complete: hasRedeemedEnrollment },
    { id: 'approve', label: 'Approve scoped access', description: 'The agent is active with its visible permission policy.', complete: hasApprovedAgent },
    { id: 'runtime', label: 'Observe runtime activity', description: runtimeDescription, complete: hasRuntimeActivity },
    { id: 'counterparty', label: 'Identify a known counterparty', description: 'A verified external agent appears after the first native exchange.', complete: hasCounterparty },
    { id: 'delivery', label: 'See a delivery and completed case outcome', description: deliveryDescription, complete: hasCompletedCaseOutcome }
  ];
}

export function caseState(workCase: WorkCase): CaseState {
  if (workCase.state && STATE_META[workCase.state]) return workCase.state;
  if (workCase.status === 'completed') return 'completed';
  if (workCase.status === 'failed') return 'failed';
  if (workCase.status === 'paused') return 'paused';
  return 'inProgress';
}

export function sectionForCase(workCase: WorkCase): NavSection {
  if (workCase.bucket) return ({ needsMe: 'needsMe', activeWork: 'active', waiting: 'waiting', completed: 'completed' } as const)[workCase.bucket];
  const state = caseState(workCase);
  if (['waitingForHuman', 'tentativeHold', 'failed', 'unknownExternalResult', 'paused', 'disputed'].includes(state)) return 'needsMe';
  if (['waitingForExternalParty', 'sent', 'received'].includes(state)) return 'waiting';
  if (['completed', 'expired', 'revoked'].includes(state)) return 'completed';
  return 'active';
}

export function casesForSection(cases: WorkCase[], section: NavSection, assets: Asset[] = []) {
  if (['policies', 'integrations', 'activity'].includes(section)) return [];
  if (section === 'inbox') return cases;
  if (section === 'scheduled') return cases.filter(workCase => workCase.collaborationMode === 'scheduling');
  if (section === 'documents') return cases.filter(workCase => ['artifactCreation', 'knowledgeSharing'].includes(workCase.collaborationMode || '') || workCase.evidence?.length || assets.some(asset => asset.caseId === workCase.id));
  return cases.filter(workCase => sectionForCase(workCase) === section);
}

export function decisionPolicy(workCase: WorkCase): PolicyEvaluation | undefined {
  return workCase.policyEvaluations?.slice().reverse().find(item => item.decision === 'needsHuman') || workCase.policyEvaluations?.at(-1);
}

export function messagesForCase(messages: Message[], caseId: string) {
  return messages.filter(message => message.caseId === caseId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function timelineForCase(workCase: WorkCase, messages: Message[]): CaseEvent[] {
  if (workCase.timeline) return collapseMessageProgress(workCase.timeline.map(event => ({ id: event.id, type: event.type, actor: event.actorId, createdAt: event.createdAt, payload: event.payload, linkedPolicyEvaluation: event.policyEvaluationId, precedingEventRef: null, summary: event.summary })));
  const structured = workCase.events || [];
  if (structured.length) return collapseMessageProgress(structured.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  const messageEvents: CaseEvent[] = messagesForCase(messages, workCase.id).map(message => ({ id: message.id, type: 'message', actor: message.senderAgentId || message.senderHumanId || 'external', createdAt: message.createdAt, payload: { text: message.text, messageType: message.type, deliveryState: message.status, senderAgentId: message.senderAgentId, senderHumanId: message.senderHumanId, recipientAgentId: message.recipientAgentId }, linkedPolicyEvaluation: null, precedingEventRef: null }));
  return collapseMessageProgress(messageEvents);
}

export function caseLabel(workCase: WorkCase) { return workCase.stateLabel || STATE_META[caseState(workCase)].label; }
export function caseTone(workCase: WorkCase) { return workCase.stateTone || STATE_META[caseState(workCase)].tone; }

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
  if (event.summary) return event.summary;
  const action = event.payload.action;
  if (action?.actionKey) {
    const labels: Record<string, string> = { approveOnce: 'Approved once', decline: 'Declined', editProposal: 'Requested proposal edits', pause: 'Paused conversation', resume: 'Resumed conversation', revoke: 'Revoked authority', takeOver: 'Took over this conversation', acceptProposal: 'Attempted to accept the proposal' };
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
  return String(value || 'Update').replace(/[._-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, character => character.toUpperCase()).replace(/\bSinaloa\b/gi, 'Envoi');
}

export function caseCounts(view: HumanView) {
  const cases = view.caseQueue;
  const counts: Record<NavSection, number> = { inbox: cases.length, needsMe: view.navigation.needsMe, active: view.navigation.activeWork, waiting: view.navigation.waiting, scheduled: 0, documents: 0, completed: view.navigation.completed, policies: 0, integrations: view.agents.length, activity: view.recentEvents.length };
  counts.scheduled = casesForSection(cases, 'scheduled').length;
  counts.documents = view.assets.length;
  if (view.history) {
    // Category badges describe loaded results; workspace totals are displayed
    // separately beside the history control rather than inferred from a page.
    counts.needsMe = casesForSection(cases, 'needsMe').length;
    counts.active = casesForSection(cases, 'active').length;
    counts.waiting = casesForSection(cases, 'waiting').length;
    counts.completed = casesForSection(cases, 'completed').length;
  }
  return counts;
}
