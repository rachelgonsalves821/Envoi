import { ApiError } from '../api';
import type { Agent } from '../types';
import type { ApprovedClaim, ClaimApproval, ClaimLookup, Installation, OnboardingApi, OwnerClaim, RejectedClaim } from './types';

export interface ClaimProblem { code: string; message: string; retryAt: number; blocksSession: boolean; retryable: boolean }
const messages: Record<string, string> = {
  FEATURE_DISABLED: 'This connection flow is not available on this Envoi deployment.',
  CLAIM_CODE_INVALID: 'Check the code shown by your agent. It may have expired or already been decided.',
  CLAIM_INVALID: 'Review the workspace, agent details and permissions before approving.',
  CLAIM_FORBIDDEN: 'You cannot manage that target. Choose a workspace or agent you can manage.',
  CLAIM_STALE: 'The current installation changed. Review the refreshed installation and confirm again.',
  CLAIM_ALREADY_DECIDED: 'This registration already has a decision. Review recent approvals; withdraw an approval before changing it.',
  CLAIM_NOT_FOUND: 'This approval is no longer available to withdraw. Refresh recent approvals.',
  ADDRESS_TAKEN: 'That address is already in use or held. Choose another address.',
  ACTIVE_AGENT_LIMIT: 'The agent limit has been reached. Review your existing agents before continuing.',
  PENDING_ACTIVATION_LIMIT: 'Too many approvals are waiting for activation. Withdraw one or wait for it to finish.',
  AGENT_NOT_RECONNECTABLE: 'That agent cannot reconnect here. Choose another agent or create a new one. Frozen agents use Advanced setup.',
  INSTALLATION_NOT_FOUND: 'That installation is no longer available. Refresh the installations.',
  ACCOUNT_CHANGED: 'The signed-in account changed. Reload before continuing.',
  AUTHENTICATION_REQUIRED: 'Sign in again before continuing.',
  AUTH_UNAVAILABLE: 'Sign-in is temporarily unavailable. Wait, then retry.',
  INTERNAL_SERVER_ERROR: 'Envoi is temporarily unavailable. Wait, then retry.'
};
export function claimProblem(caught: unknown, now = Date.now(), retryNumber = 0): ClaimProblem {
  const error = caught as Partial<ApiError> & { reason?: string; requestId?: string; retryAfterSeconds?: number; retryAfter?: string | number };
  const code = error?.code || (Number(error?.status) >= 500 ? 'INTERNAL_SERVER_ERROR' : Number(error?.status) === 401 ? 'AUTHENTICATION_REQUIRED' : 'NETWORK_ERROR');
  const retryable = code === 'RATE_LIMITED' || ['NETWORK_ERROR', 'AUTH_UNAVAILABLE', 'INTERNAL_SERVER_ERROR'].includes(code);
  const rawSeconds = error?.retryAfterSeconds ?? (typeof error?.retryAfter === 'number' ? error.retryAfter : Number(error?.retryAfter));
  const seconds = Number.isFinite(rawSeconds) && Number(rawSeconds) >= 0 ? Number(rawSeconds) : null;
  const headerTime = typeof error?.retryAfter === 'string' ? Date.parse(error.retryAfter) : NaN;
  const retryAt = retryable ? seconds !== null ? now + seconds * 1000 : Number.isFinite(headerTime) ? Math.max(now, headerTime) : now + Math.min(30_000, Math.round(1000 * 2 ** Math.min(retryNumber, 5) * (0.8 + Math.random() * 0.4))) : 0;
  return { code, retryAt, retryable, blocksSession: ['ACCOUNT_CHANGED', 'AUTHENTICATION_REQUIRED'].includes(code),
    message: code === 'RATE_LIMITED' ? error.reason === 'claim_attempts' ? 'Too many incorrect codes. Code entry is locked until the retry time.' : 'Too many requests. Wait until the retry time before continuing.'
      : messages[code] ?? (code === 'NETWORK_ERROR' ? 'The response could not be confirmed. Wait, then retry the same request.' : 'This action could not be completed. Refresh before continuing.') };
}
export function newestActiveInstallation(installations: readonly Installation[]) {
  return installations.filter(item => item.status === 'active').sort((a, b) => b.activatedAt.localeCompare(a.activatedAt))[0] ?? null;
}
export function replacementCheckIn(agent: Agent) { return agent.connection?.seenAt ?? null; }

type Decision = { kind: 'approve'; registrationId: string; body: ClaimApproval } | { kind: 'reject'; registrationId: string; verificationCode: string };
export interface ClaimState {
  phase: 'code' | 'lookup' | 'review' | 'submitting' | 'approved' | 'rejected' | 'decided';
  lookup: ClaimLookup | null; decision: Decision | null; result: ApprovedClaim | RejectedClaim | null;
  problem: ClaimProblem | null; busy: boolean; retryAt: number; blocked: boolean;
  installations: Installation[] | null; replacementScope: { inboxId: string; agentId: string } | null;
  replacementConfirmed: boolean; uncertainAttempts: number;
}
const initialClaim = (): ClaimState => ({ phase: 'code', lookup: null, decision: null, result: null, problem: null, busy: false,
  retryAt: 0, blocked: false, installations: null, replacementScope: null, replacementConfirmed: false, uncertainAttempts: 0 });

/** In-memory only: typed codes/decisions never enter URLs, analytics or browser storage. */
export class ClaimController {
  private state = initialClaim();
  private listeners = new Set<() => void>();
  private active: AbortController | null = null;
  private generation = 0;
  constructor(private client: OnboardingApi, readonly now: () => number = Date.now) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<ClaimState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  dispose = () => { this.generation++; this.active?.abort(); this.active = null; this.state = initialClaim(); this.listeners.clear(); };
  private begin() { this.active?.abort(); this.active = new AbortController(); const generation = ++this.generation; return { signal: this.active.signal, current: () => generation === this.generation && !this.active?.signal.aborted }; }
  private allowed() { return !this.state.busy && !this.state.blocked && this.state.retryAt <= this.now(); }
  reset() { if (this.state.blocked || this.state.decision && !this.state.result) return; this.active?.abort(); this.generation++; this.update(initialClaim()); }
  private failure(caught: unknown) {
    const problem = claimProblem(caught, this.now(), this.state.uncertainAttempts);
    this.update({ problem, retryAt: problem.retryAt, busy: false, blocked: problem.blocksSession,
      ...(problem.blocksSession ? { lookup: null, decision: null, result: null, installations: null, replacementScope: null, replacementConfirmed: false, phase: 'code' } : {}) });
    return problem;
  }
  async lookup(code: string) {
    if (!this.allowed() || this.state.decision && !this.state.result) return false;
    const op = this.begin(); this.update({ ...initialClaim(), phase: 'lookup', busy: true });
    try { const lookup = await this.client.lookup(code, op.signal); if (!op.current()) return false; this.update({ lookup, phase: 'review', busy: false }); return true; }
    catch (caught) { if (op.current()) { this.failure(caught); this.update({ phase: 'code' }); } return false; }
  }
  async reviewReplacement(inboxId: string, agentId: string, preserveProblem = false) {
    if (!this.allowed() || this.state.decision) return false;
    const op = this.begin(); this.update({ busy: true, installations: null, replacementScope: { inboxId, agentId }, replacementConfirmed: false, ...(!preserveProblem ? { problem: null } : {}) });
    try {
      const result = await this.client.installations(inboxId, agentId, op.signal);
      if (!op.current()) return false;
      if (result.agentId !== agentId) throw new Error('Installation identity mismatch');
      this.update({ busy: false, installations: result.installations }); return true;
    } catch (caught) { if (op.current()) this.failure(caught); return false; }
  }
  confirmReplacement(confirmed: boolean) { if (!this.state.busy && !this.state.decision && this.state.installations) this.update({ replacementConfirmed: confirmed }); }
  async approve(body: ClaimApproval) {
    if (!this.allowed() || !this.state.lookup || this.state.decision || this.now() >= Date.parse(this.state.lookup.expiresAt)) return false;
    if (body.verificationCode !== this.state.lookup.verificationCode) return false;
    if (body.target.kind === 'existing_agent' && (!this.state.replacementConfirmed || !this.state.installations || this.state.replacementScope?.agentId !== body.target.agentId
      || body.target.replacesInstallationId !== (newestActiveInstallation(this.state.installations)?.id ?? null))) return false;
    // Capture a JSON snapshot: edits to a form cannot change an uncertain decision's retry.
    const captured = JSON.parse(JSON.stringify(body)) as ClaimApproval;
    this.update({ decision: { kind: 'approve', registrationId: this.state.lookup.registrationId, body: captured } });
    return this.sendDecision();
  }
  async reject() {
    if (!this.allowed() || !this.state.lookup || this.state.decision || this.now() >= Date.parse(this.state.lookup.expiresAt)) return false;
    this.update({ decision: { kind: 'reject', registrationId: this.state.lookup.registrationId, verificationCode: this.state.lookup.verificationCode } });
    return this.sendDecision();
  }
  async retryDecision() {
    if (!this.allowed() || !this.state.decision || !this.state.problem?.retryable || this.state.uncertainAttempts >= 3) return false;
    return this.sendDecision();
  }
  private async sendDecision() {
    const decision = this.state.decision; if (!decision) return false;
    const op = this.begin(); this.update({ phase: 'submitting', busy: true, problem: null });
    try {
      const result = decision.kind === 'approve' ? await this.client.approve(decision.registrationId, JSON.parse(JSON.stringify(decision.body)), op.signal)
        : await this.client.reject(decision.registrationId, decision.verificationCode, op.signal);
      if (!op.current()) return false;
      this.update({ result, phase: result.status, busy: false, problem: null, retryAt: 0 }); return true;
    } catch (caught) {
      if (!op.current()) return false;
      const problem = this.failure(caught);
      if (problem.blocksSession) return false;
      this.update({ phase: problem.code === 'CLAIM_ALREADY_DECIDED' ? 'decided' : 'review',
        ...(problem.retryable ? { uncertainAttempts: this.state.uncertainAttempts + 1 } : { decision: null }) });
      if (problem.code === 'CLAIM_STALE' && this.state.replacementScope) {
        const { inboxId, agentId } = this.state.replacementScope;
        await this.reviewReplacement(inboxId, agentId, true);
      }
      return false;
    }
  }
}

export interface CollectionState<T> { data: T | null; busy: boolean; problem: ClaimProblem | null; blocked: boolean; retryAt: number }
export class CollectionController<T> {
  protected state: CollectionState<T> = { data: null, busy: false, problem: null, blocked: false, retryAt: 0 };
  private listeners = new Set<() => void>(); private generation = 0; private active: AbortController | null = null;
  constructor(private loader: (signal: AbortSignal) => Promise<T>, readonly now: () => number = Date.now) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  protected update(patch: Partial<CollectionState<T>>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  dispose = () => { this.generation++; this.active?.abort(); this.state = { data: null, busy: false, problem: null, blocked: false, retryAt: 0 }; this.listeners.clear(); };
  protected async execute(action: (signal: AbortSignal) => Promise<T>) {
    if (this.state.busy || this.state.blocked || this.state.retryAt > this.now()) return false;
    const generation = ++this.generation; this.active = new AbortController(); const active = this.active;
    this.update({ busy: true, problem: null });
    try { const data = await action(active.signal); if (generation !== this.generation || active.signal.aborted) return false; this.update({ data, busy: false, retryAt: 0 }); return true; }
    catch (caught) {
      if (generation !== this.generation || active.signal.aborted) return false;
      const problem = claimProblem(caught, this.now());
      this.update({ busy: false, problem, blocked: problem.blocksSession, retryAt: problem.retryAt, ...(problem.blocksSession ? { data: null } : {}) }); return false;
    }
  }
  load = () => this.execute(this.loader);
}
export class OwnerClaimsController extends CollectionController<OwnerClaim[]> {
  constructor(private client: OnboardingApi, now = Date.now) { super(async signal => (await client.claims(signal)).claims, now); }
  withdraw(registrationId: string) {
    if (!this.state.data?.some(claim => claim.registrationId === registrationId && claim.status === 'approved')) return Promise.resolve(false);
    return this.execute(async signal => { await this.client.withdraw(registrationId, signal); return (await this.client.claims(signal)).claims; });
  }
}
export class InstallationsController extends CollectionController<Installation[]> {
  constructor(private client: OnboardingApi, readonly inboxId: string, readonly agentId: string, now = Date.now) {
    super(async signal => { const result = await client.installations(inboxId, agentId, signal); if (result.agentId !== agentId) throw new Error('Installation identity mismatch'); return result.installations; }, now);
  }
  async revoke(installationId: string) {
    if (!this.state.data?.some(item => item.id === installationId && item.status === 'active')) return false;
    const revoked = await this.execute(async signal => {
      const { installation } = await this.client.revoke(this.inboxId, this.agentId, installationId, signal);
      if (installation.id !== installationId || installation.agentId !== this.agentId) throw new Error('Installation identity mismatch');
      return this.state.data!.map(item => item.id === installationId ? installation : item);
    });
    if (!revoked) return false;
    // Keep the confirmed revocation if list refresh fails, while letting the caller
    // refresh agent presence. A changed/disposed session must never fire that callback.
    await this.load();
    return !this.state.blocked && !!this.state.data?.some(item => item.id === installationId && item.status === 'ended');
  }
}
