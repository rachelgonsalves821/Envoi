import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { FileStore } from './storage.js';
import { createHumanAuth } from './human-auth.js';
import { createCsrfToken, csrfCookieHeader, parseCookies, sessionCookieHeader, verifyCsrfRequest } from './workos-auth.js';
import { DeliveryWorker } from './delivery-worker.js';
import { createEmailTransport } from './email-transport.js';
import { createProtocolMessage } from './protocol-v1.js';
import { createObjectStorageAdapter, DocumentObjectMetadataStore, FailClosedScanner, HttpMalwareScanner, ObjectStorageService, PersistentQuotaLedger } from './object-storage.js';
import { validateProductionConfiguration } from './production-config.js';
import { evaluateReadiness } from './readiness.js';
import { clientIp, publicHttpError } from './http-security.js';
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

const productionConfig = validateProductionConfiguration();
const host = process.env.SINALOA_HOST || '127.0.0.1';
const port = Number(process.env.SINALOA_PORT || 8787);
const dataDir = process.env.SINALOA_DATA_DIR || path.resolve('data');
const maxBodyBytes = Number(process.env.SINALOA_MAX_BODY_BYTES || 10 * 1024 * 1024);
const corsOrigin = process.env.SINALOA_CORS_ORIGIN || 'http://localhost:3000';
const agentDomain = process.env.SINALOA_AGENT_DOMAIN || 'sinaloa.mail';
const deliveryMaxAttempts = Number(process.env.SINALOA_DELIVERY_MAX_ATTEMPTS || 5);
const externalEmailEnabled = process.env.SINALOA_ENABLE_EXTERNAL_EMAIL === 'true';
const calendarWritesEnabled = process.env.SINALOA_ENABLE_CALENDAR_WRITES === 'true';
const consequentialActionsEnabled = process.env.SINALOA_ENABLE_CONSEQUENTIAL_ACTIONS === 'true';
const emailTransport = createEmailTransport();
const agentAccessTokenTtlSeconds = Math.max(60, Number(process.env.SINALOA_AGENT_ACCESS_TOKEN_TTL_SECONDS || 900));
const agentRefreshTokenTtlDays = Math.max(1, Number(process.env.SINALOA_AGENT_REFRESH_TOKEN_TTL_DAYS || 30));
const calendarProviders = Object.freeze({
  google: {
    label: 'Google Calendar',
    clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.events.freebusy']
  },
  outlook: {
    label: 'Outlook Calendar',
    clientId: process.env.MICROSOFT_CALENDAR_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CALENDAR_CLIENT_SECRET,
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['openid', 'email', 'offline_access', 'User.Read', 'Calendars.ReadWrite']
  }
});
const allowedPermissions = new Set(['send_agent_messages', 'receive_agent_messages', 'create_assets', 'execute_cases', 'use_email_transport']);
const actionPermission = actionKey => actionKey.startsWith('message.') ? 'send_agent_messages' : actionKey.startsWith('email.') ? 'use_email_transport' : 'execute_cases';
const store = process.env.DATABASE_URL ? new (await import('./postgres-storage.js')).PostgresStore(process.env.DATABASE_URL) : new FileStore(dataDir);
const auth = createHumanAuth(store);
const streams = new Map();
const rateBuckets = new Map();
const emailRateBuckets = new Map();
const sseCounts = new Map();
const requestTimeoutMs = Number(process.env.SINALOA_REQUEST_TIMEOUT_MS || 30_000);
const maxSsePerPrincipal = Number(process.env.SINALOA_MAX_SSE_PER_PRINCIPAL || 10);
const objectStorageProvider = process.env.SINALOA_OBJECT_STORAGE_PROVIDER || 'local';
const objectMaxBytes = Number(process.env.SINALOA_OBJECT_MAX_BYTES || 25 * 1024 * 1024);
const objectQuotaBytes = Number(process.env.SINALOA_WORKSPACE_OBJECT_QUOTA_BYTES || 1024 * 1024 * 1024);
const objectAllowedMimeTypes = (process.env.SINALOA_OBJECT_ALLOWED_MIME_TYPES || 'application/pdf,image/jpeg,image/png,text/plain,text/csv,application/json').split(',').map(value => value.trim()).filter(Boolean);
const objectStorageAdapter = createObjectStorageAdapter(objectStorageProvider === 's3' ? {
  provider: 's3',
  endpoint: process.env.SINALOA_S3_ENDPOINT || `https://s3.${process.env.SINALOA_S3_REGION || 'ca-central-1'}.amazonaws.com`,
  bucket: process.env.SINALOA_S3_BUCKET,
  region: process.env.SINALOA_S3_REGION || 'ca-central-1',
  accessKeyId: process.env.SINALOA_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.SINALOA_S3_SECRET_ACCESS_KEY,
  sessionToken: process.env.SINALOA_S3_SESSION_TOKEN,
  maxObjectBytes: objectMaxBytes,
  allowedMimeTypes: objectAllowedMimeTypes
} : { provider: 'local', root: path.join(dataDir, 'object-storage'), maxObjectBytes: objectMaxBytes, allowedMimeTypes: objectAllowedMimeTypes });
const objectScanner = process.env.SINALOA_MALWARE_SCANNER_URL ? new HttpMalwareScanner({ endpoint: process.env.SINALOA_MALWARE_SCANNER_URL, token: process.env.SINALOA_MALWARE_SCANNER_TOKEN || null }) : new FailClosedScanner();
const objectStorage = new ObjectStorageService({ adapter: objectStorageAdapter, metadataStore: new DocumentObjectMetadataStore(store), quotaLedger: new PersistentQuotaLedger(store, { defaultQuotaBytes: objectQuotaBytes }), scanner: objectScanner, maxObjectBytes: objectMaxBytes, allowedMimeTypes: objectAllowedMimeTypes });
const readinessTimeoutMs = Number(process.env.SINALOA_READINESS_TIMEOUT_MS || 5_000);

async function readinessReport() {
  const production = process.env.SINALOA_AUTH_MODE === 'production';
  const checks = [
    { name: 'database', run: async () => { await store.queryJson('readiness-probe', { limit: 1 }); } },
    {
      name: 'objectStorage',
      critical: production,
      run: async () => {
        if (objectStorageProvider !== 's3') return;
        await objectStorageAdapter.headObject('__sinaloa_readiness_probe__');
      }
    },
    {
      name: 'malwareScanner',
      critical: production,
      run: async signal => {
        if (!process.env.SINALOA_MALWARE_SCANNER_URL) throw new Error('Malware scanner is not configured');
        const response = await fetch(process.env.SINALOA_MALWARE_SCANNER_URL, {
          method: 'HEAD',
          signal,
          headers: process.env.SINALOA_MALWARE_SCANNER_TOKEN ? { authorization: `Bearer ${process.env.SINALOA_MALWARE_SCANNER_TOKEN}` } : {}
        });
        if (response.status >= 500 || [401, 403].includes(response.status)) throw new Error(`Malware scanner health check returned ${response.status}`);
      }
    },
    {
      name: 'publicEmail',
      critical: externalEmailEnabled,
      run: async () => { if (externalEmailEnabled) emailTransport.assertReady(); }
    }
  ];
  const report = await evaluateReadiness(checks, { timeoutMs: readinessTimeoutMs, at: store.now() });
  return { ...report, service: 'sinaloa', mode: productionConfig.mode, configurationValidated: productionConfig.validated };
}

const rateIdentity = req => hashSecret(String(req.headers.authorization || req.headers.cookie || clientIp(req))).slice(0, 32);
const ratePolicy = (req, pathname) => {
  if (pathname === '/api/email-webhooks/resend') return { limit: 600, windowMs: 60_000 };
  if (pathname.startsWith('/api/auth/')) return { limit: 60, windowMs: 60_000 };
  if (pathname.includes('/asset-uploads') || pathname.startsWith('/api/object-storage/')) return { limit: 120, windowMs: 60_000 };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return { limit: 180, windowMs: 60_000 };
  return { limit: 1200, windowMs: 60_000 };
};
const consumeRateLimit = (req, res, pathname) => {
  const policy = ratePolicy(req, pathname);
  const now = Date.now();
  const key = `${rateIdentity(req)}:${req.method}:${policy.limit}`;
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + policy.windowMs };
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (rateBuckets.size > 50_000) for (const [candidate, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(candidate);
  res.setHeader('ratelimit-limit', String(policy.limit));
  res.setHeader('ratelimit-remaining', String(Math.max(0, policy.limit - bucket.count)));
  res.setHeader('ratelimit-reset', String(Math.ceil(bucket.resetAt / 1000)));
  if (bucket.count <= policy.limit) return true;
  res.setHeader('retry-after', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
  return false;
};
const consumeExternalEmailLimit = (agentId, recipientEmail) => {
  const now = Date.now();
  const windowMs = 60 * 60_000;
  const limits = [
    { key: `agent:${agentId}`, limit: Number(process.env.SINALOA_EXTERNAL_EMAIL_AGENT_HOURLY_LIMIT || 100) },
    { key: `recipient:${agentId}:${externalContactKey(recipientEmail)}`, limit: Number(process.env.SINALOA_EXTERNAL_EMAIL_RECIPIENT_HOURLY_LIMIT || 20) }
  ];
  for (const policy of limits) {
    const current = emailRateBuckets.get(policy.key);
    if (current && current.resetAt > now && current.count >= policy.limit) return false;
  }
  for (const policy of limits) {
    const current = emailRateBuckets.get(policy.key);
    emailRateBuckets.set(policy.key, !current || current.resetAt <= now ? { count: 1, resetAt: now + windowMs } : { ...current, count: current.count + 1 });
  }
  if (emailRateBuckets.size > 20_000) for (const [key, value] of emailRateBuckets) if (value.resetAt <= now) emailRateBuckets.delete(key);
  return true;
};

const applyHeaders = (res, origin, nonce) => {
  const origins = corsOrigin.split(',').map((item) => item.trim());
  const allowedOrigin = corsOrigin === '*' ? '*' : origins.includes(origin) ? origin : '';
  if (allowedOrigin) {
    res.setHeader('access-control-allow-origin', allowedOrigin);
    res.setHeader('vary', 'Origin');
    if (allowedOrigin !== '*') res.setHeader('access-control-allow-credentials', 'true');
  }
  res.setHeader('access-control-allow-headers', 'content-type, authorization, idempotency-key, if-none-match, x-request-id, x-sinaloa-csrf, traceparent, x-amz-checksum-sha256, x-amz-meta-sinaloa-sha256');
  res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, PUT, OPTIONS');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('x-dns-prefetch-control', 'off');
  res.setHeader('content-security-policy', `default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; script-src 'nonce-${nonce}' 'strict-dynamic'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'`);
  if (process.env.SINALOA_AUTH_MODE === 'production') res.setHeader('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
};
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const redirect = (res, location, headers = {}) => { res.writeHead(302, { location, 'cache-control': 'no-store', ...headers }); res.end(); };
const fail = (res, status, message) => json(res, status, { error: message });
const slugify = (value) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const identityKey = (address) => encodeURIComponent(address.toLowerCase());
const normalizedEmail = value => String(value || '').trim().toLowerCase();
const validEmail = value => /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value) && value.length <= 254 && !/[\r\n]/.test(value);
const externalContactKey = address => hashSecret(normalizedEmail(address)).slice(0, 40);
const externalContactPath = (inboxId, address) => path.join('inboxes', inboxId, 'external-contacts', `${externalContactKey(address)}.json`);
const invitationPath = (inboxId, invitationId) => path.join('inboxes', inboxId, 'invitations', `${invitationId}.json`);
const externalAddressDirectoryPath = address => path.join('directory', 'email-addresses', `${identityKey(address)}.json`);
const nativeAddressDirectoryPath = address => path.join('directory', 'native-addresses', `${identityKey(address)}.json`);
const replyAddressDirectoryPath = address => path.join('directory', 'email-replies', `${identityKey(address)}.json`);
const reserveIdentity = async (address, value) => {
  const relative = path.join('identities', `${identityKey(address)}.json`);
  return store.putJsonIfAbsent(relative, value);
};
const hasPermission = (agent, permission) => agent.status === 'active' && agent.onboardingStatus === 'approved' && agent.permissions?.includes(permission);
const hashSecret = value => crypto.createHash('sha256').update(value).digest('hex');
const publicEmailAddressForAgent = agent => emailTransport.addressForSlug(agent.slug);
const publicIdentity = (slug) => ({
  type: 'agent-email',
  address: `${slug}@${agentDomain}`,
  domain: agentDomain,
  status: 'sandbox',
  transport: 'native',
  externalAddress: emailTransport.addressForSlug(slug),
  externalTransportStatus: emailTransport.ready ? 'ready' : 'unconfigured'
});
const connectorEncryptionKey = () => crypto.createHash('sha256').update(process.env.SINALOA_DATA_ENCRYPTION_KEY || 'sinaloa-development-only').digest();
const encryptConnectorTokens = value => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', connectorEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
};
const publicEmailTransportStatus = () => ({
  enabled: externalEmailEnabled,
  ready: externalEmailEnabled && emailTransport.ready,
  reason: !externalEmailEnabled ? 'disabledByConfiguration' : emailTransport.ready ? null : emailTransport.status().reason || 'providerNotReady'
});
const publicEmailTransportProjection = (agents, contacts) => ({
  ...emailTransport.status(),
  ...publicEmailTransportStatus(),
  internalAgentDomain: agentDomain,
  agents: agents.map(agent => ({
    agentId: agent.id,
    platformAddress: agent.address,
    publicEmailAddress: externalEmailEnabled ? publicEmailAddressForAgent(agent) : null,
    permitted: hasPermission(agent, 'use_email_transport')
  })),
  contacts: contacts.sort((left, right) => String(left.email).localeCompare(String(right.email)))
});
const publicAgent = agent => {
  const value = {
    ...agent,
    platformAddress: agent.address,
    publicEmailAddress: externalEmailEnabled ? publicEmailAddressForAgent(agent) : null,
    publicEmailTransport: publicEmailTransportStatus()
  };
  delete value.credentialHash;
  return value;
};
const publicCalendarConnector = connector => {
  const value = { ...connector };
  delete value.tokenSetEncrypted;
  return value;
};
const bearerToken = req => (req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
const agentCredentialPath = tokenHash => path.join('auth', 'agent-credentials', `${tokenHash}.json`);
const agentRefreshCredentialPath = tokenHash => path.join('auth', 'agent-refresh-credentials', `${tokenHash}.json`);
const agentCredentialFamilyPath = (inboxId, agentId, familyId) => path.join('auth', 'agent-credential-families', inboxId, agentId, `${familyId}.json`);
const expiresAfter = milliseconds => new Date(Date.now() + milliseconds).toISOString();

async function issueAgentCredentials(agentId, inboxId, familyId = store.id('credential_family')) {
  const issuedAt = store.now();
  const familyPath = agentCredentialFamilyPath(inboxId, agentId, familyId);
  const existingFamily = await store.getJson(familyPath);
  if (existingFamily?.revokedAt) throw Object.assign(new Error('Agent credential family is revoked'), { statusCode: 401 });
  const family = existingFamily || {
    id: familyId,
    agentId,
    inboxId,
    createdAt: issuedAt,
    refreshExpiresAt: expiresAfter(agentRefreshTokenTtlDays * 86_400_000),
    rotationCounter: 0,
    revokedAt: null
  };
  if (new Date(family.refreshExpiresAt) <= new Date()) throw Object.assign(new Error('Agent credential family is expired'), { statusCode: 401 });
  const agentApiToken = `sinaloa_agent_access_${crypto.randomBytes(32).toString('base64url')}`;
  const agentRefreshToken = `sinaloa_agent_refresh_${crypto.randomBytes(48).toString('base64url')}`;
  const agentTokenExpiresAt = expiresAfter(agentAccessTokenTtlSeconds * 1000);
  const agentRefreshTokenExpiresAt = family.refreshExpiresAt;
  family.rotationCounter = Number(family.rotationCounter || 0) + 1;
  family.updatedAt = issuedAt;
  await store.putJsonBatch([
    document(agentCredentialPath(hashSecret(agentApiToken)), { tokenType: 'access', agentId, inboxId, familyId, issuedAt, expiresAt: agentTokenExpiresAt, revokedAt: null }),
    document(agentRefreshCredentialPath(hashSecret(agentRefreshToken)), { tokenType: 'refresh', agentId, inboxId, familyId, issuedAt, expiresAt: agentRefreshTokenExpiresAt, usedAt: null, revokedAt: null }),
    document(familyPath, family)
  ]);
  return { agentApiToken, agentRefreshToken, agentTokenExpiresAt, agentRefreshTokenExpiresAt, tokenType: 'Bearer' };
}

async function rotateAgentCredentials(rawRefreshToken) {
  if (!String(rawRefreshToken || '').startsWith('sinaloa_agent_refresh_')) throw Object.assign(new Error('Valid agent refresh token required'), { statusCode: 401 });
  const refreshPath = agentRefreshCredentialPath(hashSecret(rawRefreshToken));
  const current = await store.getJson(refreshPath);
  if (!current || current.tokenType !== 'refresh' || current.revokedAt || current.usedAt || new Date(current.expiresAt) <= new Date()) throw Object.assign(new Error('Agent refresh token is invalid, expired, or already used'), { statusCode: 401 });
  const family = await store.getJson(agentCredentialFamilyPath(current.inboxId, current.agentId, current.familyId));
  if (!family || family.revokedAt || new Date(family.refreshExpiresAt) <= new Date()) throw Object.assign(new Error('Agent credential family is invalid or revoked'), { statusCode: 401 });
  const claimed = await store.claimJson(refreshPath, 'usedAt', store.now());
  if (!claimed) throw Object.assign(new Error('Agent refresh token is invalid, expired, or already used'), { statusCode: 401 });
  return issueAgentCredentials(current.agentId, current.inboxId, current.familyId);
}

const getAgentPrincipal = async (req, inboxId) => {
  const raw = bearerToken(req);
  if (!raw) return null;
  const credentialHash = hashSecret(raw);
  const index = await store.getJson(agentCredentialPath(credentialHash));
  if (!index || index.inboxId !== inboxId) return null;
  if (!index.tokenType) {
    if (process.env.SINALOA_AUTH_MODE === 'production') return null;
  } else {
    if (index.tokenType !== 'access' || index.revokedAt || new Date(index.expiresAt) <= new Date()) return null;
    const family = await store.getJson(agentCredentialFamilyPath(index.inboxId, index.agentId, index.familyId));
    if (!family || family.revokedAt || new Date(family.refreshExpiresAt) <= new Date()) return null;
  }
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
const rawBody = async (req) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) throw Object.assign(new Error(`Request body exceeds ${maxBodyBytes} bytes`), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};
const rawBuffer = async (req) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > objectMaxBytes) throw Object.assign(new Error(`Request body exceeds ${objectMaxBytes} bytes`), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};
const publicBaseUrl = req => (process.env.SINALOA_PUBLIC_URL || `http://${req.headers.host || `${host}:${port}`}`).replace(/\/$/, '');
const browserObjectUrl = (value, req) => {
  if (!value?.url?.startsWith('local-object://')) return value;
  const parsed = new URL(value.url);
  return { ...value, url: `${publicBaseUrl(req)}/api/object-storage/local-${parsed.hostname}/${parsed.pathname.slice(1)}` };
};
const eventCursor = event => event.cursor || (event.sequence ? String(event.sequence).padStart(20, '0') : `${event.createdAt}|${event.id}`);
const normalizeStreamEvent = event => ({ ...event, cursor: eventCursor(event) });
const sendStreamEvent = (subscription, event) => {
  const normalized = normalizeStreamEvent(event);
  if (subscription.sentIds.has(normalized.id)) return;
  subscription.sentIds.add(normalized.id);
  if (subscription.sentIds.size > 500) subscription.sentIds.delete(subscription.sentIds.values().next().value);
  subscription.cursor = normalized.cursor;
  subscription.res.write(`id: ${normalized.cursor}\nevent: ${normalized.type}\ndata: ${JSON.stringify(normalized)}\n\n`);
};
const publish = (inboxId, event) => {
  for (const subscription of streams.get(inboxId) || []) sendStreamEvent(subscription, event);
};
const listStreamEvents = async inboxId => (await store.listJson(path.join('inboxes', inboxId, 'events')))
  .map(normalizeStreamEvent)
  .sort((left, right) => left.cursor.localeCompare(right.cursor));
const audit = async (inboxId, type, data) => {
  const event = { id: store.id('evt'), type, createdAt: store.now(), sequence: await store.nextEventSequence(inboxId), ...data };
  event.cursor = eventCursor(event);
  await store.putJson(path.join('inboxes', inboxId, 'events', `${event.id}.json`), event);
  publish(inboxId, event);
  return event;
};

const document = (relative, value) => ({ path: relative, value });
const messagePath = (inboxId, messageId) => path.join('inboxes', inboxId, 'messages', `${messageId}.json`);
const deliveryReceiptPath = (inboxId, receiptId) => path.join('inboxes', inboxId, 'delivery-receipts', `${receiptId}.json`);
const auditRecord = async (inboxId, type, data, createdAt = store.now()) => {
  const event = { id: store.id('evt'), type, createdAt, sequence: await store.nextEventSequence(inboxId), ...data };
  event.cursor = eventCursor(event);
  return { event, document: document(path.join('inboxes', inboxId, 'events', `${event.id}.json`), event) };
};

function setCaseMessageDeliveryState(value, message, state, at) {
  const eventId = `evt_${message.id}`;
  const existing = value.events.find(item => item.id === eventId);
  if (existing) {
    existing.payload = { ...existing.payload, deliveryState: state };
    value.updatedAt = at;
    return value;
  }
  appendEvent(value, {
    id: eventId,
    type: 'message',
    actor: message.senderAgentId,
    createdAt: message.createdAt,
    payload: {
      messageId: message.id,
      messageType: message.type,
      text: message.text,
      data: message.payload,
      senderAgentId: message.senderAgentId,
      recipientAgentId: message.recipientAgentId,
      recipientEmail: message.recipientEmail,
      subject: message.subject,
      transport: message.transport || 'native',
      deliveryState: state
    },
    linkedPolicyEvaluation: null,
    precedingEventRef: value.events.at(-1)?.id || null
  });
  value.updatedAt = at;
  return value;
}

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

async function createDedicatedAgentInbox({ sourceInbox, organizationId, ownerHumanId, agent, status = 'pending_approval' }) {
  const inboxId = store.id('inbox');
  const createdAt = agent.createdAt || store.now();
  const inbox = {
    id: inboxId,
    organizationId,
    name: `${agent.name} inbox`,
    ownerAgentId: agent.id,
    ownerHumanId,
    parentInboxId: sourceInbox?.id || null,
    kind: 'agent',
    status,
    createdAt
  };
  await store.ensureInbox(inboxId);
  await Promise.all([
    store.putJson(path.join('inboxes', inboxId, 'inbox.json'), inbox),
    store.putJson(path.join('organizations', organizationId, 'workspaces', `${inboxId}.json`), { inboxId, createdAt }),
    store.putJson(path.join('inboxes', inboxId, 'agents', `${agent.id}.json`), agent),
    store.putJson(path.join('inboxes', inboxId, 'contacts', `${agent.id}.json`), { agentId: agent.id, approved: true, blocked: false, updatedAt: createdAt })
  ]);
  return inbox;
}

async function synchronizePublicEmailDirectory() {
  const entries = await store.listJson(path.join('directory', 'agents'));
  for (const entry of entries) {
    if (entry.status !== 'active' || !entry.inboxId || !entry.agentId) continue;
    const agentPath = path.join('inboxes', entry.inboxId, 'agents', `${entry.agentId}.json`);
    const agent = await store.getJson(agentPath);
    if (!agent?.slug) continue;
    const externalAddress = externalEmailEnabled ? publicEmailAddressForAgent(agent) : null;
    agent.identity = { ...(agent.identity || publicIdentity(agent.slug)), externalAddress, externalTransportStatus: publicEmailTransportStatus().ready ? 'ready' : 'disabled' };
    const documents = [
      document(agentPath, agent),
      document(path.join('directory', 'agents', `${agent.id}.json`), { ...entry, address: agent.address, externalAddress, verified: true }),
      document(nativeAddressDirectoryPath(agent.address), { agentId: agent.id, inboxId: entry.inboxId, address: agent.address, status: agent.status, verified: true })
    ];
    if (externalAddress) documents.push(document(externalAddressDirectoryPath(externalAddress), { agentId: agent.id, inboxId: entry.inboxId, address: externalAddress, status: agent.status }));
    await store.putJsonBatch(documents);
  }
}

const calendarConnectorPath = (inboxId, provider) => path.join('inboxes', inboxId, 'calendar-connectors', `${provider}.json`);
const calendarProviderStatus = () => Object.fromEntries(Object.entries(calendarProviders).map(([id, provider]) => [id, { id, label: provider.label, configured: Boolean(provider.clientId && provider.clientSecret) }]));
const calendarRedirectUri = (provider, req) => process.env[provider === 'google' ? 'GOOGLE_CALENDAR_REDIRECT_URI' : 'MICROSOFT_CALENDAR_REDIRECT_URI'] || `${(process.env.SINALOA_PUBLIC_URL || `http://${req.headers.host || `${host}:${port}`}`).replace(/\/$/, '')}/api/calendar-oauth/${provider}/callback`;
const tokenAccountLabel = tokenSet => {
  try {
    const payload = JSON.parse(Buffer.from(String(tokenSet.id_token || '').split('.')[1], 'base64url').toString('utf8'));
    return payload.email || payload.preferred_username || payload.name || null;
  } catch {
    return null;
  }
};

async function listMessages(inboxId, caseId, { limit = 100, before = null } = {}) {
  return store.queryJson(path.join('inboxes', inboxId, 'messages'), { limit, before, filters: caseId ? { caseId } : {}, sortField: 'createdAt' });
}

async function listCases(inboxId, { limit = 100, before = null } = {}) {
  return store.queryJson(path.join('inboxes', inboxId, 'cases'), { limit, before, sortField: 'updatedAt' });
}

const caseRecordPath = (inboxId, caseId) => path.join('inboxes', inboxId, 'cases', `${caseId}.json`);
const saveCase = (inboxId, value) => store.putJson(caseRecordPath(inboxId, value.id), value);
const getCase = async (inboxId, caseId) => {
  const value = await store.getJson(caseRecordPath(inboxId, caseId));
  return value?.schemaVersion && !value.collaborationMode ? { ...value, collaborationMode: 'collaboration' } : value;
};

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

const policyBindingPath = (inboxId, evaluationId) => path.join('inboxes', inboxId, 'policy-bindings', `${evaluationId}.json`);
const consequentialAction = actionKey => /^(calendar\.|email\.|payment\.|contract\.|asset\.share|external\.)/.test(String(actionKey || ''));
const canonicalValue = value => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
  return value;
};
const valueDigest = value => hashSecret(JSON.stringify(canonicalValue(value)));
const minutesFromClock = value => {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes < 1440 ? minutes : null;
};
const zonedMinutes = (instant, timezone) => {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
    return Number(parts.find(part => part.type === 'hour')?.value) * 60 + Number(parts.find(part => part.type === 'minute')?.value);
  } catch { return null; }
};

async function evaluateServerPolicy(inboxId, agent, caseRecord, input) {
  const requestedAction = String(input.requestedAction || '');
  const requiredPermission = actionPermission(requestedAction);
  const actionPayload = input.actionPayload && typeof input.actionPayload === 'object' ? input.actionPayload : {};
  const flags = [];
  let decision = hasPermission(agent, requiredPermission) ? 'allow' : 'deny';
  let reasonCode = decision === 'deny' ? `missingPermission:${requiredPermission}` : 'withinServerPolicy';
  let policyClass = `permission:${requiredPermission}`;
  if (caseRecord.deadline && new Date(caseRecord.deadline) <= new Date()) {
    decision = 'deny';
    reasonCode = 'caseDeadlineExpired';
    flags.push('caseDeadlineExpired');
  } else if (/^(payment\.|contract\.|asset\.share|external\.)/.test(requestedAction) && !consequentialActionsEnabled) {
    decision = 'deny';
    reasonCode = 'consequentialActionsDisabled';
    policyClass = 'server:feature-gate';
    flags.push('consequentialActionsDisabled');
  } else if (/^(payment\.|contract\.|asset\.share|external\.)/.test(requestedAction)) {
    decision = decision === 'deny' ? 'deny' : 'needsHuman';
    reasonCode = decision === 'deny' ? reasonCode : 'consequentialExternalCommitment';
    policyClass = 'server:consequential-action';
    flags.push('consequentialExternalCommitment');
  } else if (requestedAction.startsWith('email.')) {
    if (!externalEmailEnabled) {
      decision = 'deny';
      reasonCode = 'externalEmailDisabled';
      flags.push('externalEmailDisabled');
    }
    const recipientEmail = normalizedEmail(actionPayload.recipientEmail || input.recipientEmail);
    const contact = validEmail(recipientEmail) ? await store.getJson(externalContactPath(inboxId, recipientEmail)) : null;
    if (!contact?.approved || contact.blocked || !['outbound', 'both'].includes(contact.direction || 'both')) {
      decision = 'deny';
      reasonCode = 'externalContactNotApproved';
      flags.push('externalContactNotApproved');
    }
    policyClass = 'server:approved-external-contact';
  } else if (requestedAction.startsWith('calendar.')) {
    const connectors = await store.listJson(path.join('inboxes', inboxId, 'calendar-connectors'));
    if (!calendarWritesEnabled) {
      decision = 'deny';
      reasonCode = 'calendarWritesDisabled';
      flags.push('calendarWritesDisabled');
    } else if (!connectors.some(connector => connector.status === 'connected')) {
      decision = decision === 'deny' ? 'deny' : 'needsHuman';
      reasonCode = 'calendarConnectorUnavailable';
      flags.push('calendarConnectorUnavailable');
    } else {
      const startBoundary = minutesFromClock(caseRecord.constraints?.workingHoursStart);
      const endBoundary = minutesFromClock(caseRecord.constraints?.workingHoursEnd);
      const scheduleOptions = (caseRecord.proposals || []).filter(proposal => ['open', 'countered'].includes(proposal.status) && proposal.kind === 'schedule').flatMap(proposal => proposal.options.filter(option => !option.expired));
      for (const option of scheduleOptions) {
        const candidate = zonedMinutes(option.value?.start, option.value?.timezone || caseRecord.constraints?.timezone || 'UTC');
        if (candidate != null && ((startBoundary != null && candidate < startBoundary) || (endBoundary != null && candidate > endBoundary))) flags.push('outsideWorkingHours');
      }
      if (decision !== 'deny' && flags.includes('outsideWorkingHours')) {
        decision = 'needsHuman';
        reasonCode = 'outsideWorkingHours';
      }
    }
    policyClass = 'server:calendar-policy';
  }
  const now = store.now();
  const expiresAt = input.expiresAt && new Date(input.expiresAt) > new Date() ? input.expiresAt : new Date(Date.now() + 10 * 60_000).toISOString();
  return {
    decision,
    reasonCode,
    matchedPolicyId: `${policyClass}:${valueDigest({ requestedAction, requiredPermission, actionPayload, constraints: caseRecord.constraints, flags }).slice(0, 24)}`,
    expiresAt,
    binding: {
      caseId: caseRecord.id,
      agentId: agent.id,
      requestedAction,
      actionPayloadDigest: valueDigest(actionPayload),
      proposalDigest: valueDigest(caseRecord.proposals || []),
      allowedOptionIds: (caseRecord.proposals || []).flatMap(proposal => proposal.options.filter(option => !option.expired).map(option => option.id)),
      decision,
      reasonCode,
      flags,
      effectiveAt: now,
      expiresAt
    }
  };
}

const hasHumanApprovalForEvaluation = (caseRecord, evaluationId) => caseRecord.events.some(event =>
  event.type === 'humanAction'
  && event.payload?.action?.actionKey === 'approveOnce'
  && event.payload.action.externalRefs?.policyEvaluationId === evaluationId
);

async function validatedPolicyBinding(inboxId, caseRecord, principal, evaluationId, { requestedAction, actionPayload, proposalId, optionId, allowPendingHuman = false } = {}) {
  const evaluation = caseRecord.policyEvaluations.find(item => item.id === evaluationId);
  const binding = evaluation ? await store.getJson(policyBindingPath(inboxId, evaluation.id)) : null;
  if (!evaluation || !binding || evaluation.actor !== principal.id || binding.agentId !== principal.id || binding.caseId !== caseRecord.id) {
    throw Object.assign(new Error('A current server-issued policy evaluation for this agent and case is required'), { statusCode: 403 });
  }
  if (new Date(binding.expiresAt) <= new Date()) throw Object.assign(new Error('Policy evaluation has expired; request a new evaluation'), { statusCode: 409 });
  if (evaluation.decision === 'deny') throw Object.assign(new Error(`Policy denied this action: ${evaluation.reasonCode}`), { statusCode: 403 });
  const humanApproved = hasHumanApprovalForEvaluation(caseRecord, evaluation.id);
  if (evaluation.decision === 'needsHuman' && !humanApproved && !allowPendingHuman) {
    throw Object.assign(new Error('This action requires human approval'), { statusCode: 409 });
  }
  if (requestedAction && binding.requestedAction !== requestedAction) throw Object.assign(new Error('Policy evaluation does not authorize this action'), { statusCode: 403 });
  if (actionPayload && binding.actionPayloadDigest !== valueDigest(actionPayload)) throw Object.assign(new Error('Action payload changed after policy evaluation'), { statusCode: 409 });
  if (proposalId) {
    const proposal = caseRecord.proposals.find(item => item.id === proposalId);
    if (!proposal || binding.proposalDigest !== valueDigest(caseRecord.proposals || [])) throw Object.assign(new Error('Proposal changed after policy evaluation'), { statusCode: 409 });
    if (!binding.allowedOptionIds?.includes(optionId)) throw Object.assign(new Error('Policy evaluation does not authorize this proposal option'), { statusCode: 403 });
  }
  return { evaluation, binding, humanApproved };
}

async function ensureStructuredCase(inbox, input, actorAgentId, at) {
  const caseId = input.caseId || store.id('case');
  const existing = await getCase(inbox.id, caseId);
  if (existing?.schemaVersion) return existing;
  let value = createAgentCase({
    id: caseId,
    objective: input.objective || input.text?.slice(0, 160) || 'Agent communication',
    collaborationMode: input.collaborationMode || ({ proposal: 'negotiation', counterproposal: 'negotiation', knowledge: 'knowledgeSharing', artifact: 'artifactCreation' }[input.type] || 'collaboration'),
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

const permanentDeliveryError = message => Object.assign(new Error(message), { permanent: true });

async function enqueueNativeMessage(message, senderInbox, recipientInboxId, eventType = 'message.queued') {
  const queuedAt = store.now();
  const queued = { ...message, recipientInboxId, status: 'queued', queuedAt, updatedAt: queuedAt };
  const currentCase = await ensureStructuredCase(senderInbox, { ...queued, caseId: queued.caseId }, queued.senderAgentId, queued.createdAt);
  const queuedCase = setCaseMessageDeliveryState(structuredClone(currentCase), queued, 'queued', queuedAt);
  const auditEntry = await auditRecord(senderInbox.id, eventType, {
    messageId: queued.id,
    caseId: queued.caseId,
    conversationId: queued.conversationId,
    senderAgentId: queued.senderAgentId,
    recipientAgentId: queued.recipientAgentId,
    recipientEmail: queued.recipientEmail,
    senderInboxId: senderInbox.id,
    recipientInboxId
  }, queuedAt);
  const outbox = {
    id: `delivery_${queued.id}`,
    kind: 'nativeAgentMessage',
    messageId: queued.id,
    senderInboxId: senderInbox.id,
    recipientInboxId,
    orderingKey: queued.caseId,
    requestHash: queued.requestHash,
    status: 'queued',
    attempts: 0,
    maxAttempts: deliveryMaxAttempts,
    availableAt: queuedAt,
    createdAt: queued.createdAt,
    updatedAt: queuedAt
  };
  const delivery = await store.enqueueOutbox([
    document(messagePath(senderInbox.id, queued.id), queued),
    document(caseRecordPath(senderInbox.id, queuedCase.id), queuedCase),
    auditEntry.document
  ], outbox);
  if (delivery.requestHash && delivery.requestHash !== queued.requestHash) throw Object.assign(new Error('Idempotency key was already used for a different message'), { statusCode: 409 });
  publish(senderInbox.id, auditEntry.event);
  deliveryWorker.kick();
  return delivery.enqueueCreated ? queued : await store.getJson(messagePath(senderInbox.id, queued.id), queued);
}

async function deliverNativeAgentMessage(outbox) {
  const queued = await store.getJson(messagePath(outbox.senderInboxId, outbox.messageId));
  if (!queued) throw permanentDeliveryError('Queued message no longer exists');
  const directory = await store.getJson(path.join('directory', 'agents', `${queued.recipientAgentId}.json`));
  if (!directory || directory.status !== 'active' || directory.inboxId !== outbox.recipientInboxId) throw permanentDeliveryError('Recipient agent is unavailable');
  const recipient = await store.getJson(path.join('inboxes', directory.inboxId, 'agents', `${queued.recipientAgentId}.json`));
  if (!recipient || !hasPermission(recipient, 'receive_agent_messages')) throw permanentDeliveryError('Recipient is not approved to receive messages');
  const contact = await store.getJson(path.join('inboxes', directory.inboxId, 'contacts', `${queued.senderAgentId}.json`));
  const senderContact = await store.getJson(path.join('inboxes', outbox.senderInboxId, 'contacts', `${queued.recipientAgentId}.json`));
  if (contact?.blocked || senderContact?.blocked || contact?.approved !== true || senderContact?.approved !== true) throw permanentDeliveryError('The agent relationship is not approved for delivery');

  const deliveredAt = store.now();
  const delivered = { ...queued, status: 'delivered', deliveredAt };
  const receipt = {
    id: `delivery_receipt_${queued.id}_delivered`,
    type: 'delivery',
    messageId: queued.id,
    senderAgentId: queued.senderAgentId,
    recipientAgentId: queued.recipientAgentId,
    state: 'delivered',
    attempt: Number(outbox.attempts || 0) + 1,
    createdAt: deliveredAt
  };
  const documents = [];
  const events = [];
  for (const targetInboxId of new Set([outbox.senderInboxId, outbox.recipientInboxId])) {
    const targetInbox = await store.getJson(path.join('inboxes', targetInboxId, 'inbox.json'));
    if (!targetInbox) throw permanentDeliveryError('Delivery target workspace no longer exists');
    const currentCase = await ensureStructuredCase(targetInbox, { ...delivered, caseId: delivered.caseId }, delivered.senderAgentId, delivered.createdAt);
    const updatedCase = setCaseMessageDeliveryState(structuredClone(currentCase), delivered, 'delivered', deliveredAt);
    const auditEntry = await auditRecord(targetInboxId, 'message.delivered', {
      messageId: delivered.id,
      caseId: delivered.caseId,
      senderAgentId: delivered.senderAgentId,
      recipientAgentId: delivered.recipientAgentId,
      senderInboxId: outbox.senderInboxId,
      recipientInboxId: outbox.recipientInboxId,
      deliveryId: outbox.id
    }, deliveredAt);
    documents.push(
      document(messagePath(targetInboxId, delivered.id), delivered),
      document(caseRecordPath(targetInboxId, updatedCase.id), updatedCase),
      document(deliveryReceiptPath(targetInboxId, receipt.id), receipt),
      auditEntry.document
    );
    events.push({ inboxId: targetInboxId, event: auditEntry.event });
  }
  return { documents, result: { messageId: delivered.id, receiptId: receipt.id, deliveredAt }, events };
}

async function deliverExternalEmail(outbox) {
  emailTransport.assertReady();
  const queued = await store.getJson(messagePath(outbox.senderInboxId, outbox.messageId));
  if (!queued) throw permanentDeliveryError('Queued external email no longer exists');
  const sender = await store.getJson(path.join('inboxes', outbox.senderInboxId, 'agents', `${queued.senderAgentId}.json`));
  if (!sender || !hasPermission(sender, 'use_email_transport')) throw permanentDeliveryError('Sender is not approved to use external email');
  const contact = await store.getJson(externalContactPath(outbox.senderInboxId, queued.recipientEmail));
  if (!contact?.approved || contact.blocked || !['outbound', 'both'].includes(contact.direction || 'both')) throw permanentDeliveryError('External recipient is not an approved outbound contact');
  const externalAddress = publicEmailAddressForAgent(sender);
  if (!externalAddress) throw permanentDeliveryError('Sender has no configured public email address');
  const provider = await emailTransport.send({
    from: `${String(sender.name || sender.slug).replace(/[<>\r\n]/g, '')} <${externalAddress}>`,
    to: queued.recipientEmail,
    subject: queued.subject,
    text: queued.text,
    html: queued.html || undefined,
    replyTo: queued.replyAddress,
    idempotencyKey: `external-email/${queued.id}`
  });
  const acceptedAt = store.now();
  const accepted = { ...queued, status: 'accepted', externalDeliveryState: 'accepted', provider: provider.provider, providerMessageId: provider.providerMessageId, acceptedAt, updatedAt: acceptedAt };
  const receipt = { id: `delivery_receipt_${queued.id}_accepted`, type: 'email', transport: 'email', messageId: queued.id, senderAgentId: queued.senderAgentId, recipientEmail: queued.recipientEmail, state: 'accepted', provider: provider.provider, providerMessageId: provider.providerMessageId, attempt: Number(outbox.attempts || 0) + 1, createdAt: acceptedAt };
  const inbox = await store.getJson(path.join('inboxes', outbox.senderInboxId, 'inbox.json'));
  const currentCase = await ensureStructuredCase(inbox, { ...accepted, caseId: accepted.caseId }, accepted.senderAgentId, accepted.createdAt);
  const updatedCase = setCaseMessageDeliveryState(structuredClone(currentCase), accepted, 'accepted', acceptedAt);
  const auditEntry = await auditRecord(outbox.senderInboxId, 'email.accepted', { messageId: accepted.id, caseId: accepted.caseId, senderAgentId: accepted.senderAgentId, recipientEmail: accepted.recipientEmail, provider: provider.provider, providerMessageId: provider.providerMessageId, deliveryId: outbox.id }, acceptedAt);
  return {
    documents: [
      document(messagePath(outbox.senderInboxId, accepted.id), accepted),
      document(caseRecordPath(outbox.senderInboxId, updatedCase.id), updatedCase),
      document(deliveryReceiptPath(outbox.senderInboxId, receipt.id), receipt),
      document(path.join('email-provider-index', provider.provider, `${identityKey(provider.providerMessageId)}.json`), { inboxId: outbox.senderInboxId, messageId: accepted.id, providerMessageId: provider.providerMessageId }),
      auditEntry.document
    ],
    result: { messageId: accepted.id, receiptId: receipt.id, acceptedAt, ...provider },
    events: [{ inboxId: outbox.senderInboxId, event: auditEntry.event }]
  };
}

const emailEventState = type => ({
  'email.sent': 'accepted',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'retrying',
  'email.bounced': 'deadLettered',
  'email.complained': 'deadLettered',
  'email.failed': 'deadLettered',
  'email.suppressed': 'deadLettered'
}[type] || null);

async function processInboundEmail(event) {
  const inbound = await emailTransport.retrieveInbound(event.data?.email_id);
  const recipients = [...new Set([...(inbound.received_for || []), ...(inbound.to || [])].map(normalizedEmail).filter(Boolean))];
  let route = null;
  for (const recipient of recipients) {
    route = await store.getJson(replyAddressDirectoryPath(recipient));
    if (route) break;
  }
  if (!route?.inboxId || !route?.agentId) throw permanentDeliveryError('Inbound email is not addressed to a verified reply alias');
  const recipient = await store.getJson(path.join('inboxes', route.inboxId, 'agents', `${route.agentId}.json`));
  if (!recipient || !hasPermission(recipient, 'receive_agent_messages')) throw permanentDeliveryError('Inbound recipient is unavailable');
  const senderEmailMatch = String(inbound.from || '').match(/<([^<>]+)>\s*$/);
  const senderEmail = normalizedEmail(senderEmailMatch?.[1] || inbound.from);
  if (!validEmail(senderEmail)) throw permanentDeliveryError('Inbound sender address is invalid');
  const contact = await store.getJson(externalContactPath(route.inboxId, senderEmail));
  if (!contact?.approved || contact.blocked || !['inbound', 'both'].includes(contact.direction || 'both')) throw permanentDeliveryError('Inbound sender is not an approved contact');
  if (Array.isArray(inbound.attachments) && inbound.attachments.length) throw permanentDeliveryError('Inbound attachments remain quarantined until object scanning is configured');
  const inbox = await store.getJson(path.join('inboxes', route.inboxId, 'inbox.json'));
  if (!inbox) throw permanentDeliveryError('Inbound recipient workspace no longer exists');
  const messageId = `msg_email_${hashSecret(String(inbound.id || event.data?.email_id)).slice(0, 32)}`;
  const existing = await store.getJson(messagePath(route.inboxId, messageId));
  if (existing) return { documents: [], result: { messageId, replay: true }, events: [] };
  const createdAt = inbound.created_at || event.created_at || store.now();
  const externalParticipantId = `external_email_${hashSecret(senderEmail).slice(0, 24)}`;
  const message = {
    id: messageId,
    caseId: route.caseId || store.id('case'),
    inboxId: route.inboxId,
    transport: 'email',
    direction: 'inbound',
    senderType: 'externalHuman',
    senderEmail,
    senderDisplayName: String(inbound.from || senderEmail).replace(/\s*<[^<>]+>\s*$/, '').trim() || senderEmail,
    recipientAgentId: route.agentId,
    recipientEmail: recipients.find(address => address === route.address) || recipients[0],
    subject: String(inbound.subject || '(no subject)').slice(0, 200),
    type: 'email',
    text: String(inbound.text || '[HTML-only email retained by the configured provider]').slice(0, 500_000),
    payload: { provider: 'resend', providerMessageId: inbound.id, internetMessageId: inbound.message_id || null, attachmentCount: 0 },
    createdAt,
    receivedAt: store.now(),
    status: 'received',
    externalDeliveryState: 'received'
  };
  const currentCase = await ensureStructuredCase(inbox, { ...message, objective: message.subject }, recipient.id, createdAt);
  if (!currentCase.participants.includes(externalParticipantId)) currentCase.participants.push(externalParticipantId);
  appendEvent(currentCase, { id: `evt_${message.id}`, type: 'message', actor: externalParticipantId, createdAt, payload: { messageId: message.id, messageType: 'email', text: message.text, subject: message.subject, senderEmail, recipientAgentId: recipient.id, deliveryState: 'received' }, linkedPolicyEvaluation: null, precedingEventRef: currentCase.events.at(-1)?.id || null });
  const receipt = { id: `delivery_receipt_${message.id}_received`, type: 'email', transport: 'email', messageId: message.id, senderEmail, recipientAgentId: recipient.id, state: 'received', provider: 'resend', providerMessageId: inbound.id, createdAt: message.receivedAt };
  const auditEntry = await auditRecord(route.inboxId, 'email.received', { messageId: message.id, caseId: message.caseId, senderEmail, recipientAgentId: recipient.id, providerMessageId: inbound.id }, message.receivedAt);
  return { documents: [document(messagePath(route.inboxId, message.id), message), document(caseRecordPath(route.inboxId, currentCase.id), currentCase), document(deliveryReceiptPath(route.inboxId, receipt.id), receipt), auditEntry.document], result: { inboxId: route.inboxId, messageId: message.id, receiptId: receipt.id }, events: [{ inboxId: route.inboxId, event: auditEntry.event }] };
}

async function processOutboundEmailEvent(event) {
  const providerMessageId = event.data?.email_id;
  const state = emailEventState(event.type);
  if (!providerMessageId || !state) return { documents: [], result: { ignored: true }, events: [] };
  const index = await store.getJson(path.join('email-provider-index', 'resend', `${identityKey(providerMessageId)}.json`));
  if (!index) throw new Error('Provider message index is not available yet');
  const message = await store.getJson(messagePath(index.inboxId, index.messageId));
  if (!message) return { documents: [], result: { ignored: true, reason: 'unknown_message' }, events: [] };
  const at = event.created_at || store.now();
  const updated = { ...message, status: state, externalDeliveryState: event.type.slice('email.'.length), updatedAt: at, ...(state === 'delivered' ? { deliveredAt: at } : {}) };
  const inbox = await store.getJson(path.join('inboxes', index.inboxId, 'inbox.json'));
  const currentCase = await ensureStructuredCase(inbox, { ...updated, caseId: updated.caseId }, updated.senderAgentId, updated.createdAt);
  const updatedCase = setCaseMessageDeliveryState(structuredClone(currentCase), updated, state, at);
  const receipt = { id: `delivery_receipt_${updated.id}_${event.type.replaceAll('.', '_')}`, type: 'email', transport: 'email', messageId: updated.id, senderAgentId: updated.senderAgentId, recipientEmail: updated.recipientEmail, state: updated.externalDeliveryState, provider: 'resend', providerMessageId, createdAt: at };
  const auditEntry = await auditRecord(index.inboxId, event.type, { messageId: updated.id, caseId: updated.caseId, senderAgentId: updated.senderAgentId, recipientEmail: updated.recipientEmail, providerMessageId }, at);
  const documents = [document(messagePath(index.inboxId, updated.id), updated), document(caseRecordPath(index.inboxId, updatedCase.id), updatedCase), document(deliveryReceiptPath(index.inboxId, receipt.id), receipt), auditEntry.document];
  if (['email.complained', 'email.suppressed'].includes(event.type)) {
    const contact = await store.getJson(externalContactPath(index.inboxId, updated.recipientEmail));
    if (contact) documents.push(document(externalContactPath(index.inboxId, updated.recipientEmail), { ...contact, blocked: true, blockedReason: event.type, updatedAt: at }));
  }
  return { documents, result: { inboxId: index.inboxId, messageId: updated.id, state: updated.externalDeliveryState }, events: [{ inboxId: index.inboxId, event: auditEntry.event }] };
}

async function processEmailWebhook(outbox) {
  const event = outbox.emailEvent;
  if (!event?.type) throw permanentDeliveryError('Email webhook event is invalid');
  return event.type === 'email.received' ? processInboundEmail(event) : processOutboundEmailEvent(event);
}

async function deliverQueuedMessage(outbox) {
  if (outbox.kind === 'nativeAgentMessage') return deliverNativeAgentMessage(outbox);
  if (outbox.kind === 'externalEmail') return deliverExternalEmail(outbox);
  if (outbox.kind === 'emailWebhook') return processEmailWebhook(outbox);
  throw permanentDeliveryError(`Unsupported outbox kind: ${outbox.kind}`);
}

async function recordDeliveryFailure(outbox, error, { attempt, deadLettered }) {
  if (outbox.kind === 'emailWebhook') {
    if (!deadLettered) return { documents: [], events: [] };
    const at = store.now();
    const quarantine = {
      id: outbox.id,
      provider: outbox.provider,
      webhookId: outbox.webhookId,
      eventType: outbox.emailEvent?.type || null,
      providerMessageId: outbox.emailEvent?.data?.email_id || null,
      state: 'quarantined',
      reason: String(error?.message || error).slice(0, 1000),
      quarantinedAt: at
    };
    return { documents: [document(path.join('email-quarantine', `${outbox.id}.json`), quarantine)], events: [] };
  }
  const queued = await store.getJson(messagePath(outbox.senderInboxId, outbox.messageId));
  if (!queued) return { documents: [], events: [] };
  const at = store.now();
  const state = deadLettered ? 'deadLettered' : 'retrying';
  const failed = { ...queued, status: state, lastDeliveryError: String(error?.message || error).slice(0, 1000), deliveryAttempts: attempt, updatedAt: at };
  const documents = [document(messagePath(outbox.senderInboxId, failed.id), failed)];
  const events = [];
  const senderInbox = await store.getJson(path.join('inboxes', outbox.senderInboxId, 'inbox.json'));
  if (senderInbox) {
    const currentCase = await ensureStructuredCase(senderInbox, { ...failed, caseId: failed.caseId }, failed.senderAgentId, failed.createdAt);
    const updatedCase = setCaseMessageDeliveryState(structuredClone(currentCase), failed, state, at);
    documents.push(document(caseRecordPath(outbox.senderInboxId, updatedCase.id), updatedCase));
  }
  const auditEntry = await auditRecord(outbox.senderInboxId, deadLettered ? 'message.dead_lettered' : 'message.retry_scheduled', {
    messageId: failed.id,
    deliveryId: outbox.id,
    attempt,
    error: failed.lastDeliveryError
  }, at);
  documents.push(auditEntry.document);
  events.push({ inboxId: outbox.senderInboxId, event: auditEntry.event });
  if (deadLettered) {
    const receipt = {
      id: `delivery_receipt_${failed.id}_failed`,
      type: 'delivery',
      messageId: failed.id,
      senderAgentId: failed.senderAgentId,
      recipientAgentId: failed.recipientAgentId,
      state,
      attempt,
      error: failed.lastDeliveryError,
      createdAt: at
    };
    documents.push(document(deliveryReceiptPath(outbox.senderInboxId, receipt.id), receipt));
  }
  return { documents, events };
}

const deliveryWorker = new DeliveryWorker({
  store,
  deliver: deliverQueuedMessage,
  onFailure: recordDeliveryFailure,
  onSettled: async (_record, events) => {
    for (const { inboxId, event } of events) publish(inboxId, event);
  }
});

async function participantDirectoryForHuman(inbox, agents, cases) {
  const localAgents = new Map(agents.map(agent => [agent.id, agent]));
  const externalHumans = new Map();
  const ids = new Set();
  for (const value of cases) {
    [value.actingAgent, value.principal, ...(value.participants || [])].filter(Boolean).forEach(id => ids.add(id));
    for (const event of value.events || []) {
      [event.actor, event.payload?.senderAgentId, event.payload?.recipientAgentId, event.payload?.senderHumanId]
        .filter(Boolean)
        .forEach(id => ids.add(id));
      if (String(event.actor || '').startsWith('external_email_') && event.payload?.senderEmail) externalHumans.set(event.actor, event.payload.senderEmail);
    }
  }
  const entries = await Promise.all([...ids].slice(0, 500).map(async id => {
    const local = localAgents.get(id);
    if (local) return [id, { id, type: 'internalAgent', displayName: local.name, address: local.address, organizationId: local.organizationId || inbox.organizationId, inboxId: inbox.id, accessState: local.status === 'active' ? 'active' : 'unavailable' }];
    if (externalHumans.has(id)) {
      const email = externalHumans.get(id);
      const contact = await store.getJson(externalContactPath(inbox.id, email));
      return [id, { id, type: 'human', displayName: contact?.displayName || email, address: email, organizationId: null, inboxId: inbox.id, accessState: contact?.blocked ? 'revoked' : 'active' }];
    }
    if (id === inbox.ownerHumanId || String(id).startsWith('human_')) return [id, { id, type: 'human', displayName: id === inbox.ownerHumanId ? 'Human principal' : 'Human participant', address: null, organizationId: inbox.organizationId, inboxId: inbox.id, accessState: 'active' }];
    const directory = await store.getJson(path.join('directory', 'agents', `${id}.json`));
    if (!directory) return [id, { id, type: 'externalAgent', displayName: String(id), address: null, organizationId: null, inboxId: null, accessState: 'unavailable' }];
    const external = await store.getJson(path.join('inboxes', directory.inboxId, 'agents', `${id}.json`));
    return [id, { id, type: directory.inboxId === inbox.id ? 'internalAgent' : 'externalAgent', displayName: external?.name || directory.address || String(id), address: external?.address || directory.address || null, organizationId: external?.organizationId || null, inboxId: directory.inboxId, accessState: directory.status === 'active' ? 'active' : 'unavailable' }];
  }));
  return Object.fromEntries(entries);
}

async function humanView(inboxId, inbox) {
  const [agents, cases, messages, assets, events, deliveryReceipts, calendarConnectors, invitations, externalContacts] = await Promise.all([
    store.listJson(path.join('inboxes', inboxId, 'agents')),
    listCases(inboxId),
    listMessages(inboxId),
    store.listJson(path.join('inboxes', inboxId, 'assets')),
    store.listJson(path.join('inboxes', inboxId, 'events')),
    store.listJson(path.join('inboxes', inboxId, 'delivery-receipts')),
    store.listJson(path.join('inboxes', inboxId, 'calendar-connectors')),
    store.listJson(path.join('inboxes', inboxId, 'invitations')),
    store.listJson(path.join('inboxes', inboxId, 'external-contacts'))
  ]);
  const projection = projectWorkspaceForHuman(cases);
  const participantDirectory = await participantDirectoryForHuman(inbox, agents, cases);
  const projectedInvitations = invitations
    .map(invitation => ({
      ...invitation,
      direction: invitation.recipientInboxId === inboxId ? 'incoming' : 'outgoing',
      actionable: invitation.recipientInboxId === inboxId && invitation.state === 'pending'
    }))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const pendingInvitations = projectedInvitations.filter(invitation => invitation.actionable).length;
  return {
    inbox,
    mode: 'human-observer',
    capabilities: ['observe_agent_communications', 'receive_agent_messages', 'reply_to_approved_agents', 'review_assets', 'manage_calendar_connectors'],
    summary: { agents: agents.length, cases: cases.length, messages: messages.length, assets: assets.length, needsMe: projection.counts.needsMe + pendingInvitations },
    navigation: { ...projection.counts, needsMe: projection.counts.needsMe + pendingInvitations },
    caseQueue: projection.cases,
    participantDirectory,
    agents: agents.map(publicAgent),
    cases,
    messages,
    assets,
    calendarProviders: calendarProviderStatus(),
    calendarConnectors: calendarConnectors.map(publicCalendarConnector),
    invitations: projectedInvitations,
    contacts: externalContacts.sort((left, right) => String(left.email).localeCompare(String(right.email))),
    publicEmailTransport: publicEmailTransportProjection(agents, externalContacts),
    deliveryReceipts: deliveryReceipts.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    recentEvents: events.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100)
  };
}

async function agentView(inboxId, inbox, agentId) {
  const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
  if (!agent) return null;
  const [cases, messages, assets, deliveryReceipts, calendarConnectors] = await Promise.all([
    listCases(inboxId),
    listMessages(inboxId),
    store.listJson(path.join('inboxes', inboxId, 'assets')),
    store.listJson(path.join('inboxes', inboxId, 'delivery-receipts')),
    store.listJson(path.join('inboxes', inboxId, 'calendar-connectors'))
  ]);
  return {
    inbox,
    mode: 'agent-operator',
    agent: publicAgent(agent),
    capabilities: ['send_agent_messages', 'receive_agent_messages', 'create_assets', 'execute_cases', ...(calendarConnectors.some(item => item.status === 'connected') ? ['use_connected_calendar'] : [])],
    queue: {
      assignedMessages: messages.filter((item) => item.recipientAgentId === agentId),
      authoredMessages: messages.filter((item) => item.senderAgentId === agentId),
      activeCases: cases.filter((item) => item.status === 'active' && item.participantAgentIds?.includes(agentId)),
      createdAssets: assets.filter((item) => item.createdByAgentId === agentId),
      calendarConnectors: calendarConnectors.map(publicCalendarConnector),
      deliveryReceipts: deliveryReceipts.filter(item => item.senderAgentId === agentId || item.recipientAgentId === agentId)
    }
  };
}

async function route(req, res) {
  const responseNonce = crypto.randomBytes(18).toString('base64');
  applyHeaders(res, req.headers.origin || '', responseNonce);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  req.setTimeout(requestTimeoutMs);
  if (!consumeRateLimit(req, res, url.pathname)) return fail(res, 429, 'Request rate limit exceeded');
  const sessionCookieName = process.env.WORKOS_COOKIE_NAME || 'sinaloa_session';
  const csrfExempt = url.pathname === '/api/email-webhooks/resend' || url.pathname.startsWith('/api/object-storage/local-upload/');
  if (auth.provider === 'workos' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !csrfExempt && parseCookies(req.headers.cookie)[sessionCookieName] && !verifyCsrfRequest(req)) return fail(res, 403, 'CSRF validation failed');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/web/'))) {
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice('/web/'.length);
    const safePath = path.normalize(relative).replace(/^\.\.[\\/]/, '');
    const filePath = path.resolve('web', safePath);
    if (!filePath.startsWith(path.resolve('web'))) return fail(res, 400, 'Invalid asset path');
    const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
    try {
      const extension = path.extname(filePath);
      let content = await readFile(filePath);
      if (extension === '.html') content = Buffer.from(content.toString('utf8').replace('<script', `<script nonce="${responseNonce}"`).replace('<style', `<style nonce="${responseNonce}"`));
      res.writeHead(200, { 'content-type': contentTypes[extension] || 'application/octet-stream' });
      return res.end(content);
    }
    catch (error) { if (error.code === 'ENOENT') return fail(res, 404, 'Web asset not found'); throw error; }
  }
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'sinaloa', time: store.now(), mode: productionConfig.mode, configurationValidated: productionConfig.validated });
  if (req.method === 'GET' && url.pathname === '/ready') {
    const readiness = await readinessReport();
    return json(res, readiness.ready ? 200 : 503, readiness);
  }
  if (req.method === 'GET' && url.pathname === '/api/email-transport/status') return json(res, 200, { ...emailTransport.status(), enabled: externalEmailEnabled, internalAgentDomain: agentDomain, internalIdentityOnly: agentDomain === 'sinaloa.mail' });

  if (req.method === 'POST' && url.pathname === '/api/email-webhooks/resend') {
    if (!externalEmailEnabled) return fail(res, 404, 'External email transport is disabled');
    const raw = await rawBody(req);
    const emailEvent = emailTransport.verifyWebhook(raw, req.headers);
    const webhookId = String(req.headers['svix-id'] || '');
    if (!webhookId) return fail(res, 400, 'Webhook event ID is required');
    const createdAt = store.now();
    const queued = await store.enqueueOutbox([], {
      id: `email_webhook_${hashSecret(webhookId).slice(0, 40)}`,
      kind: 'emailWebhook',
      provider: 'resend',
      webhookId,
      emailEvent,
      senderInboxId: null,
      recipientInboxId: null,
      orderingKey: emailEvent.data?.email_id ? `provider-email:${emailEvent.data.email_id}` : `webhook:${webhookId}`,
      status: 'queued',
      attempts: 0,
      maxAttempts: deliveryMaxAttempts,
      availableAt: createdAt,
      createdAt,
      updatedAt: createdAt
    });
    deliveryWorker.kick();
    return json(res, queued.enqueueCreated ? 202 : 200, { accepted: true, replay: !queued.enqueueCreated, webhookId });
  }

  const localUploadRoute = url.pathname.match(/^\/api\/object-storage\/local-upload\/([^/]+)$/);
  if (req.method === 'PUT' && localUploadRoute && typeof objectStorageAdapter.putPresigned === 'function') {
    await objectStorageAdapter.putPresigned(localUploadRoute[1], await rawBuffer(req), { 'content-type': String(req.headers['content-type'] || ''), 'x-amz-checksum-sha256': String(req.headers['x-amz-checksum-sha256'] || '') });
    res.writeHead(204, { 'cache-control': 'no-store' });
    return res.end();
  }
  const localDownloadRoute = url.pathname.match(/^\/api\/object-storage\/local-download\/([^/]+)$/);
  if (req.method === 'GET' && localDownloadRoute && typeof objectStorageAdapter.getPresigned === 'function') {
    const content = await objectStorageAdapter.getPresigned(localDownloadRoute[1]);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(content.length), 'cache-control': 'private, max-age=60' });
    return res.end(content);
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/config') return json(res, 200, auth.config());

  if (req.method === 'POST' && url.pathname === '/api/agent-token') {
    const input = await body(req);
    if ((input.grantType || 'refresh_token') !== 'refresh_token') return fail(res, 400, 'Only refresh_token grant is supported');
    return json(res, 200, await rotateAgentCredentials(input.agentRefreshToken));
  }

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
    const csrfToken = createCsrfToken();
    return redirect(res, result.returnTo, { 'set-cookie': [sessionCookieHeader(result.sealedSession), csrfCookieHeader(csrfToken)] });
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
    if (auth.provider === 'workos') res.setHeader('set-cookie', [sessionCookieHeader('', { clear: true }), csrfCookieHeader('', { clear: true })]);
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

  const calendarCallback = url.pathname.match(/^\/api\/calendar-oauth\/(google|outlook)\/callback$/);
  if (req.method === 'GET' && calendarCallback) {
    const providerId = calendarCallback[1];
    const provider = calendarProviders[providerId];
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!state || !code || url.searchParams.get('error')) return fail(res, 400, 'Calendar authorization was not completed');
    const statePath = path.join('auth', 'calendar-oauth', `${hashSecret(state)}.json`);
    const pending = await store.getJson(statePath);
    if (!pending || pending.provider !== providerId || pending.usedAt || new Date(pending.expiresAt) <= new Date()) return fail(res, 400, 'Calendar authorization state is invalid or expired');
    if (!provider.clientId || !provider.clientSecret) return fail(res, 503, `${provider.label} is not configured`);
    const claimed = await store.claimJson(statePath, 'usedAt', store.now());
    if (!claimed) return fail(res, 400, 'Calendar authorization state was already used');
    const tokenResponse = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: provider.clientId, client_secret: provider.clientSecret, redirect_uri: calendarRedirectUri(providerId, req), grant_type: 'authorization_code' })
    });
    const tokenSet = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenSet.access_token) return fail(res, 502, `${provider.label} token exchange failed`);
    const connectedAt = store.now();
    const connector = {
      id: `calendar_${providerId}`,
      provider: providerId,
      label: provider.label,
      status: 'connected',
      accountLabel: tokenAccountLabel(tokenSet),
      scopes: String(tokenSet.scope || provider.scopes.join(' ')).split(/\s+/).filter(Boolean),
      expiresAt: tokenSet.expires_in ? new Date(Date.now() + Number(tokenSet.expires_in) * 1000).toISOString() : null,
      refreshTokenPresent: Boolean(tokenSet.refresh_token),
      connectedByHumanId: pending.humanId,
      connectedAt,
      updatedAt: connectedAt,
      tokenSetEncrypted: encryptConnectorTokens(tokenSet)
    };
    await store.putJson(calendarConnectorPath(pending.inboxId, providerId), connector);
    await audit(pending.inboxId, 'calendar.connected', { provider: providerId, humanId: pending.humanId });
    const returnUrl = new URL(pending.returnTo || '/', process.env.SINALOA_PUBLIC_URL || `http://${req.headers.host || `${host}:${port}`}`);
    returnUrl.searchParams.set('calendarConnected', providerId);
    return redirect(res, returnUrl.toString());
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-enroll') {
    const input = await body(req);
    if (!input.enrollmentToken) return fail(res, 400, 'enrollmentToken is required');
    const tokenHash = hashSecret(input.enrollmentToken);
    const tokenPath = path.join('auth', 'enrollment-tokens', `${tokenHash}.json`);
    const pendingRecord = await store.getJson(tokenPath);
    if (!pendingRecord || pendingRecord.usedAt || new Date(pendingRecord.expiresAt) <= new Date()) return fail(res, 401, 'Enrollment token is invalid, expired, or already used');
    const sourceInbox = await store.getJson(path.join('inboxes', pendingRecord.inboxId, 'inbox.json'));
    if (!sourceInbox || (sourceInbox.ownerHumanId !== pendingRecord.humanId && !await getMembership(sourceInbox.organizationId, pendingRecord.humanId))) return fail(res, 403, 'Enrollment owner is invalid');
    const agentName = String(input.name || pendingRecord.agentProfile?.name || '').trim();
    if (!agentName) return fail(res, 400, 'Agent name is required');
    const record = await store.claimJson(tokenPath, 'usedAt', store.now());
    if (!record) return fail(res, 401, 'Enrollment token is invalid, expired, or already used');
    const baseSlug = slugify(input.slug || record.agentProfile?.slug || agentName) || store.id('agent').replace('agent_', '');
    let slug = baseSlug;
    let address = `${slug}@${agentDomain}`;
    while (!(await reserveIdentity(address, { status: 'reserved' }))) { slug = `${baseSlug}-${store.id('slug').slice(-6)}`; address = `${slug}@${agentDomain}`; }
    const createdAt = store.now();
    const agent = { id: store.id('agent'), organizationId: sourceInbox.organizationId, name: agentName, slug, address, identity: publicIdentity(slug), principalHumanId: record.humanId, capabilities: input.capabilities || record.agentProfile?.capabilities || [], permissions: record.permissions, createdAt, status: 'active', onboardingStatus: 'approved', approvedAt: createdAt, approvedByHumanId: record.humanId };
    const inbox = await createDedicatedAgentInbox({ sourceInbox, organizationId: sourceInbox.organizationId, ownerHumanId: record.humanId, agent, status: 'active' });
    await store.putJsonBatch([
      document(path.join('directory', 'agents', `${agent.id}.json`), { agentId: agent.id, inboxId: inbox.id, address: agent.address, externalAddress: externalEmailEnabled ? publicEmailAddressForAgent(agent) : null, status: agent.status, verified: true }),
      document(nativeAddressDirectoryPath(agent.address), { agentId: agent.id, inboxId: inbox.id, address: agent.address, status: agent.status, verified: true })
    ]);
    if (externalEmailEnabled && publicEmailAddressForAgent(agent)) await store.putJson(externalAddressDirectoryPath(publicEmailAddressForAgent(agent)), { agentId: agent.id, inboxId: inbox.id, address: publicEmailAddressForAgent(agent), status: agent.status });
    const credentials = await issueAgentCredentials(agent.id, inbox.id);
    await audit(inbox.id, 'agent.enrolled', { agentId: agent.id, humanId: record.humanId, permissions: agent.permissions, sourceInboxId: sourceInbox.id });
    await audit(sourceInbox.id, 'agent.inbox_created', { agentId: agent.id, inboxId: inbox.id, humanId: record.humanId });
    return json(res, 201, { agent: publicAgent(agent), ...credentials, inbox, nativeMessaging: 'ready' });
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
    const agent = { id: store.id('agent'), name: input.name, slug, address, identity: publicIdentity(slug), principalLabel: input.principalLabel || null, principalHumanId: input.humanId, capabilities: input.capabilities || [], permissions: [], description: input.description || null, createdAt, status: 'pending_approval', onboardingStatus: 'pending_approval' };
    const inbox = { id: inboxId, organizationId: organization.id, name: input.inboxName || `${input.name} inbox`, ownerAgentId: agent.id, ownerHumanId: input.humanId, parentInboxId: null, kind: 'agent', status: 'pending_approval', createdAt };
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
    const inbox = { id: inboxId, organizationId: organization.id, name: input.name || 'Agent workspace', ownerAgentId: null, ownerHumanId: human.id, parentInboxId: null, kind: 'workspace', status: 'setup', createdAt: store.now() };
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

  if (req.method === 'GET' && suffix === 'calendar-connectors') {
    const human = await auth.getHuman(req);
    if (!await canAccessInbox(human, inbox)) return fail(res, 403, 'Workspace membership required');
    const connectors = await store.listJson(path.join('inboxes', inboxId, 'calendar-connectors'));
    return json(res, 200, { providers: calendarProviderStatus(), connectors: connectors.map(publicCalendarConnector) });
  }

  const calendarConnectorRoute = suffix.match(/^calendar-connectors\/(google|outlook)\/(connect|disconnect)$/);
  if (req.method === 'POST' && calendarConnectorRoute) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const [, providerId, action] = calendarConnectorRoute;
    const provider = calendarProviders[providerId];
    if (action === 'disconnect') {
      const existing = await store.getJson(calendarConnectorPath(inboxId, providerId));
      if (!existing) return fail(res, 404, 'Calendar connector not found');
      const disconnected = { ...existing, status: 'disconnected', tokenSetEncrypted: null, refreshTokenPresent: false, updatedAt: store.now(), disconnectedAt: store.now(), disconnectedByHumanId: human.id };
      await store.putJson(calendarConnectorPath(inboxId, providerId), disconnected);
      await audit(inboxId, 'calendar.disconnected', { provider: providerId, humanId: human.id });
      return json(res, 200, publicCalendarConnector(disconnected));
    }
    if (!provider.clientId || !provider.clientSecret) return fail(res, 503, `${provider.label} is not configured`);
    const state = crypto.randomBytes(32).toString('base64url');
    const publicUrl = (process.env.SINALOA_PUBLIC_URL || `http://${req.headers.host || `${host}:${port}`}`).replace(/\/$/, '');
    const stateRecord = { provider: providerId, inboxId, humanId: human.id, returnTo: `${publicUrl}/?workspace=${encodeURIComponent(inboxId)}`, createdAt: store.now(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), usedAt: null };
    await store.putJson(path.join('auth', 'calendar-oauth', `${hashSecret(state)}.json`), stateRecord);
    const authorizationUrl = new URL(provider.authorizeUrl);
    authorizationUrl.searchParams.set('client_id', provider.clientId);
    authorizationUrl.searchParams.set('redirect_uri', calendarRedirectUri(providerId, req));
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('scope', provider.scopes.join(' '));
    authorizationUrl.searchParams.set('state', state);
    if (providerId === 'google') {
      authorizationUrl.searchParams.set('access_type', 'offline');
      authorizationUrl.searchParams.set('include_granted_scopes', 'true');
      authorizationUrl.searchParams.set('prompt', 'consent');
    } else {
      authorizationUrl.searchParams.set('response_mode', 'query');
    }
    await audit(inboxId, 'calendar.connection_started', { provider: providerId, humanId: human.id });
    return json(res, 201, { provider: providerId, authorizationUrl: authorizationUrl.toString(), expiresAt: stateRecord.expiresAt });
  }

  if (req.method === 'GET' && suffix === 'email-transport') {
    const contacts = await store.listJson(path.join('inboxes', inboxId, 'external-contacts'));
    const agents = await store.listJson(path.join('inboxes', inboxId, 'agents'));
    return json(res, 200, publicEmailTransportProjection(agents, contacts));
  }

  if (req.method === 'GET' && suffix === 'external-contacts') {
    const contacts = await store.listJson(path.join('inboxes', inboxId, 'external-contacts'));
    return json(res, 200, contacts.sort((left, right) => String(left.email).localeCompare(String(right.email))));
  }

  if (req.method === 'POST' && suffix === 'external-contacts') {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const input = await body(req);
    const email = normalizedEmail(input.email);
    if (!validEmail(email)) return fail(res, 400, 'A valid external email address is required');
    if (emailTransport.publicDomain && email.endsWith(`@${emailTransport.publicDomain}`)) return fail(res, 400, 'Sinaloa agents must communicate over the native transport');
    const direction = input.direction || 'both';
    if (!['inbound', 'outbound', 'both'].includes(direction)) return fail(res, 400, 'direction must be inbound, outbound, or both');
    const existing = await store.getJson(externalContactPath(inboxId, email));
    const now = store.now();
    const contact = { id: `external_contact_${externalContactKey(email)}`, type: 'externalHuman', email, displayName: String(input.displayName || existing?.displayName || email).trim().slice(0, 120), direction, approved: true, blocked: false, approvedByHumanId: human.id, approvedAt: existing?.approvedAt || now, createdAt: existing?.createdAt || now, updatedAt: now };
    await store.putJson(externalContactPath(inboxId, email), contact);
    await audit(inboxId, existing ? 'external_contact.updated' : 'external_contact.approved', { contactId: contact.id, email, direction, humanId: human.id });
    return json(res, existing ? 200 : 201, contact);
  }

  const externalContactControl = suffix.match(/^external-contacts\/(external_contact_[a-f0-9]{40})\/(block|unblock)$/);
  if (req.method === 'POST' && externalContactControl) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const contacts = await store.listJson(path.join('inboxes', inboxId, 'external-contacts'));
    const contact = contacts.find(item => item.id === externalContactControl[1]);
    if (!contact) return fail(res, 404, 'External contact not found');
    const blocked = externalContactControl[2] === 'block';
    const updated = { ...contact, blocked, blockedReason: blocked ? 'human_control' : null, updatedAt: store.now() };
    await store.putJson(externalContactPath(inboxId, contact.email), updated);
    await audit(inboxId, blocked ? 'external_contact.blocked' : 'external_contact.unblocked', { contactId: contact.id, email: contact.email, humanId: human.id });
    return json(res, 200, updated);
  }

  if (req.method === 'GET' && suffix === 'events/delta') {
    const human = await auth.getHuman(req);
    const agent = await getAgentPrincipal(req, inboxId);
    if (!await canAccessInbox(human, inbox) && !agent) return fail(res, 401, 'Authenticated inbox participant required');
    const cursor = url.searchParams.get('cursor') || '';
    if (cursor.length > 512) return fail(res, 400, 'Event cursor is invalid');
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 100, 200));
    const matching = (await listStreamEvents(inboxId)).filter(event => !cursor || event.cursor > cursor);
    const events = matching.slice(0, limit);
    return json(res, 200, {
      events,
      nextCursor: events.at(-1)?.cursor || cursor || null,
      hasMore: matching.length > events.length
    });
  }

  if (req.method === 'GET' && suffix === 'events') {
    const human = await auth.getHuman(req);
    const agent = await getAgentPrincipal(req, inboxId);
    if (!await canAccessInbox(human, inbox) && !agent) return fail(res, 401, 'Authenticated inbox participant required');
    const cursor = String(req.headers['last-event-id'] || url.searchParams.get('cursor') || '');
    if (cursor.length > 512) return fail(res, 400, 'Event cursor is invalid');
    const connectionKey = rateIdentity(req);
    if (Number(sseCounts.get(connectionKey) || 0) >= maxSsePerPrincipal) return fail(res, 429, 'Too many concurrent event streams');
    sseCounts.set(connectionKey, Number(sseCounts.get(connectionKey) || 0) + 1);
    req.setTimeout(0);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const subscription = { res, cursor, sentIds: new Set(), heartbeat: null };
    for (const event of (await listStreamEvents(inboxId)).filter(event => !cursor || event.cursor > cursor)) sendStreamEvent(subscription, event);
    res.write(`event: ready\ndata: ${JSON.stringify({ inboxId, at: store.now(), cursor: subscription.cursor || cursor || null })}\n\n`);
    const set = streams.get(inboxId) || new Set(); set.add(subscription); streams.set(inboxId, set);
    for (const event of (await listStreamEvents(inboxId)).filter(event => !subscription.cursor || event.cursor > subscription.cursor)) sendStreamEvent(subscription, event);
    subscription.heartbeat = setInterval(() => res.write(`: keepalive ${store.now()}\n\n`), 20_000);
    subscription.heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(subscription.heartbeat);
      set.delete(subscription);
      if (!set.size) streams.delete(inboxId);
      const remaining = Math.max(0, Number(sseCounts.get(connectionKey) || 1) - 1);
      if (remaining) sseCounts.set(connectionKey, remaining); else sseCounts.delete(connectionKey);
    });
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
    if (!await reserveIdentity(address, { status: 'reserved' })) return fail(res, 409, 'Agent email address is already registered');
    const agent = { id: input.id || store.id('agent'), name: input.name, slug, address, identity: publicIdentity(slug), principalHumanId: input.humanId, capabilities: input.capabilities || [], permissions: [], createdAt: store.now(), status: 'pending_approval', onboardingStatus: 'pending_approval' };
    const agentInbox = await createDedicatedAgentInbox({ sourceInbox: inbox, organizationId: inbox.organizationId, ownerHumanId: input.humanId, agent });
    await audit(agentInbox.id, 'agent.created', { agentId: agent.id, sourceInboxId: inbox.id });
    await audit(inbox.id, 'agent.inbox_created', { agentId: agent.id, inboxId: agentInbox.id, humanId: input.humanId });
    return json(res, 201, { agent: publicAgent(agent), inbox: agentInbox });
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
    if (!await reserveIdentity(address, { status: 'reserved' })) return fail(res, 409, 'Agent email address is already registered');
    if (!input.humanId) return fail(res, 400, 'humanId is required so a human can approve the agent');
    const agent = { id: store.id('agent'), name: input.name, slug, address, identity: publicIdentity(slug), principalLabel: input.principalLabel || null, principalHumanId: input.humanId, capabilities: input.capabilities || [], permissions: [], description: input.description || null, createdAt: store.now(), status: 'pending_approval', onboardingStatus: 'pending_approval' };
    const agentInbox = await createDedicatedAgentInbox({ sourceInbox: inbox, organizationId: inbox.organizationId, ownerHumanId: input.humanId, agent });
    await audit(agentInbox.id, 'agent.onboarded', { agentId: agent.id, address: agent.address, identityStatus: agent.identity.status, sourceInboxId: inbox.id });
    await audit(inbox.id, 'agent.inbox_created', { agentId: agent.id, inboxId: agentInbox.id, humanId: input.humanId });
    return json(res, 201, { agent: publicAgent(agent), inbox: agentInbox, next: { nativeMessaging: 'pending_human_approval', humanApproval: { required: true, humanId: input.humanId }, externalEmail: 'requires_email_transport_configuration' } });
  }

  if (req.method === 'GET' && suffix === 'agents') return json(res, 200, (await store.listJson(path.join('inboxes', inboxId, 'agents'))).map(publicAgent));

  const blockMatch = suffix.match(/^contacts\/([^/]+)\/(block|unblock)$/);
  if (req.method === 'POST' && blockMatch) {
    const human = await auth.getHuman(req);
    const principal = await getAgentPrincipal(req, inboxId);
    if (!await canManageInbox(human, inbox) && principal?.id !== inbox.ownerAgentId) return fail(res, 403, 'Workspace administrator or inbox-owning agent required');
    const [, agentId, action] = blockMatch;
    const existing = await store.getJson(path.join('inboxes', inboxId, 'contacts', `${agentId}.json`), { agentId, approved: true });
    const contact = { ...existing, agentId, blocked: action === 'block', updatedAt: store.now() };
    await store.putJson(path.join('inboxes', inboxId, 'contacts', `${agentId}.json`), contact);
    await audit(inboxId, `contact.${action}ed`, { agentId, actor: human?.id || principal.id });
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
    let credentials = null;
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
      credentials = await issueAgentCredentials(agent.id, inboxId);
      await store.putJsonBatch([
        document(path.join('directory', 'agents', `${agent.id}.json`), { agentId: agent.id, inboxId, address: agent.address, externalAddress: externalEmailEnabled ? publicEmailAddressForAgent(agent) : null, status: agent.status, verified: true }),
        document(nativeAddressDirectoryPath(agent.address), { agentId: agent.id, inboxId, address: agent.address, status: agent.status, verified: true })
      ]);
      if (externalEmailEnabled && publicEmailAddressForAgent(agent)) await store.putJson(externalAddressDirectoryPath(publicEmailAddressForAgent(agent)), { agentId: agent.id, inboxId, address: publicEmailAddressForAgent(agent), status: agent.status });
      inbox.status = 'active';
      await store.putJson(path.join('inboxes', inboxId, 'inbox.json'), inbox);
    }
    agent.approvedAt = store.now();
    agent.approvedByHumanId = human.id;
    await store.putJson(path.join('inboxes', inboxId, 'agents', `${agent.id}.json`), agent);
    await audit(inboxId, `agent.onboarding_${decision}ed`, { agentId: agent.id, humanId: human.id, permissions: agent.permissions });
    return json(res, 200, { agent: publicAgent(agent), ...(credentials || {}) });
  }

  const revokeAgentCredentials = suffix.match(/^agents\/([^/]+)\/credentials\/revoke$/);
  if (req.method === 'POST' && revokeAgentCredentials) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const agentId = revokeAgentCredentials[1];
    const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
    if (!agent) return fail(res, 404, 'Agent not found');
    const revokedAt = store.now();
    const families = await store.listJson(path.join('auth', 'agent-credential-families', inboxId, agentId));
    await store.putJsonBatch(families.map(family => document(agentCredentialFamilyPath(inboxId, agentId, family.id), { ...family, revokedAt, revokedByHumanId: human.id, updatedAt: revokedAt })));
    await audit(inboxId, 'agent.credentials_revoked', { agentId, humanId: human.id, credentialFamilyCount: families.length });
    return json(res, 200, { revoked: true, agentId, credentialFamilyCount: families.length, revokedAt });
  }

  if (req.method === 'POST' && suffix === 'cases') {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !hasPermission(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    if (!String(input.objective || '').trim()) return fail(res, 400, 'A structured case objective is required');
    const now = store.now();
    const value = createAgentCase({ id: input.id || store.id('case'), objective: input.objective, collaborationMode: input.collaborationMode || 'collaboration', principal: inbox.ownerHumanId, actingAgent: principal.id, participants: input.participants || [], constraints: input.constraints || {}, deadline: input.deadline || null, createdAt: now });
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
    if (!input.requestedAction) return fail(res, 400, 'requestedAction is required');
    const value = await getCase(inboxId, caseRoute[1]);
    if (!value?.schemaVersion) return fail(res, 404, 'Structured case not found');
    const now = store.now();
    const evaluated = await evaluateServerPolicy(inboxId, principal, value, input);
    const evaluation = policyEvaluationFromInput({
      id: input.id,
      requestedAction: input.requestedAction,
      decision: evaluated.decision,
      matchedPolicyId: evaluated.matchedPolicyId,
      grantType: 'oneTime',
      expiresAt: evaluated.expiresAt,
      reasonCode: evaluated.reasonCode
    }, principal.id, now);
    const updated = addPolicyEvaluation(value, evaluation, { at: now });
    await store.putJsonBatch([
      document(caseRecordPath(inboxId, updated.id), updated),
      document(policyBindingPath(inboxId, evaluation.id), { ...evaluated.binding, id: evaluation.id, matchedPolicyId: evaluation.matchedPolicyId })
    ]);
    await audit(inboxId, 'policy.evaluated', { caseId: value.id, policyEvaluationId: evaluation.id, requestedAction: evaluation.requestedAction, decision: evaluation.decision, reasonCode: evaluation.reasonCode });
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
      if (input.actionKey === 'approveOnce') {
        const evaluationId = input.externalRefs?.policyEvaluationId;
        const evaluation = value.policyEvaluations.find(item => item.id === evaluationId);
        const binding = evaluation ? await store.getJson(policyBindingPath(inboxId, evaluationId)) : null;
        if (!evaluationId || !evaluation || !binding || evaluation.decision !== 'needsHuman' || new Date(binding.expiresAt) <= new Date()) return fail(res, 409, 'A current needsHuman policy evaluation is required for one-time approval');
      }
      result = applyHumanAction(value, { id: input.id || store.id('action'), actionKey: input.actionKey, actor: human.id, idempotencyKey, externalRefs: input.externalRefs || {}, reasonCode: input.reasonCode || null }, { at: now });
    } else if (principal && principal.id === value.actingAgent) {
      let policyExternalRefs = input.externalRefs || {};
      if (consequentialAction(input.actionKey)) {
        if (!input.policyEvaluationId) return fail(res, 400, 'policyEvaluationId is required for consequential agent actions');
        await validatedPolicyBinding(inboxId, value, principal, input.policyEvaluationId, { requestedAction: input.actionKey, actionPayload: input.actionPayload || {} });
        policyExternalRefs = { ...policyExternalRefs, policyEvaluationId: input.policyEvaluationId };
      }
      result = applyAgentAction(value, { id: input.id || store.id('action'), actionKey: input.actionKey, actor: principal.id, idempotencyKey, outcome: input.outcome, externalRefs: policyExternalRefs, reasonCode: input.reasonCode || null }, { at: now, nextState: input.nextState || null });
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
      appendEvent(updated, { id: store.id('evt'), type: 'decision', actor: principal.id, createdAt: now, payload: { proposalId: proposalRoute[2], status: 'countered', messageType: 'counterproposal' }, linkedPolicyEvaluation: null, precedingEventRef: updated.events.at(-1)?.id || null });
      await saveCase(inboxId, updated);
      await audit(inboxId, 'proposal.countered', { caseId: value.id, proposalId: proposalRoute[2], actor: principal.id });
      return json(res, 201, updated.proposals.find(item => item.id === proposalRoute[2]));
    }
    const idempotencyKey = req.headers['idempotency-key'] || input.idempotencyKey;
    if (!idempotencyKey || !input.optionId || !input.policyEvaluationId) return fail(res, 400, 'optionId, policyEvaluationId, and Idempotency-Key are required');
    const evaluation = value.policyEvaluations.find(item => item.id === input.policyEvaluationId);
    if (!evaluation || evaluation.actor !== principal.id) return fail(res, 403, 'A case policy evaluation for this agent is required');
    const authorization = await validatedPolicyBinding(inboxId, value, principal, evaluation.id, { proposalId: proposalRoute[2], optionId: input.optionId, allowPendingHuman: true });
    const effectiveEvaluation = evaluation.decision === 'needsHuman' && authorization.humanApproved ? { ...evaluation, decision: 'allow', reasonCode: 'humanApproved' } : evaluation;
    const result = acceptProposal(value, proposalRoute[2], input.optionId, effectiveEvaluation, { actor: principal.id, idempotencyKey, actionId: input.id || store.id('action'), at: now });
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
  if (req.method === 'GET' && suffix === 'delivery-receipts') {
    const receipts = await store.listJson(path.join('inboxes', inboxId, 'delivery-receipts'));
    return json(res, 200, receipts.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  }
  if (req.method === 'GET' && suffix === 'deliveries') {
    const human = await auth.getHuman(req);
    const agent = await getAgentPrincipal(req, inboxId);
    let deliveries = await store.queryOutbox({ inboxId, status: url.searchParams.get('status'), limit: url.searchParams.get('limit') });
    if (!human && agent) {
      const visible = [];
      for (const delivery of deliveries) {
        const message = await store.getJson(messagePath(delivery.senderInboxId, delivery.messageId));
        if (message && [message.senderAgentId, message.recipientAgentId].includes(agent.id)) visible.push(delivery);
      }
      deliveries = visible;
    }
    return json(res, 200, deliveries);
  }

  const retryDeliveryRoute = suffix.match(/^deliveries\/([^/]+)\/retry$/);
  if (req.method === 'POST' && retryDeliveryRoute) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const existingDelivery = await store.getOutbox(retryDeliveryRoute[1]);
    if (!existingDelivery || ![existingDelivery.senderInboxId, existingDelivery.recipientInboxId].includes(inboxId)) return fail(res, 404, 'Delivery not found');
    if (existingDelivery.status !== 'deadLettered') return fail(res, 409, 'Only dead-lettered deliveries can be retried');
    const message = await store.getJson(messagePath(existingDelivery.senderInboxId, existingDelivery.messageId));
    const at = store.now();
    const queued = message ? { ...message, status: 'queued', queuedAt: at, updatedAt: at, lastDeliveryError: null, deliveryAttempts: 0 } : null;
    const auditEntry = await auditRecord(existingDelivery.senderInboxId, 'message.dead_letter_requeued', { messageId: existingDelivery.messageId, deliveryId: existingDelivery.id, actor: human.id }, at);
    const documents = [auditEntry.document, ...(queued ? [document(messagePath(existingDelivery.senderInboxId, queued.id), queued)] : [])];
    if (queued) {
      const senderInbox = await store.getJson(path.join('inboxes', existingDelivery.senderInboxId, 'inbox.json'));
      if (senderInbox) {
        const currentCase = await ensureStructuredCase(senderInbox, { ...queued, caseId: queued.caseId }, queued.senderAgentId, queued.createdAt);
        const updatedCase = setCaseMessageDeliveryState(structuredClone(currentCase), queued, 'queued', at);
        documents.push(document(caseRecordPath(existingDelivery.senderInboxId, updatedCase.id), updatedCase));
      }
    }
    const retried = await store.retryOutbox(existingDelivery.id, documents);
    if (!retried) return fail(res, 409, 'Delivery could not be retried');
    publish(existingDelivery.senderInboxId, auditEntry.event);
    deliveryWorker.kick();
    return json(res, 202, retried);
  }

  if (req.method === 'GET' && suffix === 'invitations') {
    const human = await auth.getHuman(req);
    const principal = await getAgentPrincipal(req, inboxId);
    if (!await canAccessInbox(human, inbox) && principal?.id !== inbox.ownerAgentId) return fail(res, 403, 'Authenticated inbox participant required');
    const invitations = await store.listJson(path.join('inboxes', inboxId, 'invitations'));
    return json(res, 200, invitations.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))));
  }

  const invitationDecision = suffix.match(/^invitations\/([^/]+)\/(accept|decline)$/);
  if (req.method === 'POST' && invitationDecision) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Recipient workspace administrator required');
    const [, invitationId, decision] = invitationDecision;
    const invitation = await store.getJson(invitationPath(inboxId, invitationId));
    if (!invitation || invitation.recipientInboxId !== inboxId) return fail(res, 404, 'Invitation not found');
    if (!['pending', decision === 'accept' ? 'accepted' : 'declined'].includes(invitation.state)) return fail(res, 409, `Invitation is already ${invitation.state}`);
    const now = store.now();
    const senderInbox = await store.getJson(path.join('inboxes', invitation.senderInboxId, 'inbox.json'));
    const pendingMessage = await store.getJson(messagePath(invitation.senderInboxId, invitation.messageId));
    if (!senderInbox || !pendingMessage) return fail(res, 409, 'Invitation message is no longer available');
    if (decision === 'decline') {
      const declined = { ...invitation, state: 'declined', declinedAt: invitation.declinedAt || now, decidedByHumanId: human.id, updatedAt: now };
      const message = { ...pendingMessage, status: 'declined', updatedAt: now };
      await store.putJsonBatch([
        document(invitationPath(inboxId, invitation.id), declined),
        document(invitationPath(invitation.senderInboxId, invitation.id), declined),
        document(messagePath(invitation.senderInboxId, message.id), message),
        document(path.join('inboxes', inboxId, 'contacts', `${invitation.senderAgentId}.json`), { agentId: invitation.senderAgentId, email: invitation.fromAddress, state: 'declined', approved: false, blocked: false, updatedAt: now })
      ]);
      await audit(inboxId, 'invitation.declined', { invitationId: invitation.id, senderAgentId: invitation.senderAgentId, humanId: human.id });
      return json(res, 200, declined);
    }
    const conversationId = invitation.conversationId || invitation.pendingConversationId || store.id('conversation');
    const accepted = { ...invitation, state: 'accepted', conversationId, acceptedAt: invitation.acceptedAt || now, decidedByHumanId: human.id, updatedAt: now };
    const senderContact = { agentId: invitation.recipientAgentId, email: invitation.toAddress, state: 'accepted', approved: true, blocked: false, conversationId, updatedAt: now };
    const recipientContact = { agentId: invitation.senderAgentId, email: invitation.fromAddress, state: 'accepted', approved: true, blocked: false, conversationId, updatedAt: now };
    await store.putJsonBatch([
      document(invitationPath(inboxId, invitation.id), accepted),
      document(invitationPath(invitation.senderInboxId, invitation.id), accepted),
      document(path.join('inboxes', invitation.senderInboxId, 'contacts', `${invitation.recipientAgentId}.json`), senderContact),
      document(path.join('inboxes', inboxId, 'contacts', `${invitation.senderAgentId}.json`), recipientContact)
    ]);
    let message = { ...pendingMessage, conversationId, caseId: conversationId, invitationId: invitation.id, contactState: 'accepted' };
    if (['pendingContactApproval', 'queued'].includes(message.status)) message = await enqueueNativeMessage(message, senderInbox, inboxId, 'message.queued_after_invitation');
    await audit(inboxId, 'invitation.accepted', { invitationId: invitation.id, conversationId, senderAgentId: invitation.senderAgentId, recipientAgentId: invitation.recipientAgentId, humanId: human.id });
    return json(res, invitation.state === 'accepted' ? 200 : 201, { invitation: accepted, message });
  }

  const acknowledgementRoute = suffix.match(/^messages\/([^/]+)\/acknowledgements$/);
  if (req.method === 'POST' && acknowledgementRoute) {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal) return fail(res, 401, 'Recipient agent credential required');
    const input = await body(req);
    const idempotencyKey = req.headers['idempotency-key'] || input.idempotencyKey;
    if (!idempotencyKey) return fail(res, 400, 'Idempotency-Key header is required');
    const message = await store.getJson(messagePath(inboxId, acknowledgementRoute[1]));
    if (!message || message.recipientAgentId !== principal.id) return fail(res, 404, 'Delivered message not found for this agent');
    const state = input.state || 'acknowledged';
    if (!['acknowledged', 'processed'].includes(state)) return fail(res, 400, 'Acknowledgement state must be acknowledged or processed');
    if (!['delivered', 'acknowledged', 'processed'].includes(message.status)) return fail(res, 409, 'Message has not been delivered');
    const receiptId = `delivery_receipt_${message.id}_${state}`;
    const existingReceipt = await store.getJson(deliveryReceiptPath(inboxId, receiptId));
    if (existingReceipt) return json(res, 200, existingReceipt);
    const at = store.now();
    const updated = { ...message, status: state, [`${state}At`]: at, updatedAt: at };
    const receipt = {
      id: receiptId,
      type: 'delivery',
      messageId: message.id,
      senderAgentId: message.senderAgentId,
      recipientAgentId: message.recipientAgentId,
      state,
      idempotencyKeyHash: hashSecret(idempotencyKey),
      createdAt: at
    };
    const documents = [];
    const events = [];
    for (const targetInboxId of new Set([message.senderInboxId, message.recipientInboxId])) {
      const targetInbox = await store.getJson(path.join('inboxes', targetInboxId, 'inbox.json'));
      if (!targetInbox) continue;
      const currentCase = await ensureStructuredCase(targetInbox, { ...updated, caseId: updated.caseId }, updated.senderAgentId, updated.createdAt);
      const updatedCase = setCaseMessageDeliveryState(structuredClone(currentCase), updated, state, at);
      const auditEntry = await auditRecord(targetInboxId, `message.${state}`, { messageId: message.id, caseId: message.caseId, senderAgentId: message.senderAgentId, recipientAgentId: message.recipientAgentId }, at);
      documents.push(
        document(messagePath(targetInboxId, message.id), updated),
        document(caseRecordPath(targetInboxId, updatedCase.id), updatedCase),
        document(deliveryReceiptPath(targetInboxId, receipt.id), receipt),
        auditEntry.document
      );
      events.push({ inboxId: targetInboxId, event: auditEntry.event });
    }
    await store.putJsonBatch(documents);
    for (const { inboxId: targetInboxId, event } of events) publish(targetInboxId, event);
    return json(res, 201, receipt);
  }

  if (req.method === 'POST' && suffix === 'external-emails') {
    if (!externalEmailEnabled) return fail(res, 503, 'External email is disabled for this deployment');
    const input = await body(req);
    const idempotencyKey = req.headers['idempotency-key'] || input.idempotencyKey;
    if (!idempotencyKey) return fail(res, 400, 'Idempotency-Key header is required');
    emailTransport.assertReady();
    const senderAgentId = String(input.senderAgentId || '');
    const sender = await store.getJson(path.join('inboxes', inboxId, 'agents', `${senderAgentId}.json`));
    const principal = await getAgentPrincipal(req, inboxId);
    if (!sender || !principal || principal.id !== sender.id) return fail(res, 401, 'Valid sender agent credential required');
    if (!hasPermission(sender, 'send_agent_messages') || !hasPermission(sender, 'use_email_transport')) return fail(res, 403, 'Agent lacks send_agent_messages or use_email_transport permission');
    const recipientEmail = normalizedEmail(input.recipientEmail);
    if (!validEmail(recipientEmail)) return fail(res, 400, 'A valid recipientEmail is required');
    if (recipientEmail.endsWith(`@${emailTransport.publicDomain}`)) return fail(res, 400, 'Use the native agent transport for Sinaloa recipients');
    const subject = String(input.subject || '').trim();
    const text = String(input.text || '').trim();
    const html = input.html == null ? null : String(input.html);
    if (!subject || subject.length > 200) return fail(res, 400, 'subject is required and must be at most 200 characters');
    if (!text || text.length > 500_000 || (html && html.length > 500_000)) return fail(res, 400, 'text is required and email content must be at most 500000 characters');
    const contact = await store.getJson(externalContactPath(inboxId, recipientEmail));
    if (!contact?.approved || contact.blocked || !['outbound', 'both'].includes(contact.direction || 'both')) return fail(res, 403, 'Recipient is not an approved outbound contact');
    const messageId = `msg_email_${hashSecret(`${sender.id}:${idempotencyKey}`).slice(0, 32)}`;
    const requestHash = hashSecret(JSON.stringify({ senderAgentId, recipientEmail, caseId: input.caseId || null, subject, text, html }));
    const existing = await store.getJson(messagePath(inboxId, messageId));
    if (existing) return existing.requestHash === requestHash ? json(res, 200, existing) : fail(res, 409, 'Idempotency key was already used for a different email');
    if (!consumeExternalEmailLimit(sender.id, recipientEmail)) return fail(res, 429, 'External email rate limit exceeded');
    const createdAt = store.now();
    const caseId = input.caseId || store.id('case');
    const replyAddress = `reply+${hashSecret(messageId).slice(0, 32)}@${emailTransport.publicDomain}`;
    const message = { id: messageId, caseId, senderInboxId: inboxId, transport: 'email', direction: 'outbound', senderType: 'agent', senderAgentId, senderEmail: publicEmailAddressForAgent(sender), recipientEmail, subject, type: 'email', text, html, payload: input.payload || null, replyAddress, requestHash, createdAt, queuedAt: createdAt, status: 'queued', externalDeliveryState: 'queued' };
    const currentCase = await ensureStructuredCase(inbox, { ...input, caseId, type: 'message', text, objective: subject }, sender.id, createdAt);
    const queuedCase = setCaseMessageDeliveryState(structuredClone(currentCase), message, 'queued', createdAt);
    const auditEntry = await auditRecord(inboxId, 'email.queued', { messageId, caseId, senderAgentId, senderEmail: message.senderEmail, recipientEmail }, createdAt);
    const outbox = { id: `delivery_${message.id}`, kind: 'externalEmail', messageId, senderInboxId: inboxId, recipientInboxId: null, orderingKey: caseId, requestHash, status: 'queued', attempts: 0, maxAttempts: deliveryMaxAttempts, availableAt: createdAt, createdAt, updatedAt: createdAt };
    const queuedDelivery = await store.enqueueOutbox([
      document(messagePath(inboxId, message.id), message),
      document(caseRecordPath(inboxId, queuedCase.id), queuedCase),
      document(replyAddressDirectoryPath(replyAddress), { address: replyAddress, inboxId, agentId: sender.id, caseId, messageId }),
      auditEntry.document
    ], outbox);
    if (queuedDelivery.requestHash && queuedDelivery.requestHash !== requestHash) return fail(res, 409, 'Idempotency key was already used for a different email');
    publish(inboxId, auditEntry.event);
    deliveryWorker.kick();
    return json(res, 202, queuedDelivery.enqueueCreated ? message : await store.getJson(messagePath(inboxId, message.id), message));
  }

  if (req.method === 'POST' && suffix === 'messages') {
    const input = await body(req);
    if (!input.senderAgentId || !input.recipientEmail || !input.text) return fail(res, 400, 'senderAgentId, recipientEmail, and text are required');
    const idempotencyKey = req.headers['idempotency-key'] || input.idempotencyKey;
    if (!idempotencyKey) return fail(res, 400, 'Idempotency-Key header is required');
    const sender = await store.getJson(path.join('inboxes', inboxId, 'agents', `${input.senderAgentId}.json`));
    if (!sender) return fail(res, 403, 'Only registered agents may send messages');
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || principal.id !== sender.id) return fail(res, 401, 'Valid sender agent credential required');
    if (!hasPermission(sender, 'send_agent_messages')) return fail(res, 403, 'Agent is pending approval or lacks send_agent_messages permission');
    const recipientEmail = normalizedEmail(input.recipientEmail);
    if (!validEmail(recipientEmail) || !recipientEmail.endsWith(`@${agentDomain}`)) return fail(res, 404, 'Recipient is unavailable');
    const recipientDirectory = await store.getJson(nativeAddressDirectoryPath(recipientEmail));
    if (!recipientDirectory || recipientDirectory.status !== 'active' || recipientDirectory.verified !== true) return fail(res, 404, 'Recipient is unavailable');
    const recipient = await store.getJson(path.join('inboxes', recipientDirectory.inboxId, 'agents', `${recipientDirectory.agentId}.json`));
    if (!recipient || recipient.address !== recipientEmail || !hasPermission(recipient, 'receive_agent_messages')) return fail(res, 404, 'Recipient is unavailable');
    if (recipient.id === sender.id) return fail(res, 400, 'Sender and recipient must be different agents');
    const senderContact = await store.getJson(path.join('inboxes', inboxId, 'contacts', `${recipient.id}.json`));
    const recipientContact = await store.getJson(path.join('inboxes', recipientDirectory.inboxId, 'contacts', `${sender.id}.json`));
    if (senderContact?.blocked || recipientContact?.blocked) return fail(res, 403, 'The recipient is unavailable');
    const invitationId = `invitation_${hashSecret(`${sender.id}:${recipient.id}`).slice(0, 40)}`;
    const existingInvitation = await store.getJson(invitationPath(recipientDirectory.inboxId, invitationId));
    if (existingInvitation?.state === 'declined') return fail(res, 403, 'The recipient is unavailable');
    const relationshipApproved = senderContact?.approved === true && recipientContact?.approved === true;
    const messageId = `msg_${hashSecret(`${sender.id}:${idempotencyKey}`).slice(0, 32)}`;
    const requestHash = hashSecret(JSON.stringify({ senderAgentId: input.senderAgentId, recipientEmail, caseId: input.caseId || null, taskId: input.taskId || null, correlationId: input.correlationId || null, causationId: input.causationId || null, intent: input.intent || input.type || 'message', text: input.text, content: input.content || null, payload: input.payload || null, authority: input.authority || null, artifactRefs: input.artifactRefs || [] }));
    const existing = await store.getJson(messagePath(inboxId, messageId));
    if (existing) {
      const sameRequest = existing.requestHash ? existing.requestHash === requestHash : existing.recipientEmail === recipientEmail && existing.text === input.text && JSON.stringify(existing.payload) === JSON.stringify(input.payload || null);
      return sameRequest ? json(res, 200, existing) : fail(res, 409, 'Idempotency key was already used for a different message');
    }
    if (!relationshipApproved && existingInvitation?.state === 'pending') {
      const pendingMessage = await store.getJson(messagePath(inboxId, existingInvitation.messageId));
      return json(res, 202, { invitation: existingInvitation, message: pendingMessage, contactState: 'pending' });
    }
    const createdAt = store.now();
    const conversationId = input.caseId || senderContact?.conversationId || existingInvitation?.conversationId || existingInvitation?.pendingConversationId || store.id('conversation');
    const protocol = createProtocolMessage({
      messageId,
      conversationId,
      taskId: input.taskId || null,
      correlationId: input.correlationId || null,
      causationId: input.causationId || null,
      from: { agentId: sender.id, address: sender.address },
      to: [{ agentId: recipient.id, address: recipient.address }],
      intent: input.intent || input.type || 'message',
      text: input.text,
      content: input.content,
      proposal: input.proposal || input.payload?.proposal || null,
      authority: input.authority,
      artifactRefs: input.artifactRefs || [],
      requiresAck: input.requiresAck !== false,
      traceparent: req.headers.traceparent || input.traceparent || null,
      signature: input.signature || null,
      createdAt
    });
    const message = {
      id: messageId,
      ...protocol,
      caseId: conversationId,
      senderInboxId: inboxId,
      recipientInboxId: recipientDirectory.inboxId,
      senderType: 'agent',
      senderAgentId: input.senderAgentId,
      recipientAgentId: recipient.id,
      recipientEmail,
      transport: 'native',
      type: input.type || 'message',
      text: input.text,
      payload: input.payload || null,
      requestHash,
      createdAt,
      queuedAt: createdAt,
      status: relationshipApproved ? 'queued' : 'pendingContactApproval',
      contactState: relationshipApproved ? 'accepted' : 'pending'
    };
    if (!relationshipApproved) {
      const invitation = {
        id: invitationId,
        fromAddress: sender.address,
        toAddress: recipient.address,
        senderAgentId: sender.id,
        recipientAgentId: recipient.id,
        senderInboxId: inboxId,
        recipientInboxId: recipientDirectory.inboxId,
        state: 'pending',
        conversationId: null,
        pendingConversationId: conversationId,
        messageId: message.id,
        createdAt,
        updatedAt: createdAt
      };
      const senderAudit = await auditRecord(inboxId, 'invitation.sent', { invitationId, fromAddress: sender.address, toAddress: recipient.address, messageId: message.id }, createdAt);
      const recipientAudit = await auditRecord(recipientDirectory.inboxId, 'invitation.received', { invitationId, fromAddress: sender.address, toAddress: recipient.address, messageId: message.id }, createdAt);
      await store.putJsonBatch([
        document(messagePath(inboxId, message.id), { ...message, invitationId }),
        document(invitationPath(inboxId, invitationId), invitation),
        document(invitationPath(recipientDirectory.inboxId, invitationId), invitation),
        senderAudit.document,
        recipientAudit.document
      ]);
      publish(inboxId, senderAudit.event);
      publish(recipientDirectory.inboxId, recipientAudit.event);
      return json(res, 202, { invitation, message: { ...message, invitationId }, contactState: 'pending' });
    }
    return json(res, 202, await enqueueNativeMessage(message, inbox, recipientDirectory.inboxId));
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

  if (req.method === 'POST' && suffix === 'asset-uploads') {
    const input = await body(req);
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !hasPermission(principal, 'create_assets')) return fail(res, 403, 'Agent credential with create_assets permission required');
    if (input.createdByAgentId && input.createdByAgentId !== principal.id) return fail(res, 403, 'createdByAgentId must match the authenticated agent');
    const started = await objectStorage.beginUpload({ workspaceId: inboxId, filename: input.filename, mimeType: input.mimeType, size: input.size, checksumSha256: input.checksumSha256, caseId: input.caseId || null, createdByAgentId: principal.id });
    await audit(inboxId, 'asset.upload_started', { assetId: started.object.id, caseId: started.object.caseId, createdByAgentId: principal.id, size: started.object.size, state: started.object.state });
    return json(res, 201, { object: started.object, upload: browserObjectUrl(started.upload, req) });
  }

  const completeAssetUpload = suffix.match(/^assets\/([^/]+)\/complete$/);
  if (req.method === 'POST' && completeAssetUpload) {
    const human = await auth.getHuman(req);
    const principal = await getAgentPrincipal(req, inboxId);
    const asset = await objectStorage.getObject(completeAssetUpload[1]);
    if (asset.workspaceId !== inboxId) return fail(res, 404, 'Asset not found');
    if (!await canManageInbox(human, inbox) && principal?.id !== asset.createdByAgentId) return fail(res, 403, 'Asset creator or workspace administrator required');
    const scanned = await objectStorage.scanObject(asset.id);
    await audit(inboxId, `asset.scan_${scanned.state}`, { assetId: scanned.id, caseId: scanned.caseId, createdByAgentId: scanned.createdByAgentId, scan: scanned.scan });
    return json(res, 200, scanned);
  }

  const downloadAsset = suffix.match(/^assets\/([^/]+)\/download$/);
  if (req.method === 'GET' && downloadAsset) {
    const asset = await objectStorage.getObject(downloadAsset[1]);
    if (asset.workspaceId !== inboxId) return fail(res, 404, 'Asset not found');
    return json(res, 200, { object: asset, download: browserObjectUrl(await objectStorage.createDownload(asset.id), req) });
  }

  if (req.method === 'GET' && suffix === 'assets/quota') return json(res, 200, await objectStorage.quotaLedger.usage(inboxId));

  if (req.method === 'POST' && suffix === 'assets') {
    if (objectStorageProvider === 's3') return fail(res, 410, 'Direct asset uploads are disabled; use asset-uploads and signed URLs');
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
    if (asset.key || process.env.SINALOA_AUTH_MODE === 'production') return fail(res, 410, 'Use the scanner-gated signed download endpoint');
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${asset.name.replace(/"/g, '')}"`, 'x-content-type-options': 'nosniff' });
    return res.end(await readFile(path.join(dataDir, 'inboxes', inboxId, 'assets', asset.id, 'content.bin')));
  }
  return fail(res, 404, 'Not found');
}

await store.init();
await objectStorage.init();
await objectStorage.quotaLedger.reclaimExpired?.();
await synchronizePublicEmailDirectory();
deliveryWorker.start();
const objectQuotaReaper = setInterval(() => objectStorage.quotaLedger.reclaimExpired?.().catch(error => console.error('Object quota reaper failed', error)), Number(process.env.SINALOA_OBJECT_QUOTA_REAPER_INTERVAL_MS || 300_000));
objectQuotaReaper.unref?.();
const server = http.createServer((req, res) => route(req, res).catch((error) => {
  const requestId = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 128);
  const response = publicHttpError(error, requestId);
  if (response.status >= 500) console.error('Unhandled request error', { requestId, name: error instanceof Error ? error.name : 'Error' });
  return json(res, response.status, response.body);
}));
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.listen(port, host, () => console.log(`Sinaloa backend listening on http://${host}:${server.address().port}`));

const shutdown = () => {
  clearInterval(objectQuotaReaper);
  for (const set of streams.values()) for (const subscription of set) {
    clearInterval(subscription.heartbeat);
    subscription.res.end();
  }
  server.close(async () => {
    await deliveryWorker.stop();
    if (store.close) await store.close();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
