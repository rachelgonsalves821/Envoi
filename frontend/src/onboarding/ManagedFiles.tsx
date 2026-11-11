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
  const selected = inboxes.find(inbox => inbox.id === inboxId);
  if (!inboxes.length) return null;
  return <section className="recent-files">
    <h2>Agent file access</h2>
    <label className="field"><span>Choose an agent</span>
      <select value={inboxId} onChange={event => setInboxId(event.target.value)}>
        <option value="">Select an agent</option>
        {inboxes.map(inbox => <option key={inbox.id} value={inbox.id}>{inbox.name}</option>)}
      </select>
    </label>
    {selected && <FileAccessEditor key={selected.id} inbox={selected} />}
  </section>;
}

function FileAccessEditor({ inbox }: { inbox: FileInbox }) {
  const [files, setFiles] = useState<ManagedFile[] | null>(null);
  const [access, setAccess] = useState<Access>('none');
  const [sourceId, setSourceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/api/inboxes/${encodeURIComponent(inbox.id)}/managed-files`;
  useEffect(() => {
    const controller = new AbortController();
    request<ManagedFile[]>(base, { signal: controller.signal }).then(setFiles).catch(caught => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => controller.abort();
  }, [base]);

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
      form.reset();
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
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }

  return <>
    <p>Choose the files this agent can use. Each file starts with no access. Copying a Case attachment leaves the original attachment and its sharing in place.</p>
    <form onSubmit={save}>
      <fieldset disabled={busy || !files}>
        {!!inbox.assets.length && <label className="field"><span>Copy an existing file</span>
          <select value={sourceId} onChange={event => setSourceId(event.target.value)}>
            <option value="">Upload a file instead</option>
            {inbox.assets.map(asset => <option key={asset.id} value={asset.id}>{assetDisplayName(asset)}</option>)}
          </select>
        </label>}
        {!sourceId && <label className="field"><span>Upload a file</span><input name="file" type="file" required /></label>}
        <AccessChoice value={access} onChange={setAccess} label="Initial agent access" />
        <button className="button primary" type="submit">{busy ? 'Saving…' : 'Add file'}</button>
      </fieldset>
    </form>
    {error && <p role="alert">{error}</p>}
    {files?.length ? <ul>{files.map(file => <li key={file.id}>
      <a href={`${base}/${encodeURIComponent(file.id)}/content`}>{file.filename}</a>{' '}
      <fieldset disabled={busy}><AccessChoice label={`Agent access for ${file.filename}`} value={file.access} onChange={value => void change(file, value)} /></fieldset>
    </li>)}</ul> : files && <p>No managed files yet.</p>}
  </>;
}
