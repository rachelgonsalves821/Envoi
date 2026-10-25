import { useEffect, useState } from 'react';
import { api, type MonadPermissionEvidence } from './api';

type AgentOption = { id: string; name: string; inboxId: string };

const permissionLabel: Record<MonadPermissionEvidence['permission']['status'], string> = {
  off: 'Monad verification is off',
  not_recorded: 'Current permissions are not recorded yet',
  pending: 'Permission transaction is waiting for finality',
  unavailable: 'Monad verification is temporarily unavailable',
  recorded: 'Current permissions verified on Monad'
};

export function MonadPermissionPanel({ agents }: { agents: AgentOption[] }) {
  const [selection, setSelection] = useState('');
  const [revision, setRevision] = useState(0);
  const [evidence, setEvidence] = useState<MonadPermissionEvidence | null>(null);
  const [error, setError] = useState('');
  const selected = agents.find(agent => `${agent.inboxId}:${agent.id}` === selection) || agents[0];

  useEffect(() => {
    if (!selected) { setEvidence(null); return; }
    const controller = new AbortController();
    setEvidence(null);
    setError('');
    api.monadPermissionEvidence(selected.inboxId, selected.id, controller.signal)
      .then(setEvidence)
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Evidence could not be loaded.'); });
    return () => controller.abort();
  }, [selected?.inboxId, selected?.id, revision]);

  if (!agents.length) return null;
  return <section className="monad-evidence" aria-labelledby="monad-evidence-title">
    <div className="monad-evidence-heading">
      <div><h2 id="monad-evidence-title">Monad permission evidence</h2><p>Envoi checks an agent’s recorded permissions before it acts. Denied attempts appear below.</p></div>
      <button className="button secondary" type="button" onClick={() => setRevision(value => value + 1)}>Refresh</button>
    </div>
    <label htmlFor="monad-agent">Agent</label>
    <select id="monad-agent" value={`${selected.inboxId}:${selected.id}`} onChange={event => setSelection(event.target.value)}>
      {agents.map(agent => <option key={`${agent.inboxId}:${agent.id}`} value={`${agent.inboxId}:${agent.id}`}>{agent.name}</option>)}
    </select>
    {error && <p role="alert">{error}</p>}
    {!error && !evidence && <p role="status">Loading Monad evidence…</p>}
    {evidence && <>
      <div className="monad-evidence-status">
        <strong>{permissionLabel[evidence.permission.status]}</strong>
        {evidence.permission.digest && <code title={evidence.permission.digest}>{evidence.permission.digest}</code>}
        {evidence.permission.explorerUrl && <a href={evidence.permission.explorerUrl} target="_blank" rel="noopener noreferrer">View transaction</a>}
      </div>
      <h3>Denied attempts</h3>
      {!evidence.violations.length && <p>No denied attempts recorded for this agent.</p>}
      {evidence.violations.length > 0 && <ul className="monad-violations">{evidence.violations.map(item => <li key={item.requestId}>
        <div><strong>{item.reasonCode.replaceAll('_', ' ').toLowerCase()}</strong><span>{item.status === 'recorded' ? 'Recorded on Monad' : item.status === 'queued' ? 'Queued for transaction' : 'Waiting for finality'}</span></div>
        <small>{item.method} {item.pathname} · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></small>
        {item.explorerUrl && <a href={item.explorerUrl} target="_blank" rel="noopener noreferrer">View transaction</a>}
      </li>)}</ul>}
    </>}
  </section>;
}
