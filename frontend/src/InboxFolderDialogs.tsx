import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';

export type CreateInboxFolderContentProps = {
  busy: boolean;
  error: string;
  onClose: () => void;
  onCreate: (name: string) => void;
};

export type MoveInboxCaseContentProps = {
  folders: Array<{ id: string; name: string }>;
  currentFolderId: string | null;
  busy: boolean;
  error: string;
  onClose: () => void;
  onMove: (folderId: string | null) => void;
};

function protectSlash(event: KeyboardEvent<HTMLElement>) {
  if (event.key === '/') event.stopPropagation();
}

export function CreateInboxFolderContent({ busy, error, onClose, onCreate }: CreateInboxFolderContentProps) {
  const [name, setName] = useState('');
  const id = useId();
  const folderName = name.trim();
  const canCreate = !busy && folderName.length > 0 && folderName.length <= 80;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canCreate) onCreate(folderName);
  }

  return <form onSubmit={submit} aria-busy={busy}>
    <label className="field" htmlFor={`${id}-name`}>
      <span>Folder name</span>
      <input id={`${id}-name`} name="folderName" value={name} maxLength={80} required autoComplete="off" disabled={busy} onChange={event => setName(event.target.value.slice(0, 80))} onKeyDown={protectSlash} />
    </label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="submit" className="button primary" disabled={!canCreate}>{busy ? 'Creating…' : 'Create folder'}</button>
    </div>
  </form>;
}

export function MoveInboxCaseContent({ folders, currentFolderId, busy, error, onClose, onMove }: MoveInboxCaseContentProps) {
  const [folderId, setFolderId] = useState(currentFolderId ?? '');
  const id = useId();
  const canMove = !busy && (folderId === '' || folders.some(folder => folder.id === folderId));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canMove) onMove(folderId || null);
  }

  return <form onSubmit={submit} aria-busy={busy}>
    <label className="field" htmlFor={`${id}-folder`}>
      <span>Folder</span>
      <select id={`${id}-folder`} name="folderId" value={folderId} disabled={busy} onChange={event => setFolderId(event.target.value)} onKeyDown={protectSlash}>
        <option value="">No folder</option>
        {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
      </select>
    </label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="submit" className="button primary" disabled={!canMove}>{busy ? 'Moving…' : 'Move case'}</button>
    </div>
  </form>;
}
