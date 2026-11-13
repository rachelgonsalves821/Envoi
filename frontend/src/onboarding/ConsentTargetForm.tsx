import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Inbox } from '../types';
import { onboardingApi } from './api';
import { ClaimProblemNotice, useClaimClock } from './ClaimPage';
import { ClaimController, newestActiveInstallation } from './claim-state';
import { canReconnectAgent, permissionLabel, routeLabel, type ClaimAgent, type OnboardingApi, type RegistrationPermission } from './types';
import type { ConsentApproval } from './remote-auth-types';
import type { ConsentSavedSetup } from './saved-setup';

export interface ConsentTargetFormProps {
  workspaces: Inbox[]; agents: ClaimAgent[]; requested: RegistrationPermission[]; grantable: RegistrationPermission[];
  targetStatus?: 'loading' | 'error'; savedSetup?: ConsentSavedSetup;
  disabled: boolean; onApprove: (body: ConsentApproval) => Promise<unknown>; onDeny?: () => void; client?: OnboardingApi; controller?: ClaimController;
}
/** The server remains authoritative for management, eligibility, slots and staleness. */
export function ConsentTargetForm({ workspaces, agents, requested, grantable, savedSetup, targetStatus, disabled, onApprove, onDeny, client = onboardingApi, controller: supplied }: ConsentTargetFormProps) {
  const replacement = useMemo(() => supplied ?? new ClaimController(client), [client, supplied]);
  const review = useSyncExternalStore(replacement.subscribe, replacement.getSnapshot, replacement.getSnapshot);
  useEffect(() => () => replacement.dispose(), [replacement]);
  const now = useClaimClock(replacement.now);
  const [kind, setKind] = useState<'new_agent' | 'existing_agent'>('new_agent');
  const [selectedWorkspaceId, setWorkspaceId] = useState(savedSetup?.workspaceInboxId ?? '');
  const workspaceId = selectedWorkspaceId
    ? workspaces.find(workspace => workspace.id === selectedWorkspaceId)?.id ?? (savedSetup ? '' : workspaces[0]?.id ?? '')
    : workspaces[0]?.id ?? '';
  const [name, setName] = useState(savedSetup?.name ?? '');
  const [localPart, setLocalPart] = useState(savedSetup?.localPart ?? '');
  const [agentId, setAgentId] = useState('');
  const preferredPermissions = savedSetup?.permissions ?? requested;
  const defaultPermissions = grantable.filter(value => preferredPermissions.some(permission => permission === value));
  const [permissions, setPermissions] = useState<RegistrationPermission[]>(defaultPermissions);
  const eligible = agents.filter(canReconnectAgent);
  const agent = eligible.find(value => value.id === agentId);
  const current = review.installations ? newestActiveInstallation(review.installations) : null;
  const ready = Boolean(agent && review.replacementScope?.agentId === agent.id && review.installations && review.replacementConfirmed);
  const locked = disabled || review.busy || review.blocked || review.retryAt > now;
  const addressTaken = savedSetup?.addressAvailable === false && localPart.trim() === savedSetup.localPart;
  const canCreate = Boolean(workspaceId && name.trim() && localPart.trim() && !addressTaken);
  const selectedPermissions = permissions.filter(value => grantable.includes(value));
  const sendGrantable = grantable.includes('send_agent_messages');
  function chooseAgent(id: string) {
    setAgentId(id); const selected = eligible.find(item => item.id === id);
    setPermissions(grantable.filter(value => value === 'receive_agent_messages'
      || (requested.includes(value) && selected?.permissions.includes(value))));
    if (selected) void replacement.reviewReplacement(selected.inboxId, selected.id);
  }
  return <form className="onboarding-approval-form" onSubmit={event => {
    event.preventDefault(); if (locked || (kind === 'existing_agent' && !ready)) return;
    if (kind === 'new_agent' && !canCreate) return;
    void onApprove({ target: kind === 'new_agent'
      ? { kind, workspaceInboxId: workspaceId, name: name.trim(), localPart: localPart.trim() }
      : { kind, agentId, replacesInstallationId: current?.id ?? null }, grantedPermissions: selectedPermissions, policyProfile: 'default',
      ...(kind === 'new_agent' && savedSetup ? { savedSetupId: savedSetup.setupId } : {}) });
  }}>
    <ClaimProblemNotice problem={review.problem} now={now} />
    <fieldset disabled={locked}><legend>Choose the agent identity</legend>
      <label><input type="radio" name="oauth-target" checked={kind === 'new_agent'} onChange={() => { setKind('new_agent'); setPermissions(defaultPermissions); }} />Create a new agent</label>
      <label><input type="radio" name="oauth-target" checked={kind === 'existing_agent'} disabled={!eligible.length} onChange={() => { setKind('existing_agent'); chooseAgent(agentId); }} />Reconnect an existing agent</label>
      {!eligible.length && <p role="status">{targetStatus === 'loading' ? 'Checking your workspaces for existing agents…'
        : targetStatus === 'error' ? 'Some workspaces could not load. Refresh to check for your agent again.'
        : 'No eligible agents are available. In Manage agents, check that your agent is approved and that you can manage its inbox.'}</p>}
      {kind === 'new_agent' ? <div className="onboarding-fields">
        {savedSetup && <p>Using the setup you saved in Envoi. You can edit it before approving.</p>}
        <label className="field"><span>Workspace</span><select value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} required><option value="">Choose a workspace</option>{workspaces.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
        <label className="field"><span>Agent name</span><input value={name} onChange={event => setName(event.target.value)} maxLength={80} required /></label>
        <label className="field"><span>Address name</span><input value={localPart} onChange={event => setLocalPart(event.target.value)} autoCapitalize="none" autoComplete="off" spellCheck={false} minLength={3} maxLength={32} pattern="[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*" aria-invalid={addressTaken || undefined} aria-describedby={addressTaken ? 'saved-setup-address-taken' : undefined} required /></label>
        {addressTaken && <p id="saved-setup-address-taken" className="onboarding-notice" role="status">The saved address is already taken. Choose another address to continue.</p>}
      </div> : <>
        <label className="field"><span>Existing agent</span><select value={agentId} onChange={event => chooseAgent(event.target.value)} required><option value="">Choose an agent</option>{eligible.map(item => <option key={item.id} value={item.id}>{item.name} · {item.address}</option>)}</select></label>
        {agent && <div className="onboarding-replacement">
          <p>The agent keeps its address, cases and history{agent.paused || agent.status === 'paused' ? ', and stays paused until you resume it' : ''}. Activation replaces every active installation; current connections keep working until then.</p>
          {review.installations && review.replacementScope?.agentId === agent.id ? <>
            <p>{current ? 'Newest active installation: ' + current.runtime.type + ' · ' + routeLabel(current.connectionRoute) : 'There is no active installation to replace.'}</p>
            <label><input type="checkbox" checked={review.replacementConfirmed} onChange={event => replacement.confirmReplacement(event.target.checked)} />I reviewed the current connection and confirm this replacement.</label>
          </> : <button className="button secondary" type="button" onClick={() => void replacement.reviewReplacement(agent.inboxId, agent.id)}>Review current installations</button>}
        </div>}
      </>}
    </fieldset>
    <fieldset disabled={locked}><legend>Permissions</legend><p>Choose the permissions to grant. Receiving messages is required.</p>
      {kind === 'existing_agent' && <p>Requested permissions the agent already has are preselected where available.</p>}
      {kind === 'new_agent' && !sendGrantable && savedSetup?.permissions.includes('send_agent_messages') && <p role="status">You selected Send in Envoi. It is unavailable on this approval.</p>}
      <div className="onboarding-permissions">{grantable.map(value => {
        const checked = selectedPermissions.includes(value);
        return <label key={value}>
          <input type="checkbox" checked={checked} disabled={value === 'receive_agent_messages'} onChange={event => setPermissions(previous => event.target.checked ? [...new Set([...previous, value])] : previous.filter(item => item !== value))} />
          <span>{permissionLabel(value)}{value === 'receive_agent_messages' ? ' (required)' : ''}
            {checked && !requested.includes(value) && <small className="consent-unrequested">Your assistant didn’t ask to {permissionLabel(value)}. Approving will grant this permission.</small>}
          </span>
        </label>;
      })}</div>
      {sendGrantable && !selectedPermissions.includes('send_agent_messages') && <p className="onboarding-notice" role="status">Select send agent messages to allow your assistant to send messages and replies.</p>}
    </fieldset>
    <div className="onboarding-actions">{onDeny && <button className="button secondary" type="button" disabled={locked} onClick={onDeny}>Decline connection</button>}
      <button className="button primary" disabled={locked || (kind === 'existing_agent' ? !ready : !canCreate)}>Approve access</button>
    </div>
  </form>;
}
