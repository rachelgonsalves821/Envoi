import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { FileStore } from './storage.js';
import { createHumanAuth } from './human-auth.js';
import { sessionCookieHeader } from './workos-auth.js';
import {
  acceptProposal,
  addPolicyEvaluation,
  addProposal,
  appendEvent,
  applyAgentAction,
  applyHumanAction,
  completeCase,
  counterProposal,
  createCase as createAgentCase,
  transitionCase
} from './agent-interface.js';
import { projectWorkspaceForHuman } from './human-projection.js';

const host = process.env.SINALOA_HOST || '127.0.0.1';
const port = Number(process.env.SINALOA_PORT || 8787);
const dataDir = process.env.SINALOA_DATA_DIR || path.resolve('data');
const maxBodyBytes = Number(process.env.SINALOA_MAX_BODY_BYTES || 10 * 1024 * 1024);
const corsOrigin = process.env.SINALOA_CORS_ORIGIN || 'http://localhost:3000';
const agentDomain = process.env.SINALOA_AGENT_DOMAIN || 'sinaloa.mail';
const allowedPermissions = new Set(['send_agent_messages', 'receive_agent_messages', 'create_assets', 'execute_cases', 'use_email_transport']);
const actionPermission = actionKey => actionKey.startsWith('message.') ? 'send_agent_messages' : actionKey.startsWith('email.') ? 'use_email_transport' : 'execute_cases';
const store = process.env.DATABASE_URL ? new (await import('./postgres-storage.js')).PostgresStore(process.env.DATABASE_URL) : new FileStore(dataDir);
const auth = createHumanAuth(store);
const streams = new Map();

const applyHeaders = (res, origin) => {
  const origins = corsOrigin.split(',').map((item) => item.trim());
  const allowedOrigin = corsOrigin === '*' ? '*' : origins.includes(origin) ? origin : '';
  if (allowedOrigin) {
    res.setHeader('access-control-allow-origin', allowedOrigin);
    res.setHeader('vary', 'Origin');
    if (allowedOrigin !== '*') res.setHeader('access-control-allow-credentials', 'true');
  }
  res.setHeader('access-control-allow-headers', 'content-type, authorization, idempotency-key, x-request-id');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
};
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const redirect = (res, location, headers = {}) => { res.writeHead(302, { location, 'cache-control': 'no-store', ...headers }); res.end(); };
const fail = (res, status, message) => json(res, status, { error: message });
const slugify = (value) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const identityKey = (address) => encodeURIComponent(address.toLowerCase());
const reserveIdentity = async (address, value) => {
  const relative = path.join('identities', `${identityKey(address)}.json`);
  return store.putJsonIfAbsent(relative, value);
};
const hasPermission = (agent, permission) => agent.status === 'active' && agent.onboardingStatus === 'approved' && agent.permissions?.includes(permission);
const hashSecret = value => crypto.createHash('sha256').update(value).digest('hex');
const publicAgent = agent => { const value = { ...agent }; delete value.credentialHash; return value; };
const bearerToken = req => (req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const getAgentPrincipal = async (req, inboxId) => {
  const raw = bearerToken(req);
  if (!raw) return null;
  const credentialHash = hashSecret(raw);
  const index = await store.getJson(path.join('auth', 'agent-credentials', `${credentialHash}.json`));
  if (!index || index.inboxId !== inboxId) return null;
  return store.getJson(path.join('inboxes', inboxId, 'agents', `${index.agentId}.json`));
};
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

async function getMembership(organizationId, humanId) {
  if (!organizationId || !humanId) return null;
  const membership = await store.getJson(path.join('organizations', organizationId, 'members', `${humanId}.json`));
  return membership?.status === 'active' ? membership : null;
}

async function canAccessInbox(human, inbox) {
  return Boolean(human && (human.id === inbox.ownerHumanId || await getMembership(inbox.organizationId, human.id)));
}

async function canManageInbox(human, inbox) {
  if (!human) return false;
  if (human.id === inbox.ownerHumanId) return true;
  const membership = await getMembership(inbox.organizationId, human.id);
  return Boolean(membership && ['owner', 'admin'].includes(membership.role));
}

async function listHumanOrganizations(humanId) {
  const references = await store.listJson(path.join('humans', humanId, 'organizations'));
  const organizations = await Promise.all(references.map(reference => store.getJson(path.join('organizations', reference.organizationId, 'organization.json'))));
  return organizations.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

async function createOrganization(human, input = {}, idempotencyKey) {
  const name = String(input.name || '').trim();
  if (!name) throw Object.assign(new Error('Organization name is required'), { statusCode: 400 });
  if (idempotencyKey) {
    const existing = await store.getJson(path.join('idempotency', 'organizations', `${encodeURIComponent(`${human.id}:${idempotencyKey}`)}.json`));
    if (existing) return existing;
  }
  const organizationId = store.id('org');
  let providerOrganization = null;
  if (auth.provider === 'workos') {
    providerOrganization = await auth.createProviderOrganization({
      name,
      externalId: organizationId,
      idempotencyKey: idempotencyKey || organizationId,
      userId: human.providerUserId
    });
  }
  const organization = {
    id: organizationId,
    name,
    slug: slugify(name) || organizationId.slice(-8),
    ownerHumanId: human.id,
    workosOrganizationId: providerOrganization?.id || null,
    status: 'active',
    createdAt: store.now(),
    updatedAt: store.now()
  };
  const membership = { organizationId, humanId: human.id, role: 'owner', status: 'active', createdAt: organization.createdAt };
  await Promise.all([
    store.putJson(path.join('organizations', organizationId, 'organization.json'), organization),
    store.putJson(path.join('organizations', organizationId, 'members', `${human.id}.json`), membership),
    store.putJson(path.join('humans', human.id, 'organizations', `${organizationId}.json`), { organizationId, role: 'owner' }),
    ...(providerOrganization ? [store.putJson(path.join('auth', 'workos-organization-index', `${encodeURIComponent(providerOrganization.id)}.json`), { organizationId })] : [])
  ]);
  if (idempotencyKey) await store.putJson(path.join('idempotency', 'organizations', `${encodeURIComponent(`${human.id}:${idempotencyKey}`)}.json`), organization);
  return organization;
}

async function ensureOrganization(human, requestedId) {
  if (requestedId) {
    const organization = await store.getJson(path.join('organizations', requestedId, 'organization.json'));
    if (!organization || !await getMembership(requestedId, human.id)) throw Object.assign(new Error('Active organization membership required'), { statusCode: 403 });
    return organization;
  }
  const [existing] = await listHumanOrganizations(human.id);
  return existing || createOrganization(human, { name: `${human.displayName || 'My'} workspace` }, `personal-${human.id}`);
}

async function listMessages(inboxId, caseId, { limit = 100, before = null } = {}) {
  return store.queryJson(path.join('inboxes', inboxId, 'messages'), { limit, before, filters: caseId ? { caseId } : {}, sortField: 'createdAt' });
}

async function listCases(inboxId, { limit = 100, before = null } = {}) {
  return store.queryJson(path.join('inboxes', inboxId, 'cases'), { limit, before, sortField: 'updatedAt' });
}

const caseRecordPath = (inboxId, caseId) => path.join('inboxes', inboxId, 'cases', `${caseId}.json`);
const saveCase = (inboxId, value) => store.putJson(caseRecordPath(inboxId, value.id), value);
const getCase = (inboxId, caseId) => store.getJson(caseRecordPath(inboxId, caseId));

function proposalFromInput(input, now) {
  const options = Array.isArray(input.options) ? input.options.map(item => ({
    id: item.id || store.id('option'),
    value: item.value && typeof item.value === 'object' ? item.value : {},
    sourceConfidence: item.sourceConfidence || 'enteredForCase',
    expired: Boolean(item.expired),
    outOfPolicyFlags: Array.isArray(item.outOfPolicyFlags) ? [...new Set(item.outOfPolicyFlags)] : []
  })) : [];
  if (!options.length) throw Object.assign(new Error('At least one structured proposal option is required'), { statusCode: 400 });
  return { id: input.id || store.id('proposal'), kind: input.kind, options, status: 'open', acceptedOptionId: null, expiresAt: input.expiresAt || null, createdAt: now, updatedAt: now };
}

function policyEvaluationFromInput(input, actor, now) {
  return {
    id: input.id || store.id('policy_eval'),
    requestedAction: input.requestedAction,
    actor,
    matchedPolicyId: input.matchedPolicyId || null,
    decision: input.decision,
    grantType: input.grantType || 'oneTime',
    effectiveAt: now,
    expiresAt: input.expiresAt || null,
    reasonCode: input.reasonCode
  };
}

async function ensureStructuredCase(inbox, input, actorAgentId, at) {
  const caseId = input.caseId || store.id('case');
  const existing = await getCase(inbox.id, caseId);
  if (existing?.schemaVersion) return existing;
  let value = createAgentCase({
    id: caseId,
    objective: input.objective || input.text?.slice(0, 160) || 'Agent communication',
    principal: inbox.ownerHumanId,
    actingAgent: actorAgentId,
    participants: [actorAgentId, input.recipientAgentId].filter(Boolean),
    constraints: input.constraints || {},
    deadline: input.deadline || null,
    createdAt: existing?.createdAt || at
  });
  value = transitionCase(value, 'inProgress', { actor: actorAgentId, at, reasonCode: existing ? 'legacyCaseMigrated' : 'caseStarted' });
  return value;
}

async function participantDirectoryForHuman(inbox, agents, cases) {
  const localAgents = new Map(agents.map(agent => [agent.id, agent]));
  const ids = new Set();
  for (const value of cases) {
    [value.actingAgent, value.principal, ...(value.participants || [])].filter(Boolean).forEach(id => ids.add(id));
    for (const event of value.events || []) {
      [event.actor, event.payload?.senderAgentId, event.payload?.recipientAgentId, event.payload?.senderHumanId]
        .filter(Boolean)
        .forEach(id => ids.add(id));
    }
  }
  const entries = await Promise.all([...ids].slice(0, 500).map(async id => {
    const local = localAgents.get(id);
    if (local) return [id, { id, type: 'internalAgent', displayName: local.name, address: local.address, organizationId: local.organizationId || inbox.organizationId, inboxId: inbox.id, accessState: local.status === 'active' ? 'active' : 'unavailable' }];
    if (id === inbox.ownerHumanId || String(id).startsWith('human_')) return [id, { id, type: 'human', displayName: id === inbox.ownerHumanId ? 'Human principal' : 'Human participant', address: null, organizationId: inbox.organizationId, inboxId: inbox.id, accessState: 'active' }];
    const directory = await store.getJson(path.join('directory', 'agents', `${id}.json`));
    if (!directory) return [id, { id, type: 'externalAgent', displayName: String(id), address: null, organizationId: null, inboxId: null, accessState: 'unavailable' }];
    const external = await store.getJson(path.join('inboxes', directory.inboxId, 'agents', `${id}.json`));
    return [id, { id, type: directory.inboxId === inbox.id ? 'internalAgent' : 'externalAgent', displayName: external?.name || directory.address || String(id), address: external?.address || directory.address || null, organizationId: external?.organizationId || null, inboxId: directory.inboxId, accessState: directory.status === 'active' ? 'active' : 'unavailable' }];
  }));
  return Object.fromEntries(entries);
}

async function humanView(inboxId, inbox) {
  const [agents, cases, messages, assets, events] = await Promise.all([
    store.listJson(path.join('inboxes', inboxId, 'agents')),
    listCases(inboxId),
    listMessages(inboxId),
    store.listJson(path.join('inboxes', inboxId, 'assets')),
    store.listJson(path.join('inboxes', inboxId, 'events'))
  ]);
  const projection = projectWorkspaceForHuman(cases);
  const participantDirectory = await participantDirectoryForHuman(inbox, agents, cases);
  return {
    inbox,
    mode: 'human-observer',
    capabilities: ['observe_agent_communications', 'receive_agent_messages', 'reply_to_approved_agents', 'review_assets'],
    summary: { agents: agents.length, cases: cases.length, messages: messages.length, assets: assets.length, needsMe: projection.counts.needsMe },
    navigation: projection.counts,
    caseQueue: projection.cases,
    participantDirectory,
    agents: agents.map(publicAgent),
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
    agent: publicAgent(agent),
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
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/web/'))) {
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice('/web/'.length);
    const safePath = path.normalize(relative).replace(/^\.\.[\\/]/, '');
    const filePath = path.resolve('web', safePath);
    if (!filePath.startsWith(path.resolve('web'))) return fail(res, 400, 'Invalid asset path');
    const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
    try { res.writeHead(200, { 'content-type': contentTypes[path.extname(filePath)] || 'application/octet-stream' }); return res.end(await readFile(filePath)); }
    catch (error) { if (error.code === 'ENOENT') return fail(res, 404, 'Web asset not found'); throw error; }
  }
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'sinaloa', time: store.now() });

  if (req.method === 'GET' && url.pathname === '/api/auth/config') return json(res, 200, auth.config());

  if (req.method === 'GET' && ['/api/auth/workos/sign-in', '/api/auth/workos/sign-up'].includes(url.pathname)) {
    if (auth.provider !== 'workos') return fail(res, 404, 'Hosted authentication is not enabled');
    const authorization = await auth.startAuthorization({
      screenHint: url.pathname.endsWith('sign-up') ? 'sign-up' : 'sign-in',
      returnTo: url.searchParams.get('returnTo') || '/'
    });
    return redirect(res, authorization.url);
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/workos/callback') {
    if (auth.provider !== 'workos') return fail(res, 404, 'Hosted authentication is not enabled');
    if (url.searchParams.get('error')) return redirect(res, `/?auth_error=${encodeURIComponent(url.searchParams.get('error_description') || url.searchParams.get('error'))}`);
    const result = await auth.completeAuthorization({
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'] || ''
    });
    return redirect(res, result.returnTo, { 'set-cookie': sessionCookieHeader(result.sealedSession) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/phone/start') {
    if (auth.provider !== 'local') return fail(res, 404, 'Phone authentication is managed by WorkOS');
    const input = await body(req);
    return json(res, 201, await auth.startPhoneVerification(input.phoneNumber, input.displayName));
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/phone/verify') {
    if (auth.provider !== 'local') return fail(res, 404, 'Phone authentication is managed by WorkOS');
    const input = await body(req);
    if (!input.challengeId || !input.code) return fail(res, 400, 'challengeId and code are required');
    return json(res, 200, await auth.verifyPhone(input.challengeId, input.code));
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const human = await auth.getHuman(req, { requireMfa: false });
    if (!human) return fail(res, 401, 'Authenticated human session required');
    const session = await auth.getSession(req);
    return json(res, 200, { ...human, auth: { provider: auth.provider, assurance: session?.assurance || 'provider' } });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/totp/setup') {
    if (auth.provider !== 'local') return fail(res, 404, 'Second-factor authentication is managed by WorkOS');
    return json(res, 201, await auth.startTotp(req));
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/totp/verify') {
    if (auth.provider !== 'local') return fail(res, 404, 'Second-factor authentication is managed by WorkOS');
    const input = await body(req);
    if (!input.code) return fail(res, 400, 'Authenticator code is required');
    return json(res, 200, await auth.verifyTotp(req, input.code));
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const result = await auth.logout(req);
    const revoked = typeof result === 'boolean' ? result : result.revoked;
    if (!revoked) return fail(res, 401, 'Authenticated session required');
    if (auth.provider === 'workos') res.setHeader('set-cookie', sessionCookieHeader('', { clear: true }));
    return json(res, 200, typeof result === 'boolean' ? { revoked: true } : result);
  }

  if (url.pathname === '/api/organizations' && req.method === 'GET') {
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Authenticated human session required');
    return json(res, 200, await listHumanOrganizations(human.id));
  }

  if (url.pathname === '/api/organizations' && req.method === 'POST') {
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Authenticated human session required');
    const input = await body(req);
    return json(res, 201, await createOrganization(human, input, req.headers['idempotency-key']));
  }

  const organizationWorkspaces = url.pathname.match(/^\/api\/organizations\/([^/]+)\/workspaces$/);
  if (req.method === 'GET' && organizationWorkspaces) {
    const human = await auth.getHuman(req);
    const organizationId = organizationWorkspaces[1];
    if (!human || !await getMembership(organizationId, human.id)) return fail(res, 403, 'Active organization membership required');
    const references = await store.listJson(path.join('organizations', organizationId, 'workspaces'));
    const workspaces = await Promise.all(references.map(reference => store.getJson(path.join('inboxes', reference.inboxId, 'inbox.json'))));
    return json(res, 200, workspaces.filter(Boolean));
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-enroll') {
    const input = await body(req);
    if (!input.enrollmentToken) return fail(res, 400, 'enrollmentToken is required');
    const tokenHash = hashSecret(input.enrollmentToken);
    const tokenPath = path.join('auth', 'enrollment-tokens', `${tokenHash}.json`);
    const pendingRecord = await store.getJson(tokenPath);
    if (!pendingRecord || pendingRecord.usedAt || new Date(pendingRecord.expiresAt) <= new Date()) return fail(res, 401, 'Enrollment token is invalid, expired, or already used');
    const inbox = await store.getJson(path.join('inboxes', pendingRecord.inboxId, 'inbox.json'));
    if (!inbox || (inbox.ownerHumanId !== pendingRecord.humanId && !await getMembership(inbox.organizationId, pendingRecord.humanId))) return fail(res, 403, 'Enrollment owner is invalid');
    const agentName = String(input.name || pendingRecord.agentProfile?.name || '').trim();
    if (!agentName) return fail(res, 400, 'Agent name is required');
    const record = await store.claimJson(tokenPath, 'usedAt', store.now());
    if (!record) return fail(res, 401, 'Enrollment token is invalid, expired, or already used');
    const baseSlug = slugify(input.slug || record.agentProfile?.slug || agentName) || store.id('agent').replace('agent_', '');
    let slug = baseSlug;
    let address = `${slug}@${agentDomain}`;
    while (!(await reserveIdentity(address, { status: 'reserved' }))) { slug = `${baseSlug}-${store.id('slug').slice(-6)}`; address = `${slug}@${agentDomain}`; }
    const createdAt = store.now();
    const agentApiToken = `sinaloa_agent_${crypto.randomBytes(32).toString('base64url')}`;
    const agent = { id: store.id('agent'), organizationId: inbox.organizationId, name: agentName, slug, address, identity: { type: 'agent-email', address, domain: agentDomain, status: 'sandbox', transport: 'native' }, principalHumanId: record.humanId, capabilities: input.capabilities || record.agentProfile?.capabilities || [], permissions: record.permissions, credentialHash: hashSecret(agentApiToken), createdAt, status: 'active', onboardingStatus: 'approved', approvedAt: createdAt, approvedByHumanId: record.humanId };
    await store.ensureInbox(record.inboxId);
    await store.putJson(path.join('inboxes', record.inboxId, 'agents', `${agent.id}.json`), agent);
    await store.putJson(path.join('directory', 'agents', `${agent.id}.json`), { agentId: agent.id, inboxId: record.inboxId, address: agent.address, status: agent.status });
    await store.putJson(path.join('auth', 'agent-credentials', `${agent.credentialHash}.json`), { agentId: agent.id, inboxId: record.inboxId });
    await store.putJson(path.join('inboxes', record.inboxId, 'contacts', `${agent.id}.json`), { agentId: agent.id, approved: true, blocked: false, updatedAt: createdAt });
    inbox.status = 'active';
    await store.putJson(path.join('inboxes', record.inboxId, 'inbox.json'), inbox);
    await audit(record.inboxId, 'agent.enrolled', { agentId: agent.id, humanId: record.humanId, permissions: agent.permissions });
    return json(res, 201, { agent: publicAgent(agent), agentApiToken, inbox, nativeMessaging: 'ready' });
  }

  if (req.method === 'POST' && url.pathname === '/api/onboarding/agent-account') {
    const input = await body(req);
    if (!input.name) return fail(res, 400, 'Agent name is required');
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Verified human session required');
    input.humanId = human.id;
    const organization = await ensureOrganization(human, input.organizationId);
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
    const inbox = { id: inboxId, organizationId: organization.id, name: input.inboxName || `${input.name} workspace`, ownerAgentId: agent.id, ownerHumanId: input.humanId, status: 'pending_approval', createdAt };
    await store.putJson(path.join('inboxes', inboxId, 'inbox.json'), inbox);
    await store.putJson(path.join('organizations', organization.id, 'workspaces', `${inboxId}.json`), { inboxId, createdAt });
    await store.putJson(path.join('inboxes', inboxId, 'agents', `${agent.id}.json`), agent);
    await store.putJson(path.join('inboxes', inboxId, 'contacts', `${agent.id}.json`), { agentId: agent.id, approved: true, blocked: false, updatedAt: createdAt });
    const result = { account: { inbox, agent }, next: { nativeMessaging: 'pending_human_approval', humanApproval: { required: true, humanId: input.humanId }, externalEmail: 'requires_email_transport_configuration' } };
    if (idempotencyKey) await store.putJson(path.join('onboarding', `${encodeURIComponent(idempotencyKey)}.json`), result);
    await audit(inboxId, 'agent.account_created', { agentId: agent.id, address: agent.address, identityStatus: agent.identity.status });
    return json(res, 201, result);
  }

  if (req.method === 'POST' && url.pathname === '/api/inboxes') {
    const input = await body(req);
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Verified human session required');
    const organization = await ensureOrganization(human, input.organizationId);
    const inboxId = store.id('inbox');
    await store.ensureInbox(inboxId);
    const inbox = { id: inboxId, organizationId: organization.id, name: input.name || 'Agent workspace', ownerAgentId: null, ownerHumanId: human.id, status: 'setup', createdAt: store.now() };
    await store.putJson(path.join('inboxes', inboxId, 'inbox.json'), inbox);
    await store.putJson(path.join('organizations', organization.id, 'workspaces', `${inboxId}.json`), { inboxId, createdAt: inbox.createdAt });
    await audit(inboxId, 'inbox.created', { inboxId });
    return json(res, 201, inbox);
  }

  const match = url.pathname.match(/^\/api\/inboxes\/([^/]+)(?:\/(.*))?$/);
  if (!match) return fail(res, 404, 'Not found');
  const [, inboxId, suffix = ''] = match;
  const inbox = await store.getJson(path.join('inboxes', inboxId, 'inbox.json'));
  if (!inbox) return fail(res, 404, 'Inbox not found');

  if (req.method === 'GET' && suffix !== 'events') {
    const human = await auth.getHuman(req);
    const agent = await getAgentPrincipal(req, inboxId);
    if (!await canAccessInbox(human, inbox) && !agent) return fail(res, 401, 'Authenticated inbox participant required');
  }

  if (req.method === 'POST' && suffix === 'agent-enrollment-tokens') {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const input = await body(req);
    const requested = Array.isArray(input.permissions) ? input.permissions : ['send_agent_messages', 'receive_agent_messages'];
    const permissions = requested.filter(permission => allowedPermissions.has(permission));
    if (!permissions.includes('receive_agent_messages')) permissions.push('receive_agent_messages');
    const profileName = String(input.agentProfile?.name || '').trim();
    const agentProfile = profileName ? { name: profileName, slug: slugify(input.agentProfile?.slug || profileName), capabilities: Array.isArray(input.agentProfile?.capabilities) ? input.agentProfile.capabilities.slice(0, 20) : [] } : null;
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const record = { id: store.id('enrollment'), tokenHash: hashSecret(rawToken), inboxId, organizationId: inbox.organizationId, humanId: human.id, permissions, agentProfile, createdAt: store.now(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), usedAt: null };
    await store.putJson(path.join('auth', 'enrollment-tokens', `${record.tokenHash}.json`), record);
    await audit(inboxId, 'agent.enrollment_token_created', { enrollmentId: record.id, humanId: human.id, permissions });
    const publicUrl = process.env.SINALOA_PUBLIC_URL || `http://${req.headers.host || `${host}:${port}`}`;
    return json(res, 201, { enrollmentToken: rawToken, enrollmentUrl: `${publicUrl.replace(/\/$/, '')}/?enroll=${encodeURIComponent(rawToken)}`, expiresAt: record.expiresAt, permissions, agentProfile });
  }

  if (req.method === 'GET' && suffix === 'events') {
    const human = await auth.getHuman(req);
    const agent = await getAgentPrincipal(req, inboxId);
    if (!await canAccessInbox(human, inbox) && !agent) return fail(res, 401, 'Authenticated inbox participant required');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`event: ready\ndata: ${JSON.stringify({ inboxId, at: store.now() })}\n\n`);
    const set = streams.get(inboxId) || new Set(); set.add(res); streams.set(inboxId, set);
    req.on('close', () => { set.delete(res); if (!set.size) streams.delete(inboxId); });
    return;
  }

  if (req.method === 'GET' && suffix === '') return json(res, 200, inbox);

  if (req.method === 'GET' && suffix === 'human-view') {
    const human = await auth.getHuman(req);
    if (!await canAccessInbox(human, inbox)) return fail(res, 403, 'Workspace membership required');
    return json(res, 200, await humanView(inboxId, inbox));
  }

  if (req.method === 'GET' && suffix === 'agent-view') {
    const human = await auth.getHuman(req);
    const agentPrincipal = await getAgentPrincipal(req, inboxId);
    if (!await canAccessInbox(human, inbox) && agentPrincipal?.id !== url.searchParams.get('agentId')) return fail(res, 403, 'Authenticated inbox participant required');
    const view = await agentView(inboxId, inbox, url.searchParams.get('agentId'));
    return view ? json(res, 200, view) : fail(res, 404, 'Agent not found');
  }

  if (req.method === 'POST' && suffix === 'agents') {
    const input = await body(req);
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    input.humanId = human.id;
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
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    input.humanId = human.id;
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

  if (req.method === 'GET' && suffix === 'agents') return json(res, 200, (await store.listJson(path.join('inboxes', inboxId, 'agents'))).map(publicAgent));

  const blockMatch = suffix.match(/^contacts\/([^/]+)\/(block|unblock)$/);
  if (req.method === 'POST' && blockMatch) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const [, agentId, action] = blockMatch;
    const existing = await store.getJson(path.join('inboxes', inboxId, 'contacts', `${agentId}.json`), { agentId, approved: true });
    const contact = { ...existing, agentId, blocked: action === 'block', updatedAt: store.now() };
    await store.putJson(path.join('inboxes', inboxId, 'contacts', `${agentId}.json`), contact);
    await audit(inboxId, `contact.${action}ed`, { agentId });
    return json(res, 200, contact);
  }

  const approveMatch = suffix.match(/^contacts\/([^/]+)\/approve$/);
  if (req.method === 'POST' && approveMatch) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
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
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Verified human session required');
    const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
    if (!agent) return fail(res, 404, 'Agent not found');
    if (human.id !== (agent.principalHumanId || inbox.ownerHumanId) && !await canManageInbox(human, inbox)) return fail(res, 403, 'Only the linked human or a workspace administrator may approve this agent');
    let agentApiToken = null;
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
      agentApiToken = `sinaloa_agent_${crypto.randomBytes(32).toString('base64url')}`;
      agent.credentialHash = hashSecret(agentApiToken);
      await store.putJson(path.join('auth', 'agent-credentials', `${agent.credentialHash}.json`), { agentId: agent.id, inboxId });
      await store.putJson(path.join('directory', 'agents', `${agent.id}.json`), { agentId: agent.id, inboxId, address: agent.address, status: agent.status });
      inbox.status = 'active';
      await store.putJson(path.join('inboxes', inboxId, 'inbox.json'), inbox);
    }
    agent.approvedAt = store.now();
    agent.approvedByHumanId = human.id;
    await store.putJson(path.join('inboxes', inboxId, 'agents', `${agent.id}.json`), agent);
    await audit(inboxId, `agent.onboarding_${decision}ed`, { agentId: agent.id, humanId: human.id, permissions: agent.permissions });
    return json(res, 200, { agent: publicAgent(agent), ...(agentApiToken ? { agentApiToken } : {}) });
  }

  if (req.method === 'POST' && suffix === 'cases') {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !hasPermission(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    if (!String(input.objective || '').trim()) return fail(res, 400, 'A structured case objective is required');
    const now = store.now();
    const value = createAgentCase({ id: input.id || store.id('case'), objective: input.objective, principal: inbox.ownerHumanId, actingAgent: principal.id, participants: input.participants || [], constraints: input.constraints || {}, deadline: input.deadline || null, createdAt: now });
    if (!await store.putJsonIfAbsent(caseRecordPath(inboxId, value.id), value)) return fail(res, 409, 'Case ID already exists');
    await audit(inboxId, 'case.created', { caseId: value.id, actingAgent: principal.id, objective: value.objective });
    return json(res, 201, value);
  }

  const caseRoute = suffix.match(/^cases\/([^/]+)(?:\/(events|actions|policy-evaluations|proposals|receipt))?$/);
  if (req.method === 'GET' && caseRoute && !caseRoute[2]) {
    const value = await getCase(inboxId, caseRoute[1]);
    return value ? json(res, 200, value) : fail(res, 404, 'Case not found');
  }

  if (req.method === 'POST' && caseRoute?.[2] === 'events') {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal) return fail(res, 401, 'Agent credential required');
    const input = await body(req);
    if (!['message', 'error'].includes(input.type)) return fail(res, 400, 'Direct event writes support only message or error; use actions for stateful work');
    const value = await getCase(inboxId, caseRoute[1]);
    if (!value?.schemaVersion) return fail(res, 404, 'Structured case not found');
    const now = store.now();
    appendEvent(value, { id: input.id || store.id('evt'), type: input.type, actor: principal.id, createdAt: now, payload: input.payload || {}, linkedPolicyEvaluation: input.linkedPolicyEvaluation || null, precedingEventRef: input.precedingEventRef || value.events.at(-1)?.id || null });
    await saveCase(inboxId, value);
    await audit(inboxId, 'case.event_appended', { caseId: value.id, eventId: value.events.at(-1).id, eventType: input.type, actor: principal.id });
    return json(res, 201, value.events.at(-1));
  }

  if (req.method === 'POST' && caseRoute?.[2] === 'policy-evaluations') {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !hasPermission(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    if (!input.requestedAction || !input.reasonCode) return fail(res, 400, 'requestedAction and reasonCode are required');
    const value = await getCase(inboxId, caseRoute[1]);
    if (!value?.schemaVersion) return fail(res, 404, 'Structured case not found');
    const requiredPermission = actionPermission(input.requestedAction);
    const decision = !hasPermission(principal, requiredPermission) ? 'deny' : Array.isArray(input.outOfPolicyFlags) && input.outOfPolicyFlags.length ? 'needsHuman' : 'allow';
    const now = store.now();
    const evaluation = policyEvaluationFromInput({ ...input, decision, matchedPolicyId: input.matchedPolicyId || `permission:${requiredPermission}` }, principal.id, now);
    const updated = addPolicyEvaluation(value, evaluation, { at: now });
    await saveCase(inboxId, updated);
    await audit(inboxId, 'policy.evaluated', { caseId: value.id, policyEvaluationId: evaluation.id, requestedAction: evaluation.requestedAction, decision });
    return json(res, 201, evaluation);
  }

  if (req.method === 'POST' && caseRoute?.[2] === 'proposals') {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !hasPermission(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    const value = await getCase(inboxId, caseRoute[1]);
    if (!value?.schemaVersion) return fail(res, 404, 'Structured case not found');
    const now = store.now();
    const proposal = proposalFromInput(input, now);
    const updated = addProposal(value, proposal);
    appendEvent(updated, { id: store.id('evt'), type: 'decision', actor: principal.id, createdAt: now, payload: { proposalId: proposal.id, status: proposal.status }, linkedPolicyEvaluation: null, precedingEventRef: updated.events.at(-1)?.id || null });
    await saveCase(inboxId, updated);
    await audit(inboxId, 'proposal.created', { caseId: value.id, proposalId: proposal.id, kind: proposal.kind, actor: principal.id });
    return json(res, 201, proposal);
  }

  if (req.method === 'POST' && caseRoute?.[2] === 'actions') {
    const input = await body(req);
    const idempotencyKey = req.headers['idempotency-key'] || input.idempotencyKey;
    if (!idempotencyKey) return fail(res, 400, 'Idempotency-Key header is required');
    const value = await getCase(inboxId, caseRoute[1]);
    if (!value?.schemaVersion) return fail(res, 404, 'Structured case not found');
    const now = store.now();
    const human = await auth.getHuman(req);
    const principal = await getAgentPrincipal(req, inboxId);
    let result;
    if (human && await canAccessInbox(human, inbox)) {
      result = applyHumanAction(value, { id: input.id || store.id('action'), actionKey: input.actionKey, actor: human.id, idempotencyKey, externalRefs: input.externalRefs || {}, reasonCode: input.reasonCode || null }, { at: now });
    } else if (principal && principal.id === value.actingAgent) {
      result = applyAgentAction(value, { id: input.id || store.id('action'), actionKey: input.actionKey, actor: principal.id, idempotencyKey, outcome: input.outcome, externalRefs: input.externalRefs || {}, reasonCode: input.reasonCode || null }, { at: now, nextState: input.nextState || null });
    } else return fail(res, 403, 'Case participant credential required');
    await saveCase(inboxId, result.case);
    if (!result.replay) await audit(inboxId, 'case.action_recorded', { caseId: value.id, actionId: result.action.id, actionKey: result.action.actionKey, actor: result.action.actor, outcome: result.action.outcome });
    return json(res, result.replay ? 200 : 201, result);
  }

  const proposalRoute = suffix.match(/^cases\/([^/]+)\/proposals\/([^/]+)\/(counter|accept)$/);
  if (req.method === 'POST' && proposalRoute) {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !hasPermission(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    const value = await getCase(inboxId, proposalRoute[1]);
    if (!value?.schemaVersion) return fail(res, 404, 'Structured case not found');
    const now = store.now();
    if (proposalRoute[3] === 'counter') {
      const options = proposalFromInput({ kind: value.proposals.find(item => item.id === proposalRoute[2])?.kind, options: input.options }, now).options;
      const updated = counterProposal(value, proposalRoute[2], { options, at: now });
      await saveCase(inboxId, updated);
      await audit(inboxId, 'proposal.countered', { caseId: value.id, proposalId: proposalRoute[2], actor: principal.id });
      return json(res, 201, updated.proposals.find(item => item.id === proposalRoute[2]));
    }
    const idempotencyKey = req.headers['idempotency-key'] || input.idempotencyKey;
    if (!idempotencyKey || !input.optionId || !input.policyEvaluationId) return fail(res, 400, 'optionId, policyEvaluationId, and Idempotency-Key are required');
    const evaluation = value.policyEvaluations.find(item => item.id === input.policyEvaluationId);
    if (!evaluation || evaluation.actor !== principal.id) return fail(res, 403, 'A case policy evaluation for this agent is required');
    const result = acceptProposal(value, proposalRoute[2], input.optionId, evaluation, { actor: principal.id, idempotencyKey, actionId: input.id || store.id('action'), at: now });
    await saveCase(inboxId, result.case);
    await audit(inboxId, 'proposal.accept_attempted', { caseId: value.id, proposalId: proposalRoute[2], optionId: input.optionId, actor: principal.id, outcome: result.action.outcome });
    return json(res, result.action.outcome === 'needsApproval' ? 202 : 201, result);
  }

  if (req.method === 'POST' && caseRoute?.[2] === 'receipt') {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || principal.id === undefined || !hasPermission(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    const value = await getCase(inboxId, caseRoute[1]);
    if (!value?.schemaVersion) return fail(res, 404, 'Structured case not found');
    if (!input.result || !input.authorityBasis) return fail(res, 400, 'Receipt result and authorityBasis are required');
    const now = store.now();
    const receipt = { id: input.id || store.id('receipt'), result: input.result, counterparties: input.counterparties || [], externalIds: input.externalIds || {}, authorityBasis: input.authorityBasis, humanApprovalStatus: input.humanApprovalStatus || 'notRequired', evidenceRefs: input.evidenceRefs || [], createdAt: now };
    const updated = completeCase(value, receipt, { actor: principal.id, at: now });
    await saveCase(inboxId, updated);
    await audit(inboxId, 'case.completed', { caseId: value.id, receiptId: receipt.id, actor: principal.id });
    return json(res, 201, receipt);
  }

  if (req.method === 'GET' && suffix === 'cases') return json(res, 200, await listCases(inboxId, { limit: url.searchParams.get('limit'), before: url.searchParams.get('before') }));
  if (req.method === 'GET' && suffix === 'messages') return json(res, 200, await listMessages(inboxId, url.searchParams.get('caseId'), { limit: url.searchParams.get('limit'), before: url.searchParams.get('before') }));

  if (req.method === 'POST' && suffix === 'messages') {
    const input = await body(req);
    if (!input.senderAgentId || !input.recipientAgentId || !input.text) return fail(res, 400, 'senderAgentId, recipientAgentId, and text are required');
    const idempotencyKey = req.headers['idempotency-key'] || input.idempotencyKey;
    if (!idempotencyKey) return fail(res, 400, 'Idempotency-Key header is required');
    const sender = await store.getJson(path.join('inboxes', inboxId, 'agents', `${input.senderAgentId}.json`));
    if (!sender) return fail(res, 403, 'Only registered agents may send messages');
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || principal.id !== sender.id) return fail(res, 401, 'Valid sender agent credential required');
    if (!hasPermission(sender, 'send_agent_messages')) return fail(res, 403, 'Agent is pending approval or lacks send_agent_messages permission');
    const recipientDirectory = await store.getJson(path.join('directory', 'agents', `${input.recipientAgentId}.json`));
    if (!recipientDirectory || recipientDirectory.status !== 'active') return fail(res, 404, 'Recipient agent not found');
    const recipient = await store.getJson(path.join('inboxes', recipientDirectory.inboxId, 'agents', `${input.recipientAgentId}.json`));
    if (!recipient || !hasPermission(recipient, 'receive_agent_messages')) return fail(res, 403, 'Recipient agent is not approved to receive messages');
    const blocked = await store.getJson(path.join('inboxes', recipientDirectory.inboxId, 'contacts', `${input.senderAgentId}.json`));
    if (blocked?.blocked) return fail(res, 403, 'Recipient is blocked');
    const messageId = `msg_${hashSecret(`${sender.id}:${idempotencyKey}`).slice(0, 32)}`;
    const existing = await store.getJson(path.join('inboxes', inboxId, 'messages', `${messageId}.json`));
    if (existing) {
      const sameRequest = existing.recipientAgentId === input.recipientAgentId && existing.text === input.text && JSON.stringify(existing.payload) === JSON.stringify(input.payload || null);
      return sameRequest ? json(res, 200, existing) : fail(res, 409, 'Idempotency key was already used for a different message');
    }
    const message = { id: messageId, caseId: input.caseId || store.id('case'), senderInboxId: inboxId, recipientInboxId: recipientDirectory.inboxId, senderType: 'agent', senderAgentId: input.senderAgentId, recipientAgentId: input.recipientAgentId, type: input.type || 'message', text: input.text, payload: input.payload || null, createdAt: store.now(), status: 'delivered' };
    for (const targetInboxId of new Set([inboxId, recipientDirectory.inboxId])) {
      await store.putJson(path.join('inboxes', targetInboxId, 'messages', `${message.id}.json`), message);
      const targetInbox = targetInboxId === inboxId ? inbox : await store.getJson(path.join('inboxes', targetInboxId, 'inbox.json'));
      const caseRecord = await ensureStructuredCase(targetInbox, { ...input, caseId: message.caseId }, message.senderAgentId, message.createdAt);
      appendEvent(caseRecord, { id: `evt_${message.id}`, type: 'message', actor: message.senderAgentId, createdAt: message.createdAt, payload: { messageId: message.id, messageType: message.type, text: message.text, data: message.payload, senderAgentId: message.senderAgentId, recipientAgentId: message.recipientAgentId, deliveryState: message.status }, linkedPolicyEvaluation: null, precedingEventRef: caseRecord.events.at(-1)?.id || null });
      await saveCase(targetInboxId, caseRecord);
      await audit(targetInboxId, 'message.delivered', { messageId: message.id, caseId: message.caseId, senderAgentId: message.senderAgentId, recipientAgentId: message.recipientAgentId, senderInboxId: inboxId, recipientInboxId: recipientDirectory.inboxId });
    }
    return json(res, 201, message);
  }

  if (req.method === 'POST' && suffix === 'human-messages') {
    const input = await body(req);
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Verified human session required');
    if (!await canAccessInbox(human, inbox)) return fail(res, 403, 'Workspace membership required');
    if (!input.recipientAgentId || !input.text) return fail(res, 400, 'recipientAgentId and text are required');
    const recipient = await store.getJson(path.join('inboxes', inboxId, 'agents', `${input.recipientAgentId}.json`));
    if (!recipient) return fail(res, 404, 'Recipient agent not found');
    if (!hasPermission(recipient, 'receive_agent_messages')) return fail(res, 403, 'Recipient agent is not approved to receive messages');
    const contact = await store.getJson(path.join('inboxes', inboxId, 'contacts', `${input.recipientAgentId}.json`), { approved: true, blocked: false });
    if (contact.blocked) return fail(res, 403, 'Recipient is blocked');
    if (contact.approved === false) return fail(res, 403, 'Recipient is not an approved human contact');
    const message = { id: input.id || store.id('msg'), inboxId, caseId: input.caseId || store.id('case'), senderType: 'human', senderHumanId: human.id, recipientAgentId: input.recipientAgentId, type: input.type || 'message', text: input.text, payload: input.payload || null, createdAt: store.now(), status: 'received' };
    await store.putJson(path.join('inboxes', inboxId, 'messages', `${message.id}.json`), message);
    const caseRecord = await ensureStructuredCase(inbox, { ...input, caseId: message.caseId }, message.recipientAgentId, message.createdAt);
    appendEvent(caseRecord, { id: `evt_${message.id}`, type: 'message', actor: human.id, createdAt: message.createdAt, payload: { messageId: message.id, messageType: message.type, text: message.text, data: message.payload, senderHumanId: human.id, recipientAgentId: message.recipientAgentId, deliveryState: message.status }, linkedPolicyEvaluation: null, precedingEventRef: caseRecord.events.at(-1)?.id || null });
    await saveCase(inboxId, caseRecord);
    await audit(inboxId, 'message.created', { messageId: message.id, caseId: message.caseId, senderType: 'human', senderHumanId: message.senderHumanId, recipientAgentId: message.recipientAgentId });
    return json(res, 201, message);
  }

  if (req.method === 'POST' && suffix === 'assets') {
    const input = await body(req);
    if (!input.name || !input.contentBase64 || !input.createdByAgentId) return fail(res, 400, 'name, contentBase64, and createdByAgentId are required');
    const assetAgent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${input.createdByAgentId}.json`));
    if (!assetAgent || !hasPermission(assetAgent, 'create_assets')) return fail(res, 403, 'Agent is pending approval or lacks create_assets permission');
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || principal.id !== assetAgent.id) return fail(res, 401, 'Valid creator agent credential required');
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
server.listen(port, host, () => console.log(`Sinaloa backend listening on http://${host}:${server.address().port}`));

const shutdown = () => {
  for (const set of streams.values()) for (const res of set) res.end();
  server.close(async () => { if (store.close) await store.close(); process.exit(0); });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
