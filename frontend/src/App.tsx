'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import {
  Activity, AlertCircle, ArrowLeft, ArrowLeftRight, ArrowRight, Bot, CalendarDays, Check, CheckCircle2, ChevronDown,
  CircleDashed, Clock3, Command, Copy, Database, Download, FileCheck2, FileText, Gauge, Inbox,
  KeyRound, Link2, ListFilter, Menu, MoreHorizontal, PanelRightClose, PanelRightOpen,
  Pause, Play, PlugZap, ReceiptText, RefreshCw, Search, ShieldCheck, Sparkles,
  UserRound, UsersRound, X, XCircle, Zap
} from 'lucide-react';
import { ApiError, SESSION_EXPIRED_EVENT, api, safeDownloadUrl } from './api';
import {
  STATE_META, assetDisplayName, assetStateMeta, auditSummary, canDownloadAsset, caseCounts, caseLabel, caseState, casesForSection, caseTone, decisionPolicy,
  eventSummary, exchangeParties, humanize, isExchangeEvent, onboardingSteps, participantIds, resolveParticipant,
  sectionForCase, stateLabel, timelineForCase
} from './model';
import type {
  Agent, AgentConnectionInvitation, ApprovedEmailContact, Asset, AuthConfig, CaseEvent, CaseState, EmailTransportStatus, EvidenceItem, Human, HumanActionKey,
  HumanView, Inbox as Workspace, NavSection, Organization, PolicyEvaluation, ProposalOption, WorkCase
} from './types';

const WORKSPACE_KEY = 'sinaloa.workspace';
const permissions = ['send_agent_messages', 'receive_agent_messages', 'create_assets', 'execute_cases'];
const caseSections: NavSection[] = ['inbox', 'needsMe', 'active', 'waiting', 'scheduled', 'documents', 'completed'];

type BootState = 'loading' | 'signedOut' | 'setup' | 'ready' | 'error';

const previewHuman: Human = { id: 'human_preview', displayName: 'Rachel' };
const previewWorkspace: Workspace = { id: 'inbox_preview', organizationId: 'org_preview', name: 'Rachel’s agent studio', ownerAgentId: 'agent_milo', ownerHumanId: previewHuman.id, status: 'active', createdAt: '2026-09-01T14:00:00.000Z' };
const previewAgents: Agent[] = [
  { id: 'agent_milo', name: 'Milo', address: 'milo@sinaloa.mail', principalHumanId: previewHuman.id, status: 'active', onboardingStatus: 'approved', permissions: ['send_agent_messages', 'receive_agent_messages', 'execute_cases'] }
];
const previewView: HumanView = {
  inbox: previewWorkspace,
  mode: 'human-observer',
  capabilities: ['observe_agent_communications', 'receive_agent_messages', 'reply_to_approved_agents', 'review_assets'],
  summary: { agents: 1, cases: 4, messages: 0, assets: 2, needsMe: 1 },
  navigation: { needsMe: 1, activeWork: 1, waiting: 1, completed: 1 },
  agents: previewAgents,
  invitations: [{ id: 'invitation_luma', fromAddress: 'hello@luma.events', toAddress: 'milo@sinaloa.mail', senderAgentId: 'agent_luma', recipientAgentId: 'agent_milo', direction: 'incoming', actionable: true, state: 'pending', createdAt: '2026-09-27T15:55:00.000Z', updatedAt: '2026-09-27T15:55:00.000Z' }],
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
  const isPreview = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('preview');
  const [boot, setBoot] = useState<BootState>('loading');
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [human, setHuman] = useState<Human | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<HumanView | null>(null);
  const [error, setError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [syncNotice, setSyncNotice] = useState('');

  const expireSession = useCallback(() => {
    setHuman(null);
    setWorkspace(null);
    setView(null);
    setAuthNotice('Your secure session expired. Sign in again to continue observing agent work.');
    setBoot('signedOut');
  }, []);

  const loadView = useCallback(async (workspaceId: string, quiet = false) => {
    if (!quiet) setView(null);
    const next = await api.humanView(workspaceId);
    setView(next);
    return next;
  }, []);

  const loadAccount = useCallback(async () => {
    try {
      setBoot('loading');
      setError('');
      const [nextConfig, nextHuman] = await Promise.all([api.authConfig(), api.me()]);
      setConfig(nextConfig);
      setHuman(nextHuman);
      const nextOrganizations = await api.organizations();
      setOrganizations(nextOrganizations);
      const workspaceGroups = await Promise.all(nextOrganizations.map(item => api.workspaces(item.id)));
      const nextWorkspaces = workspaceGroups.flat();
      setWorkspaces(nextWorkspaces);
      const savedId = localStorage.getItem(WORKSPACE_KEY);
      const selected = nextWorkspaces.find(item => item.id === savedId) || nextWorkspaces[0] || null;
      if (!selected) {
        setWorkspace(null);
        setBoot('setup');
        return;
      }
      setWorkspace(selected);
      localStorage.setItem(WORKSPACE_KEY, selected.id);
      await loadView(selected.id);
      setAuthNotice('');
      setBoot('ready');
    } catch (caught) {
      const nextConfig = config || await api.authConfig().catch(() => null);
      if (nextConfig) setConfig(nextConfig);
      if (caught instanceof ApiError && caught.status === 401) {
        expireSession();
      } else {
        setError(caught instanceof Error ? caught.message : 'Sinaloa could not load your workspace.');
        setBoot('error');
      }
    }
  }, [config, expireSession, loadView]);

  useEffect(() => { if (!isPreview) void loadAccount(); }, [isPreview]);

  useEffect(() => {
    if (isPreview) return;
    window.addEventListener(SESSION_EXPIRED_EVENT, expireSession);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expireSession);
  }, [expireSession, isPreview]);

  useEffect(() => {
    if (boot !== 'ready' || !workspace || !config) return;
    const refresh = () => { void loadView(workspace.id, true).then(() => setSyncNotice('')).catch(caught => { if (!(caught instanceof ApiError && caught.status === 401)) setSyncNotice('Live updates are temporarily paused. Your workspace will keep retrying.'); }); };
    const stream = new EventSource(`/api/inboxes/${workspace.id}/events`);
    const eventTypes = ['agent.enrolled', 'agent.enrollment_token_created', 'agent.onboarding_approved', 'agent.onboarding_rejected', 'case.created', 'case.event_appended', 'case.action_recorded', 'case.completed', 'policy.evaluated', 'proposal.created', 'proposal.countered', 'proposal.accept_attempted', 'message.queued', 'message.retry_scheduled', 'message.dead_lettered', 'message.dead_letter_requeued', 'message.delivered', 'message.acknowledged', 'message.processed', 'message.created', 'asset.created', 'asset.upload_started', 'asset.scan_clean', 'asset.scan_infected', 'asset.scan_error', 'contact.blocked', 'contact.unblocked', 'contact.approved'];
    stream.onopen = () => setSyncNotice('');
    stream.onmessage = refresh;
    eventTypes.forEach(type => stream.addEventListener(type, refresh));
    stream.addEventListener('ready', () => setSyncNotice(''));
    stream.onerror = () => {
      setSyncNotice('Live updates are reconnecting. You can refresh now or keep working.');
      void api.me().catch(() => undefined);
    };
    const interval = window.setInterval(refresh, 30_000);
    return () => { window.clearInterval(interval); eventTypes.forEach(type => stream.removeEventListener(type, refresh)); stream.close(); };
  }, [boot, config, loadView, workspace]);

  async function selectWorkspace(next: Workspace) {
    setWorkspace(next);
    localStorage.setItem(WORKSPACE_KEY, next.id);
    await loadView(next.id);
  }

  async function createWorkspace(name: string) {
    const created = await api.createWorkspace(name, organizations[0]?.id);
    setWorkspaces(current => [...current, created]);
    setWorkspace(created);
    localStorage.setItem(WORKSPACE_KEY, created.id);
    await loadView(created.id);
    setBoot('ready');
  }

  if (isPreview) return <AppShell config={{ provider: 'local', hosted: false }} human={previewHuman} organizations={[]} workspaces={[previewWorkspace]} workspace={previewWorkspace} view={previewView} onSelectWorkspace={async () => undefined} onRefresh={async () => previewView} onLogout={async () => undefined} syncNotice="" />;
  if (boot === 'loading') return <LoadingScreen />;
  if (boot === 'signedOut' && config) return <AuthScreen config={config} notice={authNotice} onAuthenticated={loadAccount} />;
  if (boot === 'setup' && human) return <WorkspaceSetup human={human} onCreate={createWorkspace} />;
  if (boot === 'error') return <FailureScreen message={error} onRetry={loadAccount} />;
  if (!human || !workspace || !view || !config) return <LoadingScreen />;

  return (
    <AppShell
      config={config}
      human={human}
      organizations={organizations}
      workspaces={workspaces}
      workspace={workspace}
      view={view}
      syncNotice={syncNotice}
      onSelectWorkspace={selectWorkspace}
      onRefresh={() => loadView(workspace.id, true)}
      onLogout={async () => {
        const result = await api.logout();
        if (result.logoutUrl) window.location.assign(result.logoutUrl);
        else window.location.reload();
      }}
    />
  );
}

function LoadingScreen() {
  return (
    <main className="center-screen" aria-live="polite">
      <div className="brand-lockup"><BrandMark /><span>Sinaloa</span></div>
      <div className="decision-loader" aria-hidden="true"><span /><span /><span /></div>
      <p>Loading your delegated work…</p>
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

function AuthScreen({ config, notice, onAuthenticated }: { config: AuthConfig; notice?: string; onAuthenticated: () => Promise<void> }) {
  const [step, setStep] = useState<'phone' | 'code' | 'totp'>('phone');
  const [challengeId, setChallengeId] = useState('');
  const [developmentCode, setDevelopmentCode] = useState('');
  const [totp, setTotp] = useState<{ secret: string; otpauthUri: string; developmentCode?: string } | null>(null);
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
      await api.phoneVerify(challengeId, String(form.get('code')));
      const setup = await api.totpSetup(); setTotp(setup); setStep('totp');
    } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); }
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
              <p className="supporting">Sign in through your organization’s secure identity provider.</p>
              <a className="button primary wide" href={config.signInPath || '/api/auth/workos/sign-in'}>Sign in securely</a>
              <a className="button secondary wide" href={config.signUpPath || '/api/auth/workos/sign-up'}>Create an account</a>
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
            </form>
          ) : (
            <form onSubmit={submitTotp}>
              <p className="eyebrow">Authenticator required</p><h2>Protect consequential actions</h2>
              <p className="supporting">Add this secret to your authenticator, then enter the current code.</p>
              <div className="secret-block"><KeyRound size={18} /><code>{totp?.secret}</code><CopyButton value={totp?.secret || ''} label="Copy authenticator secret" /></div>
              {totp?.developmentCode && <InlineNotice title="Current development code" body={totp.developmentCode} tone="unknown" />}
              <Field label="Authenticator code" name="code" inputMode="numeric" autoComplete="one-time-code" required />
              <FormError message={error} />
              <button className="button primary wide" disabled={busy}>{busy ? 'Securing workspace…' : 'Finish secure sign in'}</button>
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
}

function AppShell(props: ShellProps) {
  const { config, human, workspaces, workspace, view, onSelectWorkspace, onRefresh, onLogout, syncNotice } = props;
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
          <NavItem section="scheduled" label="Calendar" icon={<CalendarDays />} count={counts.scheduled} active={section === 'scheduled'} onClick={chooseSection} />
          <NavItem section="documents" label="Shared files" icon={<FileText />} count={counts.documents} active={section === 'documents'} onClick={chooseSection} />
          <NavItem section="completed" label="Done" icon={<CheckCircle2 />} count={counts.completed} active={section === 'completed'} onClick={chooseSection} />
          <div className="nav-separator" />
          <NavItem section="policies" label="Permissions" icon={<ShieldCheck />} active={section === 'policies'} onClick={chooseSection} />
          <NavItem section="integrations" label="Agent connections" icon={<PlugZap />} count={counts.integrations} active={section === 'integrations'} onClick={chooseSection} />
          <NavItem section="activity" label="Activity log" icon={<Activity />} active={section === 'activity'} onClick={chooseSection} />
        </nav>
        <div className="nav-footer">
          <button className="pause-control" onClick={() => setToast('Global pause requires backend support and is not active in this release.')}><Pause size={16} /><span>Pause all work</span></button>
          <div className="principal-card"><span className="identity-mark human"><UserRound size={15} /></span><div><strong>{human.displayName}</strong><small>Principal · {config.provider === 'workos' ? 'WorkOS' : 'local MFA'}</small></div><button className="icon-button" aria-label="Sign out" onClick={() => void onLogout()}><MoreHorizontal size={18} /></button></div>
        </div>
      </aside>

      <section className={`application ${utilitySection ? 'utility-layout' : ''} ${syncNotice ? 'has-sync-notice' : ''}`}>
        <header className="topbar">
          <button className="icon-button mobile-only" aria-label="Open navigation" onClick={() => setNavOpen(true)}><Menu size={19} /></button>
          <button className="search-trigger" onClick={() => setSearchOpen(true)}><Search size={16} /><span>Search conversations, people, and tags…</span><kbd>⌘K</kbd></button>
          <div className="topbar-actions"><button className="icon-button" aria-label="Refresh workspace" onClick={() => void onRefresh()}><RefreshCw size={17} /></button></div>
        </header>
        {syncNotice && <div className="sync-notice" role="status"><AlertCircle size={16} /><span>{syncNotice}</span><button className="button quiet" onClick={() => void onRefresh()}>Refresh now</button></div>}

        {utilitySection ? (
          <main id="main-content" className="utility-content">
            {section === 'policies' && <PoliciesPage view={view} />}
            {section === 'integrations' && <IntegrationsPage view={view} workspace={workspace} onRefresh={onRefresh} notify={setToast} />}
            {section === 'activity' && <ActivityPage view={view} />}
          </main>
        ) : (
          <div className={`case-layout ${mobileDetail ? 'show-detail' : ''}`}>
            <CaseQueue section={section} cases={visibleCases} view={view} selectedId={selectedCase?.id || null} onSelect={item => { setSelectedCaseId(item.id); setMobileDetail(true); }} />
            <main id="main-content" className="case-main">
              {selectedCase ? <CaseWorkspace workCase={selectedCase} view={view} railOpen={railOpen} onRailToggle={() => setRailOpen(value => !value)} onBack={() => setMobileDetail(false)} onRefresh={onRefresh} notify={setToast} /> : <EmptyCaseState section={section} />}
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

function CaseWorkspace({ workCase, view, railOpen, onRailToggle, onBack, onRefresh, notify }: { workCase: WorkCase; view: HumanView; railOpen: boolean; onRailToggle: () => void; onBack: () => void; onRefresh: () => Promise<unknown>; notify: (message: string) => void }) {
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

  const canAct = Boolean(workCase.schemaVersion) && !['completed', 'expired', 'revoked'].includes(state);
  return (
    <div className={`workspace-grid ${railOpen ? 'rail-open' : ''}`}>
      <article className="case-workspace">
        <header className="case-header">
          <div className="case-header-tools"><button className="icon-button mobile-only" aria-label="Back to inbox" onClick={onBack}><ArrowLeft size={18} /></button><span className="object-id">Conversation · {workCase.id}</span><button className="icon-button desktop-only" aria-label={railOpen ? 'Hide conversation details' : 'Show conversation details'} onClick={onRailToggle}>{railOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button></div>
          <div className="case-heading"><div className="case-title-icon"><CaseIcon workCase={workCase} /></div><div><p className="eyebrow">{caseType(workCase)}</p><h1>{workCase.objective || 'Untitled conversation'}</h1><div className="conversation-tags">{conversationTags(workCase).map(tag => <span key={tag} className={`thread-tag tag-${tag.toLowerCase().replaceAll(' ', '-')}`}>{tag}</span>)}</div></div></div>
          <StatusBadge workCase={workCase} />
        </header>

        <NegotiationParticipants workCase={workCase} view={view} events={events} />

        {workCase.decision && canAct && (
          <DecisionCard workCase={workCase} view={view} events={events} policy={policy} busy={busy} onAction={key => ['decline', 'takeOver'].includes(key) ? setConfirm(key) : void act(key)} onPolicy={() => policy && setDrawer({ type: 'policy', item: policy })} />
        )}
        {state === 'unknownExternalResult' && <InlineNotice title="External result is unconfirmed" body="The external system did not return a success or failure response. Retry only with the original idempotency key." tone="unknown" />}
        {state === 'revoked' && <InlineNotice title="Authority revoked" body="This conversation is preserved for your records, but the agents cannot take further action under the revoked authority." tone="danger" />}
        {workCase.receipt && <ReceiptCard workCase={workCase} />}

        <ProposalHistory workCase={workCase} view={view} events={events} />

        {caseAssets.length > 0 && <section className="mobile-assets-panel" aria-labelledby="shared-files-title"><div className="section-heading"><div><p className="eyebrow">Safety checked</p><h2 id="shared-files-title">Shared files</h2></div><span>{caseAssets.length} {caseAssets.length === 1 ? 'file' : 'files'}</span></div><div className="mobile-assets-list">{caseAssets.map(asset => <AssetRow key={asset.id} asset={asset} inboxId={view.inbox.id} notify={notify} />)}</div></section>}

        <section className="timeline-section" aria-labelledby="timeline-title">
          <div className="section-heading"><div><p className="eyebrow">Conversation activity</p><h2 id="timeline-title">What the agents are doing</h2></div><span>{events.length} updates</span></div>
          {events.length ? <ol className="timeline">{events.map((event, index) => <TimelineEvent key={event.id} event={event} last={index === events.length - 1} view={view} workCase={workCase} onPolicy={item => setDrawer({ type: 'policy', item })} />)}</ol> : <div className="empty-panel"><Activity size={22} /><strong>The conversation is just getting started</strong><span>Messages, offers, shared context, and completed actions will appear here.</span></div>}
        </section>

        {canAct && !workCase.decision && <div className="case-footer-actions"><button className="button tertiary" onClick={() => setConfirm('takeOver')}><UserRound size={16} />Take over</button><button className="button tertiary" onClick={() => setConfirm('pause')}><Pause size={16} />Pause conversation</button></div>}
      </article>

      {railOpen && <ContextRail workCase={workCase} view={view} onPolicy={item => setDrawer({ type: 'policy', item })} onEvidence={item => setDrawer({ type: 'evidence', item })} notify={notify} />}
      {drawer && <DetailDrawer drawer={drawer} onClose={() => setDrawer(null)} />}
      {confirm && <ConfirmDialog action={confirm} busy={busy === confirm} onCancel={() => setConfirm(null)} onConfirm={() => void act(confirm)} />}
    </div>
  );
}

function NegotiationParticipants({ workCase, view, events }: { workCase: WorkCase; view: HumanView; events: CaseEvent[] }) {
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
        <div className="counterparty-stack">{counterparties.map(participant => <ParticipantCard key={participant.id} participant={participant} label={participant.relationship === 'unknown' ? 'Identity unavailable' : 'Counterparty'} />)}</div>
      </div>
    </section>
  );
}

function ParticipantCard({ participant, label }: { participant: ReturnType<typeof resolveParticipant>; label: string }) {
  const isAgent = participant.type === 'internalAgent' || participant.type === 'externalAgent';
  return (
    <div className={`participant-card relationship-${participant.relationship}`}>
      <span className={`identity-mark ${isAgent ? 'agent' : 'human'}`}>{isAgent ? <Bot size={15} /> : <UserRound size={15} />}</span>
      <span className="participant-copy"><small>{label}</small><strong>{participant.displayName}</strong>{participant.address && <code>{participant.address}</code>}</span>
      <span className={`access-state state-${participant.accessState || 'unavailable'}`}>{humanize(participant.accessState || 'unavailable')}</span>
    </div>
  );
}

function DecisionCard({ workCase, view, events, policy, busy, onAction, onPolicy }: { workCase: WorkCase; view: HumanView; events: CaseEvent[]; policy?: PolicyEvaluation; busy: HumanActionKey | null; onAction: (key: HumanActionKey) => void; onPolicy: () => void }) {
  const proposal = workCase.proposals?.find(item => ['open', 'countered'].includes(item.status));
  const option = proposal?.options.find(item => !item.expired);
  const parties = proposal ? proposalParties(workCase, proposal.id, events, view) : null;
  const optionParty = proposal?.status === 'countered' ? parties?.counterparty : parties?.originator;
  const availableActions = workCase.decision?.availableActions || [];
  return (
    <section className="decision-card" aria-labelledby="decision-title">
      <div className="decision-accent"><Sparkles size={18} /></div>
      <div className="decision-copy"><p className="eyebrow">Your judgment is required</p><h2 id="decision-title">{decisionQuestion(workCase, option)}</h2>
        {option && <ProposalOptionView option={option} expiresAt={proposal?.expiresAt || null} stageLabel={proposal?.status === 'countered' ? 'Counteroffer' : 'Offer'} partyLabel={optionParty?.displayName} />}
        <button className="authority-link" onClick={onPolicy} disabled={!policy}><AuthoritySeal decision={policy?.decision || 'needsHuman'} /> <span>Authorized by: {policy?.matchedPolicyId ? humanize(policy.matchedPolicyId) : 'Human approval required'}</span></button>
      </div>
      <div className="decision-actions">{availableActions.map((action, index) => <button key={action} className={`button ${index === 0 ? 'primary' : index === 1 ? 'secondary' : 'quiet'}`} disabled={Boolean(busy)} onClick={() => onAction(action)}>{busy === action ? 'Recording…' : action === 'pause' ? 'Pause conversation' : humanize(action)}</button>)}</div>
    </section>
  );
}

function ProposalOptionView({ option, expiresAt, stageLabel, partyLabel, muted = false }: { option: ProposalOption; expiresAt: string | null; stageLabel?: string; partyLabel?: string; muted?: boolean }) {
  const start = typeof option.value.start === 'string' ? option.value.start : null;
  const end = typeof option.value.end === 'string' ? option.value.end : null;
  const timezone = String(option.value.timezone || 'UTC');
  return (
    <div className={`proposal-option ${muted ? 'is-superseded' : ''}`}><CalendarDays size={18} /><div>{stageLabel && <span className="proposal-party">{stageLabel}{partyLabel ? ` · ${partyLabel}` : ''}</span>}<strong>{start ? `${formatDate(start)} · ${formatTime(start)}${end ? `–${formatTime(end)}` : ''}` : humanize(option.value.title || 'Proposed option')}</strong><span>{timezone} · {provenanceLabel(option.sourceConfidence)}</span>{expiresAt && !muted && <small>Tentative hold expires {formatAbsolute(expiresAt)}</small>}{muted && <small>Superseded by a counteroffer</small>}</div>{option.outOfPolicyFlags?.map(flag => <span key={flag} className="risk-label"><AlertCircle size={12} />{humanize(flag)}</span>)}</div>
  );
}

function ProposalHistory({ workCase, view, events }: { workCase: WorkCase; view: HumanView; events: CaseEvent[] }) {
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
        {policy && <button className="authority-link compact" onClick={() => onPolicy(policy)}><AuthoritySeal decision={policy.decision} /><span>Authorized by {humanize(policy.matchedPolicyId || policy.reasonCode)}</span></button>}
      </div>
    </li>
  );
}

function ExchangeLedgerEvent({ event, view, workCase }: { event: CaseEvent; view: HumanView; workCase: WorkCase }) {
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
      <RailSection title="Authority" icon={<ShieldCheck size={16} />}>
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

function ReceiptCard({ workCase }: { workCase: WorkCase }) {
  const receipt = workCase.receipt!;
  return (
    <section className="receipt-card"><div className="receipt-mark"><ReceiptText size={24} /></div><div className="receipt-content"><p className="eyebrow">Outcome receipt</p><h2>{receipt.result}</h2><div className="receipt-grid"><div><span>Completed</span><strong>{formatAbsolute(receipt.createdAt || workCase.updatedAt || workCase.createdAt)}</strong></div><div><span>Human approval</span><strong>{humanize(receipt.humanApprovalStatus)}</strong></div><div><span>Authority basis</span><strong>{humanize(receipt.authorityBasis)}</strong></div>{receipt.counterparties?.length ? <div><span>Counterparties</span><strong>{receipt.counterparties.join(', ')}</strong></div> : null}{receipt.evidenceRefs?.length ? <div><span>Evidence</span><strong>{receipt.evidenceRefs.join(', ')}</strong></div> : null}{Object.entries(receipt.externalIds || {}).map(([key, value]) => <div key={key}><span>{humanize(key)}</span><code>{String(value)}</code></div>)}</div></div><button className="button secondary" onClick={() => window.print()}>Print receipt</button></section>
  );
}

function PoliciesPage({ view }: { view: HumanView }) {
  const policies = view.caseQueue.flatMap(item => item.policyEvaluations || []).sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt));
  return <PageFrame eyebrow="Authority" title="Policies" description="The rules that let agents prepare, propose, or commit actions on your behalf."><div className="policy-summary"><Metric value={policies.filter(item => item.decision === 'allow').length} label="Allowed evaluations" /><Metric value={policies.filter(item => item.decision === 'needsHuman').length} label="Asked for judgment" /><Metric value={policies.filter(item => item.decision === 'deny').length} label="Denied" /></div>{policies.length ? <div className="data-list">{policies.map(item => <article key={item.id} className="data-row"><AuthoritySeal decision={item.decision} /><div><strong>{humanize(item.requestedAction)}</strong><span>{humanize(item.matchedPolicyId || 'No matching grant')} · {humanize(item.grantType)}</span></div><StatusText value={item.decision} /><time>{formatAbsolute(item.effectiveAt)}</time></article>)}</div> : <PageEmpty icon={<ShieldCheck />} title="No policy evaluations yet" body="Authority checks will appear here as agents attempt consequential actions." />}</PageFrame>;
}

function IntegrationsPage({ view, workspace, onRefresh, notify }: { view: HumanView; workspace: Workspace; onRefresh: () => Promise<unknown>; notify: (message: string) => void }) {
  const [enrollment, setEnrollment] = useState<{ enrollmentToken: string; enrollmentUrl: string; expiresAt: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [emailTransport, setEmailTransport] = useState<EmailTransportStatus | null>(null);
  const [emailError, setEmailError] = useState('');
  const [invitations, setInvitations] = useState<AgentConnectionInvitation[]>(view.invitations);
  const [invitationError, setInvitationError] = useState('');
  const loadInvitations = useCallback(async () => {
    if (workspace.id === previewWorkspace.id) {
      setInvitations(previewView.invitations);
      setInvitationError('');
      return;
    }
    setInvitationError('');
    try { setInvitations(await api.invitations(workspace.id)); }
    catch (caught) { setInvitationError(errorMessage(caught)); }
  }, [workspace.id]);
  const loadEmailTransport = useCallback(async () => {
    if (workspace.id === previewWorkspace.id) {
      setEmailTransport({ provider: 'resend', ready: true, publicDomain: 'agents.example.com', domainVerified: true, reason: null, internalAgentDomain: 'sinaloa.mail', agents: [{ agentId: 'agent_milo', platformAddress: 'milo@sinaloa.mail', publicEmailAddress: 'milo@agents.example.com', permitted: true }], contacts: [] });
      setEmailError('');
      return;
    }
    setEmailError('');
    try { setEmailTransport(await api.emailTransport(workspace.id)); }
    catch (caught) { setEmailError(errorMessage(caught)); }
  }, [workspace.id]);
  useEffect(() => {
    setInvitations(view.invitations);
    setInvitationError('');
  }, [view.invitations]);
  useEffect(() => {
    let active = true;
    if (view.publicEmailTransport) {
      setEmailTransport({ ...view.publicEmailTransport, contacts: view.contacts || view.publicEmailTransport.contacts || [] });
      setEmailError('');
      return () => { active = false; };
    }
    if (workspace.id === previewWorkspace.id) { void loadEmailTransport(); return () => { active = false; }; }
    setEmailTransport(null); setEmailError('');
    void api.emailTransport(workspace.id).then(value => { if (active) setEmailTransport(value); }).catch(caught => { if (active) setEmailError(errorMessage(caught)); });
    return () => { active = false; };
  }, [loadEmailTransport, view.contacts, view.publicEmailTransport, workspace.id]);
  const steps = onboardingSteps(view);
  const completeCount = steps.filter(step => step.complete).length;
  const calendarConfigured = Object.values(view.calendarProviders).some(provider => provider.configured);
  return <PageFrame eyebrow="Closed beta setup" title="Agent connections" description="Bring one agent online, verify a native counterparty, and watch the first delivery reach a durable receipt.">
    <div className="page-actions"><button className="button primary" onClick={() => setOpen(true)}><Bot size={16} />Enroll an agent</button></div>
    <section className="onboarding-card" aria-labelledby="onboarding-title">
      <header><div><p className="eyebrow">Launch checklist</p><h2 id="onboarding-title">Make the first native exchange observable</h2></div><strong>{completeCount} of {steps.length}</strong></header>
      <div className="progress-track" aria-label={`${completeCount} of ${steps.length} onboarding steps complete`}><span style={{ width: `${(completeCount / steps.length) * 100}%` }} /></div>
      <ol>{steps.map((step, index) => <li key={step.id} className={step.complete ? 'complete' : ''}><span className="step-mark">{step.complete ? <Check size={14} /> : index + 1}</span><div><strong>{step.label}</strong><p>{step.description}</p></div>{step.id === 'enroll' && !step.complete && <button className="button tertiary compact" onClick={() => setOpen(true)}>Create link</button>}</li>)}</ol>
    </section>
    <section className="beta-safeguards" aria-labelledby="safeguards-title">
      <div className="section-heading"><div><p className="eyebrow">Beta safeguards</p><h2 id="safeguards-title">Native messages only</h2></div><span>Closed beta</span></div>
      <div className="safeguard-grid">
        <SafeguardCard icon={<Inbox size={18} />} title="Agent-to-agent messaging" status="Beta path" body="Use verified Sinaloa agent addresses. Delivery and acknowledgement states remain visible here." />
        <SafeguardCard icon={<Link2 size={18} />} title="Public email" status={emailTransport?.ready ? 'Ready' : emailTransport ? 'Unavailable' : 'Checking'} body={emailTransport?.ready ? `Verified on ${emailTransport.publicDomain}. Agents may email approved contacts only; humans remain observers and approvers.` : emailTransport ? `Not available: ${emailTransport.reason || 'provider configuration is incomplete'}. No public email action is offered.` : emailError || 'Checking the configured transport and verified domain.'} />
        <SafeguardCard icon={<CalendarDays size={18} />} title="Calendar actions" status={calendarConfigured ? 'Configured, gated' : 'Unavailable'} body={calendarConfigured ? 'A provider is configured, but connect and booking actions remain gated during the closed beta.' : 'No calendar provider is configured, and calendar actions remain gated during the closed beta.'} />
        <SafeguardCard icon={<FileText size={18} />} title="Attachment upload" status="Disabled" body="Human uploads are unavailable. Agent files stay locked until the safety scan reports clean." />
      </div>
    </section>
    <ConnectionInvitations invitations={invitations} error={invitationError} workspace={workspace} onReload={loadInvitations} onRefresh={onRefresh} notify={notify} />
    <ApprovedContacts emailTransport={emailTransport} error={emailError} workspace={workspace} onReload={loadEmailTransport} notify={notify} />
    {view.agents.length ? <><div className="section-heading integration-section-heading"><div><p className="eyebrow">Connected agents</p><h2>Scoped identities</h2></div><span>{view.agents.length} total</span></div><div className="integration-grid">{view.agents.map(agent => <AgentCard key={agent.id} agent={agent} workspace={workspace} emailTransport={emailTransport} onRefresh={onRefresh} notify={notify} />)}</div></> : <PageEmpty icon={<PlugZap />} title="No agents are connected" body="Create a permissioned, 15-minute enrollment link to add the first agent." action={<button className="button primary" onClick={() => setOpen(true)}>Enroll an agent</button>} />}
    {open && <EnrollmentDialog workspace={workspace} result={enrollment} setResult={setEnrollment} onClose={() => { setOpen(false); setEnrollment(null); }} />}
  </PageFrame>;
}

function SafeguardCard({ icon, title, status, body }: { icon: ReactNode; title: string; status: string; body: string }) {
  return <article className="safeguard-card"><span className="safeguard-icon">{icon}</span><div><header><strong>{title}</strong><span>{status}</span></header><p>{body}</p></div></article>;
}

export function ConnectionInvitations({ invitations, error, workspace, onReload, onRefresh, notify }: { invitations: AgentConnectionInvitation[]; error: string; workspace: Workspace; onReload: () => Promise<void>; onRefresh: () => Promise<unknown>; notify: (message: string) => void }) {
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

  const actionableCount = invitations.filter(item => item.state === 'pending' && item.actionable === true).length;
  return <section className="connection-invitations" aria-labelledby="invitations-title" aria-live="polite"><div className="section-heading"><div><p className="eyebrow">Discovery layer</p><h2 id="invitations-title">Connection invitations</h2></div><span>{actionableCount} need review</span></div>{error || actionError ? <div className="recoverable-state"><InlineNotice title="Invitation feed unavailable" body={actionError || error} tone="unknown" /><button type="button" className="button secondary compact" onClick={() => void onReload()}>Try again</button></div> : invitations.length ? <div className="invitation-list">{invitations.map(item => {
    const busy = busyId === item.id;
    const incoming = item.direction === 'incoming';
    const counterpartAddress = incoming ? item.fromAddress : item.toAddress;
    return <article key={item.id}><span className="identity-mark agent"><Bot size={15} /></span><div><strong>{counterpartAddress}</strong><code>{incoming ? `To ${item.toAddress}` : `From ${item.fromAddress}`}</code><small>{incoming ? 'Received' : 'Sent'} {formatAbsolute(item.createdAt)} · exact address match</small></div>{item.state === 'pending' && item.actionable === true ? <div className="invitation-decision-actions"><button type="button" className="button secondary compact" disabled={busy} aria-label={`Decline connection invitation from ${item.fromAddress}`} onClick={() => void decide(item.id, 'decline')}>{busy ? 'Working…' : 'Decline'}</button><button type="button" className="button primary compact" disabled={busy} aria-label={`Accept connection invitation from ${item.fromAddress}`} onClick={() => void decide(item.id, 'accept')}>{busy ? 'Working…' : 'Accept'}</button></div> : item.state === 'pending' && item.direction === 'outgoing' ? <div className="invitation-pending-status"><StatusText value="pending" /><small>Awaiting recipient approval</small></div> : <StatusText value={item.state} />}</article>;
  })}</div> : <div className="compact-empty"><CheckCircle2 size={18} /><span><strong>No incoming invitations</strong><small>Share your agent’s exact platform address. First-contact requests appear here before any message is delivered.</small></span></div>}</section>;
}

function ApprovedContacts({ emailTransport, error, workspace, onReload, notify }: { emailTransport: EmailTransportStatus | null; error: string; workspace: Workspace; onReload: () => Promise<void>; notify: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const canManage = Boolean(emailTransport?.ready);
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
  return <section className="approved-contacts" aria-labelledby="approved-contacts-title"><div className="section-heading"><div><p className="eyebrow">Public email boundary</p><h2 id="approved-contacts-title">Approved contacts</h2></div><div className="section-actions"><span>Agent-owned sending</span>{canManage && <button type="button" className="button tertiary compact" onClick={() => setOpen(current => !current)}>{open ? 'Cancel' : 'Approve contact'}</button>}</div></div>{open && <form className="contact-approval-form" onSubmit={submit}><Field label="Contact name" name="displayName" placeholder="Jordan Lee" required /><Field label="Email address" name="email" type="email" autoComplete="email" placeholder="jordan@example.com" required /><label className="field"><span>Email direction</span><select name="direction" defaultValue="both"><option value="both">Send and receive</option><option value="outbound">Send only</option><option value="inbound">Receive only</option></select></label><button className="button primary" disabled={busyId === 'new'}>{busyId === 'new' ? 'Approving…' : 'Approve exact email'}</button></form>}{actionError && <InlineNotice title="Contact update failed" body={actionError} tone="unknown" />}{error ? <div className="recoverable-state"><InlineNotice title="Contact state unavailable" body={error} tone="unknown" /><button type="button" className="button secondary compact" onClick={() => void onReload()}>Try again</button></div> : !emailTransport ? <div className="compact-empty muted"><CircleDashed size={18} /><span><strong>Checking public email readiness</strong><small>No external action is enabled until configuration and contact state are confirmed.</small></span></div> : emailTransport.contacts.length ? <div className="contact-list">{emailTransport.contacts.map(contact => { const state = contact.blocked ? 'blocked' : contact.approved ? 'approved' : 'pending'; return <article key={contact.id}><span className="identity-mark human"><UserRound size={15} /></span><div><strong>{contact.displayName}</strong><code>{contact.email}</code><small>{humanize(contact.direction)} email · updated {formatAbsolute(contact.updatedAt)}</small></div><div className="contact-actions"><StatusText value={state} /><button type="button" className="button quiet compact" disabled={busyId === contact.id} onClick={() => void setBlocked(contact, !contact.blocked)}>{busyId === contact.id ? 'Saving…' : contact.blocked ? 'Unblock' : 'Block'}</button></div></article>; })}</div> : <div className="compact-empty"><ShieldCheck size={18} /><span><strong>No approved public contacts</strong><small>Agents cannot send arbitrary external email. Approve an exact address before enabling contact.</small></span></div>}</section>;
}

function AgentCard({ agent, workspace, emailTransport, onRefresh, notify }: { agent: Agent; workspace: Workspace; emailTransport: EmailTransportStatus | null; onRefresh: () => Promise<unknown>; notify: (message: string) => void }) {
  const pending = agent.onboardingStatus === 'pending_approval';
  const [credential, setCredential] = useState('');
  const transportAgent = emailTransport?.agents.find(item => item.agentId === agent.id);
  const platformAddress = agent.platformAddress || transportAgent?.platformAddress || transportAgent?.internalAddress || agent.address;
  const publicEmailAddress = agent.publicEmailAddress || agent.identity?.externalAddress || transportAgent?.publicEmailAddress || transportAgent?.externalAddress || null;
  return <article className="integration-card"><div className="integration-heading"><span className="identity-mark agent"><Bot size={18} /></span><div><h2>{agent.name}</h2><span className="verified-address"><code>{platformAddress}</code><CopyButton value={platformAddress} label={`Copy ${agent.name} internal platform address`} /></span><small>Internal platform address · share for agent discovery</small></div><StatusText value={pending ? 'needs human' : agent.status} /></div>{emailTransport && <div className="public-address"><span>Public sending address</span>{publicEmailAddress ? <span className="verified-address"><code>{publicEmailAddress}</code><CopyButton value={publicEmailAddress} label={`Copy ${agent.name} public sending address`} /></span> : <strong>Not assigned</strong>}<small>{emailTransport.ready && transportAgent?.permitted ? 'Approved-contact email permission is active.' : 'Public email is unavailable for this agent.'}</small></div>}<div className="capability-list">{agent.permissions?.length ? agent.permissions.map(item => <span key={item}><Check size={12} />{humanize(item)}</span>) : <span><CircleDashed size={12} />No permissions active</span>}</div><dl><div><dt>Identity</dt><dd>{agent.onboardingStatus === 'approved' ? 'Verified and active' : 'Pending approval'}</dd></div><div><dt>Access</dt><dd>{agent.permissions?.length || 0} scoped capabilities</dd></div></dl>{credential && <div className="credential-once"><InlineNotice title="Copy this credential now" body="It is shown once. Store it only in the agent runtime’s secret manager." tone="attention" /><div className="copy-field"><input readOnly value={credential} aria-label="Agent API credential" /><CopyButton value={credential} label="Copy agent API credential" /></div></div>}{pending && <button className="button primary" onClick={async () => { try { const result = await api.approveAgent(workspace.id, agent.id, permissions); if (result.agentApiToken) setCredential(result.agentApiToken); notify('Agent approved with scoped execution permissions.'); await onRefresh(); } catch (caught) { notify(errorMessage(caught)); } }}>Approve agent</button>}</article>;
}

function EnrollmentDialog({ workspace, result, setResult, onClose }: { workspace: Workspace; result: { enrollmentToken: string; enrollmentUrl: string; expiresAt: string } | null; setResult: (value: any) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const exchangeCommand = result ? `curl -X POST ${window.location.origin}/api/agent-enroll -H "content-type: application/json" --data '${JSON.stringify({ enrollmentToken: result.enrollmentToken, name: 'My agent' })}'` : '';
  return <Modal title={result ? 'Enrollment link created' : 'Enroll an agent'} onClose={onClose}>{result ? <><InlineNotice title="Shown once" body="This enrollment credential cannot be recovered after you close this dialog." tone="attention" /><label className="field"><span>One-time enrollment URL</span><div className="copy-field"><input readOnly value={result.enrollmentUrl} /><CopyButton value={result.enrollmentUrl} label="Copy enrollment URL" /></div><small>Expires {formatAbsolute(result.expiresAt)}</small></label><div className="sdk-next-step"><p className="eyebrow">Agent runtime · next step</p><h3>Exchange the link for SDK credentials</h3><p>Run this only in the agent’s trusted environment. The response returns short-lived access and refresh credentials once.</p><div className="copy-field"><input readOnly value={exchangeCommand} aria-label="Agent enrollment command" /><CopyButton value={exchangeCommand} label="Copy agent enrollment command" /></div><small>Then initialize the included <code>@sinaloa/protocol</code> client with the returned <code>agentApiToken</code>.</small></div><div className="dialog-actions"><button className="button primary" onClick={onClose}>I’ve copied the handoff</button></div></> : <form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { setResult(await api.enrollmentToken(workspace.id, String(new FormData(event.currentTarget).get('name')), permissions)); } catch (caught) { setError(errorMessage(caught)); setBusy(false); } }}><Field label="Agent name" name="name" placeholder="Scheduling agent" required /><fieldset className="permission-set"><legend>Permission policy</legend>{permissions.map(item => <label key={item}><input type="checkbox" checked readOnly /><span>{humanize(item)}</span></label>)}</fieldset><FormError message={error} /><div className="dialog-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Creating link…' : 'Create one-time link'}</button></div></form>}</Modal>;
}

function ActivityPage({ view }: { view: HumanView }) {
  return <PageFrame eyebrow="Behind the scenes" title="Activity log" description="A trustworthy history of conversations, messages, shared files, and permission changes.">{view.recentEvents.length ? <div className="activity-table" role="table"><div className="activity-head" role="row"><span>Event</span><span>Actor or object</span><span>Time</span></div>{view.recentEvents.map(event => <div className="activity-row" role="row" key={event.id}><span><Activity size={15} />{humanize(event.type)}</span><code>{auditSummary(event).split(' · ')[1] || event.id}</code><time>{formatAbsolute(event.createdAt)}</time></div>)}</div> : <PageEmpty icon={<Activity />} title="No activity recorded" body="Important operations will appear here as a durable history." />}</PageFrame>;
}

function PageFrame({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: ReactNode }) { return <><header className="page-header"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></header>{children}</>; }
function Metric({ value, label }: { value: number; label: string }) { return <div><strong>{value}</strong><span>{label}</span></div>; }
function PageEmpty({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) { return <div className="page-empty"><span>{icon}</span><h2>{title}</h2><p>{body}</p>{action}</div>; }

function DetailDrawer({ drawer, onClose }: { drawer: { type: 'policy' | 'evidence'; item?: PolicyEvaluation | EvidenceItem }; onClose: () => void }) {
  const item = drawer.item;
  return <><button className="drawer-scrim" aria-label="Close details" onClick={onClose} /><aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><header><div><p className="eyebrow">{drawer.type === 'policy' ? 'Authority basis' : 'Evidence provenance'}</p><h2 id="drawer-title">{item && 'title' in item ? item.title : item && 'requestedAction' in item ? humanize(item.requestedAction) : 'Details'}</h2></div><button className="icon-button" aria-label="Close details" onClick={onClose}><X size={18} /></button></header>{item && 'decision' in item ? <dl className="detail-list"><Detail term="Decision" value={humanize(item.decision)} /><Detail term="Matched policy" value={humanize(item.matchedPolicyId || 'No matching policy')} /><Detail term="Grant type" value={humanize(item.grantType)} /><Detail term="Reason" value={humanize(item.reasonCode)} /><Detail term="Effective" value={formatAbsolute(item.effectiveAt)} /><Detail term="Expires" value={item.expiresAt ? formatAbsolute(item.expiresAt) : 'No expiration'} /></dl> : item && 'provenance' in item ? <dl className="detail-list"><Detail term="Type" value={humanize(item.kind)} /><Detail term="Source" value={provenanceLabel(item.provenance)} /><Detail term="Reference" value={item.id} /></dl> : null}</aside></>;
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
function CopyButton({ value, label }: { value: string; label: string }) { const [copied, setCopied] = useState(false); return <button type="button" className="icon-button" aria-label={label} onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>; }
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
function actionPastTense(action: HumanActionKey) { return ({ approveOnce: 'Approved once. The agent can continue.', decline: 'Declined. The conversation has been updated.', editProposal: 'Proposal edits requested.', pause: 'Conversation paused.', revoke: 'Authority revoked.', takeOver: 'You took over this conversation.' })[action]; }
function confirmTitle(action: HumanActionKey) { return ({ decline: 'Decline this proposal?', revoke: 'Revoke authority?', takeOver: 'Take over this conversation?', pause: 'Pause this conversation?', approveOnce: 'Approve once?', editProposal: 'Request edits?' })[action]; }
function confirmBody(action: HumanActionKey) { return ({ decline: 'The current proposal will no longer be actionable. The decision remains in the audit record.', revoke: 'The agent will no longer be able to act under this authority.', takeOver: 'Agent work will pause while you handle this conversation directly.', pause: 'The agents will stop advancing this conversation until new authority is provided.', approveOnce: 'This grants one-time authority for the current action.', editProposal: 'The agent will be asked to prepare a revised option.' })[action]; }
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
