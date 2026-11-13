import { GrokBotMonitoring, GrokBotSetup } from './GrokBotSetup';
import { GrokBotVerification } from './GrokBotVerification';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Agent } from '../types';
import { agentLabel, connectionLabel } from '../agent-presence';
import { onboardingApi } from './api';
import { InstallationsController } from './claim-state';
import { ClaimProblemNotice, useClaimClock } from './ClaimPage';
import { canReconnectAgent, deliveryLabel, routeLabel, type Installation, type OnboardingApi } from './types';

export interface AgentInstallationsProps {
  humanId: string; inboxId: string; agent: Agent; canManage: boolean; onReconnect?: () => void; onRefresh?: () => void | Promise<void>;
  client?: OnboardingApi; controller?: InstallationsController;
}
const reasonLabels: Record<string, string> = { revoked: 'Revoked', replaced: 'Replaced', refresh_replay: 'Ended after refresh replay', activation_replay: 'Ended after activation replay' };
export function AgentInstallations(props: AgentInstallationsProps) { return <InstallationsSession key={`${props.humanId}:${props.inboxId}:${props.agent.id}:${props.canManage}`} {...props} />; }
function InstallationsSession({ humanId, inboxId, agent, canManage, onReconnect, onRefresh, client = onboardingApi, controller: supplied }: AgentInstallationsProps) {
  const controller = useMemo(() => supplied ?? new InstallationsController(client, inboxId, agent.id), [humanId, inboxId, agent.id, client, supplied]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const now = useClaimClock(controller.now);
  useEffect(() => { if (canManage) void controller.load(); return () => controller.dispose(); }, [controller, canManage]);
  const locked = state.busy || state.blocked || state.retryAt > now;
  if (!canManage) return null;
  return <section className="agent-installations onboarding-panel" aria-label={`Installations for ${agent.name}`}><header className="onboarding-heading"><h3>Runtime installations</h3><button type="button" className="button secondary compact" disabled={locked} onClick={() => void controller.load()}>{state.busy ? 'Checking…' : 'Refresh installations'}</button></header>
    <p>{agentLabel(agent)} · {connectionLabel(agent.connection)}</p><p>Route, delivery and runtime are declared by the host. An active installation can have expired credentials; it does not prove the runtime is running.</p>
    <ClaimProblemNotice problem={state.problem} now={now} />
    {!state.data && !state.problem && <p role="status">Loading installations…</p>}
    {state.data?.length === 0 && <p>No installations are recorded.</p>}
    <div className="onboarding-list">{state.data?.map(installation => <article key={installation.id}><header><h4>{installation.runtime.type}{installation.runtime.version ? ` ${installation.runtime.version}` : ' (version not provided)'}</h4><span>{installation.status === 'active' ? 'Active installation' : reasonLabels[installation.endedReason ?? ''] ?? 'Ended'}</span></header>
      <p>{routeLabel(installation.connectionRoute)} · {deliveryLabel(installation.deliveryMode)}{installation.legacy && ' · Legacy installation'}</p>
      <p>Activated <time dateTime={installation.activatedAt}>{new Date(installation.activatedAt).toLocaleString()}</time>{installation.endedAt && <> · Ended <time dateTime={installation.endedAt}>{new Date(installation.endedAt).toLocaleString()}</time></>}</p>
      {installation.status === 'active' && (confirmId === installation.id ? <div className="onboarding-notice" role="group" aria-label="Confirm installation revocation"><p>Revoke this installation’s access? Its runtime will stop processing Envoi work. The agent’s identity, address, cases and history remain; it can reconnect through a new approved registration.</p><div className="onboarding-actions"><button type="button" className="button secondary compact" disabled={locked} onClick={() => setConfirmId(null)}>Cancel</button><button type="button" className="button danger compact" disabled={locked} onClick={() => void controller.revoke(installation.id).then(success => { if (success) { setConfirmId(null); void onRefresh?.(); } })}>Confirm revoke</button></div></div>
        : <button type="button" className="button secondary compact" disabled={locked} onClick={() => setConfirmId(installation.id)}>Revoke installation</button>)}
      {installation.status === 'active' && installation.connectionRoute === 'remote_mcp_oauth' && <GrokBotMonitoring inboxId={inboxId} agent={agent} installationId={installation.id} onRefresh={onRefresh} />}
    </article>)}</div>
    {state.data?.some(installation => installation.connectionRoute === 'remote_mcp_oauth') && <GrokBotConnection inboxId={inboxId} agent={agent} installations={state.data} onRefresh={async () => { await controller.load(); await onRefresh?.(); }} />}
    {onReconnect && canReconnectAgent(agent) && <><p>To move this identity to another runtime, start a new registration there and choose this existing agent when claiming its code.</p><button type="button" className="button secondary" disabled={locked} onClick={onReconnect}>Reconnect this identity</button></>}
    {agent.onboardingStatus === 'revoked' && <p>This identity is frozen by agent-wide revocation. Use Quick Connect under Advanced to re-onboard it.</p>}
  </section>;
}

function GrokBotConnection({ inboxId, agent, installations, onRefresh }: { inboxId: string; agent: Agent; installations: Installation[]; onRefresh: () => Promise<void> }) {
  const [showSetup, setShowSetup] = useState(false);
  const active = installations.find(installation => installation.connectionRoute === 'remote_mcp_oauth' && installation.status === 'active');
  return <details className="onboarding-panel">
    <summary>Grok Bot setup and verification</summary>
    <p>Use this section if you connect {agent.address} through Grok Bot.</p>
    <p>Receive {agent.permissions.includes('receive_agent_messages') ? 'allowed' : 'required'} · Send {agent.permissions.includes('send_agent_messages') ? 'allowed' : 'required'}</p>
    <button type="button" className="button secondary compact" onClick={() => setShowSetup(!showSetup)}>{showSetup ? 'Hide connection steps' : active ? 'Reconnect Grok Bot' : 'Finish Grok Bot setup'}</button>
    {showSetup && <><GrokBotSetup address={agent.address} /><button type="button" className="button secondary compact" onClick={() => void onRefresh()}>Refresh after approval</button></>}
    {active && <div key={active.id}>
      <GrokBotVerification inboxId={inboxId} agent={agent} />
      <details><summary>Optional background receiving</summary>
        <p>Use Grok Bot monitoring under your active installation to set up the routine and manage its optional webhook.</p>
        <GrokBotVerification inboxId={inboxId} agent={agent} background />
      </details>
    </div>}
  </details>;
}
