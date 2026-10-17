import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { onboardingApi } from './api';
import { OwnerClaimsController } from './claim-state';
import { ClaimProblemNotice, useClaimClock } from './ClaimPage';
import { permissionLabel, type OnboardingApi } from './types';

export interface OwnerClaimsProps { humanId: string; onSelectAgent?: (agentId: string) => void; client?: OnboardingApi; controller?: OwnerClaimsController }
export function OwnerClaims(props: OwnerClaimsProps) { return <OwnerClaimsSession key={props.humanId} {...props} />; }
function OwnerClaimsSession({ humanId, onSelectAgent, client = onboardingApi, controller: supplied }: OwnerClaimsProps) {
  const controller = useMemo(() => supplied ?? new OwnerClaimsController(client), [humanId, client, supplied]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const now = useClaimClock(controller.now);
  useEffect(() => { void controller.load(); return () => controller.dispose(); }, [controller]);
  const locked = state.busy || state.blocked || state.retryAt > now;
  return <section className="owner-claims onboarding-panel" aria-labelledby="owner-claims-title"><header className="onboarding-heading"><div><p className="eyebrow">Owner decisions</p><h2 id="owner-claims-title">Recent approvals</h2></div><button type="button" className="button secondary compact" disabled={locked} onClick={() => void controller.load()}>{state.busy ? 'Checking…' : 'Refresh approvals'}</button></header>
    <p>Approvals from the last day that you can manage, including those made by a colleague. Refresh to check whether the host activated.</p><ClaimProblemNotice problem={state.problem} now={now} />
    {!state.data && !state.problem && <p role="status">Loading approvals…</p>}
    {state.data?.length === 0 && <p>No recent approvals.</p>}
    <div className="onboarding-list">{state.data?.map(claim => {
      const deadlinePassed = claim.status === 'approved' && Date.parse(claim.activationExpiresAt) <= now;
      const status = claim.status;
      return <article key={claim.registrationId}><header><h3>{claim.agent.name}</h3><span>{status === 'approved' ? deadlinePassed ? 'Refresh activation status' : 'Waiting for host activation' : status === 'activated' ? 'Activated' : status === 'withdrawn' ? 'Approval ended' : 'Expired'}</span></header><p className="onboarding-address">{claim.agent.address}</p>
        <p>{claim.approvedByMe ? 'Approved by you' : 'Approved by a colleague'} · <time dateTime={claim.approvedAt}>{new Date(claim.approvedAt).toLocaleString()}</time></p>
        <p>Effective permissions: {claim.effectivePermissions.map(permissionLabel).join(', ')}.</p>
        {status === 'approved' && !deadlinePassed && <><p>Activate before <time dateTime={claim.activationExpiresAt}>{new Date(claim.activationExpiresAt).toLocaleString()}</time>.</p><button type="button" className="button secondary compact" disabled={locked} onClick={() => void controller.withdraw(claim.registrationId)} aria-label={`Withdraw approval for ${claim.agent.name}`}>Withdraw approval</button></>}
        {deadlinePassed && <p>The activation deadline passed. Refresh approvals to check whether it activated or expired.</p>}
        {status === 'activated' && claim.agent.id && onSelectAgent && <button type="button" className="button secondary compact" disabled={state.blocked} onClick={() => onSelectAgent(claim.agent.id!)}>View agent</button>}
        {status === 'withdrawn' && <p>This approval is no longer valid. A manager withdrew it or an activation check ended it.</p>}
      </article>;
    })}</div>
  </section>;
}
