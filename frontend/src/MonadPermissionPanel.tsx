import { useEffect, useState } from 'react';
import { api, type MonadPermissionEvidence, type MonadSettings } from './api';

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
  const [settings, setSettings] = useState<MonadSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const selected = agents.find(agent => `${agent.inboxId}:${agent.id}` === selection) || agents[0];

  useEffect(() => {
    if (!selected) { setEvidence(null); setSettings(null); return; }
    const controller = new AbortController();
    setEvidence(null);
    setSettings(null);
    setError('');
    api.monadSettings(selected.inboxId, controller.signal)
      .then(async value => {
        setSettings(value);
        if (value.enabled) setEvidence(await api.monadPermissionEvidence(selected.inboxId, selected.id, controller.signal));
      })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Evidence could not be loaded.'); });
    return () => controller.abort();
  }, [selected?.inboxId, selected?.id, revision]);

  if (!agents.length) return null;
  const toggle = async () => {
    if (!selected || !settings || saving) return;
    setSaving(true);
    setError('');
    try {
      const updated = await api.updateMonadSettings(selected.inboxId, !settings.enabled);
      setSettings(updated);
      setRevision(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Monad setting could not be changed.'); }
    finally { setSaving(false); }
  };
  return <section className="monad-evidence" aria-labelledby="monad-evidence-title">
    <div className="monad-evidence-heading">
      <div><h2 id="monad-evidence-title">Monad permission verification</h2><p>Optional on-chain evidence for agent permissions and denied attempts.</p></div>
      {settings?.enabled && <button className="button secondary" type="button" onClick={() => setRevision(value => value + 1)}>Refresh</button>}
    </div>
    <label htmlFor="monad-agent">Agent</label>
    <select id="monad-agent" value={`${selected.inboxId}:${selected.id}`} onChange={event => setSelection(event.target.value)}>
      {agents.map(agent => <option key={`${agent.inboxId}:${agent.id}`} value={`${agent.inboxId}:${agent.id}`}>{agent.name}</option>)}
    </select>
    {settings?.entitled && settings.available && <label className="monad-toggle"><input type="checkbox" checked={settings.enabled} disabled={saving} onChange={() => void toggle()} /> Verify this agent’s permissions on Monad</label>}
    {settings && !settings.entitled && <p>Monad verification is a paid add-on. Contact Envoi to enable it for your organization.</p>}
    {settings?.entitled && !settings.available && <p>Monad verification is not configured for this deployment.</p>}
    {settings && !settings.enabled && <p>Monad is off for this agent. Standard Envoi permissions remain active.</p>}
    {error && <p role="alert">{error}</p>}
    {!error && !settings && <p role="status">Loading Monad settings…</p>}
    {settings?.enabled && !error && !evidence && <p role="status">Loading Monad evidence…</p>}
    {settings?.enabled && evidence && <>
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
