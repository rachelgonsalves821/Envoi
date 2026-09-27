import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { FileStore } from './storage.js';

const host = process.env.SINALOA_HOST || '127.0.0.1';
const port = Number(process.env.SINALOA_PORT || 8787);
const dataDir = process.env.SINALOA_DATA_DIR || path.resolve('data');
const maxBodyBytes = Number(process.env.SINALOA_MAX_BODY_BYTES || 10 * 1024 * 1024);
const corsOrigin = process.env.SINALOA_CORS_ORIGIN || 'http://localhost:3000';
const agentDomain = process.env.SINALOA_AGENT_DOMAIN || 'sinaloa.mail';
const allowedPermissions = new Set(['send_agent_messages', 'receive_agent_messages', 'create_assets', 'execute_cases', 'use_email_transport']);
const store = new FileStore(dataDir);
const streams = new Map();

const applyHeaders = (res, origin) => {
  const origins = corsOrigin.split(',').map((item) => item.trim());
  const allowedOrigin = corsOrigin === '*' ? '*' : origins.includes(origin) ? origin : '';
  if (allowedOrigin) {
    res.setHeader('access-control-allow-origin', allowedOrigin);
    res.setHeader('vary', 'Origin');
  }
  res.setHeader('access-control-allow-headers', 'content-type, authorization, x-request-id');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
};
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const fail = (res, status, message) => json(res, status, { error: message });
const slugify = (value) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const identityKey = (address) => encodeURIComponent(address.toLowerCase());
const reserveIdentity = async (address, value) => {
  const relative = path.join('identities', `${identityKey(address)}.json`);
  if (await store.getJson(relative)) return false;
  await store.putJson(relative, value);
  return true;
};
const hasPermission = (agent, permission) => agent.status === 'active' && agent.onboardingStatus === 'approved' && agent.permissions?.includes(permission);
const body = async (req) => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBodyBytes) {
      const error = new Error(`Request body exceeds ${maxBodyBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
};
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

async function listCases(inboxId) {
  return (await store.listJson(path.join('inboxes', inboxId, 'cases'))).sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
}

async function humanView(inboxId, inbox) {
  const [agents, cases, messages, assets, events] = await Promise.all([
    store.listJson(path.join('inboxes', inboxId, 'agents')),
    listCases(inboxId),
    listMessages(inboxId),
    store.listJson(path.join('inboxes', inboxId, 'assets')),
    store.listJson(path.join('inboxes', inboxId, 'events'))
  ]);
  return {
    inbox,
    mode: 'human-observer',
    capabilities: ['observe_agent_communications', 'receive_agent_messages', 'reply_to_approved_agents', 'review_assets'],
    summary: { agents: agents.length, cases: cases.length, messages: messages.length, assets: assets.length },
    agents,
    cases,
    messages,
    assets,
    recentEvents: events.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100)
  };
}

async function agentView(inboxId, inbox, agentId) {
  const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
  if (!agent) return null;
  const [cases, messages, assets] = await Promise.all([
    listCases(inboxId),
    listMessages(inboxId),
    store.listJson(path.join('inboxes', inboxId, 'assets'))
  ]);
  return {
    inbox,
    mode: 'agent-operator',
    agent,
    capabilities: ['send_agent_messages', 'receive_agent_messages', 'create_assets', 'execute_cases'],
    queue: {
      assignedMessages: messages.filter((item) => item.recipientAgentId === agentId),
      authoredMessages: messages.filter((item) => item.senderAgentId === agentId),
      activeCases: cases.filter((item) => item.status === 'active' && item.participantAgentIds?.includes(agentId)),
      createdAssets: assets.filter((item) => item.createdByAgentId === agentId)
    }
  };
}

async function route(req, res) {
  applyHeaders(res, req.headers.origin || '');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'sinaloa', time: store.now() });

  if (req.method === 'POST' && url.pathname === '/api/onboarding/agent-account') {
    const input = await body(req);
    if (!input.name) return fail(res, 400, 'Agent name is required');
    if (!input.humanId) return fail(res, 400, 'humanId is required so a human can approve the agent');
    const idempotencyKey = input.idempotencyKey || req.headers['idempotency-key'];
    if (idempotencyKey) {
      const previous = await store.getJson(path.join('onboarding', `${encodeURIComponent(idempotencyKey)}.json`));
      if (previous) return json(res, 200, previous);
    }
    const inboxId = store.id('inbox');
    const baseSlug = slugify(input.slug || input.name) || store.id('agent').replace('agent_', '');
    let slug = baseSlug;
    let address = `${slug}@${agentDomain}`;
    while (!(await reserveIdentity(address, { status: 'reserved' }))) {
      slug = `${baseSlug}-${store.id('slug').slice(-6)}`;
      address = `${slug}@${agentDomain}`;
    }
    await store.ensureInbox(inboxId);
    const createdAt = store.now();
    const agent = { id: store.id('agent'), name: input.name, slug, address, identity: { type: 'agent-email', address, domain: agentDomain, status: 'sandbox', transport: 'native' }, principalLabel: input.principalLabel || null, principalHumanId: input.humanId, capabilities: input.capabilities || [], permissions: [], description: input.description || null, createdAt, status: 'pending_approval', onboardingStatus: 'pending_approval' };
    const inbox = { id: inboxId, name: input.inboxName || `${input.name} workspace`, ownerAgentId: agent.id, ownerHumanId: input.humanId, status: 'pending_approval', createdAt };
    await store.putJson(path.join('inboxes', inboxId, 'inbox.json'), inbox);
    await store.putJson(path.join('inboxes', inboxId, 'agents', `${agent.id}.json`), agent);
    await store.putJson(path.join('inboxes', inboxId, 'contacts', `${agent.id}.json`), { agentId: agent.id, approved: true, blocked: false, updatedAt: createdAt });
    const result = { account: { inbox, agent }, next: { nativeMessaging: 'pending_human_approval', humanApproval: { required: true, humanId: input.humanId }, externalEmail: 'requires_email_transport_configuration' } };
    if (idempotencyKey) await store.putJson(path.join('onboarding', `${encodeURIComponent(idempotencyKey)}.json`), result);
    await audit(inboxId, 'agent.account_created', { agentId: agent.id, address: agent.address, identityStatus: agent.identity.status });
    return json(res, 201, result);
  }

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
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`event: ready\ndata: ${JSON.stringify({ inboxId, at: store.now() })}\n\n`);
    const set = streams.get(inboxId) || new Set(); set.add(res); streams.set(inboxId, set);
    req.on('close', () => { set.delete(res); if (!set.size) streams.delete(inboxId); });
    return;
  }

  if (req.method === 'GET' && suffix === '') return json(res, 200, inbox);

  if (req.method === 'GET' && suffix === 'human-view') return json(res, 200, await humanView(inboxId, inbox));

  if (req.method === 'GET' && suffix === 'agent-view') {
    const view = await agentView(inboxId, inbox, url.searchParams.get('agentId'));
    return view ? json(res, 200, view) : fail(res, 404, 'Agent not found');
  }

  if (req.method === 'POST' && suffix === 'agents') {
    const input = await body(req);
    if (!input.name) return fail(res, 400, 'Agent name is required');
    if (!input.humanId) return fail(res, 400, 'humanId is required so a human can approve the agent');
    const slug = slugify(input.slug || input.name) || store.id('agent').replace('agent_', '');
    const address = input.address || `${slug}@${agentDomain}`;
    const existingAgents = await store.listJson(path.join('inboxes', inboxId, 'agents'));
    if (existingAgents.some((item) => item.address === address)) return fail(res, 409, 'Agent email address is already registered in this inbox');
    const agent = { id: input.id || store.id('agent'), name: input.name, slug, address, identity: { type: 'agent-email', address, domain: agentDomain, status: 'sandbox', transport: 'native' }, principalHumanId: input.humanId, capabilities: input.capabilities || [], permissions: [], createdAt: store.now(), status: 'pending_approval', onboardingStatus: 'pending_approval' };
    await store.putJson(path.join('inboxes', inboxId, 'agents', `${agent.id}.json`), agent);
    if (!inbox.ownerAgentId) { inbox.ownerAgentId = agent.id; inbox.ownerHumanId = input.humanId; inbox.status = 'pending_approval'; await store.putJson(path.join('inboxes', inboxId, 'inbox.json'), inbox); }
    await store.putJson(path.join('inboxes', inboxId, 'contacts', `${agent.id}.json`), { agentId: agent.id, approved: true, blocked: false, updatedAt: store.now() });
    await audit(inboxId, 'agent.created', { agentId: agent.id });
    return json(res, 201, agent);
  }

  if (req.method === 'POST' && suffix === 'agent-onboarding') {
    const input = await body(req);
    if (!input.name) return fail(res, 400, 'Agent name is required');
    const slug = slugify(input.slug || input.name);
    if (!slug) return fail(res, 400, 'A valid agent slug is required');
    const address = `${slug}@${agentDomain}`;
    const existingAgents = await store.listJson(path.join('inboxes', inboxId, 'agents'));
    if (existingAgents.some((item) => item.address === address)) return fail(res, 409, 'Agent email address is already registered in this inbox');
    if (!input.humanId) return fail(res, 400, 'humanId is required so a human can approve the agent');
    const agent = { id: store.id('agent'), name: input.name, slug, address, identity: { type: 'agent-email', address, domain: agentDomain, status: 'sandbox', transport: 'native' }, principalLabel: input.principalLabel || null, principalHumanId: input.humanId, capabilities: input.capabilities || [], permissions: [], description: input.description || null, createdAt: store.now(), status: 'pending_approval', onboardingStatus: 'pending_approval' };
    await store.putJson(path.join('inboxes', inboxId, 'agents', `${agent.id}.json`), agent);
    if (!inbox.ownerAgentId) { inbox.ownerAgentId = agent.id; await store.putJson(path.join('inboxes', inboxId, 'inbox.json'), inbox); }
    await store.putJson(path.join('inboxes', inboxId, 'contacts', `${agent.id}.json`), { agentId: agent.id, approved: true, blocked: false, updatedAt: store.now() });
    await audit(inboxId, 'agent.onboarded', { agentId: agent.id, address: agent.address, identityStatus: agent.identity.status });
    return json(res, 201, { agent, next: { nativeMessaging: 'pending_human_approval', humanApproval: { required: true, humanId: input.humanId }, externalEmail: 'requires_email_transport_configuration' } });
  }

  if (req.method === 'GET' && suffix === 'agents') return json(res, 200, await store.listJson(path.join('inboxes', inboxId, 'agents')));

  const blockMatch = suffix.match(/^contacts\/([^/]+)\/(block|unblock)$/);
  if (req.method === 'POST' && blockMatch) {
    const [, agentId, action] = blockMatch;
    const existing = await store.getJson(path.join('inboxes', inboxId, 'contacts', `${agentId}.json`), { agentId, approved: true });
    const contact = { ...existing, agentId, blocked: action === 'block', updatedAt: store.now() };
    await store.putJson(path.join('inboxes', inboxId, 'contacts', `${agentId}.json`), contact);
    await audit(inboxId, `contact.${action}ed`, { agentId });
    return json(res, 200, contact);
  }

  const approveMatch = suffix.match(/^contacts\/([^/]+)\/approve$/);
  if (req.method === 'POST' && approveMatch) {
    const [, agentId] = approveMatch;
    if (!await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`))) return fail(res, 404, 'Agent not found');
    const contact = { agentId, approved: true, blocked: false, updatedAt: store.now() };
    await store.putJson(path.join('inboxes', inboxId, 'contacts', `${agentId}.json`), contact);
    await audit(inboxId, 'contact.approved', { agentId });
    return json(res, 200, contact);
  }

  const onboardingDecision = suffix.match(/^agent-onboarding\/([^/]+)\/(approve|reject)$/);
  if (req.method === 'POST' && onboardingDecision) {
    const [, agentId, decision] = onboardingDecision;
    const input = await body(req);
    const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
    if (!agent) return fail(res, 404, 'Agent not found');
    if (!input.humanId || input.humanId !== (agent.principalHumanId || inbox.ownerHumanId)) return fail(res, 403, 'Only the linked human may approve this agent');
    if (decision === 'reject') {
      agent.status = 'rejected';
      agent.onboardingStatus = 'rejected';
      agent.permissions = [];
    } else {
      const permissions = Array.isArray(input.permissions) ? input.permissions.filter((permission) => allowedPermissions.has(permission)) : ['send_agent_messages', 'receive_agent_messages'];
      if (!permissions.includes('receive_agent_messages')) permissions.push('receive_agent_messages');
      agent.status = 'active';
      agent.onboardingStatus = 'approved';
      agent.permissions = permissions;
      inbox.status = 'active';
      await store.putJson(path.join('inboxes', inboxId, 'inbox.json'), inbox);
    }
    agent.approvedAt = store.now();
    agent.approvedByHumanId = input.humanId;
    await store.putJson(path.join('inboxes', inboxId, 'agents', `${agent.id}.json`), agent);
    await audit(inboxId, `agent.onboarding_${decision}ed`, { agentId: agent.id, humanId: input.humanId, permissions: agent.permissions });
    return json(res, 200, agent);
  }

  if (req.method === 'GET' && suffix === 'cases') return json(res, 200, await listCases(inboxId));
  if (req.method === 'GET' && suffix === 'messages') return json(res, 200, await listMessages(inboxId, url.searchParams.get('caseId')));

  if (req.method === 'POST' && suffix === 'messages') {
    const input = await body(req);
    if (!input.senderAgentId || !input.recipientAgentId || !input.text) return fail(res, 400, 'senderAgentId, recipientAgentId, and text are required');
    const sender = await store.getJson(path.join('inboxes', inboxId, 'agents', `${input.senderAgentId}.json`));
    if (!sender) return fail(res, 403, 'Only registered agents may send messages');
    if (!hasPermission(sender, 'send_agent_messages')) return fail(res, 403, 'Agent is pending approval or lacks send_agent_messages permission');
    const blocked = await store.getJson(path.join('inboxes', inboxId, 'contacts', `${input.recipientAgentId}.json`));
    if (blocked?.blocked) return fail(res, 403, 'Recipient is blocked');
    const message = { id: input.id || store.id('msg'), inboxId, caseId: input.caseId || store.id('case'), senderType: 'agent', senderAgentId: input.senderAgentId, recipientAgentId: input.recipientAgentId, type: input.type || 'message', text: input.text, payload: input.payload || null, createdAt: store.now(), status: 'received' };
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
    if (!hasPermission(recipient, 'receive_agent_messages')) return fail(res, 403, 'Recipient agent is not approved to receive messages');
    const contact = await store.getJson(path.join('inboxes', inboxId, 'contacts', `${input.recipientAgentId}.json`), { approved: true, blocked: false });
    if (contact.blocked) return fail(res, 403, 'Recipient is blocked');
    if (contact.approved === false) return fail(res, 403, 'Recipient is not an approved human contact');
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
    const assetAgent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${input.createdByAgentId}.json`));
    if (!assetAgent || !hasPermission(assetAgent, 'create_assets')) return fail(res, 403, 'Agent is pending approval or lacks create_assets permission');
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
const server = http.createServer((req, res) => route(req, res).catch((error) => fail(res, error.statusCode || 500, error.message)));
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.listen(port, host, () => console.log(`Sinaloa backend listening on http://${host}:${port}`));

const shutdown = () => {
  for (const set of streams.values()) for (const res of set) res.end();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
