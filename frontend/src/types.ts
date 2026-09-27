export type CaseState =
  | 'new' | 'classifying' | 'inProgress' | 'waitingForExternalParty' | 'waitingForHuman'
  | 'tentativeHold' | 'authorized' | 'executing' | 'sent' | 'received' | 'accepted'
  | 'completed' | 'failed' | 'unknownExternalResult' | 'expired' | 'paused' | 'revoked' | 'disputed';

export type EventType = 'message' | 'decision' | 'policyEvaluation' | 'toolAction' | 'humanAction' | 'stateChange' | 'error' | 'receipt';
export type HumanActionKey = 'approveOnce' | 'decline' | 'editProposal' | 'pause' | 'revoke' | 'takeOver';

export interface AuthConfig {
  provider: 'local' | 'workos';
  hosted: boolean;
  phoneVerification?: boolean;
  totp?: boolean;
  signInPath?: string;
  signUpPath?: string;
}

export interface Human {
  id: string;
  displayName: string;
  email?: string;
  phoneNumber?: string;
  auth?: { provider: string; assurance: string };
}

export interface Organization { id: string; name: string; slug: string; status: string }
export interface Inbox { id: string; organizationId: string; name: string; ownerAgentId: string | null; ownerHumanId: string; status: string; createdAt: string }

export interface Agent {
  id: string;
  name: string;
  address: string;
  principalHumanId: string;
  status: string;
  onboardingStatus: string;
  permissions: string[];
  capabilities?: string[];
  approvedAt?: string;
}

export interface ParticipantIdentity {
  id: string;
  type: 'human' | 'internalAgent' | 'externalAgent' | 'organization' | 'connectedService';
  displayName: string;
  orgRef?: string | null;
  organizationId?: string | null;
  inboxId?: string | null;
  accessState?: 'active' | 'revoked' | 'unavailable';
  address?: string | null;
}

export interface PolicyEvaluation {
  id: string;
  requestedAction: string;
  actor: string;
  matchedPolicyId: string | null;
  decision: 'allow' | 'deny' | 'needsHuman';
  grantType: 'oneTime' | 'categoryBased' | 'ongoing';
  effectiveAt: string;
  expiresAt: string | null;
  reasonCode: string;
}

export interface ProposalOption {
  id: string;
  value: Record<string, unknown>;
  sourceConfidence: 'fromVerifiedProfile' | 'enteredForCase' | 'extractedFromDocument';
  expired: boolean;
  outOfPolicyFlags?: string[];
}

export interface Proposal {
  id: string;
  kind: 'schedule' | 'form' | 'negotiation' | 'document' | 'cancellation';
  options: ProposalOption[];
  status: 'open' | 'countered' | 'accepted' | 'expired' | 'withdrawn';
  acceptedOptionId?: string | null;
  expiresAt: string | null;
  createdAt?: string;
}

export interface CaseEvent {
  id: string;
  type: EventType;
  actor: string;
  createdAt: string;
  payload: Record<string, any>;
  linkedPolicyEvaluation: string | null;
  precedingEventRef: string | null;
}

export interface EvidenceItem {
  id: string;
  kind: 'document' | 'calendarReference' | 'confirmationId' | 'externalLink';
  title: string;
  provenance: 'fromVerifiedProfile' | 'enteredForCase' | 'extractedFromDocument';
  url?: string | null;
}

export interface Receipt {
  id: string;
  result: string;
  counterparties?: string[];
  externalIds?: Record<string, unknown>;
  authorityBasis: string;
  humanApprovalStatus: 'approved' | 'notRequired' | 'pending';
  evidenceRefs?: string[];
  createdAt?: string;
}

export interface WorkCase {
  id: string;
  schemaVersion?: string;
  objective?: string;
  state?: CaseState;
  status?: string;
  principal?: string;
  actingAgent?: string;
  participants?: string[];
  participantDirectory?: Record<string, ParticipantIdentity> | ParticipantIdentity[];
  participantAgentIds?: string[];
  participantHumanIds?: string[];
  constraints?: Record<string, unknown>;
  deadline?: string | null;
  authorityRefs?: string[];
  events?: CaseEvent[];
  evidence?: EvidenceItem[];
  proposals?: Proposal[];
  policyEvaluations?: PolicyEvaluation[];
  receipt?: Receipt | null;
  createdAt: string;
  updatedAt?: string;
}

export interface Message {
  id: string;
  caseId: string;
  senderType: 'agent' | 'human';
  senderAgentId?: string;
  senderHumanId?: string;
  recipientAgentId?: string;
  type: string;
  text: string;
  payload?: Record<string, unknown> | null;
  createdAt: string;
  status: string;
}

export interface Asset { id: string; caseId: string | null; name: string; mimeType: string; size: number; createdByAgentId: string; createdAt: string }
export interface AuditEvent { id: string; type: string; createdAt: string; [key: string]: unknown }

export interface HumanView {
  inbox: Inbox;
  mode: 'human-observer';
  summary: { agents: number; cases: number; messages: number; assets: number };
  participantDirectory?: Record<string, ParticipantIdentity> | ParticipantIdentity[];
  agents: Agent[];
  cases: WorkCase[];
  messages: Message[];
  assets: Asset[];
  recentEvents: AuditEvent[];
}

export type NavSection = 'needsMe' | 'active' | 'waiting' | 'scheduled' | 'documents' | 'completed' | 'policies' | 'integrations' | 'activity';
