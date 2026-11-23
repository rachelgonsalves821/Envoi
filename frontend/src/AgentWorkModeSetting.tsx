import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { agentWorkMode, isOnDemandAgent, needsDotReceivingSync } from './agent-work-mode';
import { DotReceivingSync, dotReceivingSyncTitle } from './DotReceivingSync';
import { Modal } from './Modal';
import { workModeHelp, WorkModeHelp } from './WorkModeHelp';
import { AgentListeningNotice } from './AgentListeningNotice';
import type { Agent, AgentWorkMode } from './types';
import type { ConnectorRuntime } from '../../sdk/typescript/src/quick-connect';

const options: { value: AgentWorkMode; label: string }[] = [
  { value: 'routine', label: 'Handle routine work, ask me for important decisions' },
  { value: 'ask', label: 'Always ask me first' },
  { value: 'off', label: 'Off (only when I ask)' }
];

export function AgentWorkModeSetting({ agent, inboxId, canManage, onRefresh, onReconnect }: {
  agent: Agent; inboxId: string; canManage: boolean; onRefresh: () => Promise<unknown>;
  onReconnect?: (runtime?: ConnectorRuntime) => void;
}) {
  const [saved, setSaved] = useState<Agent>();
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showSync, setShowSync] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  const current = agent.workMode && saved && (saved.workMode?.updatedAt ?? '') > (agent.workMode.updatedAt ?? '') ? saved : agent;
  const mode = unavailable ? undefined : agentWorkMode(current);
  const listeningAgent = unavailable ? { ...current, workMode: undefined } : current;

  async function save(next: AgentWorkMode) {
    if (active.current || mode === next) return;
    const request = new AbortController();
    active.current = request;
    setBusy(true);
    setError('');
    try {
      const result = await api.setAgentWorkMode(inboxId, agent.id, next, request.signal);
      if (result.id !== agent.id || agentWorkMode(result) !== next) throw new Error('Envoi could not confirm the new setting.');
      if (request.signal.aborted) return;
      setSaved(result);
      setShowSync(mode === 'off' && needsDotReceivingSync(result));
      void onRefresh().catch(() => {});
    } catch (cause) {
      if (request.signal.aborted) return;
      if (cause instanceof ApiError && cause.code === 'FEATURE_DISABLED') setUnavailable(true);
      else setError(cause instanceof Error ? cause.message : 'Could not save the work mode.');
    } finally {
      active.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  }

  return <>
    {mode && canManage && <fieldset className="dots-work-mode agent-work-mode" disabled={busy}>
      <legend>When messages arrive</legend>
      {options.map(option => <div className="work-mode-option" key={option.value}>
        <label>
          <input type="radio" name="agent-work-mode" checked={mode === option.value} value={option.value} onChange={() => void save(option.value)} />
          <span>{option.label}</span>
        </label>
        <WorkModeHelp label={option.label} description={workModeHelp[option.value]} />
      </div>)}
      <p>Pause holds all work until you resume. Off still lets the agent work when you ask.</p>
      {busy && <span role="status">Saving…</span>}
      {error && <p role="alert">{error}</p>}
    </fieldset>}
    {mode === 'off' && <p className="agent-work-mode-status" role="status">Off: {agent.name} {isOnDemandAgent(current) ? 'only works when you ask' : 'only handles your instructions'}</p>}
    {showSync && canManage && needsDotReceivingSync(listeningAgent) && <Modal title={dotReceivingSyncTitle} onClose={() => setShowSync(false)}>
      <DotReceivingSync agent={listeningAgent} showChatGPTLink />
    </Modal>}
    <AgentListeningNotice key={`${mode}:${current.backgroundReceiving?.state}:${current.backgroundReceiving?.endedReason}:${current.connection?.state}`} agent={listeningAgent} inboxId={inboxId} onReconnect={onReconnect} />
  </>;
}
