import { useId, useState, type KeyboardEvent } from 'react';

export type AgentRemovalDialogProps = {
  agentName: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (deleteHistory: boolean, confirmation: string) => void;
};

export function AgentRemovalDialogContent({ agentName, busy, error, onClose, onConfirm }: AgentRemovalDialogProps) {
  const [deleteHistory, setDeleteHistory] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const id = useId();
  const canConfirm = !busy && (!deleteHistory || confirmation === agentName);
  function protectSlash(event: KeyboardEvent<HTMLElement>) {
    if (event.key === '/') event.stopPropagation();
  }

  return <>
    <p className="dialog-copy">This immediately ends access and removes the agent from your agent list. Using it again requires new onboarding.</p>
    <label className="field" htmlFor={`${id}-history`}>
      <span>Conversation and file history</span>
      <select id={`${id}-history`} value={deleteHistory ? 'delete' : 'keep'} disabled={busy} onChange={event => setDeleteHistory(event.target.value === 'delete')} onKeyDown={protectSlash}>
        <option value="keep">Keep history as a read-only archive</option>
        <option value="delete">Delete my history and files</option>
      </select>
    </label>
    {deleteHistory && <>
      <p id={`${id}-warning`}>This cannot be undone. Other participants’ conversations and their own files remain. Minimal security records and existing backups remain subject to retention.</p>
      <label className="field" htmlFor={`${id}-confirmation`}>
        <span>Type {agentName} to confirm</span>
        <input id={`${id}-confirmation`} value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} onKeyDown={protectSlash} autoComplete="off" spellCheck={false} required aria-describedby={`${id}-warning`} />
      </label>
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="button destructive" disabled={!canConfirm} onClick={() => { if (canConfirm) onConfirm(deleteHistory, confirmation); }}>{busy ? 'Removing…' : 'Remove agent'}</button>
    </div>
  </>;
}
