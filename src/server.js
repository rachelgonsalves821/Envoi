import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { FileStore } from './storage.js';

const port = Number(process.env.SINALOA_PORT || 8787);
const dataDir = process.env.SINALOA_DATA_DIR || path.resolve('data');
const store = new FileStore(dataDir);
const streams = new Map();

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const fail = (res, status, message) => json(res, status, { error: message });
const body = async (req) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('Request body must be valid JSON'); }
};
const idParam = (url, name) => decodeURIComponent(url.pathname.split('/')[url.pathname.split('/').indexOf(name) + 1]);
const publish = (inboxId, event) => {
  for (const res of streams.get(inboxId) || []) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
};
const audit = async (inboxId, type, data) => {
  const event = { id: store.id('evt'), type, createdAt: store.now(), ...data };
  await store.putJson(path.join('inboxes', inboxId, 'events', `${event.id}.json`), event);
  publish(inboxId, event);
  return event;
};

async function listMessages(inboxId, caseId) {
  const items = await store.listJson(path.join('inboxes', inboxId, 'messages'));
  return items.filter((item) => !caseId || item.caseId === caseId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'sinaloa', time: store.now() });

  if (req.method === 'POST' && url.pathname === '/api/inboxes') {
    const input = await body(req);
    const inboxId = store.id('inbox');
    await store.ensureInbox(inboxId);
    const inbox = { id: inboxId, name: input.name || 'Agent workspace', ownerAgentId: input.ownerAgentId || null, createdAt: store.now() };
    await store.putJson(path.join('inboxes', inboxId, 'inbox.json'), inbox);
    await audit(inboxId, 'inbox.created', { inboxId });
    return json(res, 201, inbox);
  }

  const match = url.pathname.match(/^\/api\/inboxes\/([^/]+)(?:\/(.*))?$/);
  if (!match) return fail(res, 404, 'Not found');
  const [, inboxId, suffix = ''] = match;
  const inbox = await store.getJson(path.join('inboxes', inboxId, 'inbox.json'));
  if (!inbox) return fail(res, 404, 'Inbox not found');

  if (req.method === 'GET' && suffix === 'events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: ready\ndata: ${JSON.stringify({ inboxId, at: store.now() })}\n\n`);
    const set = streams.get(inboxId) || new Set(); set.add(res); streams.set(inboxId, set);
    req.on('close', () => { set.delete(res); if (!set.size) streams.delete(inboxId); });
    return;
  }

  if (req.method === 'GET' && suffix === '') return json(res, 200, inbox);

  if (req.method === 'POST' && suffix === 'agents') {
    const input = await body(req);
    if (!input.name) return fail(res, 400, 'Agent name is required');
    const agent = { id: input.id || store.id('agent'), name: input.name, address: input.address || `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${inboxId}@agents.local`, capabilities: input.capabilities || [], createdAt: store.now(), status: 'active' };
    await store.putJson(path.join('inboxes', inboxId, 'agents', `${agent.id}.json`), agent);
    if (!inbox.ownerAgentId) { inbox.ownerAgentId = agent.id; await store.putJson(path.join('inboxes', inboxId, 'inbox.json'), inbox); }
    await audit(inboxId, 'agent.created', { agentId: agent.id });
    return json(res, 201, agent);
  }

  if (req.method === 'GET' && suffix === 'agents') return json(res, 200, await store.listJson(path.join('inboxes', inboxId, 'agents')));

  const blockMatch = suffix.match(/^contacts\/([^/]+)\/(block|unblock)$/);
  if (req.method === 'POST' && blockMatch) {
    const [, agentId, action] = blockMatch;
    const contact = { agentId, blocked: action === 'block', updatedAt: store.now() };
    await store.putJson(path.join('inboxes', inboxId, 'contacts', `${agentId}.json`), contact);
    await audit(inboxId, `contact.${action}ed`, { agentId });
    return json(res, 200, contact);
  }

  if (req.method === 'GET' && suffix === 'cases') return json(res, 200, await store.listJson(path.join('inboxes', inboxId, 'cases')));
  if (req.method === 'GET' && suffix === 'messages') return json(res, 200, await listMessages(inboxId, url.searchParams.get('caseId')));

  if (req.method === 'POST' && suffix === 'messages') {
    const input = await body(req);
    if (!input.senderAgentId || !input.recipientAgentId || !input.text) return fail(res, 400, 'senderAgentId, recipientAgentId, and text are required');
    const sender = await store.getJson(path.join('inboxes', inboxId, 'agents', `${input.senderAgentId}.json`));
    if (!sender) return fail(res, 403, 'Only registered agents may send messages');
    const blocked = await store.getJson(path.join('inboxes', inboxId, 'contacts', `${input.recipientAgentId}.json`));
    if (blocked?.blocked) return fail(res, 403, 'Recipient is blocked');
    const message = { id: input.id || store.id('msg'), inboxId, caseId: input.caseId || store.id('case'), senderAgentId: input.senderAgentId, recipientAgentId: input.recipientAgentId, type: input.type || 'message', text: input.text, payload: input.payload || null, createdAt: store.now(), status: 'received' };
    await store.putJson(path.join('inboxes', inboxId, 'messages', `${message.id}.json`), message);
    const caseRecord = await store.getJson(path.join('inboxes', inboxId, 'cases', `${message.caseId}.json`), { id: message.caseId, inboxId, status: 'active', participantAgentIds: [message.senderAgentId, message.recipientAgentId], createdAt: message.createdAt });
    caseRecord.updatedAt = message.createdAt;
    await store.putJson(path.join('inboxes', inboxId, 'cases', `${message.caseId}.json`), caseRecord);
    await audit(inboxId, 'message.created', { messageId: message.id, caseId: message.caseId, senderAgentId: message.senderAgentId, recipientAgentId: message.recipientAgentId });
    return json(res, 201, message);
  }

  if (req.method === 'POST' && suffix === 'human-messages') {
    const input = await body(req);
    if (!input.humanId || !input.recipientAgentId || !input.text) return fail(res, 400, 'humanId, recipientAgentId, and text are required');
    const recipient = await store.getJson(path.join('inboxes', inboxId, 'agents', `${input.recipientAgentId}.json`));
    if (!recipient) return fail(res, 404, 'Recipient agent not found');
    const blocked = await store.getJson(path.join('inboxes', inboxId, 'contacts', `${input.recipientAgentId}.json`));
    if (blocked?.blocked) return fail(res, 403, 'Recipient is blocked');
    const message = { id: input.id || store.id('msg'), inboxId, caseId: input.caseId || store.id('case'), senderType: 'human', senderHumanId: input.humanId, recipientAgentId: input.recipientAgentId, type: input.type || 'message', text: input.text, payload: input.payload || null, createdAt: store.now(), status: 'received' };
    await store.putJson(path.join('inboxes', inboxId, 'messages', `${message.id}.json`), message);
    const caseRecord = await store.getJson(path.join('inboxes', inboxId, 'cases', `${message.caseId}.json`), { id: message.caseId, inboxId, status: 'active', participantAgentIds: [message.recipientAgentId], participantHumanIds: [message.senderHumanId], createdAt: message.createdAt });
    caseRecord.updatedAt = message.createdAt;
    caseRecord.participantHumanIds = [...new Set([...(caseRecord.participantHumanIds || []), message.senderHumanId])];
    await store.putJson(path.join('inboxes', inboxId, 'cases', `${message.caseId}.json`), caseRecord);
    await audit(inboxId, 'message.created', { messageId: message.id, caseId: message.caseId, senderType: 'human', senderHumanId: message.senderHumanId, recipientAgentId: message.recipientAgentId });
    return json(res, 201, message);
  }

  if (req.method === 'POST' && suffix === 'assets') {
    const input = await body(req);
    if (!input.name || !input.contentBase64 || !input.createdByAgentId) return fail(res, 400, 'name, contentBase64, and createdByAgentId are required');
    if (!await store.getJson(path.join('inboxes', inboxId, 'agents', `${input.createdByAgentId}.json`))) return fail(res, 403, 'Only registered agents may create assets');
    const asset = { id: store.id('asset'), inboxId, caseId: input.caseId || null, name: input.name, mimeType: input.mimeType || 'application/octet-stream', size: Buffer.byteLength(input.contentBase64, 'base64'), createdByAgentId: input.createdByAgentId, createdAt: store.now() };
    await store.putJson(path.join('inboxes', inboxId, 'assets', `${asset.id}.json`), asset);
    await mkdir(path.join(dataDir, 'inboxes', inboxId, 'assets', asset.id), { recursive: true });
    await writeFile(path.join(dataDir, 'inboxes', inboxId, 'assets', asset.id, 'content.bin'), Buffer.from(input.contentBase64, 'base64'));
    await audit(inboxId, 'asset.created', { assetId: asset.id, caseId: asset.caseId, createdByAgentId: asset.createdByAgentId });
    return json(res, 201, asset);
  }

  if (req.method === 'GET' && suffix === 'assets') return json(res, 200, await store.listJson(path.join('inboxes', inboxId, 'assets')));
  const assetMatch = suffix.match(/^assets\/([^/]+)\/content$/);
  if (req.method === 'GET' && assetMatch) {
    const asset = await store.getJson(path.join('inboxes', inboxId, 'assets', `${assetMatch[1]}.json`));
    if (!asset) return fail(res, 404, 'Asset not found');
    res.writeHead(200, { 'content-type': asset.mimeType, 'content-disposition': `inline; filename="${asset.name.replace(/"/g, '')}"` });
    return res.end(await readFile(path.join(dataDir, 'inboxes', inboxId, 'assets', asset.id, 'content.bin')));
  }
  return fail(res, 404, 'Not found');
}

await store.init();
http.createServer((req, res) => route(req, res).catch((error) => fail(res, 500, error.message))).listen(port, () => console.log(`Sinaloa backend listening on http://localhost:${port}`));
