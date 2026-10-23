import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { Inbox } from '../types';
import { agentLabel, connectionLabel, lastContactLabel } from '../agent-presence';
import { onboardingApi } from './api';
import { ClaimController, newestActiveInstallation, type ClaimProblem } from './claim-state';
import { canReconnectAgent, deliveryLabel, permissionLabel, routeLabel, type ClaimAgent, type OnboardingApi, type RegistrationPermission } from './types';

export function useClaimClock(clock: () => number = Date.now) {
  const [now, setNow] = useState(clock);
  useEffect(() => { setNow(clock()); const timer = setInterval(() => setNow(clock()), 1000); return () => clearInterval(timer); }, [clock]);
  return now;
}
export function ClaimProblemNotice({ problem, now }: { problem: ClaimProblem | null; now: number }) {
  if (!problem) return null;
  return <div role="alert" className="onboarding-notice"><p>{problem.message}</p>
    {problem.retryAt > now && <p>Try again after <time dateTime={new Date(problem.retryAt).toISOString()}>{new Date(problem.retryAt).toLocaleTimeString()}</time> ({Math.ceil((problem.retryAt - now) / 1000)} seconds).</p>}
    {problem.blocksSession && <button type="button" className="button secondary" onClick={() => window.location.reload()}>Reload and verify account</button>}
  </div>;
}
export interface ClaimPageProps {
  humanId: string; workspaces: Inbox[]; agents: ClaimAgent[]; onComplete?: () => void | Promise<void>; onBack?: () => void;
  client?: OnboardingApi; controller?: ClaimController;
}
export function ClaimPage(props: ClaimPageProps) { return <ClaimPageSession key={props.humanId} {...props} />; }
function ClaimPageSession({ humanId, workspaces, agents, onComplete, onBack, client = onboardingApi, controller: supplied }: ClaimPageProps) {
  const controller = useMemo(() => supplied ?? new ClaimController(client), [client, supplied, humanId]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => () => controller.dispose(), [controller]);
  const now = useClaimClock(controller.now);
  const [typedCode, setTypedCode] = useState('');
  const [targetKind, setTargetKind] = useState<'new_agent' | 'existing_agent'>('new_agent');
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '');
  const [name, setName] = useState(''); const [localPart, setLocalPart] = useState('');
  const [existingId, setExistingId] = useState('');
  const [permissions, setPermissions] = useState<RegistrationPermission[]>([]);
  const lookup = state.lookup;
  const eligibleAgents = agents.filter(canReconnectAgent);
  const selectedAgent = eligibleAgents.find(agent => agent.id === existingId);
  useEffect(() => {
    if (!lookup) return;
    setName(lookup.requestedName); setLocalPart(lookup.requestedLocalPart ?? ''); setTargetKind('new_agent'); setExistingId('');
    setPermissions([...new Set<RegistrationPermission>([...lookup.requestedPermissions.filter(permission => lookup.grantablePermissions.includes(permission)), 'receive_agent_messages'])]);
  }, [lookup]);
  const unresolved = Boolean(state.decision && !state.result);
  const expired = Boolean(lookup && Date.parse(lookup.expiresAt) <= now);
  const locked = state.busy || state.blocked || state.retryAt > now || unresolved;
  const selectedInstallation = state.installations ? newestActiveInstallation(state.installations) : null;
  const replacementReady = state.replacementScope?.agentId === existingId && state.installations !== null;
  const permissionChoices = lookup ? [...new Set<RegistrationPermission>([...lookup.requestedPermissions, 'receive_agent_messages'])] : [];
  function choosePermissions(agent?: ClaimAgent) {
    if (!lookup) return;
    const source = agent ? agent.permissions : lookup.requestedPermissions;
    setPermissions([...new Set<RegistrationPermission>([...lookup.grantablePermissions.filter(permission => source.includes(permission)), 'receive_agent_messages'])]);
  }
  function chooseAgent(agentId: string) {
    setExistingId(agentId); const agent = eligibleAgents.find(item => item.id === agentId); choosePermissions(agent);
    if (agent) void controller.reviewReplacement(agent.inboxId, agent.id);
  }
  async function approve(event: FormEvent) {
    event.preventDefault(); if (!lookup || locked || expired) return;
    const target = targetKind === 'new_agent' ? { kind: 'new_agent' as const, workspaceInboxId: workspaceId, name: name.trim(), localPart: localPart.trim() }
      : { kind: 'existing_agent' as const, agentId: existingId, replacesInstallationId: selectedInstallation?.id ?? null };
    if (await controller.approve({ verificationCode: lookup.verificationCode, target, grantedPermissions: [...permissions], policyProfile: 'default' })) void onComplete?.();
  }
  return <main className="onboarding-page claim-page">
    <header className="onboarding-heading"><div><p className="eyebrow">Envoi · owner approval</p><h1>Claim an agent connection</h1></div>{onBack && <button type="button" className="button quiet" onClick={onBack}>Back to workspace</button>}</header>
    <p>Enter the code shown by the helper on your runtime host. You decide which workspace, identity and permissions it can use.</p>
    <ClaimProblemNotice problem={state.problem} now={now} />
    {!lookup && <form onSubmit={event => { event.preventDefault(); void controller.lookup(typedCode); }} className="onboarding-code-form">
      <label className="field"><span>Verification code</span><input name="verificationCode" value={typedCode} onChange={event => setTypedCode(event.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} placeholder="XXXX-XXXX" disabled={locked} required /></label>
      <p>Type the code yourself; the claim URL never contains it. Spaces, hyphens and letter case are accepted.</p>
      <button className="button primary" disabled={locked || !typedCode.trim()}>{state.busy ? 'Looking up code…' : 'Review connection'}</button>
    </form>}
    {lookup && !state.result && state.phase !== 'decided' && <>
      <section className="onboarding-request" aria-labelledby="connection-request-title"><h2 id="connection-request-title">What this host requests</h2>
        <p>These details are claims made by the host. They do not verify who runs it or prove it can process work while closed.</p>
        <dl><div><dt>Code you entered</dt><dd><code>{lookup.verificationCode}</code></dd></div><div><dt>Requested name</dt><dd>{lookup.requestedName}</dd></div>
          <div><dt>Connection route</dt><dd>{routeLabel(lookup.connectionRoute)}</dd></div><div><dt>Declared runtime</dt><dd>{lookup.runtime.type}{lookup.runtime.version ? ` ${lookup.runtime.version}` : ' (version not provided)'}</dd></div>
          <div><dt>Registered</dt><dd><time dateTime={lookup.createdAt}>{new Date(lookup.createdAt).toLocaleString()}</time></dd></div>
          <div><dt>Claim deadline</dt><dd><time dateTime={lookup.expiresAt}>{new Date(lookup.expiresAt).toLocaleString()}</time>{expired && ' · Expired'}</dd></div>
          <div><dt>Declared capabilities</dt><dd>{Object.entries(lookup.deliveryCapabilities).filter(([, offered]) => offered).map(([key]) => ({ persistentProcess: 'background process', outboundHttps: 'outbound HTTPS', sse: 'SSE', webhook: 'webhook', scheduledPolling: 'scheduled polling', a2a: 'A2A' } as Record<string, string>)[key]).join(', ') || 'None declared'}</dd></div></dl>
      </section>
      {expired && !unresolved && <p role="status">This code expired. Ask the host operator for a new registration; no access was granted by this lookup.</p>}
      {unresolved ? <div className="onboarding-notice" role="status"><p>The decision’s outcome is uncertain. Its exact request is saved in this tab; do not change the target or approve again with different details.</p>
        {state.problem?.retryable && state.uncertainAttempts < 3 ? <button type="button" className="button secondary" disabled={state.busy || state.retryAt > now || state.blocked} onClick={() => void controller.retryDecision().then(success => { if (success) void onComplete?.(); })}>Retry same decision</button> : !state.busy && <p>Retry limit reached. Review recent approvals below before taking another action.</p>}
      </div> : <form onSubmit={event => void approve(event)} className="onboarding-approval-form">
        <fieldset disabled={locked || expired}><legend>Choose the agent identity</legend><div className="onboarding-choices">
          <label><input type="radio" name="target" value="new_agent" checked={targetKind === 'new_agent'} onChange={() => { setTargetKind('new_agent'); choosePermissions(); }} />Create a new agent</label>
          <label><input type="radio" name="target" value="existing_agent" checked={targetKind === 'existing_agent'} disabled={!eligibleAgents.length} onChange={() => { setTargetKind('existing_agent'); if (selectedAgent) chooseAgent(selectedAgent.id); else choosePermissions(); }} />Reconnect an existing agent</label>
        </div>
        {targetKind === 'new_agent' ? <div className="onboarding-fields"><label className="field"><span>Workspace</span><select value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} required><option value="">Choose a workspace</option>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
          <label className="field"><span>Agent name</span><input value={name} onChange={event => setName(event.target.value)} maxLength={80} required /></label>
          <label className="field"><span>Address name</span><input value={localPart} onChange={event => setLocalPart(event.target.value)} autoCapitalize="none" spellCheck={false} minLength={3} maxLength={32} pattern="[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*" required /></label><p>Use a lowercase address name with letters, numbers, periods or hyphens. The server checks availability when you approve.</p></div>
          : <><label className="field"><span>Existing agent</span><select value={existingId} onChange={event => chooseAgent(event.target.value)} required><option value="">Choose an agent</option>{eligibleAgents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {agent.address}</option>)}</select></label>
            {selectedAgent && <div className="onboarding-replacement"><p>{agentLabel(selectedAgent)} · {connectionLabel(selectedAgent.connection)}</p>
              {selectedAgent.connection?.seenAt && <p>{lastContactLabel(selectedAgent.connection)}: <time dateTime={selectedAgent.connection.seenAt}>{new Date(selectedAgent.connection.seenAt).toLocaleString()}</time></p>}
              {!replacementReady ? <button type="button" className="button secondary" disabled={state.busy} onClick={() => void controller.reviewReplacement(selectedAgent.inboxId, selectedAgent.id)}>Review current installations</button> : <>
                <p>{selectedInstallation ? <>Newest active installation: {selectedInstallation.runtime.type} · {routeLabel(selectedInstallation.connectionRoute)} · {deliveryLabel(selectedInstallation.deliveryMode)}, activated {new Date(selectedInstallation.activatedAt).toLocaleString()}.</> : 'There is no active installation to replace.'}</p>
                <p>Its current installations keep working until this connection activates. Activation then replaces every active installation. The agent keeps its address, cases and history{selectedAgent.paused || selectedAgent.status === 'paused' ? ', and stays paused until you resume it' : ''}.</p>
                <label><input type="checkbox" checked={state.replacementConfirmed} onChange={event => controller.confirmReplacement(event.target.checked)} />I reviewed the current connection and confirm this replacement.</label>
              </>}
            </div>}
          </>}
        </fieldset>
        <fieldset disabled={locked || expired}><legend>Permissions</legend><p>The active workspace policy applies. Receiving messages is required; only grantable requested permissions can be selected.</p><div className="onboarding-permissions">{permissionChoices.map(permission => <label key={permission}><input type="checkbox" checked={permissions.includes(permission)} disabled={permission === 'receive_agent_messages' || !lookup.grantablePermissions.includes(permission)} onChange={event => setPermissions(current => event.target.checked ? [...new Set([...current, permission])] : current.filter(value => value !== permission))} />{permissionLabel(permission)}{permission === 'receive_agent_messages' ? ' (required)' : !lookup.grantablePermissions.includes(permission) ? ' (not grantable)' : ''}</label>)}</div></fieldset>
        <div className="onboarding-actions"><button type="button" className="button secondary" disabled={locked || expired} onClick={() => void controller.reject().then(success => { if (success) void onComplete?.(); })}>Reject connection</button>
          <button className="button primary" disabled={locked || expired || (targetKind === 'new_agent' ? !workspaceId || !name.trim() || !localPart.trim() : !selectedAgent || !replacementReady || !state.replacementConfirmed)}>Approve access</button></div>
      </form>}
      {!unresolved && <button type="button" className="button quiet" disabled={state.busy || state.blocked || state.retryAt > now} onClick={() => { controller.reset(); setTypedCode(''); }}>Enter another code</button>}
    </>}
    {state.result?.status === 'approved' && <section className="onboarding-result" role="status"><h2>Approval recorded</h2><p>{state.result.agent.name} · {state.result.agent.address}</p><p>Workspace: {state.result.workspaceName}</p><p>Effective permissions: {state.result.effectivePermissions.map(permissionLabel).join(', ')}.</p><p>The host operator must confirm the approving account, workspace, identity and permissions before activation.</p><p>Activation deadline: <time dateTime={state.result.activationExpiresAt}>{new Date(state.result.activationExpiresAt).toLocaleString()}</time>.</p><p>Approval does not confirm that the runtime is receiving work.</p>{Date.parse(state.result.activationExpiresAt) <= now && <p>The activation deadline passed. Refresh recent approvals to see whether it activated or expired.</p>}<button type="button" className="button secondary" onClick={() => { controller.reset(); setTypedCode(''); }}>Enter another code</button></section>}
    {state.result?.status === 'rejected' && <section className="onboarding-result" role="status"><h2>Connection rejected</h2><p>This registration cannot activate.</p><button type="button" className="button secondary" onClick={() => { controller.reset(); setTypedCode(''); }}>Enter another code</button></section>}
    {state.phase === 'decided' && <div role="status"><p>Review recent approvals before changing a decision. An approved connection must be withdrawn first.</p><button type="button" className="button secondary" disabled={state.blocked} onClick={() => { controller.reset(); setTypedCode(''); }}>Enter another code</button></div>}
  </main>;
}
