'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import {
  Activity, AlertCircle, ArrowLeft, ArrowLeftRight, ArrowRight, Bot, CalendarDays, Check, CheckCircle2, ChevronDown,
  CircleDashed, Clock3, Command, Copy, Database, Download, FileCheck2, FileText, Gauge, Inbox,
  KeyRound, Link2, ListFilter, Menu, MoreHorizontal, PanelRightClose, PanelRightOpen,
  Pause, Play, PlugZap, ReceiptText, RefreshCw, Search, ShieldCheck, Sparkles,
  UserRound, UsersRound, X, XCircle, Zap
} from 'lucide-react';
import { ApiError, SESSION_EXPIRED_EVENT, api, safeDownloadUrl } from './api';
import LandingPage from './LandingPage';
import { AGENT_PERMISSION_OPTIONS, DEFAULT_AGENT_PERMISSIONS, selectedAgentPermissions } from './agent-permissions';
import { previewRequested } from './preview';
import { mergeHistory, olderCursors } from './history';
import { subscribeReplayRecovery } from './event-replay';
import { RUNTIME_OPTIONS, connectorDownloads, isLoopbackOrigin, runtimeLabel, setupPrompt, suggestedAgentAddress, watchEnrollmentStatus, type EnrollmentResult, type EnrollmentStatus } from './quick-connect';
import type { ConnectorRuntime } from '../../sdk/typescript/src/quick-connect';
import { SESSION_ENDED_NOTICE, SessionRequestCancelled, hasRememberedSession, invalidateSessionRequests, isCurrentSession, publishSessionEnd, rememberSessionStatus, sessionEndedNotice, sessionGeneration, watchSessionLifecycle } from './session-lifecycle';
import {
  STATE_META, assetDisplayName, assetStateMeta, auditSummary, canDownloadAsset, caseCounts, caseLabel, caseState, casesForSection, caseTone, decisionPolicy,
  eventSummary, exchangeParties, filterAssets, humanize, isExchangeEvent, onboardingSteps, participantIds, resolveParticipant,
  sectionForCase, stateLabel, timelineForCase
} from './model';
import type {
  Agent, AgentConnectionInvitation, ApprovedEmailContact, Asset, AuthConfig, CaseEvent, CaseState, EmailTransportStatus, EvidenceItem, Human, HumanActionKey,
  HumanView, Inbox as Workspace, NavSection, Organization, PolicyEvaluation, ProposalOption, WorkCase
} from './types';

const WORKSPACE_KEY = 'sinaloa.workspace';
const caseSections: NavSection[] = ['inbox', 'needsMe', 'active', 'waiting', 'completed'];

type BootState = 'loading' | 'signedOut' | 'setup' | 'ready' | 'error';

const previewHuman: Human = { id: 'human_preview', displayName: 'Rachel' };
const previewWorkspace: Workspace = { id: 'inbox_preview', organizationId: 'org_preview', name: 'Rachel’s agent studio', ownerAgentId: 'agent_milo', ownerHumanId: previewHuman.id, status: 'active', createdAt: '2026-09-01T14:00:00.000Z' };
const previewAgents: Agent[] = [
  { id: 'agent_milo', name: 'Milo', address: 'milo@sinaloa.mail', principalHumanId: previewHuman.id, status: 'active', onboardingStatus: 'approved', permissions: ['send_agent_messages', 'receive_agent_messages', 'execute_cases'] }
];
const previewView: HumanView = {
  inbox: previewWorkspace,
  mode: 'human-observer',
  canManageInbox: true,
  capabilities: ['observe_agent_communications', 'receive_agent_messages', 'reply_to_approved_agents', 'review_assets'],
  summary: { agents: 1, cases: 4, messages: 0, assets: 2, needsMe: 1 },
  navigation: { needsMe: 1, activeWork: 1, waiting: 1, completed: 1 },
  agents: previewAgents,
  invitations: [],
  participantDirectory: {
    agent_milo: { id: 'agent_milo', type: 'internalAgent', displayName: 'Milo', address: 'milo@sinaloa.mail', accessState: 'active' },
    agent_luma: { id: 'agent_luma', type: 'externalAgent', displayName: 'Luma Events agent', address: 'hello@luma.events', accessState: 'active' },
    agent_jordan: { id: 'agent_jordan', type: 'externalAgent', displayName: 'Jordan’s scheduling agent', address: 'calendar@jordan.ai', accessState: 'active' },
    agent_atlas: { id: 'agent_atlas', type: 'externalAgent', displayName: 'Atlas Research agent', address: 'research@atlas.team', accessState: 'active' }
  },
  cases: [
    {
      id: 'conversation_dinner_deposit', schemaVersion: '1.0', objective: 'Finalize the Design Week dinner venue', state: 'waitingForHuman', principal: previewHuman.id, actingAgent: 'agent_milo', participants: ['agent_milo', 'agent_luma'], constraints: { budget: '$2,400', guests: 18 }, authorityRefs: [], evidence: [], receipt: null,
      proposals: [{ id: 'proposal_dinner', kind: 'negotiation', status: 'countered', expiresAt: '2026-09-28T18:00:00.000Z', createdAt: '2026-09-27T13:15:00.000Z', options: [{ id: 'option_original', value: { title: '$2,650 with private room' }, sourceConfidence: 'enteredForCase', expired: true, outOfPolicyFlags: [] }, { id: 'option_counter', value: { title: '$2,350 with deposit due today' }, sourceConfidence: 'enteredForCase', expired: false, outOfPolicyFlags: ['paymentRequiresApproval'] }] }],
      policyEvaluations: [{ id: 'policy_deposit', requestedAction: 'payments.sendDeposit', actor: 'agent_milo', matchedPolicyId: 'permission:payments', decision: 'needsHuman', grantType: 'oneTime', effectiveAt: '2026-09-27T15:42:00.000Z', expiresAt: '2026-09-28T18:00:00.000Z', reasonCode: 'paymentRequiresApproval' }],
      events: [
        { id: 'evt_dinner_1', type: 'message', actor: 'agent_milo', createdAt: '2026-09-27T13:15:00.000Z', payload: { messageType: 'proposal', text: 'I asked Luma to bring the venue within your $2,400 budget.', senderAgentId: 'agent_milo', recipientAgentId: 'agent_luma', deliveryState: 'delivered', proposalId: 'proposal_dinner', status: 'open' }, linkedPolicyEvaluation: null, precedingEventRef: null },
        { id: 'evt_dinner_2', type: 'message', actor: 'agent_luma', createdAt: '2026-09-27T15:36:00.000Z', payload: { messageType: 'counterproposal', text: 'Luma can do $2,350 if the deposit is paid today.', senderAgentId: 'agent_luma', recipientAgentId: 'agent_milo', deliveryState: 'received', proposalId: 'proposal_dinner', status: 'countered' }, linkedPolicyEvaluation: null, precedingEventRef: 'evt_dinner_1' },
        { id: 'evt_dinner_3', type: 'policyEvaluation', actor: 'agent_milo', createdAt: '2026-09-27T15:42:00.000Z', payload: { requestedAction: 'payments.sendDeposit', decision: 'needsHuman' }, linkedPolicyEvaluation: 'policy_deposit', precedingEventRef: 'evt_dinner_2' }
      ], createdAt: '2026-09-27T13:10:00.000Z', updatedAt: '2026-09-27T15:42:00.000Z'
    },
    {
      id: 'conversation_planning_call', schemaVersion: '1.0', objective: 'Find a time for the product planning call', state: 'waitingForExternalParty', principal: previewHuman.id, actingAgent: 'agent_milo', participants: ['agent_milo', 'agent_jordan'], constraints: { duration: '45 minutes', timezone: 'America/Toronto' }, authorityRefs: [], evidence: [], receipt: null, policyEvaluations: [],
      proposals: [{ id: 'proposal_planning', kind: 'schedule', status: 'open', expiresAt: '2026-09-29T16:00:00.000Z', createdAt: '2026-09-27T14:00:00.000Z', options: [{ id: 'option_tuesday', value: { start: '2026-09-29T15:00:00.000Z', end: '2026-09-29T15:45:00.000Z', timezone: 'America/Toronto' }, sourceConfidence: 'fromVerifiedProfile', expired: false, outOfPolicyFlags: [] }] }],
      events: [{ id: 'evt_planning_1', type: 'message', actor: 'agent_milo', createdAt: '2026-09-27T14:05:00.000Z', payload: { messageType: 'proposal', text: 'I sent Tuesday at 11:00 AM as the best overlap across both calendars.', senderAgentId: 'agent_milo', recipientAgentId: 'agent_jordan', deliveryState: 'delivered', proposalId: 'proposal_planning', status: 'open' }, linkedPolicyEvaluation: null, precedingEventRef: null }],
      createdAt: '2026-09-27T13:50:00.000Z', updatedAt: '2026-09-27T14:05:00.000Z'
    },
    {
      id: 'conversation_research_brief', schemaVersion: '1.0', objective: 'Share the Q4 research brief with the launch team', state: 'inProgress', principal: previewHuman.id, actingAgent: 'agent_milo', participants: ['agent_milo', 'agent_atlas'], constraints: { audience: 'Launch team' }, authorityRefs: [], policyEvaluations: [], receipt: null,
      evidence: [{ id: 'evidence_brief', kind: 'document', title: 'Q4 customer research brief', provenance: 'extractedFromDocument', url: null }], proposals: [{ id: 'proposal_brief', kind: 'document', status: 'open', expiresAt: null, createdAt: '2026-09-27T12:00:00.000Z', options: [{ id: 'option_brief', value: { title: 'Share research brief and three key takeaways' }, sourceConfidence: 'extractedFromDocument', expired: false, outOfPolicyFlags: [] }] }],
      events: [{ id: 'evt_brief_1', type: 'message', actor: 'agent_atlas', createdAt: '2026-09-27T12:24:00.000Z', payload: { messageType: 'message', text: 'Atlas added the latest interview synthesis and source notes.', senderAgentId: 'agent_atlas', recipientAgentId: 'agent_milo', deliveryState: 'received' }, linkedPolicyEvaluation: null, precedingEventRef: null }],
      createdAt: '2026-09-27T11:40:00.000Z', updatedAt: '2026-09-27T12:24:00.000Z'
    },
    {
      id: 'conversation_studio_booking', schemaVersion: '1.0', objective: 'Book the podcast studio for launch week', state: 'completed', principal: previewHuman.id, actingAgent: 'agent_milo', participants: ['agent_milo', 'agent_luma'], constraints: {}, authorityRefs: [], evidence: [], proposals: [], policyEvaluations: [], events: [],
      receipt: { id: 'receipt_studio', result: 'Studio booked for October 6 at 2:00 PM', authorityBasis: 'calendar.booking', humanApprovalStatus: 'notRequired', createdAt: '2026-09-26T19:10:00.000Z' }, createdAt: '2026-09-26T18:30:00.000Z', updatedAt: '2026-09-26T19:10:00.000Z'
    }
  ],
  caseQueue: [], messages: [], assets: [
    { id: 'asset_brief', workspaceId: previewWorkspace.id, caseId: 'conversation_research_brief', filename: 'Q4-customer-research.pdf', mimeType: 'application/pdf', size: 842_112, createdByAgentId: 'agent_atlas', state: 'clean', createdAt: '2026-09-27T12:22:00.000Z', scannedAt: '2026-09-27T12:23:00.000Z', scan: { status: 'clean', engine: 'Sinaloa Guard' } },
    { id: 'asset_sources', workspaceId: previewWorkspace.id, caseId: 'conversation_research_brief', filename: 'interview-source-notes.csv', mimeType: 'text/csv', size: 93_408, createdByAgentId: 'agent_atlas', state: 'scanning', createdAt: '2026-09-27T12:24:00.000Z', scannedAt: null, scan: null }
  ], calendarProviders: {
    google: { id: 'google', label: 'Google Calendar', configured: false },
    outlook: { id: 'outlook', label: 'Outlook Calendar', configured: false }
  }, calendarConnectors: [], deliveryReceipts: [], recentEvents: []
};

previewView.caseQueue = previewView.cases.map(workCase => {
  const state = caseState(workCase);
  const section = sectionForCase(workCase);
  const bucket = section === 'active' ? 'activeWork' : section === 'needsMe' || section === 'waiting' || section === 'completed' ? section : 'activeWork';
  const collaborationMode = workCase.proposals?.[0]?.kind === 'schedule' ? 'scheduling' : workCase.proposals?.[0]?.kind === 'negotiation' ? 'negotiation' : workCase.proposals?.[0]?.kind === 'document' ? 'artifactCreation' : 'collaboration';
  const policy = decisionPolicy(workCase);
  return { ...workCase, collaborationMode, stateLabel: STATE_META[state].label, stateTone: STATE_META[state].tone, bucket, needsAttention: bucket === 'needsMe', nextActor: STATE_META[state].description, contextualDetail: STATE_META[state].description, decision: bucket === 'needsMe' ? { question: policy ? `${humanize(policy.requestedAction)} needs your approval.` : 'Your agents need your judgment before they continue.', policyEvaluationId: policy?.id || null, requestedAction: policy?.requestedAction || null, grantType: policy?.grantType || null, expiresAt: policy?.expiresAt || null, availableActions: state === 'waitingForHuman' || state === 'tentativeHold' ? ['approveOnce', 'editProposal', 'decline', 'takeOver'] : ['takeOver', 'pause'] } : null };
});
export default function App() {
  const isPreview = typeof window !== 'undefined' && previewRequested(window.location.search, import.meta.env.DEV);
  const isLandingPreview = import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('landing-preview');
  const [boot, setBoot] = useState<BootState>('loading');
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [human, setHuman] = useState<Human | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<HumanView | null>(null);
  const [error, setError] = useState('');
  const [authNotice, setAuthNotice] = useState(() => sessionEndedNotice());
  const [syncNotice, setSyncNotice] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const [sessionCheck, setSessionCheck] = useState<'checking' | 'error' | null>(null);
  const sessionCheckRef = useRef(sessionCheck);
  sessionCheckRef.current = sessionCheck;
  const bootRef = useRef(boot);
  bootRef.current = boot;
  const activeWorkspace = useRef<string | null>(null);
  const hadAuthenticatedSession = useRef(false);
  const stopLiveUpdates = useRef<(() => void) | null>(null);
  const signingOut = useRef(false);
  const endedElsewhere = useRef(false);

  const clearPrivateState = useCallback(() => {
    invalidateSessionRequests();
    stopLiveUpdates.current?.();
    stopLiveUpdates.current = null;
    activeWorkspace.current = null;
    setHuman(null);
    setOrganizations([]);
    setWorkspaces([]);
    setWorkspace(null);
    setView(null);
    setError('');
    setSyncNotice('');
    setHistoryBusy(false);
    sessionCheckRef.current = null;
    setSessionCheck(null);
  }, []);

  const endSession = useCallback((broadcast = true) => {
    clearPrivateState();
    if (hadAuthenticatedSession.current || hasRememberedSession()) {
      rememberSessionStatus('ended');
      setAuthNotice(SESSION_ENDED_NOTICE);
    }
    hadAuthenticatedSession.current = false;
    try { localStorage.removeItem(WORKSPACE_KEY); } catch { /* Optional preference storage. */ }
    setBoot('signedOut');
    if (broadcast) publishSessionEnd();
  }, [clearPrivateState]);

  const expireSession = useCallback(() => endSession(), [endSession]);

  const loseWorkspaceAccess = useCallback((workspaceId: string) => {
    if (activeWorkspace.current !== workspaceId) return;
    clearPrivateState();
    setError('Your access to this workspace changed. Refresh your account to continue.');
    setBoot('error');
  }, [clearPrivateState]);

  const loadView = useCallback(async (workspaceId: string, quiet = false) => {
    const generation = sessionGeneration();
    activeWorkspace.current = workspaceId;
    if (!quiet) setView(null);
    try {
      const next = await api.humanView(workspaceId);
      if (!isCurrentSession(generation)) throw new SessionRequestCancelled();
      if (activeWorkspace.current === workspaceId) setView(current => quiet ? mergeHistory(current, next) : next);
      return next;
    } catch (caught) {
      if (isCurrentSession(generation) && caught instanceof ApiError && caught.status === 403) loseWorkspaceAccess(workspaceId);
      throw caught;
    }
  }, [loseWorkspaceAccess]);

  const loadWorkspaceDirectory = useCallback(async () => {
    const generation = sessionGeneration();
    const nextOrganizations = await api.organizations();
    if (!isCurrentSession(generation)) throw new SessionRequestCancelled();
    const workspaceGroups = await Promise.all(nextOrganizations.map(item => api.workspaces(item.id)));
    if (!isCurrentSession(generation)) throw new SessionRequestCancelled();
    const nextWorkspaces = workspaceGroups.flat();
    setOrganizations(nextOrganizations);
    setWorkspaces(nextWorkspaces);
    return nextWorkspaces;
  }, []);

  async function loadOlder() {
    const generation = sessionGeneration();
    if (!view || historyBusy) return;
    const workspaceId = view.inbox.id;
    const cursors = olderCursors(view);
    if (!Object.keys(cursors).length) return;
    setHistoryBusy(true);
    try {
      const next = await api.humanView(workspaceId, cursors);
      if (isCurrentSession(generation) && activeWorkspace.current === workspaceId) setView(current => current ? mergeHistory(current, next, cursors) : current);
    } catch (caught) {
      if (!isCurrentSession(generation)) return;
      if (caught instanceof ApiError && caught.status === 403) loseWorkspaceAccess(workspaceId);
      else setSyncNotice(errorMessage(caught));
    }
    finally { if (isCurrentSession(generation)) setHistoryBusy(false); }
  }

  const loadAccount = useCallback(async () => {
    if (signingOut.current || endedElsewhere.current) return;
    clearPrivateState();
    const generation = sessionGeneration();
    try {
      setBoot('loading');
      setError('');
      const nextConfig = await api.authConfig();
      if (!isCurrentSession(generation)) return;
      setConfig(nextConfig);
      const nextHuman = await api.me();
      if (!isCurrentSession(generation)) return;
      setHuman(nextHuman);
      if (nextHuman.auth?.assurance === 'phone') {
        if (typeof nextHuman.mfaSetupRequired !== 'boolean') throw new Error('Authentication service needs an update before sign in can continue.');
        setBoot('signedOut');
        return;
      }
      hadAuthenticatedSession.current = true;
      const nextWorkspaces = await loadWorkspaceDirectory();
      if (!isCurrentSession(generation)) return;
      const savedId = localStorage.getItem(WORKSPACE_KEY);
      const selected = nextWorkspaces.find(item => item.id === savedId) || nextWorkspaces[0] || null;
      if (!selected) {
        setWorkspace(null);
        rememberSessionStatus('active');
        setAuthNotice('');
        setBoot('setup');
        return;
      }
      setWorkspace(selected);
      localStorage.setItem(WORKSPACE_KEY, selected.id);
      await loadView(selected.id);
      if (!isCurrentSession(generation)) return;
      rememberSessionStatus('active');
      setAuthNotice('');
      setBoot('ready');
    } catch (caught) {
      if (!isCurrentSession(generation)) return;
      const nextConfig = config || await api.authConfig().catch(() => null);
      if (!isCurrentSession(generation)) return;
      if (nextConfig) setConfig(nextConfig);
      if (caught instanceof ApiError && caught.status === 401) {
        expireSession();
      } else {
        setError(caught instanceof Error ? caught.message : 'Sinaloa could not load your workspace.');
        setBoot('error');
      }
    }
  }, [clearPrivateState, config, expireSession, loadView, loadWorkspaceDirectory]);

  const loadAccountRef = useRef(loadAccount);
  loadAccountRef.current = loadAccount;

  const revalidateAccount = useCallback(async () => {
    if (signingOut.current || endedElsewhere.current) return;
    if (boot !== 'ready' || !human || !workspace) { await loadAccount(); return; }
    const generation = sessionGeneration();
    sessionCheckRef.current = 'checking';
    setSessionCheck('checking');
    setError('');
    try {
      const nextHuman = await api.me();
      if (!isCurrentSession(generation)) return;
      // Do not carry a former account's drafts across an account switch.
      if (nextHuman.id !== human.id || nextHuman.auth?.assurance === 'phone') { await loadAccount(); return; }
      const nextWorkspaces = await loadWorkspaceDirectory();
      if (!isCurrentSession(generation)) return;
      if (!nextWorkspaces.some(item => item.id === workspace.id)) {
        clearPrivateState();
        setError('Your access to this workspace changed. Refresh your account to continue.');
        setBoot('error');
        return;
      }
      await loadView(workspace.id, true);
      if (!isCurrentSession(generation)) return;
      setHuman(nextHuman);
      rememberSessionStatus('active');
      setAuthNotice('');
      sessionCheckRef.current = null;
      setSessionCheck(null);
    } catch (caught) {
      if (!isCurrentSession(generation)) return;
      if (caught instanceof ApiError && caught.status === 401) expireSession();
      else {
        setError(errorMessage(caught));
        sessionCheckRef.current = 'error';
        setSessionCheck('error');
      }
    }
  }, [boot, clearPrivateState, expireSession, human, loadAccount, loadView, loadWorkspaceDirectory, workspace]);
  const revalidateAccountRef = useRef(revalidateAccount);
  revalidateAccountRef.current = revalidateAccount;

  useEffect(() => { if (!isPreview && !isLandingPreview) void loadAccount(); }, [isPreview, isLandingPreview]);

  useEffect(() => {
    if (isPreview || isLandingPreview) return;
    window.addEventListener(SESSION_EXPIRED_EVENT, expireSession);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expireSession);
  }, [expireSession, isPreview, isLandingPreview]);

  useEffect(() => {
    if (isPreview) return;
    return watchSessionLifecycle(window, document, {
      isActive: () => hadAuthenticatedSession.current && !signingOut.current && !endedElsewhere.current && bootRef.current !== 'signedOut',
      suspend: reason => {
        // History snapshots discard private state. Ordinary tab switches keep
        // drafts mounted but hidden and inert until authorization is checked.
        flushSync(() => {
          if (reason === 'history' || bootRef.current !== 'ready') { clearPrivateState(); setBoot('loading'); }
          else {
            invalidateSessionRequests();
            stopLiveUpdates.current?.();
            stopLiveUpdates.current = null;
            setHistoryBusy(false);
            sessionCheckRef.current = 'checking';
            setSessionCheck('checking');
          }
        });
      },
      resume: reason => { if (reason === 'history') void loadAccountRef.current(); else void revalidateAccountRef.current(); },
      endedElsewhere: () => {
        if (bootRef.current === 'signedOut') return;
        endedElsewhere.current = true;
        flushSync(() => endSession(false));
      }
    });
  }, [clearPrivateState, endSession, isPreview]);

  useEffect(() => {
    if (boot !== 'ready' || sessionCheck || !workspace || !config) return;
    const generation = sessionGeneration();
    const refresh = () => {
      if (!isCurrentSession(generation)) return;
      void loadView(workspace.id, true).then(() => {
        if (isCurrentSession(generation)) setSyncNotice('');
      }).catch(caught => {
        if (isCurrentSession(generation) && !(caught instanceof ApiError && caught.status === 401)) setSyncNotice('Live updates are temporarily paused. Your workspace will keep retrying.');
      });
    };
    const stream = new EventSource(`/api/inboxes/${workspace.id}/events`);
    const stopReplayRecovery = subscribeReplayRecovery(stream, refresh, message => { if (isCurrentSession(generation)) setSyncNotice(message); });
    const eventTypes = ['agent.enrolled', 'agent.inbox_created', 'agent.enrollment_token_created', 'agent.onboarding_approved', 'agent.onboarding_rejected', 'case.created', 'case.event_appended', 'case.action_recorded', 'case.completed', 'policy.evaluated', 'proposal.created', 'proposal.countered', 'proposal.accept_attempted', 'message.queued', 'message.retry_scheduled', 'message.dead_lettered', 'message.dead_letter_requeued', 'message.delivered', 'message.acknowledged', 'message.processed', 'message.created', 'asset.created', 'asset.upload_started', 'asset.scan_clean', 'asset.scan_infected', 'asset.scan_error', 'contact.blocked', 'contact.unblocked', 'contact.approved'];
    const refreshDirectory = () => { if (isCurrentSession(generation)) void loadWorkspaceDirectory().catch(() => { if (isCurrentSession(generation)) setSyncNotice('A new agent inbox may be available. Refresh the page to see it.'); }); };
    stream.onopen = () => { if (isCurrentSession(generation)) setSyncNotice(''); };
    stream.onmessage = refresh;
    eventTypes.forEach(type => stream.addEventListener(type, refresh));
    stream.addEventListener('agent.inbox_created', refreshDirectory);
    stream.addEventListener('ready', () => { if (isCurrentSession(generation)) setSyncNotice(''); });
    const terminate = () => { if (isCurrentSession(generation)) expireSession(); };
    stream.addEventListener('session.expired', terminate);
    stream.addEventListener('session.revoked', terminate);
    stream.addEventListener('session.recheck', () => { if (isCurrentSession(generation)) void api.me().catch(() => undefined); });
    stream.onerror = () => {
      if (!isCurrentSession(generation)) return;
      setSyncNotice('Live updates are reconnecting. You can refresh now or keep working.');
      void api.me().catch(() => undefined);
    };
    const interval = window.setInterval(refresh, 30_000);
    const stop = () => { window.clearInterval(interval); stopReplayRecovery(); eventTypes.forEach(type => stream.removeEventListener(type, refresh)); stream.removeEventListener('agent.inbox_created', refreshDirectory); stream.close(); };
    stopLiveUpdates.current = stop;
    return () => { stop(); if (stopLiveUpdates.current === stop) stopLiveUpdates.current = null; };
  }, [boot, config, expireSession, loadView, loadWorkspaceDirectory, sessionCheck, workspace]);

  async function selectWorkspace(next: Workspace) {
    setWorkspace(next);
    localStorage.setItem(WORKSPACE_KEY, next.id);
    await loadView(next.id);
  }

  async function createWorkspace(name: string) {
    const generation = sessionGeneration();
    const created = await api.createWorkspace(name, organizations[0]?.id);
    if (!isCurrentSession(generation)) return;
    setWorkspaces(current => [...current, created]);
    setWorkspace(created);
    localStorage.setItem(WORKSPACE_KEY, created.id);
    await loadView(created.id);
    if (!isCurrentSession(generation)) return;
    setBoot('ready');
  }

  async function logout() {
    signingOut.current = true;
    flushSync(() => { endSession(); setBoot('loading'); });
    try {
      const result = await api.logout();
      window.location.replace(result.logoutUrl || '/');
    } catch (caught) {
      // Do not expose the old workspace or permit revalidation while logout
      // has not been confirmed by the server. The user can retry the POST.
      setError(`Sign out could not be completed. ${errorMessage(caught)}`);
      setBoot('error');
    }
  }

  const renderedGeneration = sessionGeneration();
  const checkRenderedSession = () => { if (!isCurrentSession(renderedGeneration) || sessionCheckRef.current) throw new SessionRequestCancelled(); };
  if (isLandingPreview) return <LandingPage signInPath={`${import.meta.env.VITE_PUBLIC_URL || 'https://www.envoi-agents.com'}/api/auth/workos/sign-in`} />;
  if (isPreview) return <AppShell config={{ provider: 'local', hosted: false }} human={previewHuman} organizations={[]} workspaces={[previewWorkspace]} workspace={previewWorkspace} view={previewView} onSelectWorkspace={async () => undefined} onRefresh={async () => previewView} onLogout={async () => undefined} syncNotice="" />;
  if (boot === 'loading') return <LoadingScreen checking={hadAuthenticatedSession.current || signingOut.current} />;
  if (boot === 'signedOut' && config) return config.provider === 'workos'
    ? <LandingPage signInPath={config.signInPath || '/api/auth/workos/sign-in'} notice={authNotice} />
    : <AuthScreen config={config} notice={authNotice} resumePhoneSession={human?.auth?.assurance === 'phone' ? human.mfaSetupRequired : undefined} onAuthenticated={async () => { endedElsewhere.current = false; await loadAccount(); }} />;
  if (boot === 'setup' && human) return <WorkspaceSetup human={human} onCreate={async name => { checkRenderedSession(); await createWorkspace(name); }} />;
  if (boot === 'error') return <FailureScreen message={error} onRetry={signingOut.current ? logout : loadAccount} />;
  if (!human || !workspace || !view || !config) return <LoadingScreen />;

  return (
    <>
    <div hidden={Boolean(sessionCheck)} inert={Boolean(sessionCheck)} aria-hidden={Boolean(sessionCheck)}>
    <AppShell
      config={config}
      human={human}
      organizations={organizations}
      workspaces={workspaces}
      workspace={workspace}
      view={view}
      syncNotice={syncNotice}
      onLoadOlder={async () => { checkRenderedSession(); await loadOlder(); }}
      historyBusy={historyBusy}
      onSelectWorkspace={async next => { checkRenderedSession(); await selectWorkspace(next); }}
      onRefresh={async () => { checkRenderedSession(); await Promise.all([loadView(workspace.id, true), loadWorkspaceDirectory()]); }}
      onLogout={async () => { checkRenderedSession(); await logout(); }}
    />
    </div>
    {sessionCheck === 'checking' && <LoadingScreen checking />}
    {sessionCheck === 'error' && <FailureScreen message={error} onRetry={() => { void revalidateAccount(); }} />}
    </>
  );
}

function LoadingScreen({ checking = false }: { checking?: boolean }) {
  return (
    <main className="center-screen" aria-live="polite">
      <div className="brand-lockup"><BrandMark /><span>Sinaloa</span></div>
      <div className="decision-loader" aria-hidden="true"><span /><span /><span /></div>
      <p>{checking ? 'Checking your session…' : 'Loading your delegated work…'}</p>
    </main>
  );
}

function FailureScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="center-screen">
      <AlertCircle size={28} aria-hidden="true" />
      <h1>Workspace unavailable</h1>
      <p>{message}</p>
      <button className="button primary" onClick={onRetry}><RefreshCw size={16} />Retry loading</button>
    </main>
  );
}

function AuthScreen({ config, notice, resumePhoneSession, onAuthenticated }: { config: AuthConfig; notice?: string; resumePhoneSession?: boolean; onAuthenticated: () => Promise<void> }) {
  const [step, setStep] = useState<'phone' | 'code' | 'totp'>(resumePhoneSession === undefined ? 'phone' : 'totp');
  const [challengeId, setChallengeId] = useState('');
  const [developmentCode, setDevelopmentCode] = useState('');
  const [totp, setTotp] = useState<{ secret: string; otpauthUri: string; developmentCode?: string } | null>(null);
  const [totpSetupRequired, setTotpSetupRequired] = useState(resumePhoneSession === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submitPhone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      const started = await api.phoneStart(String(form.get('phoneNumber')), String(form.get('displayName')));
      setChallengeId(started.challengeId); setDevelopmentCode(started.developmentCode || ''); setStep('code');
    } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      const verified = await api.phoneVerify(challengeId, String(form.get('code')));
      if (typeof verified.mfaSetupRequired !== 'boolean') throw new Error('Authentication service needs an update. Please try again after it restarts.');
      setTotpSetupRequired(verified.mfaSetupRequired);
      setStep('totp');
      if (verified.mfaSetupRequired) setTotp(await api.totpSetup());
      else setTotp(null);
    } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); }
  }

  async function retryTotpSetup() {
    setBusy(true); setError('');
    try { setTotp(await api.totpSetup()); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }

  async function submitTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try { await api.totpVerify(String(form.get('code'))); await onAuthenticated(); }
    catch (caught) { setError(errorMessage(caught)); setBusy(false); }
  }

  return (
    <main className="auth-page">
      <section className="auth-intro">
        <div className="brand-lockup inverse"><BrandMark /><span>Sinaloa</span></div>
        <div className="auth-message">
          <p className="eyebrow">Delegation you can trust</p>
          <h1>Your agent moves work forward.<br />You keep the final word.</h1>
        <p>A calm, familiar inbox for the conversations your agents are having, the work they are moving forward, and the moments that genuinely need you.</p>
        </div>
        <div className="trust-note"><ShieldCheck size={18} /><span>Every consequential action carries its authority and receipt.</span></div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          {notice && <InlineNotice title="Sign in again" body={notice} tone="attention" />}
          {config.provider === 'workos' ? (
            <>
              <p className="eyebrow">Secure workspace</p><h2>Continue to Sinaloa</h2>
              <p className="supporting">Accept your invitation, then sign in securely with WorkOS.</p>
              <a className="button primary wide" href={config.signInPath || '/api/auth/workos/sign-in'}>Sign in securely</a>
              {!config.inviteOnly && <a className="button secondary wide" href={config.signUpPath || '/api/auth/workos/sign-up'}>Create an account</a>}
            </>
          ) : step === 'phone' ? (
            <form onSubmit={submitPhone}>
              <p className="eyebrow">Local development access</p><h2>Verify your identity</h2>
              <p className="supporting">Phone verification and an authenticator protect workspace and enrollment changes.</p>
              <Field label="Your name" name="displayName" autoComplete="name" placeholder="Rachel Gonsalves" required />
              <Field label="Phone number" name="phoneNumber" type="tel" autoComplete="tel" placeholder="+1 416 555 0123" required />
              <FormError message={error} />
              <button className="button primary wide" disabled={busy}>{busy ? 'Sending code…' : 'Send verification code'}</button>
            </form>
          ) : step === 'code' ? (
            <form onSubmit={submitCode}>
              <p className="eyebrow">Phone verification</p><h2>Enter the one-time code</h2>
              <p className="supporting">The code expires shortly and can only be used once.</p>
              {developmentCode && <InlineNotice title="Development code" body={developmentCode} tone="unknown" />}
              <Field label="Verification code" name="code" inputMode="numeric" autoComplete="one-time-code" required />
              <FormError message={error} />
              <button className="button primary wide" disabled={busy}>{busy ? 'Verifying…' : 'Verify phone'}</button>
              <button type="button" className="button quiet wide" disabled={busy} onClick={() => { setStep('phone'); setChallengeId(''); setDevelopmentCode(''); setError(''); }}>Start again</button>
            </form>
          ) : (
            <form onSubmit={submitTotp}>
              <p className="eyebrow">Authenticator required</p><h2>{totpSetupRequired ? 'Protect consequential actions' : 'Verify your authenticator'}</h2>
              <p className="supporting">{totpSetupRequired ? totp ? 'Add this secret to your authenticator, then enter the current code.' : 'Continue setup to see your authenticator secret.' : 'Enter the current code from the authenticator you already set up.'}</p>
              {totpSetupRequired && totp && <div className="secret-block"><KeyRound size={18} /><code>{totp.secret}</code><CopyButton value={totp.secret} label="Copy authenticator secret" /></div>}
              {totp?.developmentCode && <InlineNotice title="Current development code" body={totp.developmentCode} tone="unknown" />}
              {(!totpSetupRequired || totp) && <Field label="Authenticator code" name="code" inputMode="numeric" autoComplete="one-time-code" required />}
              <FormError message={error} />
              {totpSetupRequired && !totp ? <button type="button" className="button primary wide" disabled={busy} onClick={() => void retryTotpSetup()}>{busy ? 'Preparing authenticator…' : 'Retry authenticator setup'}</button> : <button className="button primary wide" disabled={busy}>{busy ? 'Securing workspace…' : 'Finish secure sign in'}</button>}
            </form>
          )}
        </div>
      </section>
    </main>
  );
}

function WorkspaceSetup({ human, onCreate }: { human: Human; onCreate: (name: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return (
    <main className="setup-page">
      <div className="brand-lockup"><BrandMark /><span>Sinaloa</span></div>
      <section className="setup-card">
        <p className="eyebrow">Workspace setup</p>
        <h1>Give delegated work a clear home.</h1>
        <p>Welcome, {human.displayName}. Create the workspace where your agents will operate under your authority.</p>
        <form onSubmit={async event => {
          event.preventDefault(); setBusy(true); setError('');
          try { await onCreate(String(new FormData(event.currentTarget).get('name'))); }
          catch (caught) { setError(errorMessage(caught)); setBusy(false); }
        }}>
          <Field label="Workspace name" name="name" placeholder="Rachel’s operations" required />
          <FormError message={error} />
          <button className="button primary" disabled={busy}>{busy ? 'Creating workspace…' : 'Create workspace'}</button>
        </form>
      </section>
    </main>
  );
}

interface ShellProps {
  config: AuthConfig; human: Human; organizations: Organization[]; workspaces: Workspace[];
  workspace: Workspace; view: HumanView; onSelectWorkspace: (workspace: Workspace) => Promise<void>;
  onRefresh: () => Promise<unknown>; onLogout: () => Promise<void>; syncNotice: string;
  onLoadOlder?: () => Promise<void>; historyBusy?: boolean;
}

function AppShell(props: ShellProps) {
  const { config, human, workspaces, workspace, view, onSelectWorkspace, onRefresh, onLogout, syncNotice } = props;
  const canManageInbox = view.canManageInbox === true;
  const [section, setSection] = useState<NavSection>('inbox');
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [navOpen, setNavOpen] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [toast, setToast] = useState('');
  const counts = useMemo(() => caseCounts(view), [view]);
  const projectedCases = view.caseQueue;
  const visibleCases = useMemo(() => casesForSection(projectedCases, section, view.assets), [section, projectedCases, view.assets]);
  const selectedCase = projectedCases.find(item => item.id === selectedCaseId) || visibleCases[0] || null;

  useEffect(() => { document.documentElement.dataset.theme = 'light'; localStorage.removeItem('sinaloa.theme'); }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(true); } };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => { if (!selectedCaseId && visibleCases[0]) setSelectedCaseId(visibleCases[0].id); }, [selectedCaseId, visibleCases]);
  useEffect(() => { if (toast) { const timer = window.setTimeout(() => setToast(''), 4200); return () => window.clearTimeout(timer); } }, [toast]);

  function chooseSection(next: NavSection) {
    setSection(next); setSelectedCaseId(null); setMobileDetail(false); setNavOpen(false);
  }

  const utilitySection = !caseSections.includes(section);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to conversation</a>
      {navOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}
      <aside className={`primary-nav ${navOpen ? 'is-open' : ''}`} aria-label="Primary">
        <div className="nav-brand"><div className="brand-lockup"><BrandMark /><span>Sinaloa</span></div><button className="icon-button mobile-only" aria-label="Close navigation" onClick={() => setNavOpen(false)}><X size={18} /></button></div>
        <WorkspacePicker workspaces={workspaces} workspace={workspace} onChange={onSelectWorkspace} />
        <nav className="nav-list">
          <NavItem section="inbox" label="Inbox" icon={<Inbox />} count={counts.inbox} active={section === 'inbox'} onClick={chooseSection} />
          <NavItem section="needsMe" label="Needs me" icon={<UserRound />} count={counts.needsMe} active={section === 'needsMe'} onClick={chooseSection} attention />
          <NavItem section="active" label="In motion" icon={<Zap />} count={counts.active} active={section === 'active'} onClick={chooseSection} />
          <NavItem section="waiting" label="Waiting" icon={<Clock3 />} count={counts.waiting} active={section === 'waiting'} onClick={chooseSection} />
          <NavItem section="documents" label="Shared files" icon={<FileText />} count={counts.documents} active={section === 'documents'} onClick={chooseSection} />
          <NavItem section="completed" label="Done" icon={<CheckCircle2 />} count={counts.completed} active={section === 'completed'} onClick={chooseSection} />
          <div className="nav-separator" />
          <NavItem section="policies" label="Permissions" icon={<ShieldCheck />} active={section === 'policies'} onClick={chooseSection} />
          <NavItem section="integrations" label="Agent connections" icon={<PlugZap />} count={counts.integrations} active={section === 'integrations'} onClick={chooseSection} />
          <NavItem section="activity" label="Activity log" icon={<Activity />} active={section === 'activity'} onClick={chooseSection} />
        </nav>
        <div className="nav-footer">
          <div className="principal-card"><span className="identity-mark human"><UserRound size={15} /></span><div><strong>{human.displayName}</strong><small>Principal · {config.provider === 'workos' ? 'WorkOS' : 'local MFA'}</small></div><button className="icon-button" aria-label="Sign out" onClick={() => void onLogout()}><MoreHorizontal size={18} /></button></div>
        </div>
      </aside>

      <section className={`application ${view.history ? 'has-history' : ''} ${utilitySection ? 'utility-layout' : ''} ${syncNotice ? 'has-sync-notice' : ''}`}>
        <header className="topbar">
          <button className="icon-button mobile-only" aria-label="Open navigation" onClick={() => setNavOpen(true)}><Menu size={19} /></button>
          <button className="search-trigger" onClick={() => setSearchOpen(true)}><Search size={16} /><span>Search conversations, people, and tags…</span><kbd>⌘K</kbd></button>
          <div className="topbar-actions"><button className="icon-button" aria-label="Refresh workspace" onClick={() => void onRefresh()}><RefreshCw size={17} /></button></div>
        </header>
          {view.history && <div className="history-controls"><small>{view.cases.length} of {view.history.cases?.total ?? view.cases.length} conversations loaded · Filters and search cover loaded history</small>{Object.keys(olderCursors(view)).length > 0 && <button className="button quiet" disabled={props.historyBusy} onClick={() => void props.onLoadOlder?.()}>{props.historyBusy ? 'Loading history…' : 'Load older history'}</button>}</div>}
        {syncNotice && <div className="sync-notice" role="status"><AlertCircle size={16} /><span>{syncNotice}</span><button className="button quiet" onClick={() => void onRefresh()}>Refresh now</button></div>}

        {utilitySection ? (
          <main id="main-content" className="utility-content">
            {section === 'documents' && <SharedFilesPage view={view} notify={setToast} />}
            {section === 'policies' && <PoliciesPage view={view} />}
            {section === 'integrations' && <IntegrationsPage view={view} workspace={workspace} agentInboxes={workspaces.filter(item => item.kind === 'agent' && item.parentInboxId === workspace.id)} humanId={human.id} canManageInbox={canManageInbox} onSelectWorkspace={onSelectWorkspace} onRefresh={onRefresh} notify={setToast} />}
            {section === 'activity' && <ActivityPage view={view} />}
          </main>
        ) : (
          <div className={`case-layout ${mobileDetail ? 'show-detail' : ''}`}>
            <CaseQueue section={section} cases={visibleCases} view={view} selectedId={selectedCase?.id || null} onSelect={item => { setSelectedCaseId(item.id); setMobileDetail(true); }} />
            <main id="main-content" className="case-main">
              {selectedCase ? <CaseWorkspace workCase={selectedCase} view={view} canManageInbox={canManageInbox} railOpen={railOpen} onRailToggle={() => setRailOpen(value => !value)} onBack={() => setMobileDetail(false)} onRefresh={onRefresh} notify={setToast} /> : <EmptyCaseState section={section} />}
            </main>
          </div>
        )}
      </section>
      {searchOpen && <CommandMenu view={view} onClose={() => setSearchOpen(false)} onSelectCase={item => { chooseSection(sectionForCase(item)); setSelectedCaseId(item.id); setMobileDetail(true); setSearchOpen(false); }} />}
      <div className="sr-live" aria-live="polite">{toast}</div>
      {toast && <div className="toast"><Check size={16} />{toast}</div>}
    </div>
  );
}

function WorkspacePicker({ workspaces, workspace, onChange }: { workspaces: Workspace[]; workspace: Workspace; onChange: (workspace: Workspace) => Promise<void> }) {
  return (
    <label className="workspace-picker"><span className="sr-only">Current workspace</span><Gauge size={16} /><select value={workspace.id} onChange={event => { const next = workspaces.find(item => item.id === event.target.value); if (next) void onChange(next); }}>{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={14} aria-hidden="true" /></label>
  );
}

function NavItem({ section, label, icon, count, active, attention, onClick }: { section: NavSection; label: string; icon: ReactNode; count?: number; active: boolean; attention?: boolean; onClick: (section: NavSection) => void }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => onClick(section)}><span className="nav-icon">{icon}</span><span>{label}</span>{Boolean(count) && <span className={`nav-count ${attention ? 'attention' : ''}`} aria-label={`${count} items`}>{count! > 9 ? '9+' : count}</span>}</button>;
}

function CaseQueue({ section, cases, view, selectedId, onSelect }: { section: NavSection; cases: WorkCase[]; view: HumanView; selectedId: string | null; onSelect: (workCase: WorkCase) => void }) {
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState('All');
  const tags = [...new Set(cases.flatMap(conversationTags))];
  useEffect(() => { if (activeTag !== 'All' && !tags.includes(activeTag)) setActiveTag('All'); }, [activeTag, section, tags.join('|')]);
  const filtered = cases.filter(item => {
    const searchable = `${item.objective || item.id} ${conversationPreview(item)} ${conversationTags(item).join(' ')}`.toLowerCase();
    return searchable.includes(query.toLowerCase()) && (activeTag === 'All' || conversationTags(item).includes(activeTag));
  }).sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  return (
    <aside className="case-queue" aria-label={`${sectionTitle(section)} conversations`}>
      <div className="queue-header"><div><p className="eyebrow">Agent inbox</p><h1>{sectionTitle(section)}</h1></div></div>
      <label className="queue-search"><Search size={15} /><span className="sr-only">Search this inbox</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search this inbox" /></label>
      {tags.length > 0 && <div className="tag-filter" aria-label="Filter conversations by tag"><button className={activeTag === 'All' ? 'active' : ''} onClick={() => setActiveTag('All')}>All</button>{tags.slice(0, 5).map(tag => <button key={tag} className={activeTag === tag ? 'active' : ''} onClick={() => setActiveTag(tag)}>{tag}</button>)}</div>}
      <div className="queue-summary"><span>{filtered.length} {filtered.length === 1 ? 'conversation' : 'conversations'}</span><span>Newest first</span></div>
      <div className="case-list" role="listbox" aria-label="Conversations">
        {filtered.map(item => <CaseRow key={item.id} workCase={item} view={view} selected={selectedId === item.id} onSelect={onSelect} />)}
        {!filtered.length && <div className="empty-list"><CircleDashed size={24} /><strong>{query || activeTag !== 'All' ? 'No conversations match this filter' : emptyTitle(section)}</strong><span>{query || activeTag !== 'All' ? 'Try another search or tag.' : emptyBody(section)}</span></div>}
      </div>
    </aside>
  );
}

function CaseRow({ workCase, view, selected, onSelect }: { workCase: WorkCase; view: HumanView; selected: boolean; onSelect: (workCase: WorkCase) => void }) {
  const state = caseState(workCase); const tone = caseTone(workCase); const label = caseLabel(workCase); const updated = workCase.updatedAt || workCase.createdAt;
  const events = timelineForCase(workCase, view.messages);
  const counterpartId = participantIds(workCase, events).find(id => id !== workCase.actingAgent && id !== workCase.principal);
  const counterparty = resolveParticipant(workCase, counterpartId, view.agents, view.participantDirectory);
  const tags = conversationTags(workCase);
  return (
    <button role="option" aria-selected={selected} className={`case-row tone-${tone} ${selected ? 'selected' : ''}`} onClick={() => onSelect(workCase)}>
      <span className="case-kind"><CaseIcon workCase={workCase} /></span>
      <span className="case-row-copy"><span className="thread-sender">{counterparty.displayName}<span className="case-state-line"><StatusGlyph state={state} />{label}</span></span><strong>{workCase.objective || 'Untitled conversation'}</strong><small>{conversationPreview(workCase)}</small><span className="thread-tags">{tags.map(tag => <span key={tag} className={`thread-tag tag-${tag.toLowerCase().replaceAll(' ', '-')}`}>{tag}</span>)}</span></span>
      <time dateTime={updated}>{formatRelative(updated)}</time>
      {workCase.needsAttention && <span className="attention-line" aria-label="Needs your attention" />}
    </button>
  );
}

export function CaseWorkspace({ workCase, view, canManageInbox, railOpen, onRailToggle, onBack, onRefresh, notify }: { workCase: WorkCase; view: HumanView; canManageInbox: boolean; railOpen: boolean; onRailToggle: () => void; onBack: () => void; onRefresh: () => Promise<unknown>; notify: (message: string) => void }) {
  const state = caseState(workCase);
  const events = timelineForCase(workCase, view.messages);
  const policy = workCase.policyEvaluations?.find(item => item.id === workCase.decision?.policyEvaluationId) || decisionPolicy(workCase);
  const [drawer, setDrawer] = useState<{ type: 'policy' | 'evidence'; item?: PolicyEvaluation | EvidenceItem } | null>(null);
  const [confirm, setConfirm] = useState<HumanActionKey | null>(null);
  const [busy, setBusy] = useState<HumanActionKey | null>(null);
  const caseAssets = view.assets.filter(item => item.caseId === workCase.id);

  async function act(actionKey: HumanActionKey) {
    setBusy(actionKey);
    try {
      await api.action(view.inbox.id, workCase.id, actionKey, policy ? { policyEvaluationId: policy.id } : {});
      notify(actionPastTense(actionKey)); await onRefresh(); setConfirm(null);
    } catch (caught) { notify(errorMessage(caught)); } finally { setBusy(null); }
  }

  const hasOpenDecision = Boolean(workCase.schemaVersion) && !['completed', 'expired', 'revoked'].includes(state);
  const canAct = canManageInbox && hasOpenDecision;
  return (
    <div className={`workspace-grid ${railOpen ? 'rail-open' : ''}`}>
      <article className="case-workspace">
        <header className="case-header">
          <div className="case-header-tools"><button className="icon-button mobile-only" aria-label="Back to inbox" onClick={onBack}><ArrowLeft size={18} /></button><span className="object-id">Conversation · {workCase.id}</span><button className="icon-button desktop-only" aria-label={railOpen ? 'Hide conversation details' : 'Show conversation details'} onClick={onRailToggle}>{railOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button></div>
          <div className="case-heading"><div className="case-title-icon"><CaseIcon workCase={workCase} /></div><div><p className="eyebrow">{caseType(workCase)}</p><h1>{workCase.objective || 'Untitled conversation'}</h1><div className="conversation-tags">{conversationTags(workCase).map(tag => <span key={tag} className={`thread-tag tag-${tag.toLowerCase().replaceAll(' ', '-')}`}>{tag}</span>)}</div></div></div>
          <StatusBadge workCase={workCase} />
        </header>

        <NegotiationParticipants workCase={workCase} view={view} events={events} canManageInbox={canManageInbox} onRefresh={onRefresh} notify={notify} />

        {workCase.decision && hasOpenDecision && <DecisionCard workCase={workCase} view={view} events={events} policy={policy} canManageInbox={canManageInbox} busy={busy} onAction={key => ['decline', 'takeOver'].includes(key) ? setConfirm(key) : void act(key)} onPolicy={() => policy && setDrawer({ type: 'policy', item: policy })} />}
        {state === 'unknownExternalResult' && <InlineNotice title="External result is unconfirmed" body="The external system did not return a success or failure response. Retry only with the original idempotency key." tone="unknown" />}
        {state === 'revoked' && <InlineNotice title="Authority revoked" body="This conversation remains visible. New agent work for this case is blocked." tone="danger" />}
        {canManageInbox && workCase.schemaVersion && !['completed', 'expired', 'revoked'].includes(state) && <div className="case-control-actions">
          <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => state === 'paused' ? void act('resume') : setConfirm('pause')}>{state === 'paused' ? 'Resume conversation' : 'Pause conversation'}</button>
          <button type="button" className="button destructive" disabled={Boolean(busy)} onClick={() => setConfirm('revoke')}>Revoke case authority</button>
        </div>}
        {workCase.receipt && <ReceiptCard workCase={workCase} />}

        <ProposalHistory workCase={workCase} view={view} events={events} />

        {caseAssets.length > 0 && <section className="mobile-assets-panel" aria-labelledby="shared-files-title"><div className="section-heading"><div><p className="eyebrow">Safety checked</p><h2 id="shared-files-title">Shared files</h2></div><span>{caseAssets.length} {caseAssets.length === 1 ? 'file' : 'files'}</span></div><div className="mobile-assets-list">{caseAssets.map(asset => <AssetRow key={asset.id} asset={asset} inboxId={view.inbox.id} notify={notify} />)}</div></section>}

        <section className="timeline-section" aria-labelledby="timeline-title">
          <div className="section-heading"><div><p className="eyebrow">Conversation activity</p><h2 id="timeline-title">What the agents are doing</h2></div><span>{events.length} updates</span></div>
          {events.length ? <ol className="timeline">{events.map((event, index) => <TimelineEvent key={event.id} event={event} last={index === events.length - 1} view={view} workCase={workCase} onPolicy={item => setDrawer({ type: 'policy', item })} />)}</ol> : <div className="empty-panel"><Activity size={22} /><strong>The conversation is just getting started</strong><span>Messages, offers, shared context, and completed actions will appear here.</span></div>}
        </section>

      </article>

      {railOpen && <ContextRail workCase={workCase} view={view} onPolicy={item => setDrawer({ type: 'policy', item })} onEvidence={item => setDrawer({ type: 'evidence', item })} notify={notify} />}
      {drawer && <DetailDrawer drawer={drawer} onClose={() => setDrawer(null)} />}
      {confirm && canAct && <ConfirmDialog action={confirm} busy={busy === confirm} onCancel={() => setConfirm(null)} onConfirm={() => void act(confirm)} />}
    </div>
  );
}

function NegotiationParticipants({ workCase, view, events, canManageInbox, onRefresh, notify }: { workCase: WorkCase; view: HumanView; events: CaseEvent[]; canManageInbox: boolean; onRefresh: () => Promise<unknown>; notify: (message: string) => void }) {
  const local = resolveParticipant(workCase, workCase.actingAgent, view.agents, view.participantDirectory);
  const counterpartIds = participantIds(workCase, events).filter(id => id !== workCase.actingAgent && id !== workCase.principal);
  const counterparties = counterpartIds.length
    ? counterpartIds.map(id => resolveParticipant(workCase, id, view.agents, view.participantDirectory))
    : [resolveParticipant(workCase, undefined, view.agents, view.participantDirectory)];
  return (
    <section className="participant-strip" aria-labelledby="participants-title">
      <div className="participant-strip-heading"><div><p className="eyebrow">Agent negotiation</p><h2 id="participants-title">Participants in this exchange</h2></div><span><ArrowLeftRight size={14} />Two-way exchange</span></div>
      <div className="participant-flow">
        <ParticipantCard participant={local} label="Your acting agent" />
        <div className="participant-connector" aria-hidden="true"><ArrowRight size={17} /><span>Negotiating with</span></div>
        <div className="counterparty-stack">{counterparties.map(participant => <ParticipantCard key={participant.id} participant={participant} label={participant.relationship === 'unknown' ? 'Identity unavailable' : 'Counterparty'} nativeControl={canManageInbox && participant.type === 'externalAgent' ? { inboxId: view.inbox.id, onRefresh, notify } : undefined} />)}</div>
      </div>
    </section>
  );
}

export function ParticipantCard({ participant, label, nativeControl }: { participant: ReturnType<typeof resolveParticipant>; label: string; nativeControl?: { inboxId: string; onRefresh: () => Promise<unknown>; notify: (message: string) => void } }) {
  const isAgent = participant.type === 'internalAgent' || participant.type === 'externalAgent';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function setBlocked() {
    if (!nativeControl) return;
    const blocked = participant.accessState !== 'blocked';
    setBusy(true); setError('');
    try {
      await api.setNativeContactBlocked(nativeControl.inboxId, participant.id, blocked);
      nativeControl.notify(blocked ? 'Counterparty blocked.' : 'Counterparty unblocked.');
      await nativeControl.onRefresh();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }
  return (
    <div className={`participant-card relationship-${participant.relationship}`}>
      <span className={`identity-mark ${isAgent ? 'agent' : 'human'}`}>{isAgent ? <Bot size={15} /> : <UserRound size={15} />}</span>
      <span className="participant-copy"><small>{label}</small><strong>{participant.displayName}</strong>{participant.address && <code>{participant.address}</code>}</span>
      <span className={`access-state state-${participant.accessState || 'unavailable'}`}>{humanize(participant.accessState || 'unavailable')}</span>
      {nativeControl && <button type="button" className="button quiet compact" disabled={busy} onClick={() => void setBlocked()}>{busy ? 'Saving…' : participant.accessState === 'blocked' ? 'Unblock agent' : 'Block agent'}</button>}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

export function DecisionCard({ workCase, view, events, policy, canManageInbox, busy, onAction, onPolicy }: { workCase: WorkCase; view: HumanView; events: CaseEvent[]; policy?: PolicyEvaluation; canManageInbox: boolean; busy: HumanActionKey | null; onAction: (key: HumanActionKey) => void; onPolicy: () => void }) {
  const proposal = workCase.proposals?.find(item => ['open', 'countered'].includes(item.status));
  const option = proposal?.options.find(item => !item.expired);
  const parties = proposal ? proposalParties(workCase, proposal.id, events, view) : null;
  const optionParty = proposal?.status === 'countered' ? parties?.counterparty : parties?.originator;
  // Case pause, resume and revocation are available in the dedicated controls above.
  // Takeover still lacks an enforcing server contract.
  const availableActions = (workCase.decision?.availableActions || []).filter(action => !['pause', 'revoke', 'takeOver'].includes(action));
  return (
    <section className="decision-card" aria-labelledby="decision-title">
      <div className="decision-accent"><Sparkles size={18} /></div>
      <div className="decision-copy"><p className="eyebrow">{canManageInbox ? 'Your judgment is required' : 'Workspace administrator review'}</p><h2 id="decision-title">{decisionQuestion(workCase, option)}</h2>
        {option && <ProposalOptionView option={option} expiresAt={proposal?.expiresAt || null} stageLabel={proposal?.status === 'countered' ? 'Counteroffer' : 'Offer'} partyLabel={optionParty?.displayName} />}
        <button className="authority-link" onClick={onPolicy} disabled={!policy}><AuthoritySeal decision={policy?.decision || 'needsHuman'} /> <span>Recorded policy: {policy?.matchedPolicyId ? humanize(policy.matchedPolicyId) : 'Human approval required'}</span></button>
      </div>
      {canManageInbox && availableActions.length > 0 && <div className="decision-actions">{availableActions.map((action, index) => <button key={action} className={`button ${index === 0 ? 'primary' : index === 1 ? 'secondary' : 'quiet'}`} disabled={Boolean(busy)} onClick={() => onAction(action)}>{busy === action ? 'Recording…' : humanize(action)}</button>)}</div>}
    </section>
  );
}

function ProposalOptionView({ option, expiresAt, stageLabel, partyLabel, muted = false }: { option: ProposalOption; expiresAt: string | null; stageLabel?: string; partyLabel?: string; muted?: boolean }) {
  const start = typeof option.value.start === 'string' ? option.value.start : null;
  const end = typeof option.value.end === 'string' ? option.value.end : null;
  const timezone = String(option.value.timezone || 'UTC');
  const terms = Object.entries(option.value).filter(([key]) => !['title', 'start', 'end', 'timezone'].includes(key));
  return (
    <div className={`proposal-option ${muted ? 'is-superseded' : ''}`}><CalendarDays size={18} /><div>{stageLabel && <span className="proposal-party">{stageLabel}{partyLabel ? ` · ${partyLabel}` : ''}</span>}<strong>{start ? `${formatDate(start)} · ${formatTime(start)}${end ? `–${formatTime(end)}` : ''}` : humanize(option.value.title || 'Proposed option')}</strong>{start && <span>{timezone} · {provenanceLabel(option.sourceConfidence)}</span>}{!start && <span>{provenanceLabel(option.sourceConfidence)}</span>}{terms.length > 0 && <dl className="proposal-terms">{terms.map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>}{expiresAt && !muted && <small>Tentative hold expires {formatAbsolute(expiresAt)}</small>}{muted && <small>Superseded by a counteroffer</small>}</div>{option.outOfPolicyFlags?.map(flag => <span key={flag} className="risk-label"><AlertCircle size={12} />{humanize(flag)}</span>)}</div>
  );
}

export function ProposalHistory({ workCase, view, events }: { workCase: WorkCase; view: HumanView; events: CaseEvent[] }) {
  if (!workCase.proposals?.length) return null;
  return (
    <section className="proposal-history" aria-labelledby="proposal-history-title">
      <div className="section-heading"><div><p className="eyebrow">Negotiation record</p><h2 id="proposal-history-title">Offers and counteroffers</h2></div><span>{workCase.proposals.length} {workCase.proposals.length === 1 ? 'proposal' : 'proposals'}</span></div>
      <div className="proposal-history-list">{workCase.proposals.map(proposal => {
        const parties = proposalParties(workCase, proposal.id, events, view);
        return <article key={proposal.id} className="proposal-history-item"><header><div><strong>{humanize(proposal.kind)} proposal</strong><code>{proposal.id}</code></div><StatusText value={proposal.status} /></header><div className="proposal-history-options">{proposal.options.map(option => {
          const isCounteroffer = proposal.status === 'countered' && !option.expired;
          return <ProposalOptionView key={option.id} option={option} expiresAt={proposal.expiresAt} stageLabel={isCounteroffer ? 'Counteroffer' : 'Offer'} partyLabel={(isCounteroffer ? parties.counterparty : parties.originator).displayName} muted={option.expired} />;
        })}</div></article>;
      })}</div>
    </section>
  );
}

function proposalParties(workCase: WorkCase, proposalId: string, events: CaseEvent[], view: HumanView) {
  const proposalEvents = events.filter(event => event.payload.proposalId === proposalId);
  const originEvent = proposalEvents.find(event => String(event.payload.status || '').toLowerCase() !== 'countered');
  const counterEvent = proposalEvents.slice().reverse().find(event => String(event.payload.messageType || event.payload.status || '').toLowerCase().includes('counter'));
  const originator = resolveParticipant(workCase, originEvent?.actor || workCase.actingAgent, view.agents, view.participantDirectory);
  const candidateId = participantIds(workCase, events).find(id => id !== workCase.actingAgent && id !== workCase.principal);
  const counterExchange = counterEvent ? exchangeParties(workCase, counterEvent, view.agents, view.participantDirectory) : null;
  const counterparty = counterExchange
    ? counterExchange.sender.id === workCase.actingAgent ? counterExchange.recipient : counterExchange.sender
    : resolveParticipant(workCase, candidateId, view.agents, view.participantDirectory);
  return { originator, counterparty };
}

function TimelineEvent({ event, last, view, workCase, onPolicy }: { event: CaseEvent; last: boolean; view: HumanView; workCase: WorkCase; onPolicy: (policy: PolicyEvaluation) => void }) {
  const participant = resolveParticipant(workCase, event.actor, view.agents, view.participantDirectory);
  const policy = workCase.policyEvaluations?.find(item => item.id === event.linkedPolicyEvaluation);
  const actor = event.actor ? participant.displayName : 'Sinaloa system';
  const actorIsAgent = participant.type === 'internalAgent' || participant.type === 'externalAgent';
  const tone = event.type === 'error' ? 'unknown' : event.type === 'receipt' ? 'success' : event.type === 'decision' ? 'attention' : 'neutral';
  return (
    <li className={`timeline-event tone-${tone}`} tabIndex={0}>
      <div className="timeline-rail"><span className={`event-node type-${event.type}`}><EventIcon type={event.type} /></span>{!last && <span className="rail-line" />}</div>
      <div className="event-body">{isExchangeEvent(event)
        ? <ExchangeLedgerEvent event={event} view={view} workCase={workCase} />
        : <><div className="event-meta"><span className={`identity-label ${actorIsAgent ? 'agent' : 'system'}`}>{actorIsAgent ? <Bot size={13} /> : <Database size={13} />}{actor}<small>{participantRole(participant)}</small></span><time dateTime={event.createdAt}>{formatAbsolute(event.createdAt)}</time></div><p>{eventSummary(event)}</p></>}
        {policy && <button className="authority-link compact" onClick={() => onPolicy(policy)}><AuthoritySeal decision={policy.decision} /><span>Linked policy record: {humanize(policy.matchedPolicyId || policy.reasonCode)}</span></button>}
      </div>
    </li>
  );
}

export function ExchangeLedgerEvent({ event, view, workCase }: { event: CaseEvent; view: HumanView; workCase: WorkCase }) {
  const exchange = exchangeParties(workCase, event, view.agents, view.participantDirectory);
  const label = exchangeEventLabel(event);
  return (
    <article className="exchange-ledger" aria-label={`${label} from ${exchange.sender.displayName} to ${exchange.recipient.displayName}`}>
      <header className="exchange-ledger-meta"><span className="exchange-kind">{label}</span><span className={`exchange-direction direction-${exchange.direction}`}>{exchange.direction === 'outbound' ? 'Outbound' : exchange.direction === 'inbound' ? 'Inbound' : 'Party to party'}</span><time dateTime={event.createdAt}>{formatAbsolute(event.createdAt)}</time></header>
      <div className="exchange-route">
        <ExchangeParty participant={exchange.sender} role="From" />
        <span className="exchange-arrow" aria-hidden="true"><ArrowRight size={18} /></span>
        <ExchangeParty participant={exchange.recipient} role="To" />
      </div>
      {event.payload.subject && <strong className="email-subject">Subject: {String(event.payload.subject)}</strong>}
      <p>{eventSummary(event)}</p>
      {event.payload.deliveryState && <span className="delivery-state">{event.payload.deliveryState === 'deadLettered' ? <AlertCircle size={13} /> : ['queued', 'retrying'].includes(event.payload.deliveryState) ? <Clock3 size={13} /> : <CheckCircle2 size={13} />}{humanize(event.payload.deliveryState)}</span>}
    </article>
  );
}

function ExchangeParty({ participant, role }: { participant: ReturnType<typeof resolveParticipant>; role: 'From' | 'To' }) {
  const isAgent = participant.type === 'internalAgent' || participant.type === 'externalAgent';
  return <div className="exchange-party"><span className="exchange-party-role">{role}</span><span className={`identity-mark ${isAgent ? 'agent' : 'human'}`}>{isAgent ? <Bot size={14} /> : <UserRound size={14} />}</span><span><strong>{participant.displayName}</strong><small>{participantRole(participant)}</small></span></div>;
}

function exchangeEventLabel(event: CaseEvent) {
  const messageType = String(event.payload.messageType || '').toLowerCase();
  if (messageType === 'email') return event.payload.senderEmail ? 'Email reply' : 'Email';
  if (messageType === 'proposal' || (event.payload.proposalId && event.payload.status === 'open')) return 'Offer';
  if (messageType === 'counterproposal' || String(event.payload.status || '').toLowerCase() === 'countered') return 'Counteroffer';
  if (messageType === 'request') return 'Request';
  if (messageType === 'acceptance') return 'Acceptance';
  if (messageType === 'rejection') return 'Rejection';
  if (messageType === 'decision') return `Decision: ${humanize(event.payload.data?.decision?.kind || 'recorded')}`;
  if (messageType === 'completion') return 'Completion';
  return 'Message';
}

function participantRole(participant: ReturnType<typeof resolveParticipant>) {
  if (participant.relationship === 'localAgent') return 'Your acting agent';
  if (participant.relationship === 'principal') return 'Human principal';
  if (participant.relationship === 'unknown') return 'Unknown external agent';
  if (participant.type === 'externalAgent') return 'Counterparty agent';
  if (participant.type === 'internalAgent') return 'Internal agent';
  return humanize(participant.type);
}

function ContextRail({ workCase, view, onPolicy, onEvidence, notify }: { workCase: WorkCase; view: HumanView; onPolicy: (item: PolicyEvaluation) => void; onEvidence: (item: EvidenceItem) => void; notify: (message: string) => void }) {
  const participants = participantIds(workCase, timelineForCase(workCase, view.messages));
  const assets = view.assets.filter(item => item.caseId === workCase.id);
  const deliveries = view.deliveryReceipts.filter(item => timelineForCase(workCase, view.messages).some(event => event.payload.messageId === item.messageId));
  return (
    <aside className="context-rail" aria-label="Conversation details">
      <RailSection title="Recorded policy evaluations" icon={<ShieldCheck size={16} />}>
        {workCase.policyEvaluations?.length ? workCase.policyEvaluations.map(item => <button key={item.id} className="rail-row interactive" onClick={() => onPolicy(item)}><AuthoritySeal decision={item.decision} /><span><strong>{humanize(item.requestedAction)}</strong><small>{humanize(item.grantType)} · {humanize(item.decision)}</small></span><ChevronDown size={14} /></button>) : <RailEmpty>No special permission has been requested.</RailEmpty>}
      </RailSection>
      <RailSection title="Evidence" icon={<FileCheck2 size={16} />}>
        {workCase.evidence?.map(item => <button key={item.id} className="rail-row interactive" onClick={() => onEvidence(item)}><FileText size={17} /><span><strong>{item.title}</strong><small>{provenanceLabel(item.provenance)}</small></span></button>)}
        {assets.map(item => <AssetRow key={item.id} asset={item} inboxId={view.inbox.id} notify={notify} />)}
        {!workCase.evidence?.length && !assets.length && <RailEmpty>No evidence has been attached.</RailEmpty>}
      </RailSection>
      <RailSection title="Delivery receipts" icon={<ReceiptText size={16} />}>
        {deliveries.length ? deliveries.map(item => <div key={item.id} className="rail-row"><CheckCircle2 size={17} /><span><strong>{item.transport === 'email' || item.type === 'email' ? `Email ${humanize(item.state).toLowerCase()}` : humanize(item.state)}</strong><small>{item.recipientEmail || item.senderEmail || item.recipientAgentId || item.messageId} · {formatAbsolute(item.createdAt)}</small></span></div>) : <RailEmpty>No delivery receipt has been recorded.</RailEmpty>}
      </RailSection>
      <RailSection title="Participants" icon={<UsersRound size={16} />}>
        {participants.length ? participants.map(id => { const participant = resolveParticipant(workCase, id, view.agents, view.participantDirectory); const isAgent = participant.type === 'internalAgent' || participant.type === 'externalAgent'; return <div key={id} className="rail-row"><span className={`identity-mark ${isAgent ? 'agent' : 'human'}`}>{isAgent ? <Bot size={14} /> : <UserRound size={14} />}</span><span><strong>{participant.displayName}</strong><small>{participantRole(participant)}</small></span></div>; }) : <RailEmpty>No additional participants are recorded.</RailEmpty>}
      </RailSection>
      <RailSection title="Constraints" icon={<ListFilter size={16} />}>
        {Object.keys(workCase.constraints || {}).length ? Object.entries(workCase.constraints || {}).map(([key, value]) => <div className="constraint-row" key={key}><span>{humanize(key)}</span><strong>{String(value)}</strong></div>) : <RailEmpty>No structured constraints are recorded.</RailEmpty>}
      </RailSection>
    </aside>
  );
}

function AssetRow({ asset, inboxId, notify }: { asset: Asset; inboxId: string; notify: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const state = assetStateMeta(asset);
  const downloadable = canDownloadAsset(asset);
  async function download() {
    setBusy(true);
    try {
      const result = await api.downloadAsset(inboxId, asset.id);
      const url = safeDownloadUrl(result.download.url);
      if (!url) throw new Error('The storage provider returned an unsafe download address.');
      const link = document.createElement('a');
      link.href = url;
      link.download = assetDisplayName(asset);
      link.rel = 'noopener';
      link.referrerPolicy = 'no-referrer';
      document.body.appendChild(link);
      link.click();
      link.remove();
      notify(`Downloading ${assetDisplayName(asset)}.`);
    } catch (caught) {
      notify(assetDownloadError(caught));
    } finally {
      setBusy(false);
    }
  }
  return <div className={`asset-row tone-${state.tone}`}><div className="asset-row-heading"><FileText size={17} /><span><strong>{assetDisplayName(asset)}</strong><small>{asset.mimeType} · {formatBytes(asset.size)}</small></span></div><span className="asset-state"><StatusGlyph state={asset.state === 'clean' ? 'completed' : asset.state === 'infected' ? 'failed' : asset.state === 'error' ? 'unknownExternalResult' : 'waitingForExternalParty'} />{state.label}</span><p>{state.description}</p>{downloadable && <button className="button tertiary compact" disabled={busy} onClick={() => void download()}><Download size={14} />{busy ? 'Preparing…' : 'Download file'}</button>}</div>;
}

function RailSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) { return <section className="rail-section"><h3>{icon}{title}</h3>{children}</section>; }
function RailEmpty({ children }: { children: ReactNode }) { return <p className="rail-empty">{children}</p>; }

export function ReceiptCard({ workCase }: { workCase: WorkCase }) {
  const receipt = workCase.receipt!;
  return (
    <section className="receipt-card"><div className="receipt-mark"><ReceiptText size={24} /></div><div className="receipt-content"><p className="eyebrow">Case outcome receipt</p><h2>{receipt.result}</h2><div className="receipt-grid"><div><span>Recorded</span><strong>{formatAbsolute(receipt.createdAt || workCase.updatedAt || workCase.createdAt)}</strong></div><div><span>Human approval</span><strong>{humanize(receipt.humanApprovalStatus)}</strong></div><div><span>Authority basis</span><strong>{humanize(receipt.authorityBasis)}</strong></div>{receipt.counterparties?.length ? <div><span>Counterparties</span><strong>{receipt.counterparties.join(', ')}</strong></div> : null}{receipt.evidenceRefs?.length ? <div><span>Evidence</span><strong>{receipt.evidenceRefs.join(', ')}</strong></div> : null}{Object.entries(receipt.externalIds || {}).map(([key, value]) => <div key={key}><span>{humanize(key)}</span><code>{String(value)}</code></div>)}</div></div><button className="button secondary" onClick={() => window.print()}>Print receipt</button></section>
  );
}

function SharedFilesPage({ view, notify }: { view: HumanView; notify: (message: string) => void }) {
  const [query, setQuery] = useState('');
  const [caseId, setCaseId] = useState('');
  const [creatorId, setCreatorId] = useState('');
  const [mimeType, setMimeType] = useState('');
  const files = filterAssets(view.assets, view.caseQueue, view.agents, { query, caseId, creatorId, mimeType });
  const caseOptions = view.caseQueue.filter(item => view.assets.some(asset => asset.caseId === item.id));
  const creators = view.agents.filter(agent => view.assets.some(asset => asset.createdByAgentId === agent.id));
  const types = [...new Set(view.assets.map(asset => asset.mimeType))].sort();
  return <PageFrame eyebrow="Agent artifacts" title="Shared files" description="Files exchanged by your agents. Only files that passed the safety scan can be downloaded.">
    {view.history?.assets?.hasMore && <InlineNotice title="More files may exist" body="Filters cover the files currently loaded. Load older history to search earlier files." tone="attention" />}
    <div className="file-filters">
      <label><span>Search files</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Name, case, creator, or type" /></label>
      <label><span>Case</span><select value={caseId} onChange={event => setCaseId(event.target.value)}><option value="">All cases</option>{caseOptions.map(item => <option key={item.id} value={item.id}>{item.objective || item.id}</option>)}</select></label>
      <label><span>Creator</span><select value={creatorId} onChange={event => setCreatorId(event.target.value)}><option value="">All creators</option>{creators.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
      <label><span>Type</span><select value={mimeType} onChange={event => setMimeType(event.target.value)}><option value="">All types</option>{types.map(type => <option key={type} value={type}>{type}</option>)}</select></label>
    </div>
    <p className="file-count">{files.length} of {view.assets.length} loaded files</p>
    {files.length ? <div className="shared-file-grid">{files.map(asset => {
      const workCase = view.caseQueue.find(item => item.id === asset.caseId);
      const creator = view.agents.find(item => item.id === asset.createdByAgentId);
      return <article className="shared-file-card" key={asset.id}><div><strong>{workCase?.objective || asset.caseId || 'No case assigned'}</strong><small>Created by {creator?.name || asset.createdByAgentId || 'Unknown agent'} · {formatAbsolute(asset.createdAt)}</small></div><AssetRow asset={asset} inboxId={view.inbox.id} notify={notify} /></article>;
    })}</div> : <PageEmpty icon={<FileText />} title={view.assets.length ? 'No files match these filters' : 'No shared files yet'} body={view.assets.length ? 'Try another name, case, creator, or file type.' : 'Agent-created files will appear here after they are exchanged.'} />}
  </PageFrame>;
}

function PoliciesPage({ view }: { view: HumanView }) {
  const policies = view.caseQueue.flatMap(item => item.policyEvaluations || []).sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt));
  return <PageFrame eyebrow="Authority" title="Policy evaluations" description="Recorded policy decisions for agent work. This view does not independently verify agent-reported authority or outcome claims."><div className="policy-summary"><Metric value={policies.filter(item => item.decision === 'allow').length} label="Allowed evaluations" /><Metric value={policies.filter(item => item.decision === 'needsHuman').length} label="Asked for judgment" /><Metric value={policies.filter(item => item.decision === 'deny').length} label="Denied" /></div>{policies.length ? <div className="data-list">{policies.map(item => <article key={item.id} className="data-row"><AuthoritySeal decision={item.decision} /><div><strong>{humanize(item.requestedAction)}</strong><span>{humanize(item.matchedPolicyId || 'No matching grant')} · {humanize(item.grantType)}</span></div><StatusText value={item.decision} /><time>{formatAbsolute(item.effectiveAt)}</time></article>)}</div> : <PageEmpty icon={<ShieldCheck />} title="No policy evaluations yet" body="Authority checks will appear here as agents attempt consequential actions." />}</PageFrame>;
}

function IntegrationsPage({ view, workspace, agentInboxes, humanId, canManageInbox, onSelectWorkspace, onRefresh, notify }: { view: HumanView; workspace: Workspace; agentInboxes: Workspace[]; humanId: string; canManageInbox: boolean; onSelectWorkspace: (workspace: Workspace) => Promise<void>; onRefresh: () => Promise<unknown>; notify: (message: string) => void }) {
  const [enrollment, setEnrollment] = useState<EnrollmentResult | null>(null);
  const [open, setOpen] = useState(false);
  const steps = onboardingSteps(view, agentInboxes);
  const completeCount = steps.filter(step => step.complete).length;
  return <PageFrame eyebrow="Closed beta setup" title="Agent connections" description="Connect your agent, share its Sinaloa address, and follow its conversations with other agents.">
    {canManageInbox ? <div className="page-actions"><button className="button primary" onClick={() => setOpen(true)}><Bot size={16} />Enroll an agent</button></div> : <InlineNotice title="Limited access" body="A workspace administrator manages agent enrollment. You can observe your agent’s conversations." tone="attention" />}
    <section className="onboarding-card" aria-labelledby="onboarding-title">
      <header><div><p className="eyebrow">Launch checklist</p><h2 id="onboarding-title">Make the first native exchange observable</h2></div><strong>{completeCount} of {steps.length}</strong></header>
      <div className="progress-track" aria-label={`${completeCount} of ${steps.length} onboarding steps complete`}><span style={{ width: `${(completeCount / steps.length) * 100}%` }} /></div>
      <ol>{steps.map((step, index) => <li key={step.id} className={step.complete ? 'complete' : ''}><span className="step-mark">{step.complete ? <Check size={14} /> : index + 1}</span><div><strong>{step.label}</strong><p>{step.description}</p></div>{canManageInbox && step.id === 'enroll' && !step.complete && <button className="button tertiary compact" onClick={() => setOpen(true)}>Connect agent</button>}</li>)}</ol>
    </section>
    {agentInboxes.length > 0 && <section className="agent-inbox-list" aria-label="Your agent inboxes"><div className="section-heading"><div><p className="eyebrow">Agent inboxes</p><h2>Each agent has its own view</h2></div><span>{agentInboxes.length} inboxes</span></div><div className="data-list">{agentInboxes.map(agentInbox => <article className="data-row" key={agentInbox.id}><span className="identity-mark agent"><Bot size={15} /></span><div><strong>{agentInbox.name}</strong><span>Separate conversation history and permissions</span></div><StatusText value={agentInbox.status} /><button type="button" className="button secondary compact" onClick={() => void onSelectWorkspace(agentInbox)}>Open inbox</button></article>)}</div></section>}
    <section className="beta-safeguards" aria-labelledby="safeguards-title">
      <div className="section-heading"><div><p className="eyebrow">Beta capabilities</p><h2 id="safeguards-title">Direct agent collaboration</h2></div><span>Closed beta</span></div>
      <div className="safeguard-grid">
        <SafeguardCard icon={<Inbox size={18} />} title="Direct messaging" status="Beta requirement" body="An agent can message another agent immediately using its exact known Sinaloa address. No first-contact approval is needed." />
        <SafeguardCard icon={<Link2 size={18} />} title="Runtime connection" status="Quick Connect" body="Paste a setup prompt into your self-hosted OpenClaw agent to connect it. Keep its host and runtime running for unattended messages. Manual bridges and Grok are available under advanced setup." />
        <SafeguardCard icon={<FileText size={18} />} title="Shared files" status="Beta requirement" body="Agent-created files appear in Shared files. Download unlocks only after a clean malware scan." />
      </div>
    </section>
    {view.agents.length ? <><div className="section-heading integration-section-heading"><div><p className="eyebrow">Enrolled agents</p><h2>Scoped identities</h2></div><span>{view.agents.length} total</span></div><div className="integration-grid">{view.agents.map(agent => <AgentCard key={agent.id} agent={agent} workspace={workspace} humanId={humanId} canManageInbox={canManageInbox} emailTransport={null} onRefresh={onRefresh} notify={notify} />)}</div></> : !agentInboxes.length && <PageEmpty icon={<PlugZap />} title="No agent inboxes yet" body="A workspace administrator can choose permissions and create a private setup prompt to add the first agent." action={canManageInbox ? <button className="button primary" onClick={() => setOpen(true)}>Enroll an agent</button> : undefined} />}
    {open && canManageInbox && <EnrollmentDialog workspace={workspace} agentDomain={view.publicEmailTransport?.internalAgentDomain || 'agents.envoi-agents.com'} result={enrollment} setResult={setEnrollment} onRefresh={onRefresh} onClose={() => { setOpen(false); setEnrollment(null); }} />}
  </PageFrame>;
}

function SafeguardCard({ icon, title, status, body }: { icon: ReactNode; title: string; status: string; body: string }) {
  return <article className="safeguard-card"><span className="safeguard-icon">{icon}</span><div><header><strong>{title}</strong><span>{status}</span></header><p>{body}</p></div></article>;
}

export function ConnectionInvitations({ invitations, error, workspace, canManageInbox, onReload, onRefresh, notify }: { invitations: AgentConnectionInvitation[]; error: string; workspace: Workspace; canManageInbox: boolean; onReload: () => Promise<void>; onRefresh: () => Promise<unknown>; notify: (message: string) => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  async function decide(invitationId: string, decision: 'accept' | 'decline') {
    setBusyId(invitationId);
    setActionError('');
    try {
      if (decision === 'accept') await api.acceptInvitation(workspace.id, invitationId);
      else await api.declineInvitation(workspace.id, invitationId);
      notify(decision === 'accept' ? 'Agent connection accepted. The conversation is now active.' : 'Agent connection declined. No messages were delivered.');
      await onRefresh();
      await onReload();
    } catch (caught) {
      const message = errorMessage(caught);
      setActionError(message);
      notify(message);
    } finally {
      setBusyId(null);
    }
  }

  const actionableCount = invitations.filter(item => canManageInbox && item.state === 'pending' && item.actionable === true).length;
  return <section className="connection-invitations" aria-labelledby="invitations-title" aria-live="polite"><div className="section-heading"><div><p className="eyebrow">Discovery layer</p><h2 id="invitations-title">Connection invitations</h2></div><span>{actionableCount} need review</span></div>{error || actionError ? <div className="recoverable-state"><InlineNotice title="Invitation feed unavailable" body={actionError || error} tone="unknown" /><button type="button" className="button secondary compact" onClick={() => void onReload()}>Try again</button></div> : invitations.length ? <div className="invitation-list">{invitations.map(item => {
    const busy = busyId === item.id;
    const incoming = item.direction === 'incoming';
    const counterpartAddress = incoming ? item.fromAddress : item.toAddress;
    return <article key={item.id}><span className="identity-mark agent"><Bot size={15} /></span><div><strong>{counterpartAddress}</strong><code>{incoming ? `To ${item.toAddress}` : `From ${item.fromAddress}`}</code><small>{incoming ? 'Received' : 'Sent'} {formatAbsolute(item.createdAt)} · exact address match</small></div>{canManageInbox && item.state === 'pending' && item.actionable === true ? <div className="invitation-decision-actions"><button type="button" className="button secondary compact" disabled={busy} aria-label={`Decline connection invitation from ${item.fromAddress}`} onClick={() => void decide(item.id, 'decline')}>{busy ? 'Working…' : 'Decline'}</button><button type="button" className="button primary compact" disabled={busy} aria-label={`Accept connection invitation from ${item.fromAddress}`} onClick={() => void decide(item.id, 'accept')}>{busy ? 'Working…' : 'Accept'}</button></div> : item.state === 'pending' && item.direction === 'outgoing' ? <div className="invitation-pending-status"><StatusText value="pending" /><small>Awaiting recipient approval</small></div> : <StatusText value={item.state} />}</article>;
  })}</div> : <div className="compact-empty"><CheckCircle2 size={18} /><span><strong>No incoming invitations</strong><small>Share your agent’s exact platform address. First-contact requests appear here before any message is delivered.</small></span></div>}</section>;
}

function ApprovedContacts({ emailTransport, error, workspace, canManageInbox, onReload, notify }: { emailTransport: EmailTransportStatus | null; error: string; workspace: Workspace; canManageInbox: boolean; onReload: () => Promise<void>; notify: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const canManage = canManageInbox && Boolean(emailTransport?.ready);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusyId('new'); setActionError('');
    try {
      await api.approveExternalContact(workspace.id, { email: String(data.get('email') || ''), displayName: String(data.get('displayName') || ''), direction: String(data.get('direction') || 'both') as ApprovedEmailContact['direction'] });
      form.reset(); setOpen(false); notify('External contact approved for the selected email direction.'); await onReload();
    } catch (caught) { const message = errorMessage(caught); setActionError(message); notify(message); }
    finally { setBusyId(null); }
  }
  async function setBlocked(contact: ApprovedEmailContact, blocked: boolean) {
    setBusyId(contact.id); setActionError('');
    try { await api.setExternalContactBlocked(workspace.id, contact.id, blocked); notify(blocked ? 'External contact blocked.' : 'External contact restored.'); await onReload(); }
    catch (caught) { const message = errorMessage(caught); setActionError(message); notify(message); }
    finally { setBusyId(null); }
  }
  return <section className="approved-contacts" aria-labelledby="approved-contacts-title"><div className="section-heading"><div><p className="eyebrow">Public email boundary</p><h2 id="approved-contacts-title">Approved contacts</h2></div><div className="section-actions"><span>Agent-owned sending</span>{canManage && <button type="button" className="button tertiary compact" onClick={() => setOpen(current => !current)}>{open ? 'Cancel' : 'Approve contact'}</button>}</div></div>{open && canManage && <form className="contact-approval-form" onSubmit={submit}><Field label="Contact name" name="displayName" placeholder="Jordan Lee" required /><Field label="Email address" name="email" type="email" autoComplete="email" placeholder="jordan@example.com" required /><label className="field"><span>Email direction</span><select name="direction" defaultValue="both"><option value="both">Send and receive</option><option value="outbound">Send only</option><option value="inbound">Receive only</option></select></label><button className="button primary" disabled={busyId === 'new'}>{busyId === 'new' ? 'Approving…' : 'Approve exact email'}</button></form>}{actionError && <InlineNotice title="Contact update failed" body={actionError} tone="unknown" />}{error ? <div className="recoverable-state"><InlineNotice title="Contact state unavailable" body={error} tone="unknown" /><button type="button" className="button secondary compact" onClick={() => void onReload()}>Try again</button></div> : !emailTransport ? <div className="compact-empty muted"><CircleDashed size={18} /><span><strong>Checking public email readiness</strong><small>No external action is enabled until configuration and contact state are confirmed.</small></span></div> : emailTransport.contacts.length ? <div className="contact-list">{emailTransport.contacts.map(contact => { const state = contact.blocked ? 'blocked' : contact.approved ? 'approved' : 'pending'; return <article key={contact.id}><span className="identity-mark human"><UserRound size={15} /></span><div><strong>{contact.displayName}</strong><code>{contact.email}</code><small>{humanize(contact.direction)} email · updated {formatAbsolute(contact.updatedAt)}</small></div><div className="contact-actions"><StatusText value={state} />{canManageInbox && <button type="button" className="button quiet compact" disabled={busyId === contact.id} onClick={() => void setBlocked(contact, !contact.blocked)}>{busyId === contact.id ? 'Saving…' : contact.blocked ? 'Unblock' : 'Block'}</button>}</div></article>; })}</div> : <div className="compact-empty"><ShieldCheck size={18} /><span><strong>No approved public contacts</strong><small>Agents cannot send arbitrary external email. Approve an exact address before enabling contact.</small></span></div>}</section>;
}

export function AgentCard({ agent, workspace, humanId, canManageInbox, emailTransport, onRefresh, notify }: { agent: Agent; workspace: Workspace; humanId: string; canManageInbox: boolean; emailTransport: EmailTransportStatus | null; onRefresh: () => Promise<unknown>; notify: (message: string) => void }) {
  const pending = agent.onboardingStatus === 'pending_approval';
  const canApproveAgent = canManageInbox || (agent.principalHumanId || workspace.ownerHumanId) === humanId;
  const [credential, setCredential] = useState('');
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState('');
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState('');
  const [revokeResult, setRevokeResult] = useState<{ revokedAt: string; credentialFamilyCount: number } | null>(null);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [reconnectResult, setReconnectResult] = useState<EnrollmentResult | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseError, setPauseError] = useState('');
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>(DEFAULT_AGENT_PERMISSIONS);
  const transportAgent = emailTransport?.agents.find(item => item.agentId === agent.id);
  const platformAddress = agent.platformAddress || transportAgent?.platformAddress || transportAgent?.internalAddress || agent.address;
  const publicEmailAddress = agent.publicEmailAddress || agent.identity?.externalAddress || transportAgent?.publicEmailAddress || transportAgent?.externalAddress || null;
  async function approve() {
    setApprovalBusy(true);
    setApprovalError('');
    try {
      const result = await api.approveAgent(workspace.id, agent.id, selectedAgentPermissions(selectedPermissions));
      if (result.agentApiToken) setCredential(result.agentApiToken);
      notify('Agent approved with the selected permissions.');
      setApprovalOpen(false);
      await onRefresh();
    } catch (caught) { setApprovalError(errorMessage(caught)); }
    finally { setApprovalBusy(false); }
  }
  async function revokeCredentials() {
    setRevokeBusy(true);
    setRevokeError('');
    try {
      const result = await api.revokeAgentCredentials(workspace.id, agent.id);
      setCredential('');
      setRevokeResult(result);
      setRevokeOpen(false);
      notify(`Credentials revoked for ${agent.name}.`);
      try { await onRefresh(); }
      catch { notify(`Credentials revoked for ${agent.name}. Refresh the workspace to see the latest audit event.`); }
    } catch (caught) { setRevokeError(errorMessage(caught)); }
    finally { setRevokeBusy(false); }
  }
  async function setPaused(paused: boolean) {
    setPauseBusy(true);
    setPauseError('');
    try {
      await api.setAgentPaused(workspace.id, agent.id, paused);
      notify(`${agent.name} ${paused ? 'paused' : 'resumed'}.`);
      await onRefresh();
    } catch (caught) { setPauseError(errorMessage(caught)); }
    finally { setPauseBusy(false); }
  }
  return <article className="integration-card">
    <div className="integration-heading"><span className="identity-mark agent"><Bot size={18} /></span><div><h2>{agent.name}</h2><span className="verified-address"><code>{platformAddress}</code><CopyButton value={platformAddress} label={`Copy ${agent.name} internal platform address`} /></span><small>Internal platform address · share for agent discovery</small></div><StatusText value={pending ? 'needs human' : agent.pausedAt ? 'paused' : agent.onboardingStatus === 'approved' ? 'enrolled' : agent.status} /></div>
    {emailTransport && <div className="public-address"><span>Public sending address</span>{publicEmailAddress ? <span className="verified-address"><code>{publicEmailAddress}</code><CopyButton value={publicEmailAddress} label={`Copy ${agent.name} public sending address`} /></span> : <strong>Not assigned</strong>}<small>{emailTransport.ready && transportAgent?.permitted ? 'Approved-contact email permission is active.' : 'Public email is unavailable for this agent.'}</small></div>}
    <div className="capability-list">{agent.permissions?.length ? agent.permissions.map(item => <span key={item}><Check size={12} />{humanize(item)}</span>) : <span><CircleDashed size={12} />No permissions active</span>}</div>
    <dl><div><dt>Identity</dt><dd>{agent.onboardingStatus === 'approved' ? 'Enrolled identity' : 'Pending approval'}</dd></div><div><dt>Permissions</dt><dd>{agent.permissions?.length || 0} scoped capabilities</dd></div></dl>
    {revokeResult && <InlineNotice title="Credential revocation completed" body={`${revokeResult.credentialFamilyCount} credential ${revokeResult.credentialFamilyCount === 1 ? 'family was' : 'families were'} revoked at ${formatAbsolute(revokeResult.revokedAt)}. The agent identity and past conversations remain visible.`} tone="attention" />}
    {credential && <div className="credential-once"><InlineNotice title="Copy this credential now" body="It is shown once. Store it only in the agent runtime’s secret manager." tone="attention" /><div className="copy-field"><input readOnly value={credential} aria-label="Agent API credential" /><CopyButton value={credential} label="Copy agent API credential" /></div></div>}
    {pending && canApproveAgent && <button className="button primary" onClick={() => setApprovalOpen(true)}>Review agent access</button>}
    {pauseError && <InlineNotice title="Agent control failed" body={pauseError} tone="unknown" />}
    {canManageInbox && agent.onboardingStatus === 'approved' && agent.status === 'active' && <button className="button secondary" disabled={pauseBusy} onClick={() => void setPaused(!agent.pausedAt)}>{pauseBusy ? 'Saving…' : agent.pausedAt ? 'Resume agent' : 'Pause agent'}</button>}
    {canManageInbox && agent.onboardingStatus === 'approved' && agent.status === 'active' && <button className="button secondary" onClick={() => { setReconnectResult(null); setReconnectOpen(true); }}>Reconnect runtime</button>}
    {canManageInbox && agent.onboardingStatus === 'approved' && <button className="button destructive" onClick={() => { setRevokeError(''); setRevokeOpen(true); }}>Revoke agent credentials</button>}
    {approvalOpen && canApproveAgent && <Modal title={`Approve ${agent.name}`} onClose={() => setApprovalOpen(false)}>
      <p>Choose what this agent may do. You can grant file sharing and task execution only if needed.</p>
      <AgentPermissionPicker selected={selectedPermissions} onChange={setSelectedPermissions} />
      <FormError message={approvalError} />
      <div className="dialog-actions"><button type="button" className="button secondary" onClick={() => setApprovalOpen(false)}>Cancel</button><button className="button primary" disabled={approvalBusy} onClick={() => void approve()}>{approvalBusy ? 'Approving…' : 'Approve with selected access'}</button></div>
    </Modal>}
    {revokeOpen && canManageInbox && <Modal title={`Revoke ${agent.name}'s credentials?`} onClose={() => setRevokeOpen(false)} dismissible={!revokeBusy}>
      <p className="dialog-copy">This revokes the agent's current access and refresh credentials and disconnects its live stream. The agent identity and conversation history remain visible.</p>
      <FormError message={revokeError} />
      <div className="dialog-actions"><button className="button secondary" disabled={revokeBusy} onClick={() => setRevokeOpen(false)}>Keep credentials</button><button className="button destructive" disabled={revokeBusy} onClick={() => void revokeCredentials()}>{revokeBusy ? 'Revoking…' : 'Revoke credentials'}</button></div>
    </Modal>}
    {reconnectOpen && canManageInbox && <EnrollmentDialog workspace={workspace} reconnectAgent={agent} result={reconnectResult} setResult={setReconnectResult} onRefresh={onRefresh} onClose={() => { setReconnectOpen(false); setReconnectResult(null); }} />}
  </article>;
}

const reservedAgentAddresses = new Set(['admin', 'administrator', 'agents', 'abuse', 'billing', 'contact', 'help', 'info', 'mail', 'noreply', 'no-reply', 'postmaster', 'root', 'security', 'support', 'system']);
const validAgentLocalPart = (value: string) => value.length >= 3 && value.length <= 32 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value) && !reservedAgentAddresses.has(value);

export function EnrollmentDialog({ workspace, agentDomain = 'agents.envoi-agents.com', result, setResult, onClose, onRefresh, reconnectAgent }: { workspace: Workspace; agentDomain?: string; result: EnrollmentResult | null; setResult: (value: EnrollmentResult | null) => void; onClose: () => void; onRefresh?: () => Promise<unknown>; reconnectAgent?: Agent & { runtime?: ConnectorRuntime } }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [runtime, setRuntime] = useState<ConnectorRuntime>(reconnectAgent?.runtime || 'openclaw');
  const addressEdited = useRef(false);
  const [status, setStatus] = useState<EnrollmentStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [pollingAttempt, setPollingAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>(DEFAULT_AGENT_PERMISSIONS);
  const [localPartInput, setLocalPartInput] = useState('');
  const [availability, setAvailability] = useState<'idle' | 'checking' | 'available' | 'taken' | 'error'>('idle');
  const localPart = localPartInput.trim().toLowerCase();
  const handoff = result?.quickConnect;
  const chosenAddress = handoff?.address || (result?.agentProfile?.localPart ? `${result.agentProfile.localPart}@${agentDomain}` : '');
  const prompt = handoff ? setupPrompt(handoff) : '';
  const downloads = handoff ? connectorDownloads(handoff) : null;
  const phase = status?.phase || 'waiting';
  const terminal = ['ready', 'expired', 'revoked', 'error'].includes(phase);
  const tokenExpired = result ? Date.parse(result.expiresAt) <= Date.now() : false;
  const canUseHandoff = !terminal && !tokenExpired && phase === 'waiting';
  useEffect(() => {
    setStatus(null); setStatusError(''); setCopied(false);
    if (!result?.enrollmentId) return;
    let previousPhase = 'waiting';
    return watchEnrollmentStatus({
      enrollmentId: result.enrollmentId,
      expiresAt: result.expiresAt,
      request: signal => api.enrollmentStatus(workspace.id, result.enrollmentId!, signal),
      onStatus: next => {
        setStatus(next); setStatusError('');
        if (next.phase !== previousPhase && ['enrolled', 'ready'].includes(next.phase)) void refresh.current?.().catch(() => {});
        previousPhase = next.phase;
      },
      onError: setStatusError,
      onTimeout: () => setStatusError('Automatic progress checks stopped. Check your agent’s setup report, or check status again. Do not create another token if this one was already redeemed.')
    });
  }, [result, workspace.id, pollingAttempt]);
  const sinaloaOrigin = typeof window === 'undefined' ? '' : window.location.origin;
  const selectedRuntime = handoff?.runtime || runtime;
  const label = runtimeLabel(selectedRuntime);
  const prepareCommand = `node sinaloa-connector.mjs prepare --runtime ${runtime} --api-url ${sinaloaOrigin || '<Sinaloa origin>'}${runtime === 'hermes' ? ' --prepare-runtime' : ''}`;
  const setupCommand = `node sinaloa-connector.mjs setup --handoff sinaloa-setup.json${selectedRuntime === 'hermes' ? ' --prepare-runtime' : ''}`;
  useEffect(() => {
    if (result || reconnectAgent || !validAgentLocalPart(localPart)) { setAvailability('idle'); return; }
    let cancelled = false;
    setAvailability('checking');
    const timer = setTimeout(() => {
      void api.agentAddressAvailability(workspace.id, localPart)
        .then(response => { if (!cancelled) setAvailability(response.available ? 'available' : 'taken'); })
        .catch(() => { if (!cancelled) setAvailability('error'); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [workspace.id, localPart, result, reconnectAgent]);
  async function copyPrompt() {
    try { await navigator.clipboard.writeText(prompt); setCopied(true); setError(''); }
    catch { setError('Clipboard access was unavailable. Expand “View setup prompt” and select the text to copy it, or use the terminal fallback.'); }
  }
  function downloadHandoff() {
    if (!handoff) return;
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(handoff, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'sinaloa-setup.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch { setError('The setup file could not be downloaded. Save the setup JSON privately on your runtime host.'); }
  }
  return <Modal title={result ? handoff ? `${reconnectAgent ? 'Reconnect' : 'Connect'} your ${label} agent` : 'Enrollment token created' : reconnectAgent ? `Reconnect ${reconnectAgent.name}` : 'Enroll an agent'} onClose={onClose}>
    {result ? <>
      {handoff ? <>
        <p className="dialog-copy">Run the setup instructions where {label} is installed. The connector detects local settings and keeps runtime and provider credentials on that host. You can give the prompt to an agent with terminal access, or use the private setup file.</p>
        <InlineNotice title="One private setup handoff" body={`Give this prompt only to your trusted agent. Its one-use token expires ${formatAbsolute(result.expiresAt)}. Copy or download before closing; it cannot be recovered.`} tone="attention" />
      </> : <InlineNotice title="Copy before closing" body="This one-use token cannot be recovered. Give it to one trusted agent bridge; do not redeem it in the browser or a separate shell first." tone="attention" />}
      {chosenAddress && <label className="field"><span>Chosen platform address</span><div className="copy-field"><input readOnly value={chosenAddress} aria-label="Chosen agent address" /><CopyButton value={chosenAddress} label="Copy chosen agent address" /></div><small>This address becomes active when the bridge redeems the token. It cannot be renamed during beta.</small></label>}
      {handoff && <section className="quick-connect">
        <button className="button primary" type="button" disabled={!canUseHandoff} onClick={() => void copyPrompt()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Setup prompt copied' : 'Copy setup prompt'}</button>
        <small>Connects {label} using a durable wake bridge. Node.js 22 or newer and access to the runtime host are required. The prompt contains a confidential token that may remain in chat history; prefer the private setup file in Terminal fallback.</small>
        {isLoopbackOrigin(handoff.apiUrl) && <InlineNotice title="Local development address" body="This setup points to localhost. A remotely hosted agent cannot reach it. Use a reachable HTTPS Sinaloa deployment or run the connector beside this development server." tone="attention" />}
        {selectedRuntime === 'hermes' && <InlineNotice title="Hermes credentials" body="The installer reuses the model provider already configured in Hermes and generates or reuses its local API Server key. The Sinaloa token replaces neither. A running Gateway may need your approval to restart." tone="attention" />}
        {canUseHandoff && <details className="setup-details"><summary>View setup prompt</summary><label className="field"><span className="sr-only">Setup prompt</span><textarea readOnly value={prompt} rows={9} onFocus={event => event.currentTarget.select()} /></label></details>}
        <div className="connection-progress" role="status" aria-live="polite">
          <strong>{phase === 'ready' ? 'Setup checks passed' : phase === 'enrolled' ? 'Agent paired · checking runtime' : phase === 'expired' ? 'Setup token expired' : phase === 'revoked' ? 'Connection revoked' : phase === 'error' ? 'Setup needs attention' : 'Waiting for your agent'}</strong>
          <ol><li className={['enrolled', 'ready'].includes(phase) ? 'complete' : ''}>Paste setup prompt</li><li className={['enrolled', 'ready'].includes(phase) ? 'complete' : ''}>Pair agent</li><li className={phase === 'ready' ? 'complete' : ''}>Run setup checks</li></ol>
          <p>{phase === 'ready' ? 'The connector reported that setup checks passed. Next, exchange a real message with another agent to verify unattended receiving and replies. Keep the host and runtime running.' : phase === 'enrolled' ? 'The one-time token has been redeemed. Continue with this connector’s setup; do not redeem it again.' : phase === 'expired' ? 'Create a new setup prompt if the agent has not paired. If it already paired, check its connector report first.' : phase === 'revoked' ? 'This connection’s credentials were revoked. Review agent connections before enrolling again.' : phase === 'error' ? 'Run the connector’s doctor command on your runtime host for the specific recovery step.' : 'This window watches setup progress. Enrollment alone does not confirm that the runtime is receiving messages.'}</p>
          {status?.checkedAt && <small>Setup report: {formatAbsolute(status.checkedAt)}</small>}
          {status?.errorCode && <small>Diagnostic: {humanize(status.errorCode)}</small>}
          {statusError && <FormError message={statusError} />}
          {(statusError || phase === 'error') && <button className="button secondary" onClick={() => setPollingAttempt(value => value + 1)}>Check status again</button>}
          {['expired', 'revoked'].includes(phase) && <button className="button secondary" onClick={() => { setResult(null); setBusy(false); setError(''); }}>Create new setup prompt</button>}
        </div>
        {canUseHandoff && downloads && <details className="setup-details"><summary>Terminal fallback</summary><p>Download the setup file and move it to a private directory on the machine running {label}. Restrict it to your user (0600 on Unix, current-user-only ACL on Windows).</p><button className="button secondary" onClick={downloadHandoff}><Download size={16} />Download setup file</button><p>Download the <a href={downloads.connector} download="sinaloa-connector.mjs">official connector</a> and <a href={downloads.release}>release metadata</a>. Verify the connector’s SHA256 against <code>artifacts["sinaloa-connector.mjs"].sha256</code> before running it.</p><pre>{setupCommand}</pre><p>Setup checks and saves your connection, then exits. Delete the setup file after successful pairing. To start the durable bridge at user login on supported hosts, run <code>node sinaloa-connector.mjs install-service --state-dir &lt;reported state directory&gt;</code>. You can also append <code>--install-service</code> to setup, or use its reported start command under your existing process supervisor. User services may stop at logout; they do not guarantee unattended boot.</p></details>}
        <FormError message={error} />
      </section>}
      <details className="setup-details" open={!handoff}><summary>Advanced setup · manual bridges</summary>
      <label className="field"><span>Raw enrollment token</span><div className="copy-field"><input readOnly value={result.enrollmentToken} aria-label="Raw enrollment token" /><CopyButton value={result.enrollmentToken} label="Copy raw enrollment token" /></div><small>Set this as <code>SINALOA_ENROLLMENT_TOKEN</code>. It expires {formatAbsolute(result.expiresAt)} and is consumed once by the bridge.</small></label>
      <div className="sdk-next-step"><p className="eyebrow">Agent runtime · next step</p><h3>Configure one supported bridge</h3><p>The bridge redeems the token and stores rotating Sinaloa credentials in its persistent state directory. Provider secrets stay on the external host and are never entered here.</p><div className="runtime-setup-list">
        <article><strong>OpenClaw</strong><p>Set <code>SINALOA_API_URL</code>, <code>SINALOA_STATE_DIR</code>, <code>OPENCLAW_GATEWAY_URL</code>, <code>OPENCLAW_GATEWAY_TOKEN</code>, and <code>OPENCLAW_AGENT_ID</code>. Run the renewable local relay beside the Gateway.</p></article>
        <article><strong>Grok</strong><p>Set <code>SINALOA_API_URL</code>, <code>SINALOA_STATE_DIR</code>, and <code>XAI_API_KEY</code>. Add <code>SINALOA_MCP_URL</code> only when hosted MCP reads are configured.</p></article>
        <article><strong>Hermes</strong><p>Use the official connector with the selected Hermes profile. It prepares API Server and MCP configuration while reusing the model provider already configured locally. Confirm a normal Hermes chat works before enrolling; missing provider credentials must be configured on the Hermes host. Start a new Hermes chat after configuration and verify an incoming Sinaloa message receives a reply.</p></article>
      </div></div>
      </details>
      <div className="dialog-actions"><button className="button secondary" onClick={onClose}>Close</button></div>
    </> : <form onSubmit={async event => {
      event.preventDefault();
      setBusy(true);
      setError('');
      try {
        if (reconnectAgent) setResult(await api.reconnectAgentToken(workspace.id, reconnectAgent.id, runtime));
        else {
          if (!validAgentLocalPart(localPart) || availability !== 'available') throw new Error('Choose an available agent address name');
          setResult(await api.enrollmentToken(workspace.id, name.trim(), localPart, selectedAgentPermissions(selectedPermissions), runtime));
        }
      } catch (caught) { setError(errorMessage(caught)); setBusy(false); }
    }}>
      <p className="dialog-copy">{reconnectAgent ? `Reconnect ${reconnectAgent.name} while keeping ${reconnectAgent.address}, its inbox and conversation history. Redeeming the token revokes the old credentials and disconnects the old runtime.` : 'Choose your runtime and connect it with a personalized setup prompt. Each agent gets its own durable wake connection and private state.'}</p>
      <RuntimePicker runtime={runtime} onChange={setRuntime} />
      {!reconnectAgent && <>
      <Field label="Agent name" name="name" value={name} onChange={event => { setName(event.target.value); if (!addressEdited.current) setLocalPartInput(suggestedAgentAddress(event.target.value)); }} placeholder="Scheduling agent" required />
      <label className="field"><span>Agent address name</span><div className="address-entry"><input name="localPart" value={localPartInput} onChange={event => { addressEdited.current = true; setLocalPartInput(event.target.value); }} autoComplete="off" spellCheck={false} placeholder="milo" required /><span>@{agentDomain}</span></div><small>Suggested from your agent’s name; you can edit it. Choose 3–32 letters, numbers, periods or hyphens. Start with a letter. The final address is checked again when the token is redeemed.</small></label>
      {localPartInput && <p role="status" className="address-feedback">{!validAgentLocalPart(localPart) ? 'Enter a valid, non-reserved address name.' : availability === 'checking' ? 'Checking availability…' : availability === 'available' ? `${localPart}@${agentDomain} is available now.` : availability === 'taken' ? 'That address is already taken.' : availability === 'error' ? 'Availability could not be checked. Try again.' : ''}</p>}
      <AgentPermissionPicker selected={selectedPermissions} onChange={setSelectedPermissions} />
      </>}
      <RuntimePreparation runtime={runtime} command={prepareCommand} apiUrl={sinaloaOrigin} reconnect={Boolean(reconnectAgent)} />
      <FormError message={error} />
      <div className="dialog-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || (!reconnectAgent && (!name.trim() || availability !== 'available'))}>{busy ? 'Creating setup prompt…' : reconnectAgent ? 'Create reconnect prompt' : 'Create setup prompt'}</button></div>
    </form>}
  </Modal>;
}

export function RuntimePicker({ runtime, onChange }: { runtime: ConnectorRuntime; onChange: (value: ConnectorRuntime) => void }) {
  return <label className="field"><span>Agent runtime</span><select name="runtime" value={runtime} onChange={event => onChange(event.target.value as ConnectorRuntime)}>{RUNTIME_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select><small>{RUNTIME_OPTIONS.find(option => option.id === runtime)!.prerequisite}</small></label>;
}

export function RuntimePreparation({ runtime, command, apiUrl, reconnect = false }: { runtime: ConnectorRuntime; command: string; apiUrl: string; reconnect?: boolean }) {
  const downloads = apiUrl ? { connector: `${apiUrl}/web/downloads/sinaloa-connector.mjs`, release: `${apiUrl}/web/downloads/release.json` } : null;
  return <div className="sdk-next-step"><p className="eyebrow">{runtimeLabel(runtime)} · preparation</p><h3>Check the runtime before enrolling</h3><p>The one-use token expires after 15 minutes. Confirm the runtime can complete a normal model request and that you have terminal access to its persistent host. Node.js 22 or newer is required. Provider credentials stay on that host.</p><p>{downloads ? <>Download the <a href={downloads.connector}>official connector</a> and <a href={downloads.release}>release metadata</a>.</> : 'Download the official connector and release metadata from this Sinaloa deployment.'} Verify SHA256 against <code>artifacts["sinaloa-connector.mjs"].sha256</code> before running:</p>{reconnect && <p>If this host already has the connection, use <code>doctor --state-dir &lt;existing state directory&gt;</code> to check it. Preserve that directory and stop its connector before applying reconnect. Use the preparation command below for a new host or profile without an existing Sinaloa connection.</p>}<pre>{command}</pre>{runtime === 'hermes' && <p>Preparation reuses the configured Hermes model provider and generates or reuses the local API Server key. These keys are separate from the Sinaloa enrollment token. Start the selected profile Gateway in a separate terminal after preparation. A running Gateway may need an owner-approved restart; preparation does not restart it automatically.</p>}{runtime === 'grok' && <p>Configure a missing xAI API key privately on the host. The installer cannot create a provider account or substitute the Sinaloa token for an xAI key.</p>}{apiUrl && isLoopbackOrigin(apiUrl) && <p>This local Sinaloa address cannot be reached by a remote agent. Use a reachable HTTPS deployment for remote onboarding.</p>}</div>;
}

export function AgentPermissionPicker({ selected, onChange }: { selected: string[]; onChange: (permissions: string[]) => void }) {
  return <fieldset className="permission-set"><legend>Agent permissions</legend>
    {AGENT_PERMISSION_OPTIONS.map(option => <label key={option.id}>
      <input type="checkbox" checked={option.required || selected.includes(option.id)} disabled={option.required} onChange={event => onChange(selectedAgentPermissions(event.target.checked ? [...selected, option.id] : selected.filter(permission => permission !== option.id)))} />
      <span><strong>{option.label}</strong><small>{option.description}</small></span>
    </label>)}
  </fieldset>;
}

function ActivityPage({ view }: { view: HumanView }) {
  return <PageFrame eyebrow="Behind the scenes" title="Activity log" description="A trustworthy history of conversations, messages, shared files, and permission changes.">{view.recentEvents.length ? <div className="activity-table" role="table"><div className="activity-head" role="row"><span>Event</span><span>Actor or object</span><span>Time</span></div>{view.recentEvents.map(event => <div className="activity-row" role="row" key={event.id}><span><Activity size={15} />{humanize(event.type)}</span><code>{auditSummary(event).split(' · ')[1] || event.id}</code><time>{formatAbsolute(event.createdAt)}</time></div>)}</div> : <PageEmpty icon={<Activity />} title="No activity recorded" body="Important operations will appear here as a durable history." />}</PageFrame>;
}

function PageFrame({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: ReactNode }) { return <><header className="page-header"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></header>{children}</>; }
function Metric({ value, label }: { value: number; label: string }) { return <div><strong>{value}</strong><span>{label}</span></div>; }
function PageEmpty({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) { return <div className="page-empty"><span>{icon}</span><h2>{title}</h2><p>{body}</p>{action}</div>; }

function DetailDrawer({ drawer, onClose }: { drawer: { type: 'policy' | 'evidence'; item?: PolicyEvaluation | EvidenceItem }; onClose: () => void }) {
  const item = drawer.item;
  return <><button className="drawer-scrim" aria-label="Close details" onClick={onClose} /><aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><header><div><p className="eyebrow">{drawer.type === 'policy' ? 'Recorded policy evaluation' : 'Evidence provenance'}</p><h2 id="drawer-title">{item && 'title' in item ? item.title : item && 'requestedAction' in item ? humanize(item.requestedAction) : 'Details'}</h2></div><button className="icon-button" aria-label="Close details" onClick={onClose}><X size={18} /></button></header>{item && 'decision' in item ? <dl className="detail-list"><Detail term="Decision" value={humanize(item.decision)} /><Detail term="Matched policy" value={humanize(item.matchedPolicyId || 'No matching policy')} /><Detail term="Grant type" value={humanize(item.grantType)} /><Detail term="Reason" value={humanize(item.reasonCode)} /><Detail term="Effective" value={formatAbsolute(item.effectiveAt)} /><Detail term="Expires" value={item.expiresAt ? formatAbsolute(item.expiresAt) : 'No expiration'} /></dl> : item && 'provenance' in item ? <dl className="detail-list"><Detail term="Type" value={humanize(item.kind)} /><Detail term="Source" value={provenanceLabel(item.provenance)} /><Detail term="Reference" value={item.id} /></dl> : null}</aside></>;
}

function Detail({ term, value }: { term: string; value: string }) { return <div><dt>{term}</dt><dd>{value}</dd></div>; }

function ConfirmDialog({ action, busy, onCancel, onConfirm }: { action: HumanActionKey; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const destructive = ['decline', 'revoke'].includes(action);
  return <Modal title={confirmTitle(action)} onClose={onCancel} dismissible={!busy}><p className="dialog-copy">{confirmBody(action)}</p><div className="dialog-actions"><button className="button secondary" onClick={onCancel} disabled={busy}>Keep working</button><button className={`button ${destructive ? 'destructive' : 'primary'}`} onClick={onConfirm} disabled={busy}>{busy ? 'Recording action…' : humanize(action)}</button></div></Modal>;
}

function Modal({ title, children, onClose, dismissible = true }: { title: string; children: ReactNode; onClose: () => void; dismissible?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.focus(); const handler = (event: KeyboardEvent) => { if (event.key === 'Escape' && dismissible) onClose(); }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, [dismissible, onClose]);
  return <div className="modal-layer"><button className="modal-scrim" aria-label={dismissible ? 'Close dialog' : undefined} onClick={dismissible ? onClose : undefined} /><div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1} ref={panel}><header><h2 id="modal-title">{title}</h2>{dismissible && <button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button>}</header>{children}</div></div>;
}

function CommandMenu({ view, onClose, onSelectCase }: { view: HumanView; onClose: () => void; onSelectCase: (item: WorkCase) => void }) {
  const [query, setQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const results = view.caseQueue.filter(item => `${item.objective} ${item.id}`.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
  useEffect(() => { searchInput.current?.focus({ preventScroll: true }); const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, [onClose]);
  return <div className="command-layer"><button className="modal-scrim" aria-label="Close search" onClick={onClose} /><div className="command-menu" role="dialog" aria-modal="true" aria-label="Search your agent workspace"><label><Search size={18} /><span className="sr-only">Search conversations, actions, participants, policies, and receipts</span><input ref={searchInput} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search conversations, people, and outcomes…" /><kbd>Esc</kbd></label><div className="command-results"><p className="eyebrow">Conversations</p>{results.map(item => <button key={item.id} onClick={() => onSelectCase(item)}><CaseIcon workCase={item} /><span><strong>{item.objective || item.id}</strong><small>{stateLabel(caseState(item))} · {conversationTags(item).join(' · ')}</small></span></button>)}{!results.length && <p className="command-empty">No results for “{query}”.</p>}</div></div></div>;
}

function EmptyCaseState({ section }: { section: NavSection }) { return <div className="case-empty"><CircleDashed size={28} /><h1>{emptyTitle(section)}</h1><p>{emptyBody(section)}</p></div>; }
function Field(props: InputHTMLAttributes<HTMLInputElement> & { label: string; name: string }) { const { label, ...input } = props; return <label className="field"><span>{label}</span><input {...input} /></label>; }
function FormError({ message }: { message: string }) { return message ? <p className="form-error" role="alert"><AlertCircle size={15} />{message}</p> : null; }
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); }, [copied]);
  return <><button type="button" className="icon-button" aria-label={label} onClick={async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setCopyError(false); }
    catch { setCopyError(true); }
  }}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>{copyError && <small role="alert">Could not copy. Select the value and copy it manually.</small>}</>;
}
function InlineNotice({ title, body, tone }: { title: string; body: string; tone: 'unknown' | 'danger' | 'attention' }) { return <div className={`inline-notice tone-${tone}`} role="status"><AlertCircle size={18} /><div><strong>{title}</strong><p>{body}</p></div></div>; }
function StatusBadge({ workCase }: { workCase: WorkCase }) { const state = caseState(workCase); return <span className={`status-badge tone-${caseTone(workCase)}`}><StatusGlyph state={state} />{caseLabel(workCase)}</span>; }
function StatusText({ value }: { value: string }) { return <span className={`status-text value-${value.replaceAll(' ', '-')}`}><span />{humanize(value)}</span>; }
function AuthoritySeal({ decision }: { decision: PolicyEvaluation['decision'] }) { return <span className={`authority-seal decision-${decision}`} aria-hidden="true">{decision === 'allow' ? <Check size={11} /> : decision === 'deny' ? <X size={11} /> : <UserRound size={11} />}</span>; }

function EventIcon({ type }: { type: CaseEvent['type'] }) { const icons = { message: <Inbox />, decision: <Sparkles />, policyEvaluation: <ShieldCheck />, toolAction: <Zap />, humanAction: <UserRound />, stateChange: <RefreshCw />, error: <AlertCircle />, receipt: <ReceiptText /> }; return icons[type]; }
function CaseIcon({ workCase }: { workCase: WorkCase }) { if (workCase.collaborationMode === 'scheduling') return <CalendarDays />; if (['artifactCreation', 'knowledgeSharing'].includes(workCase.collaborationMode || '')) return <FileText />; if (workCase.receipt) return <ReceiptText />; return <Command />; }
function StatusGlyph({ state }: { state: CaseState }) { if (['completed', 'accepted', 'authorized'].includes(state)) return <CheckCircle2 size={13} />; if (['failed', 'expired', 'revoked', 'disputed'].includes(state)) return <XCircle size={13} />; if (state === 'unknownExternalResult') return <AlertCircle size={13} />; if (['waitingForHuman', 'waitingForExternalParty', 'tentativeHold'].includes(state)) return <Clock3 size={13} />; return <Play size={13} />; }
function BrandMark() { return <span className="brand-mark" aria-hidden="true"><span /><span /></span>; }

function sectionTitle(section: NavSection) { return ({ inbox: 'Inbox', needsMe: 'Needs me', active: 'In motion', waiting: 'Waiting', scheduled: 'Calendar', documents: 'Shared files', completed: 'Done', policies: 'Permissions', integrations: 'Agent connections', activity: 'Activity log' } as Record<NavSection, string>)[section]; }
function emptyTitle(section: NavSection) { return section === 'inbox' ? 'Your agent inbox is empty' : section === 'needsMe' ? 'Your agents have it handled' : `No conversations in ${sectionTitle(section).toLowerCase()}`; }
function emptyBody(section: NavSection) { return section === 'inbox' ? 'Agent-to-agent conversations will appear here as soon as they begin.' : section === 'needsMe' ? 'Conversations will land here when your context or permission is genuinely needed.' : 'Conversations will appear here when they reach this stage.'; }
function caseType(workCase: WorkCase) { return `${humanize(workCase.collaborationMode || 'collaboration')} conversation`; }
function decisionQuestion(workCase: WorkCase, option?: ProposalOption) { if (workCase.decision?.question) return workCase.decision.question; if (option?.outOfPolicyFlags?.includes('outsideWorkingHours')) return 'The only viable time falls outside your preferred working hours.'; const policy = decisionPolicy(workCase); return policy ? `${humanize(policy.requestedAction)} needs your approval.` : 'Your agents need your judgment before they continue.'; }
function actionPastTense(action: HumanActionKey) { return ({ approveOnce: 'Approved once. The agent can continue.', decline: 'Declined. The conversation has been updated.', editProposal: 'Proposal edits requested.', pause: 'Conversation paused.', resume: 'Conversation resumed.', revoke: 'Authority revoked.', takeOver: 'You took over this conversation.' })[action]; }
function confirmTitle(action: HumanActionKey) { return ({ decline: 'Decline this proposal?', revoke: 'Revoke authority?', takeOver: 'Take over this conversation?', pause: 'Pause this conversation?', resume: 'Resume this conversation?', approveOnce: 'Approve once?', editProposal: 'Request edits?' })[action]; }
function confirmBody(action: HumanActionKey) { return ({ decline: 'Your rejection will be recorded in the case audit history.', revoke: 'New agent work for this case will be blocked and the decision will be audited.', takeOver: 'A takeover request will be recorded in the case history.', pause: 'New agent work for this case will pause until you resume it.', resume: 'Permitted agent work can continue.', approveOnce: 'This grants one-time authority for the current action.', editProposal: 'A request for a revised option will be recorded.' })[action]; }
function conversationTags(workCase: WorkCase) {
  const state = caseState(workCase);
  const mode = workCase.collaborationMode;
  const tags = [
    state === 'waitingForHuman' ? 'Needs approval' : null,
    state === 'waitingForExternalParty' ? 'Waiting on agent' : null,
    mode === 'scheduling' ? 'Scheduling' : null,
    mode === 'negotiation' ? 'Negotiation' : null,
    mode === 'artifactCreation' ? 'Artifact creation' : null,
    mode === 'knowledgeSharing' ? 'Knowledge sharing' : null,
    workCase.receipt ? 'Completed' : null
  ].filter((value): value is string => Boolean(value));
  return [...new Set(tags.length ? tags : ['Agent task'])].slice(0, 3);
}
function conversationPreview(workCase: WorkCase) {
  const projectedEvent = workCase.timeline?.at(-1);
  if (projectedEvent) return projectedEvent.summary;
  const event = [...(workCase.events || [])].reverse().find(item => item.payload.text || item.payload.message);
  if (event) return String(event.payload.text || event.payload.message);
  return workCase.contextualDetail || (workCase.deadline ? `Working toward ${formatDate(workCase.deadline)}` : STATE_META[caseState(workCase)].description);
}
function provenanceLabel(value: string) { return ({ fromVerifiedProfile: 'From verified profile', enteredForCase: 'Added for this conversation', extractedFromDocument: 'Extracted from attached document' } as Record<string, string>)[value] || humanize(value); }
function formatAbsolute(value: string) { return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value)); }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(value)); }
function formatTime(value: string) { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }
function formatRelative(value: string) { const diff = Date.now() - new Date(value).getTime(); const minutes = Math.max(0, Math.floor(diff / 60_000)); if (minutes < 60) return `${minutes}m`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h`; return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value)); }
function formatBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB`; }
function assetDownloadError(caught: unknown) { if (caught instanceof ApiError && caught.status === 423) return 'Download remains locked until the safety scan completes.'; if (caught instanceof ApiError && caught.status === 503) return 'File storage is not configured or is temporarily unavailable. Ask a workspace administrator to check the provider.'; if (caught instanceof ApiError && caught.status === 401) return 'Your session expired. Sign in again before downloading this file.'; return errorMessage(caught); }
function errorMessage(caught: unknown) { if (caught instanceof ApiError && caught.status === 503) return `${caught.message} Check the provider configuration, then retry.`; return caught instanceof Error ? caught.message : 'The action could not be completed.'; }
