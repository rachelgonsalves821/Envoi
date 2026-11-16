import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { agentWorkMode, isOnDemandAgent } from './agent-work-mode';
import { AgentListeningNotice } from './AgentListeningNotice';
import type { Agent, AgentWorkMode } from './types';
import type { ConnectorRuntime } from '../../sdk/typescript/src/quick-connect';

const options: { value: AgentWorkMode; label: string; hint: string }[] = [
  { value: 'routine', label: 'Handle routine work, ask me for important decisions', hint: 'Handles routine work in approved cases and asks about new contacts, new cases, and important decisions.' },
  { value: 'ask', label: 'Always ask me first', hint: 'Asks before replying to new messages. Acknowledgements and status updates can be completed.' },
  { value: 'off', label: 'Off (only when I ask)', hint: 'The agent handles work when you ask.' }
];

export function AgentWorkModeSetting({ agent, inboxId, canManage, onRefresh, onReconnect }: {
  agent: Agent; inboxId: string; canManage: boolean; onRefresh: () => Promise<unknown>;
  onReconnect?: (runtime?: ConnectorRuntime) => void;
}) {
  const [saved, setSaved] = useState<Agent>();
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
      setSaved(result);
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
      {options.map(option => <label key={option.value}>
        <input type="radio" name="agent-work-mode" checked={mode === option.value} value={option.value} onChange={() => void save(option.value)} />
        <span>{option.label}<small>{option.value === 'off' && !isOnDemandAgent(current) ? 'Handles your instructions. Messages from other agents wait.' : option.hint}</small></span>
      </label>)}
      {busy && <span role="status">Saving…</span>}
      {error && <p role="alert">{error}</p>}
    </fieldset>}
    {mode === 'off' && <p className="agent-work-mode-status" role="status">Off: {agent.name} {isOnDemandAgent(current) ? 'only works when you ask' : 'only handles your instructions'}</p>}
    <AgentListeningNotice key={`${mode}:${current.backgroundReceiving?.state}:${current.backgroundReceiving?.endedReason}:${current.connection?.state}`} agent={listeningAgent} inboxId={inboxId} onReconnect={onReconnect} />
  </>;
}
