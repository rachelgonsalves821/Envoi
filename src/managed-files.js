import crypto from 'node:crypto';
import path from 'node:path';

const fileLimit = 5 * 1024 * 1024;
const accessLevels = new Set(['none', 'read', 'edit']);
const fileError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const notFound = () => fileError(404, 'File not found');

export function createManagedFiles({ store, objectStorage, adapter, auth, canManageInbox,
  getAgentPrincipal, withInboxMutation, body, json, objectMetadataPath }) {
  return async function managedFiles(req, res, inbox, suffix) {
    const route = /^managed-files(?:\/(file_[a-f0-9-]+)(?:\/(content|data|access))?)?$/.exec(suffix);
    if (!route) return false;
    const [, id, action] = route;
    const directory = path.join('inboxes', inbox.id, 'managed-files');
    const filePath = id ? path.join(directory, `${id}.json`) : null;
    const owner = async () => {
      const human = await auth.getHuman(req);
      return await canManageInbox(human, inbox, { maxAgeMs: 0 }) ? human : null;
    };
    const agent = async () => {
      const principal = await getAgentPrincipal(req, inbox.id);
      return principal && principal.id === inbox.ownerAgentId && principal.status === 'active' ? principal : null;
    };
    const canRead = (file, manager, principal) => Boolean(file && (manager ||
      principal && file.agentId === principal.id && ['read', 'edit'].includes(file.access)));
    const canEdit = (file, principal) => Boolean(file && principal && file.agentId === principal.id && file.access === 'edit');
    const summary = ({ id, filename, mimeType, size, revision, access, updatedAt }) =>
      ({ id, filename, mimeType, size, revision, access, updatedAt });
    const manager = await owner();
    const principal = manager ? null : await agent();
    const file = filePath ? await store.getJson(filePath) : null;

    if (req.method === 'GET' && !id) {
      if (!manager && !principal) throw notFound();
      const files = await store.listJson(directory);
      json(res, 200, files.filter(item => canRead(item, manager, principal)).map(summary));
      return true;
    }

    if (req.method === 'GET' && ['content', 'data'].includes(action)) {
      if (!canRead(file, manager, principal)) throw notFound();
      const { bytes } = await objectStorage.readCleanObject(file.objectId);
      const current = await store.getJson(filePath);
      if (!canRead(current, manager ? await owner() : null, principal ? await agent() : null)
          || current.revision !== file.revision) throw notFound();
      if (action === 'data') {
        json(res, 200, { ...summary(file), contentBase64: bytes.toString('base64') });
        return true;
      }
      res.writeHead(200, { 'content-type': file.mimeType, 'content-length': String(bytes.length),
        'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': `attachment; filename="${file.filename.replace(/[^\x20-\x7e]|["\\]/g, '_')}"` });
      res.end(bytes);
      return true;
    }

    if (req.method === 'PUT' && action === 'access') {
      if (!manager || !file) throw notFound();
      const { access, revision } = await body(req, 4096);
      if (!accessLevels.has(access)) throw fileError(400, 'Choose no access, read, or edit');
      const result = await withInboxMutation(inbox.id, async audit => {
        const human = await owner();
        if (!human) throw notFound();
        const current = await store.getJson(filePath);
        if (!current || current.revision !== revision) throw fileError(409, 'File changed. Reload before changing access.');
        if (current.access === access) return current;
        const updated = { ...current, access, revision: current.revision + 1, updatedAt: store.now() };
        await store.putJson(filePath, updated);
        await audit('managed_file.access_changed', { fileId: id, agentId: current.agentId, humanId: human.id, access });
        return updated;
      });
      json(res, 200, summary(result));
      return true;
    }

    const creating = req.method === 'POST' && !id;
    const editing = req.method === 'PUT' && action === 'content';
    if (!creating && !editing) throw notFound();
    if (creating && (!manager || !inbox.ownerAgentId)) throw notFound();
    if (editing && !canRead(file, manager, principal)) throw notFound();
    if (editing && !manager && !canEdit(file, principal)) throw fileError(403, 'File is read-only');
    const input = await body(req, Math.ceil(fileLimit / 3) * 4 + 4096);
    if (editing && input.revision !== file.revision) throw fileError(409, 'File changed. Reload before editing.');

    let filename = file?.filename || input.filename;
    let mimeType = file?.mimeType || input.mimeType || 'application/octet-stream';
    let bytes;
    if (creating && input.sourceAssetId !== undefined) {
      if (typeof input.sourceAssetId !== 'string' || !/^obj_[a-f0-9-]+$/.test(input.sourceAssetId)) throw notFound();
      const source = await store.getJson(objectMetadataPath(input.sourceAssetId));
      if (source?.workspaceId !== inbox.id || source.managedFile || source.state !== 'clean') throw notFound();
      if (source.size > fileLimit) throw fileError(413, 'Managed files must be 5 MB or smaller');
      ({ bytes } = await objectStorage.readCleanObject(source.id));
      ({ filename, mimeType } = source);
    } else {
      if (typeof input.contentBase64 !== 'string') throw fileError(400, 'File content is required');
      bytes = Buffer.from(input.contentBase64, 'base64');
      if (bytes.toString('base64') !== input.contentBase64) throw fileError(400, 'Invalid file content encoding');
    }
    if (!bytes.length || bytes.length > fileLimit) throw fileError(400, 'File must contain between 1 byte and 5 MB');
    if (creating && !accessLevels.has(input.access)) throw fileError(400, 'Choose no access, read, or edit');
    const checksumSha256 = crypto.createHash('sha256').update(bytes).digest('base64');
    const candidate = await objectStorage.beginUpload({ workspaceId: inbox.id, filename, mimeType, size: bytes.length,
      checksumSha256, managedFile: true });
    let published = false;
    try {
      if (typeof adapter.putObject === 'function') {
        await adapter.putObject({ key: candidate.object.key, body: bytes, contentType: mimeType, checksumSha256 });
      } else {
        const put = await fetch(candidate.upload.url, { method: 'PUT', headers: candidate.upload.headers,
          body: bytes, redirect: 'error', signal: AbortSignal.timeout(30000) });
        if (!put.ok) throw fileError(502, 'File storage rejected the upload');
      }
      const clean = await objectStorage.scanObject(candidate.object.id);
      if (clean.state !== 'clean') throw fileError(422, 'File did not pass malware scanning');
      const result = await withInboxMutation(inbox.id, async audit => {
        const human = manager ? await owner() : null;
        const actor = principal ? await agent() : null;
        const current = filePath ? await store.getJson(filePath) : null;
        if (creating ? !human : !human && !canEdit(current, actor)) throw notFound();
        if (editing && current?.revision !== file.revision) throw fileError(409, 'File changed. Reload before editing.');
        const saved = { id: id || store.id('file'), agentId: inbox.ownerAgentId, filename, mimeType,
          access: current?.access || input.access, objectId: clean.id, size: clean.size,
          revision: (current?.revision || 0) + 1, updatedAt: store.now() };
        await store.putJson(path.join(directory, `${saved.id}.json`), saved);
        await audit(creating ? 'managed_file.created' : 'managed_file.edited', {
          fileId: saved.id, agentId: actor?.id || saved.agentId, humanId: human?.id, revision: saved.revision,
          ...(creating ? { access: saved.access } : {})
        });
        return saved;
      });
      published = true;
      if (file) await objectStorage.requestRemoval(file.objectId).catch(() => {});
      json(res, creating ? 201 : 200, summary(result));
      return true;
    } finally {
      if (!published) await objectStorage.requestRemoval(candidate.object.id).catch(() => {});
    }
  };
}
