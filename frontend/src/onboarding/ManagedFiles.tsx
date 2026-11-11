import { FileText, Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { request } from '../api';
import { assetDisplayName } from '../model';
import type { Asset } from '../types';

type Access = 'none' | 'read' | 'edit';
type ManagedFile = { id: string; filename: string; access: Access; revision: number };
type FileInbox = { id: string; name: string; assets: Asset[] };

function AccessChoice({ value, onChange, label }: { value: Access; onChange: (value: Access) => void; label: string }) {
  return <select aria-label={label} value={value} onChange={event => onChange(event.target.value as Access)}>
    <option value="none">No access</option><option value="read">Read only</option><option value="edit">Read and edit</option>
  </select>;
}

async function encodeFile(file: File) {
  if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('Choose a file between 1 byte and 5 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 16384) binary += String.fromCharCode(...bytes.subarray(start, start + 16384));
  return btoa(binary);
}

export function ManagedFiles({ inboxes }: { inboxes: FileInbox[] }) {
  const [inboxId, setInboxId] = useState('');
  const selected = inboxes.find(inbox => inbox.id === inboxId) ?? inboxes[0];
  if (!selected) return null;
  return <div className="managed-files">
    {inboxes.length > 1
      ? <label className="managed-agent"><span>Agent</span>
        <select value={selected.id} onChange={event => setInboxId(event.target.value)}>
          {inboxes.map(inbox => <option key={inbox.id} value={inbox.id}>{inbox.name}</option>)}
        </select>
      </label>
      : <p className="managed-agent-name">{selected.name}</p>}
    <FileAccessEditor key={selected.id} inbox={selected} />
  </div>;
}

function FileAccessEditor({ inbox }: { inbox: FileInbox }) {
  const [files, setFiles] = useState<ManagedFile[] | null>(null);
  const [access, setAccess] = useState<Access>('none');
  const [sourceId, setSourceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [reload, setReload] = useState(0);
  const base = `/api/inboxes/${encodeURIComponent(inbox.id)}/managed-files`;
  useEffect(() => {
    const controller = new AbortController();
    request<ManagedFile[]>(base, { signal: controller.signal }).then(setFiles).catch(caught => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => controller.abort();
  }, [base, reload]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError('');
    try {
      const file = new FormData(form).get('file');
      if (!sourceId && !(file instanceof File && file.size)) throw new Error('Choose an existing file or upload one.');
      const input = sourceId ? { sourceAssetId: sourceId } : {
        filename: (file as File).name, mimeType: (file as File).type, contentBase64: await encodeFile(file as File)
      };
      const created = await request<ManagedFile>(base, { method: 'POST', body: JSON.stringify({ ...input, access }) });
      setFiles(current => [...(current || []), created]);
      setAccess('none');
      setSourceId('');
      setAdding(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }

  async function change(file: ManagedFile, nextAccess: Access) {
    setBusy(true);
    setError('');
    try {
      const updated = await request<ManagedFile>(`${base}/${encodeURIComponent(file.id)}/access`, {
        method: 'PUT', body: JSON.stringify({ access: nextAccess, revision: file.revision })
      });
      setFiles(current => current?.map(item => item.id === file.id ? updated : item) || []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setReload(value => value + 1);
    } finally { setBusy(false); }
  }

  return <>
    {error && <p className="managed-file-error" role="alert">{error}
      {!files && <button className="button tertiary" onClick={() => { setError(''); setReload(value => value + 1); }}>Retry</button>}
    </p>}
    {files ? files.length > 0 ? <ul className="managed-file-list">{files.map(file => <li key={file.id}>
      <FileText size={17} aria-hidden="true" />
      <a href={`${base}/${encodeURIComponent(file.id)}/content`} title={file.filename}>{file.filename}</a>
      <fieldset disabled={busy}><AccessChoice label={`Agent access for ${file.filename}`} value={file.access} onChange={value => void change(file, value)} /></fieldset>
    </li>)}</ul> : <p className="managed-file-empty">No files added for this agent.</p> : !error && <p role="status">Loading files…</p>}
    {files && !adding && <button className="button secondary managed-add-file" disabled={busy} onClick={() => { setError(''); setAdding(true); }}>
      <Plus size={16} /> Add file
    </button>}
    {adding && <form className="managed-file-form" onSubmit={save}>
      <fieldset disabled={busy}>
        {!!inbox.assets.length && <label className="field"><span>File source</span>
          <select value={sourceId} onChange={event => setSourceId(event.target.value)}>
            <option value="">Upload from device</option>
            {inbox.assets.map(asset => <option key={asset.id} value={asset.id}>{assetDisplayName(asset)}</option>)}
          </select>
        </label>}
        {sourceId ? <small>The original keeps its Case sharing.</small> :
          <label className="field"><span>Upload a file</span><input name="file" type="file" required /></label>}
        <label className="field"><span>Agent access</span>
          <AccessChoice value={access} onChange={setAccess} label="Initial agent access" />
        </label>
        <div className="managed-file-actions">
          <button className="button tertiary" type="button" onClick={() => { setAdding(false); setAccess('none'); setSourceId(''); setError(''); }}>Cancel</button>
          <button className="button primary" type="submit">{busy ? 'Saving…' : 'Save file'}</button>
        </div>
      </fieldset>
    </form>}
  </>;
}
