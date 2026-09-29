import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { FileStore } from './storage.js';
import { workspaceHistory, parseHistoryCursors, decodeHistoryCursor } from './workspace-history.js';
import { fetchEventPage } from './event-history.js';
import { createHumanAuth } from './human-auth.js';
import { createCsrfToken, csrfCookieHeader, membershipCanManage, parseCookies, sessionCookieHeader, sessionCookieName, verifyCsrfRequest } from './workos-auth.js';
import { DeliveryWorker } from './delivery-worker.js';
import { createEmailTransport } from './email-transport.js';
import { createProtocolMessage } from './protocol-v1.js';
import { createObjectStorageAdapter, DocumentObjectMetadataStore, FailClosedScanner, HttpMalwareScanner, ObjectStorageService, PersistentQuotaLedger } from './object-storage.js';
import { PostgresMalwareScanJobStore } from './object-scan-lifecycle.js';
import { validateProductionConfiguration } from './production-config.js';
import { evaluateReadiness } from './readiness.js';
import { dependencyReadinessChecks } from './dependency-readiness.js';
import { clientIp, publicHttpError } from './http-security.js';
import { createPkcePair, exchangeCalendarAuthorizationCode } from './calendar-oauth.js';
import { assertSafeIdentifier, assertSafeRequestTarget, resolvePathWithin } from './path-safety.js';
import { claimIdempotency, completeIdempotency, replayResponse, scopedIdempotencyPath, semanticDigest, validateIdempotencyKey } from './idempotency.js';
import { humanConversationMessagingEnabled } from './human-messaging.js';
import { handleAgentMcp } from './agent-mcp.js';
import {
  assertExactBinding,
  createWorkspacePolicy,
  evaluatePolicy,
  requiresPolicyEvaluation,
  valueDigest,
  verifyDecisionChain,
  verifyDecisionRecord
} from './policy-engine.js';
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
  isActiveCase,
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
const policyActiveKeyId = process.env.SINALOA_POLICY_ACTIVE_KEY_ID || 'primary';
const policySigningKeys = (() => {
  const configured = process.env.SINALOA_POLICY_SIGNING_KEYS ? JSON.parse(process.env.SINALOA_POLICY_SIGNING_KEYS) : {};
  const single = process.env.SINALOA_POLICY_SIGNING_KEY || process.env.SINALOA_DATA_ENCRYPTION_KEY || 'sinaloa-development-policy-signing-key';
  return { ...configured, [policyActiveKeyId]: configured[policyActiveKeyId] || single };
})();
const policyKeyring = Object.freeze({ activeKeyId: policyActiveKeyId, keys: Object.freeze(policySigningKeys) });
const emailTransport = createEmailTransport();
const agentAccessTokenTtlSeconds = Math.max(60, Number(process.env.SINALOA_AGENT_ACCESS_TOKEN_TTL_SECONDS || 900));
const agentRefreshTokenTtlDays = Math.max(1, Number(process.env.SINALOA_AGENT_REFRESH_TOKEN_TTL_DAYS || 30));
const configuredAgentWorkLeaseMs = Number(process.env.SINALOA_AGENT_WORK_LEASE_MS || 60_000);
const agentWorkLeaseMs = Number.isFinite(configuredAgentWorkLeaseMs) ? Math.max(1_000, Math.min(300_000, configuredAgentWorkLeaseMs)) : 60_000;
const configuredAgentWorkMaxAttempts = Number(process.env.SINALOA_AGENT_WORK_MAX_ATTEMPTS || 5);
const agentWorkMaxAttempts = Number.isSafeInteger(configuredAgentWorkMaxAttempts) && configuredAgentWorkMaxAttempts > 0 ? Math.min(20, configuredAgentWorkMaxAttempts) : 5;
const configuredAgentWorkRetryBaseMs = Number(process.env.SINALOA_AGENT_WORK_RETRY_BASE_MS || 5_000);
const agentWorkRetryBaseMs = Number.isSafeInteger(configuredAgentWorkRetryBaseMs) && configuredAgentWorkRetryBaseMs > 0 ? configuredAgentWorkRetryBaseMs : 5_000;
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
const acknowledgementStateRank = Object.freeze({ delivered: 0, acknowledged: 1, processed: 2 });
const store = process.env.DATABASE_URL ? new (await import('./postgres-storage.js')).PostgresStore(process.env.DATABASE_URL) : new FileStore(dataDir);
const auth = createHumanAuth(store);
const providerMembershipCache = Symbol('provider-membership-cache');
const streams = new Map();
const rateBuckets = new Map();
const emailRateBuckets = new Map();
const sseCounts = new Map();
const requestTimeoutMs = Number(process.env.SINALOA_REQUEST_TIMEOUT_MS || 30_000);
const calendarOAuthTimeoutMs = Number(process.env.SINALOA_CALENDAR_OAUTH_TIMEOUT_MS || 15_000);
const maxSsePerPrincipal = Number(process.env.SINALOA_MAX_SSE_PER_PRINCIPAL || 10);
const objectStorageProvider = process.env.SINALOA_OBJECT_STORAGE_PROVIDER || 'local';
const objectMaxBytes = Number(process.env.SINALOA_OBJECT_MAX_BYTES || 25 * 1024 * 1024);
const objectQuotaBytes = Number(process.env.SINALOA_WORKSPACE_OBJECT_QUOTA_BYTES || 1024 * 1024 * 1024);
const objectStorageRequestTimeoutMs = Number(process.env.SINALOA_S3_REQUEST_TIMEOUT_MS || 30_000);
const objectScanWorkerIntervalMs = Number(process.env.SINALOA_SCAN_WORKER_INTERVAL_MS || 1_000);
const objectScanRetentionIntervalMs = Number(process.env.SINALOA_SCAN_RETENTION_INTERVAL_MS || 60_000);
if (!Number.isSafeInteger(objectScanWorkerIntervalMs) || objectScanWorkerIntervalMs < 1) throw new TypeError('SINALOA_SCAN_WORKER_INTERVAL_MS must be a positive integer');
if (!Number.isSafeInteger(objectScanRetentionIntervalMs) || objectScanRetentionIntervalMs < 1) throw new TypeError('SINALOA_SCAN_RETENTION_INTERVAL_MS must be a positive integer');
const objectAllowedMimeTypes = (process.env.SINALOA_OBJECT_ALLOWED_MIME_TYPES || 'application/pdf,image/jpeg,image/png,text/plain,text/csv,application/json').split(',').map(value => value.trim()).filter(Boolean);
const objectStorageAdapter = createObjectStorageAdapter(objectStorageProvider === 's3' ? {
  provider: 's3',
  endpoint: process.env.SINALOA_S3_ENDPOINT || `https://s3.${process.env.SINALOA_S3_REGION || 'ca-central-1'}.amazonaws.com`,
  bucket: process.env.SINALOA_S3_BUCKET,
  region: process.env.SINALOA_S3_REGION || 'ca-central-1',
  accessKeyId: process.env.SINALOA_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.SINALOA_S3_SECRET_ACCESS_KEY,
  sessionToken: process.env.SINALOA_S3_SESSION_TOKEN,
  requestTimeoutMs: objectStorageRequestTimeoutMs,
  maxObjectBytes: objectMaxBytes,
  allowedMimeTypes: objectAllowedMimeTypes
} : { provider: 'local', root: path.join(dataDir, 'object-storage'), maxObjectBytes: objectMaxBytes, allowedMimeTypes: objectAllowedMimeTypes });
const objectScanner = process.env.SINALOA_MALWARE_SCANNER_URL ? new HttpMalwareScanner({ endpoint: process.env.SINALOA_MALWARE_SCANNER_URL, token: process.env.SINALOA_MALWARE_SCANNER_TOKEN || null }) : new FailClosedScanner();
const scanJobStore = process.env.DATABASE_URL ? new PostgresMalwareScanJobStore(store) : null;
const objectQuotaLedger = new PersistentQuotaLedger(store, { defaultQuotaBytes: objectQuotaBytes });
const scanLifecycle = {
  maxAttempts: Number(process.env.SINALOA_SCAN_MAX_ATTEMPTS || 5),
  leaseMs: Number(process.env.SINALOA_SCAN_LEASE_MS || 60_000),
  retryBaseMs: Number(process.env.SINALOA_SCAN_RETRY_BASE_MS || 5_000),
  retryMaxMs: Number(process.env.SINALOA_SCAN_RETRY_MAX_MS || 15 * 60_000),
  infectedRetentionMs: Number(process.env.SINALOA_SCAN_INFECTED_RETENTION_MS || 30 * 24 * 60 * 60_000),
  deadLetterRetentionMs: Number(process.env.SINALOA_SCAN_DEAD_LETTER_RETENTION_MS || 7 * 24 * 60 * 60_000),
  completedJobRetentionMs: Number(process.env.SINALOA_SCAN_COMPLETED_JOB_RETENTION_MS || 90 * 24 * 60 * 60_000),
  retentionRetryMs: Number(process.env.SINALOA_SCAN_RETENTION_RETRY_MS || 60 * 60_000)
};
const objectStorage = new ObjectStorageService({ adapter: objectStorageAdapter, metadataStore: new DocumentObjectMetadataStore(store), quotaLedger: objectQuotaLedger, scanner: objectScanner, scanJobStore, scanLifecycle, maxObjectBytes: objectMaxBytes, allowedMimeTypes: objectAllowedMimeTypes });
if (scanJobStore && !['processNextScan', 'reapScanRetention'].every(method => typeof objectStorage[method] === 'function')) throw new TypeError('Object storage durable scan lifecycle is not configured');
const readinessTimeoutMs = Number(process.env.SINALOA_READINESS_TIMEOUT_MS || 5_000);

let scanLifecycleStopping = false;
let objectScanRun = null;
let objectScanRetentionRun = null;
const scanWorkerId = `scan-${process.pid}-${crypto.randomUUID()}`;
const scanRetentionWorkerId = `scan-retention-${process.pid}-${crypto.randomUUID()}`;

function runObjectScans() {
  if (!scanJobStore || scanLifecycleStopping || objectScanRun) return objectScanRun;
  const run = (async () => {
    while (!scanLifecycleStopping && await objectStorage.processNextScan(scanWorkerId)) {}
  })().catch(error => console.error('Object scan worker failed', { name: error?.name || 'Error', code: error?.code || 'SCAN_FAILED' }))
    .finally(() => { if (objectScanRun === run) objectScanRun = null; });
  objectScanRun = run;
  return run;
}

function runObjectScanRetention() {
  if (!scanJobStore || scanLifecycleStopping || objectScanRetentionRun) return objectScanRetentionRun;
  const run = (async () => {
    while (!scanLifecycleStopping && await objectStorage.reapScanRetention(scanRetentionWorkerId)) {}
  })().catch(error => console.error('Object scan retention worker failed', { name: error?.name || 'Error', code: error?.code || 'SCAN_RETENTION_FAILED' }))
    .finally(() => { if (objectScanRetentionRun === run) objectScanRetentionRun = null; });
  objectScanRetentionRun = run;
  return run;
}

async function readinessReport() {
  const checks = dependencyReadinessChecks({ store, adapter: objectStorageAdapter,
    provider: objectStorageProvider, env: process.env, externalEmailEnabled, emailTransport });
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
  res.setHeader('access-control-allow-headers', 'content-type, authorization, idempotency-key, mcp-protocol-version, if-none-match, x-request-id, x-sinaloa-csrf, traceparent, x-amz-checksum-sha256, x-amz-meta-sinaloa-sha256');
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
const reservedAgentLocalParts = new Set(['admin', 'administrator', 'agents', 'abuse', 'billing', 'contact', 'help', 'info', 'mail', 'noreply', 'no-reply', 'postmaster', 'root', 'security', 'support', 'system']);
function normalizeAgentLocalPart(value) {
  if (typeof value !== 'string') throw Object.assign(new Error('Agent address name is required'), { statusCode: 400 });
  const localPart = value.trim().toLowerCase();
  if (localPart.length < 3 || localPart.length > 32 || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(localPart) || reservedAgentLocalParts.has(localPart)) {
    throw Object.assign(new Error('Choose 3–32 letters, numbers, periods or hyphens; start with a letter and avoid reserved names'), { statusCode: 400 });
  }
  return localPart;
}
const agentAddressForLocalPart = localPart => `${localPart}@${agentDomain}`;
async function activeAgentCountForHuman(humanId) {
  const directory = await store.listJson(path.join('directory', 'agents'));
  let active = 0;
  for (const item of directory) {
    const agent = item?.inboxId && item?.agentId ? await store.getJson(path.join('inboxes', item.inboxId, 'agents', `${item.agentId}.json`)) : null;
    if (agent?.principalHumanId === humanId && agent.status === 'active') active += 1;
  }
  return active;
}
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
const hasPermission = (agent, permission) => agent.status === 'active' && agent.onboardingStatus === 'approved' && !agent.pausedAt && agent.permissions?.includes(permission);
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
const mcpReadTokenTtlMs = 5 * 60_000;

function scopedMcpReadRequest(req, inboxId, caseId) {
  if (req.method !== 'GET' || !caseId) return false;
  const url = new URL(req.url, 'http://localhost');
  const base = `/api/inboxes/${inboxId}`;
  if (url.pathname === `${base}/cases/${caseId}`) return url.search === '';
  return url.pathname === `${base}/messages`
    && url.searchParams.get('caseId') === caseId
    && [...url.searchParams.keys()].every(key => ['caseId', 'limit', 'before'].includes(key));
}

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
  const pending = await store.getJson(refreshPath);
  if (!pending?.inboxId) throw Object.assign(new Error('Agent refresh token is invalid, expired, or already used'), { statusCode: 401 });
  const rotate = async () => {
    const current = await store.getJson(refreshPath);
    if (!current || current.tokenType !== 'refresh' || current.revokedAt || current.usedAt || new Date(current.expiresAt) <= new Date()) throw Object.assign(new Error('Agent refresh token is invalid, expired, or already used'), { statusCode: 401 });
    const family = await store.getJson(agentCredentialFamilyPath(current.inboxId, current.agentId, current.familyId));
    if (!family || family.revokedAt || new Date(family.refreshExpiresAt) <= new Date()) throw Object.assign(new Error('Agent credential family is invalid or revoked'), { statusCode: 401 });
    const agent = await store.getJson(path.join('inboxes', current.inboxId, 'agents', `${current.agentId}.json`));
    if (agent?.status !== 'active' || agent.onboardingStatus !== 'approved') throw Object.assign(new Error('Agent is not active and approved'), { statusCode: 401 });
    const claimed = await store.claimJson(refreshPath, 'usedAt', store.now());
    if (!claimed) throw Object.assign(new Error('Agent refresh token is invalid, expired, or already used'), { statusCode: 401 });
    return issueAgentCredentials(current.agentId, current.inboxId, current.familyId);
  };
  return typeof store.withTransaction === 'function' ? store.withTransaction([inboxMutationKey(pending.inboxId)], rotate) : rotate();
}

async function issueMcpReadToken(identity, caseId) {
  if (identity.agent.pausedAt) throw Object.assign(new Error('Paused agents cannot issue MCP read tokens'), { statusCode: 403 });
  if (caseId && !await getCase(identity.inboxId, caseId)) throw Object.assign(new Error('Case not found'), { statusCode: 404 });
  const raw = `sinaloa_mcp_read_${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = expiresAfter(mcpReadTokenTtlMs);
  await store.putJson(agentCredentialPath(hashSecret(raw)), {
    tokenType: 'mcp_read', agentId: identity.agent.id, inboxId: identity.inboxId,
    familyId: identity.familyId, caseId, issuedAt: store.now(), expiresAt, revokedAt: null
  });
  await audit(identity.inboxId, 'agent.mcp_read_token_issued', { agentId: identity.agent.id, caseId, expiresAt });
  return { mcpAccessToken: raw, tokenType: 'Bearer', scope: 'case_read', caseId, expiresAt };
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
    if (!['access', 'mcp_read'].includes(index.tokenType) || index.revokedAt || new Date(index.expiresAt) <= new Date()) return null;
    if (index.tokenType === 'mcp_read' && !scopedMcpReadRequest(req, inboxId, index.caseId)) return null;
    const family = await store.getJson(agentCredentialFamilyPath(index.inboxId, index.agentId, index.familyId));
    if (!family || family.revokedAt || new Date(family.refreshExpiresAt) <= new Date()) return null;
  }
  const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${index.agentId}.json`));
  return agent?.status === 'active' && agent.onboardingStatus === 'approved' && !(index.tokenType === 'mcp_read' && agent.pausedAt) ? agent : null;
};
const workClaimPath = (inboxId, workId) => path.join('inboxes', inboxId, 'work-claims', `${workId}.json`);

async function getAgentWorkIdentity(req) {
  const raw = bearerToken(req);
  if (!raw) return null;
  const index = await store.getJson(agentCredentialPath(hashSecret(raw)));
  if (!index?.inboxId || index.tokenType !== 'access' || index.revokedAt || new Date(index.expiresAt) <= new Date() || !index.familyId) return null;
  const family = await store.getJson(agentCredentialFamilyPath(index.inboxId, index.agentId, index.familyId));
  if (!family || family.revokedAt || new Date(family.refreshExpiresAt) <= new Date()) return null;
  const agent = await store.getJson(path.join('inboxes', index.inboxId, 'agents', `${index.agentId}.json`));
  if (!agent || agent.status !== 'active' || agent.onboardingStatus !== 'approved') return null;
  return { agent, familyId: index.familyId, inboxId: index.inboxId };
}

async function getMcpIdentity(req) {
  const full = await getAgentWorkIdentity(req);
  if (full) return full.agent.pausedAt ? null : full;
  const raw = bearerToken(req);
  if (!raw?.startsWith('sinaloa_mcp_read_')) return null;
  const index = await store.getJson(agentCredentialPath(hashSecret(raw)));
  if (!index || index.tokenType !== 'mcp_read' || index.revokedAt || new Date(index.expiresAt) <= new Date()) return null;
  const family = await store.getJson(agentCredentialFamilyPath(index.inboxId, index.agentId, index.familyId));
  if (!family || family.revokedAt || new Date(family.refreshExpiresAt) <= new Date()) return null;
  const agent = await store.getJson(path.join('inboxes', index.inboxId, 'agents', `${index.agentId}.json`));
  if (!agent || agent.status !== 'active' || agent.onboardingStatus !== 'approved' || agent.pausedAt) return null;
  return { agent, familyId: index.familyId, inboxId: index.inboxId, mcpScope: { caseId: index.caseId } };
}
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
const mcpOriginAllowed = req => {
  if (!req.headers.origin) return true;
  const allowed = corsOrigin.split(',').map(value => value.trim()).filter(value => value && value !== '*');
  if (process.env.SINALOA_PUBLIC_URL) {
    try { allowed.push(new URL(process.env.SINALOA_PUBLIC_URL).origin); }
    catch { return false; }
  }
  return allowed.includes(req.headers.origin);
};
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
  for (const subscription of streams.get(inboxId) || []) {
    if (subscription.replaying) {
      if (subscription.buffer.size >= 500) subscription.overflow = true;
      else subscription.buffer.set(event.id, event);
    } else sendStreamEvent(subscription, event);
  }
};
const disconnectAgentStreams = (inboxId, agentId) => {
  const subscriptions = streams.get(inboxId);
  if (!subscriptions) return;
  for (const subscription of [...subscriptions]) {
    if (subscription.agentId !== agentId) continue;
    clearInterval(subscription.heartbeat);
    subscriptions.delete(subscription);
    subscription.res.end();
  }
  if (!subscriptions.size) streams.delete(inboxId);
};
const audit = (inboxId, type, data) => withInboxMutation(inboxId, writeAudit => writeAudit(type, data));

const document = (relative, value) => ({ path: relative, value });
const messagePath = (inboxId, messageId) => path.join('inboxes', inboxId, 'messages', `${messageId}.json`);
const deliveryReceiptPath = (inboxId, receiptId) => path.join('inboxes', inboxId, 'delivery-receipts', `${receiptId}.json`);
const agentWorkAttempts = claim => Number(claim?.attempts || claim?.fence || 0);
const agentWorkRetryDelay = attempts => Math.min(15 * 60_000, agentWorkRetryBaseMs * 2 ** Math.min(20, Math.max(0, attempts - 1)));
async function failAgentWorkPermanently(message, claim, reasonCode, at, writeAudit) {
  claim.status = 'failed';
  claim.failure = { retryable: false, reasonCode, createdAt: at };
  claim.leaseExpiresAt = null;
  claim.retryAt = null;
  claim.updatedAt = at;
  const failed = { ...message, status: 'failed', failedAt: at, updatedAt: at };
  const receipt = {
    id: `delivery_receipt_${message.id}_failed`, type: 'delivery', messageId: message.id,
    senderAgentId: message.senderAgentId, recipientAgentId: message.recipientAgentId,
    state: 'failed', reasonCode, attempts: agentWorkAttempts(claim), createdAt: at
  };
  const documents = [document(workClaimPath(claim.inboxId, message.id), claim)];
  for (const targetInboxId of new Set([message.senderInboxId, message.recipientInboxId])) {
    const targetInbox = await store.getJson(path.join('inboxes', targetInboxId, 'inbox.json'));
    if (!targetInbox) continue;
    const currentCase = await ensureStructuredCase(targetInbox, { ...failed, caseId: failed.caseId }, failed.senderAgentId, failed.createdAt);
    const updatedCase = setCaseMessageDeliveryState(structuredClone(currentCase), failed, 'failed', at);
    documents.push(document(messagePath(targetInboxId, message.id), failed), document(caseRecordPath(targetInboxId, updatedCase.id), updatedCase), document(deliveryReceiptPath(targetInboxId, receipt.id), receipt));
    await writeAudit('message.failed', { messageId: message.id, caseId: message.caseId, senderAgentId: message.senderAgentId, recipientAgentId: message.recipientAgentId, reasonCode }, at, targetInboxId);
  }
  await store.putJsonBatch(documents);
  return receipt;
}
const auditRecord = async (inboxId, type, data, createdAt = store.now()) => {
  const event = { id: store.id('evt'), type, createdAt, sequence: await store.nextEventSequence(inboxId), ...data };
  event.cursor = eventCursor(event);
  return { event, document: document(path.join('inboxes', inboxId, 'events', `${event.id}.json`), event) };
};

const inboxMutationKey = inboxId => `inbox:${inboxId}:mutations`;
const enrollmentMutationKey = tokenHash => `enrollment:${tokenHash}:mutations`;
const humanEnrollmentMutationKey = humanId => `human:${humanId}:agent-enrollment`;
async function withInboxMutation(inboxId, operation, relatedInboxIds = [], additionalLockKeys = []) {
  const committedEvents = [];
  const run = () => operation(async (type, data, createdAt = store.now(), targetInboxId = inboxId) => {
    const record = await auditRecord(targetInboxId, type, data, createdAt);
    await store.putJson(record.document.path, record.document.value);
    committedEvents.push({ inboxId: targetInboxId, event: record.event });
    return record.event;
  });
  const result = typeof store.withTransaction === 'function'
    ? await store.withTransaction([...new Set([inboxId, ...relatedInboxIds])].map(inboxMutationKey).concat(additionalLockKeys), run)
    : await run();
  for (const committed of committedEvents) publish(committed.inboxId, committed.event);
  return result;
}

async function revokeAgentCredentialFamilies(inboxId, agentId, humanId, revokedAt = store.now()) {
  const families = await store.listJson(path.join('auth', 'agent-credential-families', inboxId, agentId));
  await store.putJsonBatch(families.map(family => document(agentCredentialFamilyPath(inboxId, agentId, family.id), {
    ...family,
    revokedAt,
    revokedByHumanId: humanId,
    updatedAt: revokedAt
  })));
  return families.length;
}

function setCaseMessageDeliveryState(value, message, state, at) {
  const eventId = `evt_${message.id}`;
  const existing = value.events.find(item => item.id === eventId);
  if (existing) {
    existing.payload = { ...existing.payload, deliveryState: state };
    if (state === 'delivered') applyNativeCaseOutcome(value, message, at);
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
  if (state === 'delivered') applyNativeCaseOutcome(value, message, at);
  value.updatedAt = at;
  return value;
}

function applyNativeCaseOutcome(value, message, at) {
  if (message.transport !== 'native') return;
  const status = { offer: 'proposed', counteroffer: 'countered', accept: 'accepted', reject: 'rejected' }[message.intent];
  if (!status) return;
  const proposal = message.proposal || message.payload?.proposal || null;
  const decision = message.payload?.decision || null;
  if (['proposed', 'countered'].includes(status) && (!proposal || typeof proposal !== 'object')) {
    throw Object.assign(new Error('A typed offer requires a structured proposal'), { statusCode: 422 });
  }
  const referencedProposal = decision?.proposalMessageId || null;
  if (['accepted', 'rejected'].includes(status) && (!referencedProposal || !value.events.some(event =>
    event.type === 'proposal' && event.payload?.messageId === referencedProposal && event.actor !== message.senderAgentId))) {
    throw Object.assign(new Error('The decision must refer to a counterparty proposal in this case'), { statusCode: 409 });
  }
  appendEvent(value, {
    id: `evt_${message.id}_typed`,
    type: ['proposed', 'countered'].includes(status) ? 'proposal' : 'decision',
    actor: message.senderAgentId,
    createdAt: message.createdAt,
    payload: { messageId: message.id, caseId: message.caseId, status, proposal, decision, authorityVerified: false },
    linkedPolicyEvaluation: null,
    precedingEventRef: value.events.at(-1)?.id || null
  });
  value.nativeOutcome = {
    status,
    messageId: message.id,
    proposalMessageId: referencedProposal || (['proposed', 'countered'].includes(status) ? message.id : null),
    actorAgentId: message.senderAgentId,
    humanApprovalStatus: 'unverified',
    updatedAt: at
  };
}

function assertNativeCaseParticipants(value, senderAgentId, recipientAgentId) {
  if (!value?.schemaVersion) return;
  const actual = new Set(value.participants || []);
  if (actual.size !== 2 || !actual.has(senderAgentId) || !actual.has(recipientAgentId)) {
    throw Object.assign(new Error('Case ID is bound to different participants'), { statusCode: 409 });
  }
}

async function getMembership(organizationId, humanId) {
  if (!organizationId || !humanId) return null;
  const membership = await store.getJson(path.join('organizations', organizationId, 'members', `${humanId}.json`));
  return membership?.status === 'active' ? membership : null;
}

async function getAuthorizedMembership(organizationId, human) {
  if (!human) return null;
  const membership = await getMembership(organizationId, human.id);
  if (!membership || auth.provider !== 'workos') return membership;
  const organization = await store.getJson(path.join('organizations', organizationId, 'organization.json'));
  if (!organization?.workosOrganizationId || !human.providerUserId || typeof auth.getOrganizationMembership !== 'function') return null;
  if (!human[providerMembershipCache]) Object.defineProperty(human, providerMembershipCache, { value: new Map(), enumerable: false });
  const cacheKey = organization.workosOrganizationId;
  if (!human[providerMembershipCache].has(cacheKey)) human[providerMembershipCache].set(cacheKey, auth.getOrganizationMembership(human.providerUserId, cacheKey));
  const providerMembership = await human[providerMembershipCache].get(cacheKey);
  return providerMembership ? { ...membership, providerMembership } : null;
}

async function canAccessInbox(human, inbox) {
  return Boolean(await getAuthorizedMembership(inbox.organizationId, human));
}

async function canManageInbox(human, inbox) {
  const membership = await getAuthorizedMembership(inbox.organizationId, human);
  return membershipCanManage(membership, auth.provider);
}

async function listHumanOrganizations(humanId) {
  const references = await store.listJson(path.join('humans', humanId, 'organizations'));
  const organizations = await Promise.all(references.map(reference => store.getJson(path.join('organizations', reference.organizationId, 'organization.json'))));
  return organizations.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

async function createOrganization(human, input = {}, idempotencyKey) {
  const name = String(input.name || '').trim();
  if (!name) throw Object.assign(new Error('Organization name is required'), { statusCode: 400 });
  const safeKey = validateIdempotencyKey(idempotencyKey);
  const requestDigest = semanticDigest({ name });
  const idempotencyPath = safeKey ? scopedIdempotencyPath('organizations', human.id, human.id, safeKey) : null;
  let idempotencyClaim = null;
  if (idempotencyPath) {
    idempotencyClaim = await claimIdempotency(store, idempotencyPath, { principalId: human.id, requestDigest, createdAt: store.now() });
    if (idempotencyClaim.replay) return idempotencyClaim.replay;
  }
  try {
    const organizationId = store.id('org');
    let providerOrganization = null;
    if (auth.provider === 'workos') {
      providerOrganization = await auth.createProviderOrganization({
        name,
        externalId: organizationId,
        idempotencyKey: safeKey || organizationId,
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
    if (idempotencyPath) await completeIdempotency(store, idempotencyPath, { principalId: human.id, requestDigest, response: organization, createdAt: organization.createdAt });
    return organization;
  } catch (error) {
    if (idempotencyPath && idempotencyClaim?.claimed) await store.deleteJson(idempotencyPath).catch(() => {});
    throw error;
  }
}

async function ensureOrganization(human, requestedId) {
  if (requestedId) {
    const organizationId = assertSafeIdentifier(requestedId, 'organizationId');
    const organization = await store.getJson(path.join('organizations', organizationId, 'organization.json'));
    if (!organization || !await getAuthorizedMembership(organizationId, human)) throw Object.assign(new Error('Active organization membership required'), { statusCode: 403 });
    return organization;
  }
  const existingOrganizations = await listHumanOrganizations(human.id);
  let existing = null;
  for (const organization of existingOrganizations) {
    if (await getAuthorizedMembership(organization.id, human)) { existing = organization; break; }
  }
  return existing || createOrganization(human, { name: `${human.displayName || 'My'} workspace` }, `personal-${human.id}`);
}

async function createDedicatedAgentInbox({ sourceInbox, organizationId, ownerHumanId, agent, status = 'pending_approval', inboxId = store.id('inbox') }) {
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
const nativeCaseBindingPath = caseId => path.join('native-case-bindings', `${caseId}.json`);
const assetGrantPath = (recipientInboxId, assetId) => path.join('inboxes', recipientInboxId, 'asset-grants', `${assetId}.json`);
const saveCase = (inboxId, value) => store.putJson(caseRecordPath(inboxId, value.id), value);
const getCase = async (inboxId, caseId) => {
  const value = await store.getJson(caseRecordPath(inboxId, caseId));
  return value?.schemaVersion && !value.collaborationMode ? { ...value, collaborationMode: 'collaboration' } : value;
};
async function assertNativeCaseBinding(caseId, senderAgent, recipientAgent, senderInboxId, recipientInboxId) {
  const agentIds = [senderAgent.id, recipientAgent.id].sort();
  const inboxIds = [senderInboxId, recipientInboxId].sort();
  const pathName = nativeCaseBindingPath(caseId);
  const existing = await store.getJson(pathName);
  if (existing) {
    if (JSON.stringify(existing.agentIds) !== JSON.stringify(agentIds) || JSON.stringify(existing.inboxIds) !== JSON.stringify(inboxIds)) throw Object.assign(new Error('Case ID is bound to different participants'), { statusCode: 409 });
    if (existing.pausedAt || existing.revokedAt || existing.completedAt) throw Object.assign(new Error('Case is paused or closed'), { statusCode: 403 });
    return existing;
  }
  const value = { caseId, agentIds, inboxIds, pausedAt: null, revokedAt: null, completedAt: null, createdAt: store.now() };
  if (!await store.putJsonIfAbsent(pathName, value)) return assertNativeCaseBinding(caseId, senderAgent, recipientAgent, senderInboxId, recipientInboxId);
  return value;
}
async function canAgentReadNativeCase(inboxId, caseId, agent) {
  if (!agent || agent.pausedAt) return false;
  const binding = await store.getJson(nativeCaseBindingPath(caseId));
  if (!binding) return true;
  if (!binding.inboxIds?.includes(inboxId) || !binding.agentIds?.includes(agent.id) || binding.pausedAt || binding.revokedAt) return false;
  const [first, second] = binding.agentIds;
  const [firstDirectory, secondDirectory] = await Promise.all([
    store.getJson(path.join('directory', 'agents', `${first}.json`)),
    store.getJson(path.join('directory', 'agents', `${second}.json`))
  ]);
  if (!firstDirectory?.inboxId || !secondDirectory?.inboxId) return false;
  const [firstContact, secondContact] = await Promise.all([
    store.getJson(path.join('inboxes', firstDirectory.inboxId, 'contacts', `${second}.json`)),
    store.getJson(path.join('inboxes', secondDirectory.inboxId, 'contacts', `${first}.json`))
  ]);
  return !firstContact?.blocked && !secondContact?.blocked;
}
async function assetGrantAccess(asset, inbox, req) {
  const human = await auth.getHuman(req);
  const principal = await getAgentPrincipal(req, inbox.id);
  if (asset.workspaceId === inbox.id) return principal?.id === asset.createdByAgentId && !principal.pausedAt || await canAccessInbox(human, inbox);
  if (!asset.caseId) return false;
  const grant = await store.getJson(assetGrantPath(inbox.id, asset.id));
  if (!grant || grant.ownerInboxId !== asset.workspaceId || grant.recipientInboxId !== inbox.id || grant.caseId !== asset.caseId || grant.createdByAgentId !== asset.createdByAgentId || grant.revokedAt) return false;
  const binding = await store.getJson(nativeCaseBindingPath(asset.caseId));
  if (binding?.pausedAt || binding?.revokedAt) return false;
  const [ownerCase, recipientCase, creator, recipient, senderContact, recipientContact] = await Promise.all([
    getCase(asset.workspaceId, asset.caseId),
    getCase(inbox.id, asset.caseId),
    store.getJson(path.join('inboxes', asset.workspaceId, 'agents', `${asset.createdByAgentId}.json`)),
    store.getJson(path.join('inboxes', inbox.id, 'agents', `${grant.recipientAgentId}.json`)),
    store.getJson(path.join('inboxes', asset.workspaceId, 'contacts', `${grant.recipientAgentId}.json`)),
    store.getJson(path.join('inboxes', inbox.id, 'contacts', `${asset.createdByAgentId}.json`))
  ]);
  if (!ownerCase || !recipientCase || !creator || !recipient || senderContact?.blocked || recipientContact?.blocked || !hasPermission(creator, 'send_agent_messages') || !hasPermission(recipient, 'receive_agent_messages')) return false;
  try {
    assertNativeCaseParticipants(ownerCase, creator.id, recipient.id);
    assertNativeCaseParticipants(recipientCase, creator.id, recipient.id);
  } catch { return false; }
  return principal?.id === recipient.id || await canAccessInbox(human, inbox);
}
const isCaseParticipant = (value, agentId) => Boolean(agentId && (value?.actingAgent === agentId || value?.participants?.includes(agentId)));

function proposalFromInput(input, now) {
  const options = Array.isArray(input.options) ? input.options.map(item => ({
    id: item.id || store.id('option'),
    value: item.value && typeof item.value === 'object' ? item.value : {},
    sourceConfidence: item.sourceConfidence || 'enteredForCase',
    expired: Boolean(item.expired),
    outOfPolicyFlags: Array.isArray(item.outOfPolicyFlags) ? [...new Set(item.outOfPolicyFlags)] : []
  })) : [];
  if (!options.length) throw Object.assign(new Error('At least one structured proposal option is required'), { statusCode: 400 });
  return { id: store.id('proposal'), kind: input.kind, options, status: 'open', acceptedOptionId: null, expiresAt: input.expiresAt || null, createdAt: now, updatedAt: now };
}

function policyEvaluationFromInput(input, actor, now) {
  return {
    id: input.id,
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
const policyExecutionPath = (inboxId, executionId) => path.join('inboxes', inboxId, 'policy-executions', `${executionId}.json`);
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

async function activeWorkspacePolicy(inboxId) {
  const configured = await store.getJson(path.join('inboxes', inboxId, 'policies', 'active.json')) || {};
  return createWorkspacePolicy({
    ...configured,
    id: configured.id || 'sinaloa-default-authority',
    version: configured.version || process.env.SINALOA_POLICY_VERSION || '2026-09-27',
    decisionTtlSeconds: configured.decisionTtlSeconds ?? Number(process.env.SINALOA_POLICY_DECISION_TTL_SECONDS || 600),
    executeAtToleranceSeconds: configured.executeAtToleranceSeconds ?? Number(process.env.SINALOA_POLICY_EXECUTE_AT_TOLERANCE_SECONDS || 60),
    maxPaymentMinorWithoutHuman: configured.maxPaymentMinorWithoutHuman ?? Number(process.env.SINALOA_POLICY_MAX_AUTOMATIC_PAYMENT_MINOR || 0),
    consequentialActionsEnabled: consequentialActionsEnabled && configured.consequentialActionsEnabled !== false,
    externalEmailEnabled: externalEmailEnabled && configured.externalEmailEnabled !== false,
    calendarWritesEnabled: calendarWritesEnabled && configured.calendarWritesEnabled !== false
  });
}

async function policyDecisionChain(inboxId) {
  const decisions = [
    ...await store.listJson(path.join('inboxes', inboxId, 'policy-bindings')),
    ...await store.listJson(path.join('inboxes', inboxId, 'policy-executions'))
  ];
  if (!verifyDecisionChain(decisions, { keyring: policyKeyring, requireSigned: true })) {
    throw Object.assign(new Error('Policy decision history failed integrity verification'), { statusCode: 409, code: 'POLICY_CHAIN_INVALID' });
  }
  const referenced = new Set(decisions.map(decision => decision.previousRecordDigest).filter(Boolean));
  return { records: decisions, latest: decisions.find(decision => !referenced.has(decision.recordDigest)) || null };
}

async function evaluateServerPolicy(inboxId, agent, caseRecord, input, options = {}) {
  const requestedAction = String(input.requestedAction || '');
  const requiredPermission = actionPermission(requestedAction);
  const actionPayload = {
    ...(input.actionPayload && typeof input.actionPayload === 'object' && !Array.isArray(input.actionPayload) ? input.actionPayload : {}),
    ...(input.recipientEmail && !input.actionPayload?.recipientEmail ? { recipientEmail: normalizedEmail(input.recipientEmail) } : {})
  };
  const recipientEmail = normalizedEmail(actionPayload.recipientEmail);
  const contact = requestedAction.startsWith('email.') && validEmail(recipientEmail) ? await store.getJson(externalContactPath(inboxId, recipientEmail)) : null;
  const connectors = requestedAction.startsWith('calendar.') ? await store.listJson(path.join('inboxes', inboxId, 'calendar-connectors')) : [];
  const startBoundary = minutesFromClock(caseRecord.constraints?.workingHoursStart);
  const endBoundary = minutesFromClock(caseRecord.constraints?.workingHoursEnd);
  const scheduleOptions = requestedAction.startsWith('calendar.') ? (caseRecord.proposals || []).filter(proposal => ['open', 'countered'].includes(proposal.status) && proposal.kind === 'schedule').flatMap(proposal => proposal.options.filter(option => !option.expired)) : [];
  const outsideWorkingHours = scheduleOptions.some(option => {
    const candidate = zonedMinutes(option.value?.start, option.value?.timezone || caseRecord.constraints?.timezone || 'UTC');
    return candidate != null && ((startBoundary != null && candidate < startBoundary) || (endBoundary != null && candidate > endBoundary));
  });
  const policy = await activeWorkspacePolicy(inboxId);
  const chain = await policyDecisionChain(inboxId);
  const record = evaluatePolicy({
    id: options.id || input.id || store.id(options.phase === 'execution' ? 'policy_exec' : 'policy_eval'),
    executionId: options.executionId || null,
    workspaceId: inboxId,
    caseId: caseRecord.id,
    agentId: agent.id,
    requestedAction,
    actionPayload,
    permissionGranted: hasPermission(agent, requiredPermission),
    caseDeadline: caseRecord.deadline,
    requestedExpiresAt: input.expiresAt,
    contactApproved: contact ? contact.approved && !contact.blocked && ['outbound', 'both'].includes(contact.direction || 'both') : false,
    calendarConnectorAvailable: connectors.some(connector => connector.status === 'connected'),
    outsideWorkingHours,
    proposalDigest: valueDigest(caseRecord.proposals || []),
    allowedOptionIds: (caseRecord.proposals || []).flatMap(proposal => proposal.options.filter(option => !option.expired).map(option => option.id)),
    policy,
    previousRecordDigest: chain.latest?.recordDigest || null,
    phase: options.phase || 'evaluation',
    sourceEvaluationId: options.sourceEvaluationId || null,
    grantType: input.grantType || 'oneTime',
    keyring: policyKeyring,
    now: store.now()
  });
  return {
    decision: record.decision,
    reasonCode: record.reasonCode,
    matchedPolicyId: `${policy.id}@${policy.version}`,
    expiresAt: record.expiresAt,
    binding: record
  };
}

const hasHumanApprovalForEvaluation = (caseRecord, evaluationId) => caseRecord.events.some(event =>
  event.type === 'humanAction'
  && event.payload?.action?.actionKey === 'approveOnce'
  && event.payload.action.externalRefs?.policyEvaluationId === evaluationId
);

const actionRequestDigest = input => {
  const externalRefs = { ...(input.externalRefs || {}) };
  delete externalRefs.policyExecutionId;
  delete externalRefs.requestDigest;
  return valueDigest({
    actor: input.actor,
    actionKey: input.actionKey,
    outcome: input.outcome ?? null,
    nextState: input.nextState ?? null,
    policyEvaluationId: input.policyEvaluationId ?? externalRefs.policyEvaluationId ?? null,
    actionPayload: input.actionPayload || {},
    externalRefs,
    reasonCode: input.reasonCode ?? null
  });
};

async function validatedPolicyBinding(inboxId, caseRecord, principal, evaluationId, { requestedAction, actionPayload, proposalId, optionId, executionId = store.id('action'), allowPendingHuman = false, writeAudit = (type, data) => audit(inboxId, type, data) } = {}) {
  const evaluation = caseRecord.policyEvaluations.find(item => item.id === evaluationId);
  const binding = evaluation ? await store.getJson(policyBindingPath(inboxId, evaluation.id)) : null;
  await policyDecisionChain(inboxId);
  if (!evaluation || !binding || !verifyDecisionRecord(binding, { keyring: policyKeyring, requireSigned: true }) || evaluation.actor !== principal.id || binding.agentId !== principal.id || binding.caseId !== caseRecord.id) {
    throw Object.assign(new Error('A current server-issued policy evaluation for this agent and case is required'), { statusCode: 403 });
  }
  const proposalStateDigest = valueDigest(caseRecord.proposals || []);
  assertExactBinding(binding, { requestedAction: requestedAction || binding.requestedAction, actionPayload: actionPayload || {}, proposalDigest: proposalId ? proposalStateDigest : null, optionId, keyring: policyKeyring, at: store.now() });
  if (evaluation.decision === 'deny') throw Object.assign(new Error(`Policy denied this action: ${evaluation.reasonCode}`), { statusCode: 403 });
  const humanApproved = hasHumanApprovalForEvaluation(caseRecord, evaluation.id);
  if (evaluation.decision === 'needsHuman' && !humanApproved && !allowPendingHuman) {
    throw Object.assign(new Error('This action requires human approval'), { statusCode: 409 });
  }
  if (proposalId && !caseRecord.proposals.some(proposal => proposal.id === proposalId)) throw Object.assign(new Error('Proposal not found'), { statusCode: 404 });
  if (evaluation.decision === 'needsHuman' && !humanApproved && allowPendingHuman) {
    return { evaluation, binding, refreshed: binding, humanApproved: false, executionId };
  }
  const priorExecutions = await store.listJson(path.join('inboxes', inboxId, 'policy-executions'));
  if (binding.grantType === 'oneTime' && priorExecutions.some(record => record.sourceEvaluationId === evaluation.id)) throw Object.assign(new Error('This one-time policy evaluation has already been consumed'), { statusCode: 409 });

  const refreshed = await evaluateServerPolicy(inboxId, principal, caseRecord, {
    requestedAction: binding.requestedAction,
    actionPayload: binding.actionPayload,
    expiresAt: binding.expiresAt,
    grantType: binding.grantType || 'oneTime'
  }, { id: store.id('policy_exec'), phase: 'execution', executionId, sourceEvaluationId: evaluation.id });
  const executionPath = policyExecutionPath(inboxId, binding.grantType === 'oneTime' ? evaluation.id : refreshed.binding.id);
  const persisted = binding.grantType === 'oneTime'
    ? await store.putJsonIfAbsent(executionPath, refreshed.binding)
    : (await store.putJson(executionPath, refreshed.binding), true);
  if (!persisted) throw Object.assign(new Error('This one-time policy evaluation has already been consumed'), { statusCode: 409 });
  await writeAudit('policy.re_evaluated', {
    caseId: caseRecord.id,
    policyEvaluationId: evaluation.id,
    policyExecutionId: refreshed.binding.id,
    executionId,
    requestedAction: refreshed.binding.requestedAction,
    decision: refreshed.decision,
    reasonCode: refreshed.reasonCode,
    previousRecordDigest: refreshed.binding.previousRecordDigest,
    recordDigest: refreshed.binding.recordDigest
  });
  if (refreshed.decision === 'deny') throw Object.assign(new Error(`Current policy denied this action: ${refreshed.reasonCode}`), { statusCode: 403 });
  const approvalApplies = humanApproved && refreshed.binding.policy.digest === binding.policy.digest;
  if (refreshed.decision === 'needsHuman' && !approvalApplies && !allowPendingHuman) {
    throw Object.assign(new Error('Current policy requires a new human approval'), { statusCode: 409 });
  }
  return { evaluation, binding, refreshed: refreshed.binding, humanApproved: approvalApplies, executionId };
}

async function ensureStructuredCase(inbox, input, actorAgentId, at) {
  const caseId = input.caseId ? assertSafeIdentifier(input.caseId, 'caseId') : store.id('case');
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

async function enqueueNativeMessage(message, senderInbox, recipientInboxId, eventType = 'message.queued', writeAudit = null, agentRequest = null) {
  if (!writeAudit) {
    const queued = await withInboxMutation(senderInbox.id, auditWriter => enqueueNativeMessage(message, senderInbox, recipientInboxId, eventType, auditWriter, agentRequest), [recipientInboxId]);
    deliveryWorker.kick();
    return queued;
  }
  const [senderAgent, recipientAgent] = await Promise.all([
    store.getJson(path.join('inboxes', senderInbox.id, 'agents', `${message.senderAgentId}.json`)),
    store.getJson(path.join('inboxes', recipientInboxId, 'agents', `${message.recipientAgentId}.json`))
  ]);
  if (!senderAgent || !hasPermission(senderAgent, 'send_agent_messages')) throw Object.assign(new Error('Sender agent is no longer approved to send messages'), { statusCode: 403 });
  if (!recipientAgent || !hasPermission(recipientAgent, 'receive_agent_messages')) throw Object.assign(new Error('Recipient agent is unavailable'), { statusCode: 404 });
  let senderCredentialFamilyId;
  if (agentRequest) {
    const currentPrincipal = await getAgentPrincipal(agentRequest, senderInbox.id);
    if (!currentPrincipal || currentPrincipal.id !== senderAgent.id) throw Object.assign(new Error('Valid sender agent credential required'), { statusCode: 401 });
    senderCredentialFamilyId = (await store.getJson(agentCredentialPath(hashSecret(bearerToken(agentRequest)))))?.familyId;
  } else {
    const families = await store.listJson(path.join('auth', 'agent-credential-families', senderInbox.id, senderAgent.id));
    senderCredentialFamilyId = families.find(family => !family.revokedAt && new Date(family.refreshExpiresAt) > new Date())?.id;
  }
  if (!senderCredentialFamilyId) throw Object.assign(new Error('An active sender agent credential is required'), { statusCode: 401 });
  const existing = await store.getJson(messagePath(senderInbox.id, message.id));
  if (existing) {
    if (existing.requestHash && existing.requestHash !== message.requestHash) throw Object.assign(new Error('Idempotency key was already used for a different message'), { statusCode: 409 });
    if (existing.status !== 'pendingContactApproval') return existing;
  }
  const queuedAt = store.now();
  const queued = { ...message, recipientInboxId, status: 'queued', queuedAt, updatedAt: queuedAt };
  const currentCase = await ensureStructuredCase(senderInbox, { ...queued, caseId: queued.caseId }, queued.senderAgentId, queued.createdAt);
  const queuedCase = setCaseMessageDeliveryState(structuredClone(currentCase), queued, 'queued', queuedAt);
  const auditData = {
    messageId: queued.id,
    caseId: queued.caseId,
    conversationId: queued.conversationId,
    senderAgentId: queued.senderAgentId,
    recipientAgentId: queued.recipientAgentId,
    recipientEmail: queued.recipientEmail,
    senderInboxId: senderInbox.id,
    recipientInboxId
  };
  const outbox = {
    id: `delivery_${queued.id}`,
    kind: 'nativeAgentMessage',
    messageId: queued.id,
    senderInboxId: senderInbox.id,
    recipientInboxId,
    senderCredentialFamilyId,
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
    document(caseRecordPath(senderInbox.id, queuedCase.id), queuedCase)
  ], outbox);
  if (delivery.requestHash && delivery.requestHash !== queued.requestHash) throw Object.assign(new Error('Idempotency key was already used for a different message'), { statusCode: 409 });
  await writeAudit(eventType, auditData, queuedAt);
  return delivery.enqueueCreated ? queued : await store.getJson(messagePath(senderInbox.id, queued.id), queued);
}

async function deliverNativeAgentMessage(outbox) {
  const queued = await store.getJson(messagePath(outbox.senderInboxId, outbox.messageId));
  if (!queued) throw permanentDeliveryError('Queued message no longer exists');
  const caseBinding = await store.getJson(nativeCaseBindingPath(queued.caseId));
  if (caseBinding?.pausedAt || caseBinding?.revokedAt || caseBinding?.completedAt) throw permanentDeliveryError('Case is paused or closed');
  const sender = await store.getJson(path.join('inboxes', outbox.senderInboxId, 'agents', `${queued.senderAgentId}.json`));
  if (!sender || !hasPermission(sender, 'send_agent_messages')) throw permanentDeliveryError('Sender agent is no longer approved to send messages');
  const senderFamilies = outbox.senderCredentialFamilyId
    ? [await store.getJson(agentCredentialFamilyPath(outbox.senderInboxId, queued.senderAgentId, outbox.senderCredentialFamilyId))]
    : await store.listJson(path.join('auth', 'agent-credential-families', outbox.senderInboxId, queued.senderAgentId));
  if (!senderFamilies.some(family => family && !family.revokedAt && new Date(family.refreshExpiresAt) > new Date())) throw permanentDeliveryError('Sender agent credential is revoked or expired');
  const directory = await store.getJson(path.join('directory', 'agents', `${queued.recipientAgentId}.json`));
  if (!directory || directory.status !== 'active' || directory.inboxId !== outbox.recipientInboxId) throw permanentDeliveryError('Recipient agent is unavailable');
  const recipient = await store.getJson(path.join('inboxes', directory.inboxId, 'agents', `${queued.recipientAgentId}.json`));
  if (!recipient || !hasPermission(recipient, 'receive_agent_messages')) throw permanentDeliveryError('Recipient is not approved to receive messages');
  const contact = await store.getJson(path.join('inboxes', directory.inboxId, 'contacts', `${queued.senderAgentId}.json`));
  const senderContact = await store.getJson(path.join('inboxes', outbox.senderInboxId, 'contacts', `${queued.recipientAgentId}.json`));
  if (contact?.blocked || senderContact?.blocked) throw permanentDeliveryError('The agent relationship is blocked for delivery');

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

async function prepareEmailDelivery(outbox) {
  if (outbox.kind !== 'emailWebhook') return {};
  const event = outbox.emailEvent;
  if (!event?.type) throw permanentDeliveryError('Email webhook event is invalid');
  if (event.type !== 'email.received') {
    if (!event.data?.email_id || !emailEventState(event.type)) return {};
    const index = await store.getJson(path.join('email-provider-index', 'resend', `${identityKey(event.data.email_id)}.json`));
    if (!index?.inboxId) throw new Error('Provider message index is not available yet');
    return { lockKeys: [`inbox:${index.inboxId}:mutations`], context: { index } };
  }
  // Provider payload is immutable; retrieve it before opening a database
  // transaction, then revalidate every mutable routing/permission record inside.
  const inbound = await emailTransport.retrieveInbound(event.data?.email_id);
  const recipients = [...new Set([...(inbound.received_for || []), ...(inbound.to || [])].map(normalizedEmail).filter(Boolean))];
  for (const recipient of recipients) {
    const route = await store.getJson(replyAddressDirectoryPath(recipient));
    if (route?.inboxId && route?.agentId) return { lockKeys: [`inbox:${route.inboxId}:mutations`], context: { inbound, recipients, route, routeAddress: recipient } };
  }
  throw permanentDeliveryError('Inbound email is not addressed to a verified reply alias');
}

async function processInboundEmail(event, prepared) {
  if (!prepared?.route) throw new Error('Inbound email routing was not prepared');
  const { inbound, recipients } = prepared;
  const route = await store.getJson(replyAddressDirectoryPath(prepared.routeAddress));
  if (!route?.inboxId || !route?.agentId) throw permanentDeliveryError('Inbound email is not addressed to a verified reply alias');
  if (route.inboxId !== prepared.route.inboxId || route.agentId !== prepared.route.agentId || route.caseId !== prepared.route.caseId) throw new Error('Inbound email route changed; retry routing');
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

async function processOutboundEmailEvent(event, prepared) {
  const providerMessageId = event.data?.email_id;
  const state = emailEventState(event.type);
  if (!providerMessageId || !state) return { documents: [], result: { ignored: true }, events: [] };
  const index = await store.getJson(path.join('email-provider-index', 'resend', `${identityKey(providerMessageId)}.json`));
  if (!index) throw new Error('Provider message index is not available yet');
  if (index.inboxId !== prepared?.index?.inboxId || index.messageId !== prepared?.index?.messageId) throw new Error('Provider message route changed; retry routing');
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

async function processEmailWebhook(outbox, prepared) {
  const event = outbox.emailEvent;
  if (!event?.type) throw permanentDeliveryError('Email webhook event is invalid');
  return event.type === 'email.received' ? processInboundEmail(event, prepared) : processOutboundEmailEvent(event, prepared);
}

async function deliverQueuedMessage(outbox, prepared) {
  if (outbox.kind === 'nativeAgentMessage') return deliverNativeAgentMessage(outbox);
  if (outbox.kind === 'externalEmail') return deliverExternalEmail(outbox);
  if (outbox.kind === 'emailWebhook') return processEmailWebhook(outbox, prepared);
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
  prepare: prepareEmailDelivery,
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
    const contact = await store.getJson(path.join('inboxes', inbox.id, 'contacts', `${id}.json`));
    return [id, { id, type: directory.inboxId === inbox.id ? 'internalAgent' : 'externalAgent', displayName: external?.name || directory.address || String(id), address: external?.address || directory.address || null, organizationId: external?.organizationId || null, inboxId: directory.inboxId, accessState: contact?.blocked ? 'blocked' : directory.status === 'active' ? 'active' : 'unavailable' }];
  }));
  return Object.fromEntries(entries);
}

async function humanView(inboxId, inbox, req, cursors = {}) {
  const [agents, calendarConnectors, page] = await Promise.all([
    store.listJson(path.join('inboxes', inboxId, 'agents')),
    store.listJson(path.join('inboxes', inboxId, 'calendar-connectors')),
    workspaceHistory(store, inboxId, cursors)
  ]);
  const { items: { cases, messages, recentEvents: events, deliveryReceipts, invitations, contacts: externalContacts }, history } = page;
  const [ownAssets, assetGrants] = await Promise.all([
    store.listJson(path.join('inboxes', inboxId, 'assets')),
    store.listJson(path.join('inboxes', inboxId, 'asset-grants'))
  ]);
  const grantedAssets = (await Promise.all(assetGrants.map(async grant => {
    if (grant.revokedAt) return null;
    const asset = await objectStorage.getObject(grant.assetId).catch(() => null);
    return asset?.state === 'clean' && await assetGrantAccess(asset, inbox, req) ? { ...asset, grant } : null;
  }))).filter(Boolean);
  const allAssets = [...ownAssets, ...grantedAssets].sort((left, right) =>
    String(right.createdAt).localeCompare(String(left.createdAt)) || String(right.id).localeCompare(String(left.id)));
  const cursor = cursors.assets ? decodeHistoryCursor(cursors.assets) : null;
  const remainingAssets = cursor ? allAssets.filter(item =>
    String(item.createdAt).localeCompare(cursor.value) < 0 ||
    (String(item.createdAt) === cursor.value && String(item.id).localeCompare(cursor.id) < 0)) : allAssets;
  const assets = remainingAssets.slice(0, 50);
  const lastAsset = assets.at(-1);
  history.assets = { total: allAssets.length, hasMore: remainingAssets.length > assets.length,
    nextCursor: remainingAssets.length > assets.length && lastAsset
      ? Buffer.from(JSON.stringify({ value: String(lastAsset.createdAt), id: lastAsset.id })).toString('base64url') : null };
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
    capabilities: ['observe_agent_communications', 'approve_or_pause_agent_actions', 'review_assets', 'manage_calendar_connectors'],
    history,
    countScope: { navigation: 'loaded-history', summaryTotals: 'workspace' },
    summary: { agents: agents.length, cases: history.cases.total, messages: history.messages.total, assets: history.assets.total, needsMe: projection.counts.needsMe + pendingInvitations },
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
    capabilities: [...new Set((Array.isArray(agent.permissions) ? agent.permissions : [])
      .filter(permission => allowedPermissions.has(permission) && hasPermission(agent, permission)))],
    queue: {
      assignedMessages: messages.filter((item) => item.recipientAgentId === agentId),
      authoredMessages: messages.filter((item) => item.senderAgentId === agentId),
      activeCases: cases.filter(item => item.schemaVersion
        ? isActiveCase(item) && isCaseParticipant(item, agentId)
        : item.status === 'active' && item.participantAgentIds?.includes(agentId)),
      createdAssets: assets.filter((item) => item.createdByAgentId === agentId),
      calendarConnectors: calendarConnectors.map(publicCalendarConnector),
      deliveryReceipts: deliveryReceipts.filter(item => item.senderAgentId === agentId || item.recipientAgentId === agentId)
    }
  };
}

async function route(req, res) {
  const responseNonce = crypto.randomBytes(18).toString('base64');
  applyHeaders(res, req.headers.origin || '', responseNonce);
  if (String(req.url || '').split('?', 1)[0] === '/mcp' && !mcpOriginAllowed(req)) return fail(res, 403, 'MCP Origin is not allowed');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try { assertSafeRequestTarget(req.url); }
  catch { return fail(res, 400, 'Invalid request path'); }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  req.setTimeout(requestTimeoutMs);
  if (!consumeRateLimit(req, res, url.pathname)) return fail(res, 429, 'Request rate limit exceeded');
  const csrfExempt = url.pathname === '/api/email-webhooks/resend'
    || url.pathname.startsWith('/api/object-storage/local-upload/')
    || url.pathname === '/api/auth/phone/start'
    || url.pathname === '/api/auth/phone/verify';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !csrfExempt && parseCookies(req.headers.cookie)[sessionCookieName()] && !verifyCsrfRequest(req)) return fail(res, 403, 'CSRF validation failed');
  if (url.pathname === '/mcp') {
    const identity = await getMcpIdentity(req);
    if (!identity) {
      res.setHeader('www-authenticate', 'Bearer realm="Sinaloa agent MCP"');
      return fail(res, 401, 'Active v1 agent credential required');
    }
    const callRest = async (method, pathname, input, idempotencyKey) => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Local API is unavailable');
      const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
        method,
        headers: {
          authorization: req.headers.authorization,
          ...(input === undefined ? {} : { 'content-type': 'application/json' }),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
        },
        body: input === undefined ? undefined : JSON.stringify(input),
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(requestTimeoutMs, 25_000))
      });
      const payload = await response.json();
      return { status: response.status, payload };
    };
    return handleAgentMcp(req, res, { identity, callRest });
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/web/'))) {
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice('/web/'.length);
    let filePath;
    try { filePath = resolvePathWithin(path.resolve('web'), relative); }
    catch { return fail(res, 400, 'Invalid asset path'); }
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

  const workSettlementRoute = url.pathname.match(/^\/api\/agent\/work\/([^/]+)\/(renew|acknowledge|complete|fail)$/);
  if ((req.method === 'POST' && url.pathname === '/api/agent/work/claim') || (req.method === 'POST' && workSettlementRoute)) {
    const identity = await getAgentWorkIdentity(req);
    if (!identity) return fail(res, 401, 'Active v1 agent credential required');
    if (!hasPermission(identity.agent, 'receive_agent_messages')) return fail(res, 403, 'Agent is not approved to receive messages');
    const input = workSettlementRoute ? await body(req) : {};
    const workId = workSettlementRoute ? assertSafeIdentifier(workSettlementRoute[1], 'workId') : null;
    const action = workSettlementRoute?.[2] || 'claim';
    const requestedMessage = workSettlementRoute ? await store.getJson(messagePath(identity.inboxId, workId)) : null;
    const claimCandidates = action === 'claim' ? await store.listJson(path.join('inboxes', identity.inboxId, 'messages')) : [];
    if (action !== 'claim' && (typeof input.leaseToken !== 'string' || !input.leaseToken)) return fail(res, 400, 'leaseToken is required');
    if (action === 'fail' && typeof input.retryable !== 'boolean') return fail(res, 400, 'retryable must be a boolean');
    let idempotencyKey = null;
    let idempotencyPath = null;
    let requestDigest = null;
    if (action === 'acknowledge' || action === 'complete') {
      idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key'], { required: true });
      idempotencyPath = scopedIdempotencyPath(`agent-work-${action}`, identity.inboxId, identity.agent.id, idempotencyKey);
      requestDigest = semanticDigest({ workId, leaseToken: input.leaseToken });
    }
    const result = await withInboxMutation(identity.inboxId, async writeAudit => {
      const currentIdentity = await getAgentWorkIdentity(req);
      if (!currentIdentity || currentIdentity.inboxId !== identity.inboxId || currentIdentity.agent.id !== identity.agent.id || currentIdentity.familyId !== identity.familyId) {
        throw Object.assign(new Error('Agent credential is revoked or no longer active'), { statusCode: 401 });
      }
      if (!hasPermission(currentIdentity.agent, 'receive_agent_messages')) throw Object.assign(new Error('Agent is not approved to receive messages'), { statusCode: 403 });
      if (action === 'claim') {
        const messages = claimCandidates
          .filter(message => message.senderInboxId && message.senderAgentId && message.recipientInboxId === identity.inboxId && message.recipientAgentId === identity.agent.id && ['delivered', 'acknowledged'].includes(message.status))
          .sort((left, right) => String(left.deliveredAt || left.createdAt).localeCompare(String(right.deliveredAt || right.createdAt)) || String(left.id).localeCompare(String(right.id)));
        for (const candidate of messages) {
          const message = await store.getJson(messagePath(identity.inboxId, candidate.id));
          if (!message || !['delivered', 'acknowledged'].includes(message.status) || message.senderInboxId !== candidate.senderInboxId) continue;
          const binding = await store.getJson(nativeCaseBindingPath(message.caseId));
          if (binding?.pausedAt || binding?.revokedAt || binding?.completedAt) continue;
          const senderContact = await store.getJson(path.join('inboxes', message.senderInboxId, 'contacts', `${identity.agent.id}.json`));
          const recipientContact = await store.getJson(path.join('inboxes', identity.inboxId, 'contacts', `${message.senderAgentId}.json`));
          if (senderContact?.blocked || recipientContact?.blocked) continue;
          const claimPath = workClaimPath(identity.inboxId, message.id);
          const currentClaim = await store.getJson(claimPath);
          if (currentClaim && ['completed', 'failed'].includes(currentClaim.status)) continue;
          if (currentClaim && ['claimed', 'acknowledged'].includes(currentClaim.status) && new Date(currentClaim.leaseExpiresAt) > new Date()) continue;
          const now = store.now();
          if (currentClaim?.status === 'retryable' && new Date(currentClaim.retryAt) > new Date(now)) continue;
          if (currentClaim && agentWorkAttempts(currentClaim) >= agentWorkMaxAttempts) {
            await failAgentWorkPermanently(message, currentClaim, 'MAX_ATTEMPTS_EXCEEDED', now, writeAudit);
            continue;
          }
          const leaseToken = crypto.randomBytes(32).toString('base64url');
          const leaseExpiresAt = new Date(Date.now() + agentWorkLeaseMs).toISOString();
          const claim = {
            workId: message.id,
            messageId: message.id,
            agentId: identity.agent.id,
            inboxId: identity.inboxId,
            credentialFamilyId: identity.familyId,
            fence: Number(currentClaim?.fence || 0) + 1,
            attempts: agentWorkAttempts(currentClaim) + 1,
            leaseTokenHash: hashSecret(leaseToken),
            leaseExpiresAt,
            retryAt: null,
            status: 'claimed',
            createdAt: currentClaim?.createdAt || now,
            updatedAt: now
          };
          await store.putJson(claimPath, claim);
          await writeAudit('agent.work_claimed', { workId: message.id, agentId: identity.agent.id, fence: claim.fence }, now);
          return { status: 200, payload: { work: { workId: message.id, message, leaseToken, leaseExpiresAt } } };
        }
        return { status: 200, payload: { work: null } };
      }

      const currentMessage = await store.getJson(messagePath(identity.inboxId, workId));
      if (!currentMessage || currentMessage.recipientInboxId !== identity.inboxId || currentMessage.recipientAgentId !== identity.agent.id) {
        throw Object.assign(new Error('Work was not found for this agent'), { statusCode: 404 });
      }
      const binding = await store.getJson(nativeCaseBindingPath(currentMessage.caseId));
      if (binding?.pausedAt || binding?.revokedAt || binding?.completedAt) throw Object.assign(new Error('Case is paused or closed'), { statusCode: 403 });
      const senderContact = await store.getJson(path.join('inboxes', currentMessage.senderInboxId, 'contacts', `${identity.agent.id}.json`));
      const recipientContact = await store.getJson(path.join('inboxes', identity.inboxId, 'contacts', `${currentMessage.senderAgentId}.json`));
      if (senderContact?.blocked || recipientContact?.blocked) {
        throw Object.assign(new Error('Message receive permission was lost'), { statusCode: 403 });
      }
      const claimPath = workClaimPath(identity.inboxId, workId);
      const claim = await store.getJson(claimPath);
      const leaseTokenHash = hashSecret(input.leaseToken);
      if (!claim || claim.credentialFamilyId !== identity.familyId || claim.leaseTokenHash !== leaseTokenHash) {
        throw Object.assign(new Error('Work lease fence is stale'), { statusCode: 409 });
      }
      const now = store.now();
      const live = ['claimed', 'acknowledged'].includes(claim.status) && new Date(claim.leaseExpiresAt) > new Date(now);
      const priorComplete = action === 'complete' ? await store.getJson(idempotencyPath) : null;
      if (action === 'complete' && priorComplete) {
        const replay = replayResponse(priorComplete, { principalId: identity.agent.id, requestDigest });
        if (claim.status === 'completed' && replay) return { status: 200, payload: replay };
      }
      if (!live) throw Object.assign(new Error('Work lease has expired or was consumed'), { statusCode: 409 });

      if (action === 'renew') {
        claim.leaseExpiresAt = new Date(Date.now() + agentWorkLeaseMs).toISOString();
        claim.updatedAt = now;
        await store.putJson(claimPath, claim);
        return { status: 200, payload: { workId, leaseToken: input.leaseToken, leaseExpiresAt: claim.leaseExpiresAt } };
      }
      if (action === 'fail') {
        const reasonCode = input.reasonCode == null ? null : String(input.reasonCode).slice(0, 120);
        const retryable = input.retryable && agentWorkAttempts(claim) < agentWorkMaxAttempts;
        if (retryable) {
          claim.status = 'retryable';
          claim.failure = { retryable: true, reasonCode, createdAt: now };
          claim.retryAt = new Date(Date.now() + agentWorkRetryDelay(agentWorkAttempts(claim))).toISOString();
          claim.leaseExpiresAt = null;
          claim.updatedAt = now;
          await store.putJson(claimPath, claim);
        } else await failAgentWorkPermanently(currentMessage, claim, reasonCode || 'MAX_ATTEMPTS_EXCEEDED', now, writeAudit);
        await writeAudit('agent.work_failed', { workId, agentId: identity.agent.id, retryable, reasonCode }, now);
        return { status: 200, payload: { workId, status: claim.status } };
      }

      const state = action === 'acknowledge' ? 'acknowledged' : 'processed';
      if (action === 'acknowledge') {
        const replay = replayResponse(await store.getJson(idempotencyPath), { principalId: identity.agent.id, requestDigest });
        if (replay) return { status: 200, payload: replay };
      }
      if (currentMessage.status === 'processed' || claim.status === 'completed') {
        throw Object.assign(new Error('Work has already been processed'), { statusCode: 409 });
      }
      const receiptId = `delivery_receipt_${currentMessage.id}_${state}`;
      const existingReceipt = await store.getJson(deliveryReceiptPath(identity.inboxId, receiptId));
      if (existingReceipt && action === 'acknowledge' && currentMessage.status === 'acknowledged') {
        const receipt = {
          id: existingReceipt.id,
          type: 'delivery',
          messageId: currentMessage.id,
          senderAgentId: currentMessage.senderAgentId,
          recipientAgentId: currentMessage.recipientAgentId,
          state: 'acknowledged',
          createdAt: existingReceipt.createdAt
        };
        const response = { workId, status: 'acknowledged', receipt };
        claim.status = 'acknowledged';
        claim.updatedAt = now;
        await store.putJson(claimPath, claim);
        await store.putJson(idempotencyPath, { principalId: identity.agent.id, requestDigest, status: 'completed', response, createdAt: now });
        return { status: 200, payload: response };
      }
      if (existingReceipt) throw Object.assign(new Error('Message already has a receipt outside this work fence'), { statusCode: 409 });
      const updated = { ...currentMessage, status: state, [`${state}At`]: now, updatedAt: now };
      const receipt = {
        id: receiptId,
        type: 'delivery',
        messageId: currentMessage.id,
        senderAgentId: currentMessage.senderAgentId,
        recipientAgentId: currentMessage.recipientAgentId,
        state,
        createdAt: now
      };
      const documents = [];
      for (const targetInboxId of new Set([currentMessage.senderInboxId, currentMessage.recipientInboxId])) {
        const targetInbox = await store.getJson(path.join('inboxes', targetInboxId, 'inbox.json'));
        if (!targetInbox) continue;
        const currentCase = await ensureStructuredCase(targetInbox, { ...updated, caseId: updated.caseId }, updated.senderAgentId, updated.createdAt);
        const updatedCase = setCaseMessageDeliveryState(structuredClone(currentCase), updated, state, now);
        documents.push(document(messagePath(targetInboxId, currentMessage.id), updated), document(caseRecordPath(targetInboxId, updatedCase.id), updatedCase), document(deliveryReceiptPath(targetInboxId, receipt.id), receipt));
        await writeAudit(`message.${state}`, { messageId: currentMessage.id, caseId: currentMessage.caseId, senderAgentId: currentMessage.senderAgentId, recipientAgentId: currentMessage.recipientAgentId }, now, targetInboxId);
      }
      claim.status = state === 'processed' ? 'completed' : 'acknowledged';
      claim.updatedAt = now;
      if (state === 'processed') claim.leaseExpiresAt = null;
      const response = { workId, status: state, receipt };
      await store.putJsonBatch(documents);
      await store.putJson(claimPath, claim);
      if (idempotencyPath) await store.putJson(idempotencyPath, { principalId: identity.agent.id, requestDigest, status: 'completed', response, createdAt: now });
      return { status: 201, payload: response };
    }, [requestedMessage?.senderInboxId, ...claimCandidates.filter(message => message.recipientInboxId === identity.inboxId && message.recipientAgentId === identity.agent.id && ['delivered', 'acknowledged'].includes(message.status)).map(message => message.senderInboxId)].filter(Boolean));
    return json(res, result.status, result.payload);
  }

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

  if (req.method === 'POST' && url.pathname === '/api/agent/mcp-read-token') {
    const identity = await getAgentWorkIdentity(req);
    if (!identity) return fail(res, 401, 'Active agent access credential required');
    const input = await body(req);
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => key !== 'caseId')) {
      return fail(res, 400, 'Only an optional caseId is accepted');
    }
    const caseId = input.caseId == null ? null : assertSafeIdentifier(input.caseId, 'caseId');
    return json(res, 201, await issueMcpReadToken(identity, caseId));
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
    const result = await auth.verifyPhone(input.challengeId, input.code);
    const csrfToken = createCsrfToken();
    res.setHeader('set-cookie', [sessionCookieHeader(result.sessionCookieValue), csrfCookieHeader(csrfToken)]);
    const { sessionCookieValue: _sessionCookieValue, ...publicResult } = result;
    return json(res, 200, publicResult);
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const human = await auth.getHuman(req, { requireMfa: false });
    if (!human) return fail(res, 401, 'Authenticated human session required');
    const session = await auth.getSession(req);
    const assurance = session?.assurance || 'provider';
    const mfaSetupRequired = assurance === 'phone' && typeof auth.getMfaSetupRequired === 'function'
      ? await auth.getMfaSetupRequired(req)
      : null;
    return json(res, 200, { ...human, auth: { provider: auth.provider, assurance }, ...(assurance === 'phone' ? { mfaSetupRequired } : {}) });
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
    res.setHeader('set-cookie', [sessionCookieHeader('', { clear: true }), csrfCookieHeader('', { clear: true })]);
    return json(res, 200, typeof result === 'boolean' ? { revoked: true } : result);
  }

  if (url.pathname === '/api/organizations' && req.method === 'GET') {
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Authenticated human session required');
    const organizations = await listHumanOrganizations(human.id);
    const authorized = [];
    for (const organization of organizations) if (await getAuthorizedMembership(organization.id, human)) authorized.push(organization);
    return json(res, 200, authorized);
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
    if (!human || !await getAuthorizedMembership(organizationId, human)) return fail(res, 403, 'Active organization membership required');
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
    if (!claimed.codeVerifier) return fail(res, 400, 'Calendar authorization state is invalid or expired');
    const tokenSet = await exchangeCalendarAuthorizationCode({
      provider,
      code,
      redirectUri: calendarRedirectUri(providerId, req),
      codeVerifier: claimed.codeVerifier,
      timeoutMs: calendarOAuthTimeoutMs
    });
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
    const plannedInboxId = store.id('inbox');
    const enrolled = await withInboxMutation(pendingRecord.inboxId, async writeAudit => {
      const currentRecord = await store.getJson(tokenPath);
      if (!currentRecord || currentRecord.usedAt || new Date(currentRecord.expiresAt) <= new Date()) throw Object.assign(new Error('Enrollment token is invalid, expired, or already used'), { statusCode: 401 });
      const sourceInbox = await store.getJson(path.join('inboxes', currentRecord.inboxId, 'inbox.json'));
      const localMembership = sourceInbox ? await getMembership(sourceInbox.organizationId, currentRecord.humanId) : null;
      let issuerMembership = localMembership;
      if (sourceInbox && auth.provider === 'workos') {
        const [organization, owner] = await Promise.all([
          store.getJson(path.join('organizations', sourceInbox.organizationId, 'organization.json')),
          store.getJson(path.join('humans', `${currentRecord.humanId}.json`))
        ]);
        const providerMembership = organization?.workosOrganizationId && owner?.workosUserId
          ? await auth.getOrganizationMembership(owner.workosUserId, organization.workosOrganizationId)
          : null;
        issuerMembership = localMembership ? { ...localMembership, providerMembership } : null;
      }
      if (!sourceInbox || !membershipCanManage(issuerMembership, auth.provider)) throw Object.assign(new Error('Enrollment owner is invalid'), { statusCode: 403 });
      if ((productionConfig.mode === 'production' || process.env.SINALOA_ENFORCE_BETA_AGENT_LIMIT === '1') && await activeAgentCountForHuman(currentRecord.humanId) >= 2) throw Object.assign(new Error('The beta allows two active agents per human'), { statusCode: 409 });
      const agentName = String(input.name || currentRecord.agentProfile?.name || '').trim();
      if (!agentName) throw Object.assign(new Error('Agent name is required'), { statusCode: 400 });
      const record = await store.claimJson(tokenPath, 'usedAt', store.now());
      if (!record) throw Object.assign(new Error('Enrollment token is invalid, expired, or already used'), { statusCode: 401 });
      const requestedLocalPart = record.agentProfile?.localPart;
      const baseSlug = requestedLocalPart ? normalizeAgentLocalPart(requestedLocalPart) : slugify(input.slug || record.agentProfile?.slug || agentName) || store.id('agent').replace('agent_', '');
      let slug = baseSlug;
      let address = agentAddressForLocalPart(slug);
      if (requestedLocalPart) {
        if (!await reserveIdentity(address, { status: 'reserved' })) throw Object.assign(new Error('That agent address is already taken'), { statusCode: 409 });
      } else {
        while (!(await reserveIdentity(address, { status: 'reserved' }))) { slug = `${baseSlug}-${store.id('slug').slice(-6)}`; address = agentAddressForLocalPart(slug); }
      }
      const createdAt = store.now();
      const agent = { id: store.id('agent'), organizationId: sourceInbox.organizationId, name: agentName, slug, address, identity: publicIdentity(slug), principalHumanId: record.humanId, capabilities: input.capabilities || record.agentProfile?.capabilities || [], permissions: record.permissions, createdAt, status: 'active', onboardingStatus: 'approved', approvedAt: createdAt, approvedByHumanId: record.humanId };
      const inbox = await createDedicatedAgentInbox({ sourceInbox, organizationId: sourceInbox.organizationId, ownerHumanId: record.humanId, agent, status: 'active', inboxId: plannedInboxId });
      await store.putJsonBatch([
        document(path.join('directory', 'agents', `${agent.id}.json`), { agentId: agent.id, inboxId: inbox.id, address: agent.address, externalAddress: externalEmailEnabled ? publicEmailAddressForAgent(agent) : null, status: agent.status, verified: true }),
        document(nativeAddressDirectoryPath(agent.address), { agentId: agent.id, inboxId: inbox.id, address: agent.address, status: agent.status, verified: true })
      ]);
      if (externalEmailEnabled && publicEmailAddressForAgent(agent)) await store.putJson(externalAddressDirectoryPath(publicEmailAddressForAgent(agent)), { agentId: agent.id, inboxId: inbox.id, address: publicEmailAddressForAgent(agent), status: agent.status });
      const credentials = await issueAgentCredentials(agent.id, inbox.id);
      await writeAudit('agent.enrolled', { agentId: agent.id, humanId: record.humanId, permissions: agent.permissions, sourceInboxId: sourceInbox.id }, createdAt, inbox.id);
      await writeAudit('agent.enrollment_redeemed', { enrollmentId: record.id, agentId: agent.id, agentInboxId: inbox.id, address: agent.address, humanId: record.humanId }, createdAt, sourceInbox.id);
      await writeAudit('agent.inbox_created', { agentId: agent.id, inboxId: inbox.id, humanId: record.humanId }, createdAt, sourceInbox.id);
      return { agent, credentials, inbox };
    }, [plannedInboxId], [enrollmentMutationKey(tokenHash), humanEnrollmentMutationKey(pendingRecord.humanId)]);
    return json(res, 201, { agent: publicAgent(enrolled.agent), ...enrolled.credentials, inbox: enrolled.inbox, nativeMessaging: 'ready' });
  }

  if (req.method === 'POST' && url.pathname === '/api/onboarding/agent-account') {
    const input = await body(req);
    if (!input.name) return fail(res, 400, 'Agent name is required');
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Verified human session required');
    input.humanId = human.id;
    const organization = await ensureOrganization(human, input.organizationId);
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey || req.headers['idempotency-key']);
    const onboardingRequestDigest = semanticDigest({
      organizationId: organization.id,
      name: String(input.name).trim(),
      slug: slugify(input.slug || input.name),
      inboxName: input.inboxName || null,
      principalLabel: input.principalLabel || null,
      capabilities: Array.isArray(input.capabilities) ? input.capabilities : [],
      description: input.description || null
    });
    const onboardingIdempotencyPath = idempotencyKey ? scopedIdempotencyPath('agent-onboarding', organization.id, human.id, idempotencyKey) : null;
    let onboardingClaim = null;
    if (onboardingIdempotencyPath) {
      onboardingClaim = await claimIdempotency(store, onboardingIdempotencyPath, { principalId: human.id, requestDigest: onboardingRequestDigest, createdAt: store.now() });
      if (onboardingClaim.replay) return json(res, 200, onboardingClaim.replay);
    }
    try {
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
      if (onboardingIdempotencyPath) await completeIdempotency(store, onboardingIdempotencyPath, { principalId: human.id, requestDigest: onboardingRequestDigest, response: result, createdAt });
      await audit(inboxId, 'agent.account_created', { agentId: agent.id, address: agent.address, identityStatus: agent.identity.status });
      return json(res, 201, result);
    } catch (error) {
      if (onboardingIdempotencyPath && onboardingClaim?.claimed) await store.deleteJson(onboardingIdempotencyPath).catch(() => {});
      throw error;
    }
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

  if (req.method === 'GET' && suffix === 'agent-address-availability') {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const localPart = normalizeAgentLocalPart(url.searchParams.get('localPart'));
    const address = agentAddressForLocalPart(localPart);
    const available = !await store.getJson(path.join('identities', `${identityKey(address)}.json`));
    return json(res, 200, { localPart, address, available });
  }

  if (req.method === 'POST' && suffix === 'agent-enrollment-tokens') {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    if ((productionConfig.mode === 'production' || process.env.SINALOA_ENFORCE_BETA_AGENT_LIMIT === '1') && await activeAgentCountForHuman(human.id) >= 2) return fail(res, 409, 'The beta allows two active agents per human');
    const input = await body(req);
    const requested = Array.isArray(input.permissions) ? input.permissions : ['send_agent_messages', 'receive_agent_messages'];
    const permissions = requested.filter(permission => allowedPermissions.has(permission));
    if (!permissions.includes('receive_agent_messages')) permissions.push('receive_agent_messages');
    const profileName = String(input.agentProfile?.name || '').trim();
    const requestedLocalPart = input.agentProfile?.localPart;
    if (productionConfig.mode === 'production' && !requestedLocalPart) return fail(res, 400, 'Choose an agent address before creating an enrollment token');
    const localPart = requestedLocalPart ? normalizeAgentLocalPart(requestedLocalPart) : null;
    if (localPart && !profileName) return fail(res, 400, 'Agent name is required with a chosen address');
    if (localPart && await store.getJson(path.join('identities', `${identityKey(agentAddressForLocalPart(localPart))}.json`))) return fail(res, 409, 'That agent address is already taken');
    const agentProfile = profileName ? { name: profileName, slug: localPart || slugify(input.agentProfile?.slug || profileName), ...(localPart ? { localPart } : {}), capabilities: Array.isArray(input.agentProfile?.capabilities) ? input.agentProfile.capabilities.slice(0, 20) : [] } : null;
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
    const pkce = createPkcePair();
    const publicUrl = (process.env.SINALOA_PUBLIC_URL || `http://${req.headers.host || `${host}:${port}`}`).replace(/\/$/, '');
    const stateRecord = { provider: providerId, inboxId, humanId: human.id, codeVerifier: pkce.verifier, returnTo: `${publicUrl}/?workspace=${encodeURIComponent(inboxId)}`, createdAt: store.now(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), usedAt: null };
    await store.putJson(path.join('auth', 'calendar-oauth', `${hashSecret(state)}.json`), stateRecord);
    const authorizationUrl = new URL(provider.authorizeUrl);
    authorizationUrl.searchParams.set('client_id', provider.clientId);
    authorizationUrl.searchParams.set('redirect_uri', calendarRedirectUri(providerId, req));
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('scope', provider.scopes.join(' '));
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('code_challenge', pkce.challenge);
    authorizationUrl.searchParams.set('code_challenge_method', pkce.method);
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
    return json(res, 200, await fetchEventPage(store, inboxId, { cursor, limit: url.searchParams.get('limit') ?? 100 }));
  }

  if (req.method === 'GET' && suffix === 'events') {
    const human = await auth.getHuman(req);
    const agent = await getAgentPrincipal(req, inboxId);
    if (!await canAccessInbox(human, inbox) && !agent) return fail(res, 401, 'Authenticated inbox participant required');
    const cursor = String(req.headers['last-event-id'] || url.searchParams.get('cursor') || '');
    if (cursor.length > 512 || /[\r\n\0]/.test(cursor)) return fail(res, 400, 'Event cursor is invalid');
    const connectionKey = rateIdentity(req);
    if (Number(sseCounts.get(connectionKey) || 0) >= maxSsePerPrincipal) return fail(res, 429, 'Too many concurrent event streams');
    sseCounts.set(connectionKey, Number(sseCounts.get(connectionKey) || 0) + 1);
    req.setTimeout(0);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const subscription = { res, cursor, sentIds: new Set(), heartbeat: null, agentId: agent?.id || null, humanId: human?.id || null, replaying: true, buffer: new Map(), overflow: false };
    const set = streams.get(inboxId) || new Set(); set.add(subscription); streams.set(inboxId, set);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(subscription.heartbeat);
      set.delete(subscription);
      if (!set.size) streams.delete(inboxId);
      const remaining = Math.max(0, Number(sseCounts.get(connectionKey) || 1) - 1);
      if (remaining) sseCounts.set(connectionKey, remaining); else sseCounts.delete(connectionKey);
    };
    res.on('close', cleanup);
    const resumeReplay = () => {
      // No id field: reconnect from the last actual event, never beyond it.
      if (!res.destroyed) res.write(`event: replay_required\ndata: ${JSON.stringify({ cursor: subscription.cursor || null, hasMore: true })}\n\n`);
      cleanup(); res.end();
    };
    try {
      let hasMore = false;
      for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
        const page = await fetchEventPage(store, inboxId, { cursor: subscription.cursor, limit: 100 });
        if (cleaned) return;
        for (const event of page.events) sendStreamEvent(subscription, event);
        hasMore = page.hasMore;
        if (!hasMore || subscription.overflow) break;
      }
      if (hasMore || subscription.overflow) { resumeReplay(); return; }
      const buffered = [...subscription.buffer.values()].map(normalizeStreamEvent).sort((a, b) => a.cursor.localeCompare(b.cursor));
      for (const event of buffered) {
        if (!cursor || event.cursor > cursor) sendStreamEvent(subscription, event);
      }
      subscription.buffer.clear();
      subscription.replaying = false;
      res.write(`event: ready\ndata: ${JSON.stringify({ inboxId, at: store.now(), cursor: subscription.cursor || cursor || null })}\n\n`);
      subscription.heartbeat = setInterval(() => res.write(`: keepalive ${store.now()}\n\n`), 20_000);
      subscription.heartbeat.unref?.();
    } catch (error) {
      cleanup();
      res.write(`event: replay_error\ndata: ${JSON.stringify({ message: 'Event history is temporarily unavailable' })}\n\n`);
      res.end();
    }
    return;
  }

  if (req.method === 'GET' && suffix === '') return json(res, 200, inbox);

  if (req.method === 'GET' && suffix === 'human-view') {
    const human = await auth.getHuman(req);
    if (!await canAccessInbox(human, inbox)) return fail(res, 403, 'Workspace membership required');
    const [view, requesterCanManage] = await Promise.all([
      humanView(inboxId, inbox, req, parseHistoryCursors(url.searchParams.get('history'))),
      canManageInbox(human, inbox)
    ]);
    return json(res, 200, { ...view, canManageInbox: requesterCanManage });
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
    const address = `${slug}@${agentDomain}`;
    if (!await reserveIdentity(address, { status: 'reserved' })) return fail(res, 409, 'Agent email address is already registered');
    const agent = { id: store.id('agent'), name: input.name, slug, address, identity: publicIdentity(slug), principalHumanId: input.humanId, capabilities: input.capabilities || [], permissions: [], createdAt: store.now(), status: 'pending_approval', onboardingStatus: 'pending_approval' };
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
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const [, agentId, action] = blockMatch;
    assertSafeIdentifier(agentId, 'agentId');
    if (!await store.getJson(path.join('directory', 'agents', `${agentId}.json`))) return fail(res, 404, 'Agent not found');
    const existing = await store.getJson(path.join('inboxes', inboxId, 'contacts', `${agentId}.json`), { agentId, approved: true });
    const contact = { ...existing, agentId, blocked: action === 'block', updatedAt: store.now() };
    await store.putJson(path.join('inboxes', inboxId, 'contacts', `${agentId}.json`), contact);
    await audit(inboxId, `contact.${action}ed`, { agentId, actor: human.id });
    return json(res, 200, contact);
  }

  const pauseMatch = suffix.match(/^agents\/([^/]+)\/(pause|resume)$/);
  if (req.method === 'POST' && pauseMatch) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const [, agentId, action] = pauseMatch;
    assertSafeIdentifier(agentId, 'agentId');
    const result = await withInboxMutation(inboxId, async writeAudit => {
      const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
      if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
      if (agent.status !== 'active' || agent.onboardingStatus !== 'approved') throw Object.assign(new Error('Agent is not active and approved'), { statusCode: 409 });
      const now = store.now();
      const updated = { ...agent, pausedAt: action === 'pause' ? (agent.pausedAt || now) : null, pausedByHumanId: action === 'pause' ? human.id : null, updatedAt: now };
      await store.putJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`), updated);
      await writeAudit(`agent.${action}d`, { agentId, humanId: human.id, pausedAt: updated.pausedAt });
      return publicAgent(updated);
    });
    if (action === 'pause') disconnectAgentStreams(inboxId, agentId);
    return json(res, 200, result);
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
    const existingAgent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
    if (!existingAgent) return fail(res, 404, 'Agent not found');
    if (!await canAccessInbox(human, inbox)) return fail(res, 403, 'Active workspace membership required');
    if (human.id !== (existingAgent.principalHumanId || inbox.ownerHumanId) && !await canManageInbox(human, inbox)) return fail(res, 403, 'Only the linked human or a workspace administrator may approve this agent');
    const result = await withInboxMutation(inboxId, async writeAudit => {
      const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
      if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
      let credentials = null;
      if (decision === 'reject') {
        agent.status = 'rejected';
        agent.onboardingStatus = 'rejected';
        agent.permissions = [];
        await revokeAgentCredentialFamilies(inboxId, agent.id, human.id);
        await store.putJsonBatch([
          document(path.join('directory', 'agents', `${agent.id}.json`), { agentId: agent.id, inboxId, address: agent.address, externalAddress: externalEmailEnabled ? publicEmailAddressForAgent(agent) : null, status: agent.status, verified: true }),
          document(nativeAddressDirectoryPath(agent.address), { agentId: agent.id, inboxId, address: agent.address, status: agent.status, verified: true })
        ]);
        if (externalEmailEnabled && publicEmailAddressForAgent(agent)) await store.putJson(externalAddressDirectoryPath(publicEmailAddressForAgent(agent)), { agentId: agent.id, inboxId, address: publicEmailAddressForAgent(agent), status: agent.status });
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
        await store.putJson(path.join('inboxes', inboxId, 'inbox.json'), { ...inbox, status: 'active' });
      }
      agent.approvedAt = store.now();
      agent.approvedByHumanId = human.id;
      await store.putJson(path.join('inboxes', inboxId, 'agents', `${agent.id}.json`), agent);
      await writeAudit(`agent.onboarding_${decision}ed`, { agentId: agent.id, humanId: human.id, permissions: agent.permissions });
      return { agent, credentials };
    });
    if (decision === 'reject') disconnectAgentStreams(inboxId, agentId);
    return json(res, 200, { agent: publicAgent(result.agent), ...(result.credentials || {}) });
  }

  const revokeAgentCredentials = suffix.match(/^agents\/([^/]+)\/credentials\/revoke$/);
  if (req.method === 'POST' && revokeAgentCredentials) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const agentId = revokeAgentCredentials[1];
    const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
    if (!agent) return fail(res, 404, 'Agent not found');
    const revoked = await withInboxMutation(inboxId, async writeAudit => {
      const revokedAt = store.now();
      const credentialFamilyCount = await revokeAgentCredentialFamilies(inboxId, agentId, human.id, revokedAt);
      await writeAudit('agent.credentials_revoked', { agentId, humanId: human.id, credentialFamilyCount });
      return { revoked: true, agentId, credentialFamilyCount, revokedAt };
    });
    disconnectAgentStreams(inboxId, agentId);
    return json(res, 200, revoked);
  }

  if (req.method === 'POST' && suffix === 'cases') {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !hasPermission(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    if (!String(input.objective || '').trim()) return fail(res, 400, 'A structured case objective is required');
    const value = await withInboxMutation(inboxId, async writeAudit => {
      const currentPrincipal = await getAgentPrincipal(req, inboxId);
      if (!currentPrincipal || !hasPermission(currentPrincipal, 'execute_cases')) throw Object.assign(new Error('Agent credential with execute_cases permission required'), { statusCode: 403 });
      const now = store.now();
      const created = createAgentCase({ id: store.id('case'), objective: input.objective, collaborationMode: input.collaborationMode || 'collaboration', principal: inbox.ownerHumanId, actingAgent: currentPrincipal.id, participants: input.participants || [], constraints: input.constraints || {}, deadline: input.deadline || null, createdAt: now });
      if (!await store.putJsonIfAbsent(caseRecordPath(inboxId, created.id), created)) throw Object.assign(new Error('Case ID already exists'), { statusCode: 409 });
      await writeAudit('case.created', { caseId: created.id, actingAgent: currentPrincipal.id, objective: created.objective });
      return created;
    });
    return json(res, 201, value);
  }

  const caseRoute = suffix.match(/^cases\/([^/]+)(?:\/(events|actions|policy-evaluations|proposals|receipt))?$/);
  if (req.method === 'GET' && caseRoute && !caseRoute[2]) {
    const value = await getCase(inboxId, caseRoute[1]);
    if (!value) return fail(res, 404, 'Case not found');
    const human = await auth.getHuman(req);
    if (!human && !await canAgentReadNativeCase(inboxId, caseRoute[1], await getAgentPrincipal(req, inboxId))) return fail(res, 403, 'Case access is paused or blocked');
    return json(res, 200, value);
  }

  if (req.method === 'POST' && caseRoute?.[2] === 'events') {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !hasPermission(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    if (!['message', 'error'].includes(input.type)) return fail(res, 400, 'Direct event writes support only message or error; use actions for stateful work');
    const event = await withInboxMutation(inboxId, async writeAudit => {
      const currentPrincipal = await getAgentPrincipal(req, inboxId);
      if (!currentPrincipal || !hasPermission(currentPrincipal, 'execute_cases')) throw Object.assign(new Error('Agent credential with execute_cases permission required'), { statusCode: 403 });
      const value = await getCase(inboxId, caseRoute[1]);
      if (!value?.schemaVersion) throw Object.assign(new Error('Structured case not found'), { statusCode: 404 });
      if (!isCaseParticipant(value, currentPrincipal.id)) throw Object.assign(new Error('Case participant credential required'), { statusCode: 403 });
      const now = store.now();
      appendEvent(value, { id: store.id('evt'), type: input.type, actor: currentPrincipal.id, createdAt: now, payload: input.payload || {}, linkedPolicyEvaluation: input.linkedPolicyEvaluation || null, precedingEventRef: input.precedingEventRef || value.events.at(-1)?.id || null });
      await saveCase(inboxId, value);
      const appended = value.events.at(-1);
      await writeAudit('case.event_appended', { caseId: value.id, eventId: appended.id, eventType: input.type, actor: currentPrincipal.id });
      return appended;
    });
    return json(res, 201, event);
  }

  if (req.method === 'POST' && caseRoute?.[2] === 'policy-evaluations') {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !hasPermission(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    if (!input.requestedAction) return fail(res, 400, 'requestedAction is required');
    const evaluation = await withInboxMutation(inboxId, async writeAudit => {
      const currentPrincipal = await getAgentPrincipal(req, inboxId);
      if (!currentPrincipal || !hasPermission(currentPrincipal, 'execute_cases')) throw Object.assign(new Error('Agent credential with execute_cases permission required'), { statusCode: 403 });
      const value = await getCase(inboxId, caseRoute[1]);
      if (!value?.schemaVersion) throw Object.assign(new Error('Structured case not found'), { statusCode: 404 });
      if (!isCaseParticipant(value, currentPrincipal.id)) throw Object.assign(new Error('Case participant credential required'), { statusCode: 403 });
      const now = store.now();
      const evaluationId = store.id('policy_eval');
      const evaluated = await evaluateServerPolicy(inboxId, currentPrincipal, value, { ...input, id: evaluationId }, { id: evaluationId });
      const created = policyEvaluationFromInput({ id: evaluationId, requestedAction: input.requestedAction, decision: evaluated.decision, matchedPolicyId: evaluated.matchedPolicyId, grantType: 'oneTime', expiresAt: evaluated.expiresAt, reasonCode: evaluated.reasonCode }, currentPrincipal.id, now);
      const updated = addPolicyEvaluation(value, created, { at: now });
      await store.putJsonBatch([document(caseRecordPath(inboxId, updated.id), updated), document(policyBindingPath(inboxId, created.id), evaluated.binding)]);
      await writeAudit('policy.evaluated', { caseId: value.id, policyEvaluationId: created.id, requestedAction: created.requestedAction, decision: created.decision, reasonCode: created.reasonCode });
      return created;
    });
    return json(res, 201, evaluation);
  }

  if (req.method === 'POST' && caseRoute?.[2] === 'proposals') {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !hasPermission(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    const proposal = await withInboxMutation(inboxId, async writeAudit => {
      const currentPrincipal = await getAgentPrincipal(req, inboxId);
      if (!currentPrincipal || !hasPermission(currentPrincipal, 'execute_cases')) throw Object.assign(new Error('Agent credential with execute_cases permission required'), { statusCode: 403 });
      const value = await getCase(inboxId, caseRoute[1]);
      if (!value?.schemaVersion) throw Object.assign(new Error('Structured case not found'), { statusCode: 404 });
      if (!isCaseParticipant(value, currentPrincipal.id)) throw Object.assign(new Error('Case participant credential required'), { statusCode: 403 });
      const now = store.now();
      const created = proposalFromInput(input, now);
      const updated = addProposal(value, created);
      appendEvent(updated, { id: store.id('evt'), type: 'decision', actor: currentPrincipal.id, createdAt: now, payload: { proposalId: created.id, status: created.status }, linkedPolicyEvaluation: null, precedingEventRef: updated.events.at(-1)?.id || null });
      await saveCase(inboxId, updated);
      await writeAudit('proposal.created', { caseId: value.id, proposalId: created.id, kind: created.kind, actor: currentPrincipal.id });
      return created;
    });
    return json(res, 201, proposal);
  }

  if (req.method === 'POST' && caseRoute?.[2] === 'actions') {
    const input = await body(req);
    const idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key'] || input.idempotencyKey, { required: true });
    const human = await auth.getHuman(req);
    const principal = await getAgentPrincipal(req, inboxId);
    const humanCanManage = human ? await canManageInbox(human, inbox) : false;
    if (!humanCanManage && (!principal || !hasPermission(principal, 'execute_cases'))) return fail(res, 403, 'Workspace administrator or agent credential with execute_cases permission required');
    const nativeBinding = await store.getJson(nativeCaseBindingPath(caseRoute[1]));
    const relatedInboxIds = nativeBinding?.inboxIds?.includes(inboxId) ? nativeBinding.inboxIds.filter(id => id !== inboxId) : [];
    const response = await withInboxMutation(inboxId, async writeAudit => {
      const currentPrincipal = humanCanManage ? null : await getAgentPrincipal(req, inboxId);
      if (!humanCanManage && (!currentPrincipal || !hasPermission(currentPrincipal, 'execute_cases'))) throw Object.assign(new Error('Agent credential with execute_cases permission required'), { statusCode: 403 });
      const value = await getCase(inboxId, caseRoute[1]);
      if (!value?.schemaVersion) throw Object.assign(new Error('Structured case not found'), { statusCode: 404 });
      if (['paused', 'revoked', 'completed'].includes(value.state) && !(humanCanManage && input.actionKey === 'resume' && value.state === 'paused')) throw Object.assign(new Error('Case is paused or closed'), { statusCode: 403 });
      const now = store.now();
      let result;
      if (humanCanManage) {
        if (input.actionKey === 'resume' && value.state !== 'paused') throw Object.assign(new Error('Case is not paused'), { statusCode: 409 });
        const requestDigest = actionRequestDigest({ ...input, actor: human.id, outcome: 'ok' });
        const replayEvent = value.events.find(event => event.payload?.action?.idempotencyKey === idempotencyKey);
        if (replayEvent) {
          const replayAction = replayEvent.payload.action;
          if (replayAction.actor !== human.id || replayAction.externalRefs?.requestDigest !== requestDigest) throw Object.assign(new Error('Idempotency key was already used for a different action'), { statusCode: 409 });
          return { status: 200, result: { case: value, action: replayAction, replay: true } };
        }
        if (input.actionKey === 'approveOnce') {
          const evaluationId = input.externalRefs?.policyEvaluationId;
          const evaluation = value.policyEvaluations.find(item => item.id === evaluationId);
          const binding = evaluation ? await store.getJson(policyBindingPath(inboxId, evaluationId)) : null;
          await policyDecisionChain(inboxId);
          if (!evaluationId || !evaluation || !binding || !verifyDecisionRecord(binding, { keyring: policyKeyring, requireSigned: true }) || evaluation.decision !== 'needsHuman' || new Date(binding.expiresAt) <= new Date()) throw Object.assign(new Error('A current needsHuman policy evaluation is required for one-time approval'), { statusCode: 409 });
        }
        result = applyHumanAction(value, { id: store.id('action'), actionKey: input.actionKey, actor: human.id, idempotencyKey, externalRefs: { ...(input.externalRefs || {}), requestDigest }, reasonCode: input.reasonCode || null }, { at: now });
      } else {
        if (currentPrincipal.id !== value.actingAgent || !isCaseParticipant(value, currentPrincipal.id)) throw Object.assign(new Error('Case participant credential required'), { statusCode: 403 });
        const requestDigest = actionRequestDigest({ ...input, actor: currentPrincipal.id });
        const replayEvent = value.events.find(event => event.payload?.action?.idempotencyKey === idempotencyKey);
        if (replayEvent) {
          const replayAction = replayEvent.payload.action;
          if (replayAction.actor !== currentPrincipal.id || replayAction.externalRefs?.requestDigest !== requestDigest) throw Object.assign(new Error('Idempotency key was already used for a different action'), { statusCode: 409 });
          return { status: 200, result: { case: value, action: replayAction, replay: true } };
        }
        let policyExternalRefs = { ...(input.externalRefs || {}), requestDigest };
        const actionId = store.id('action');
        if (requiresPolicyEvaluation(input.actionKey)) {
          if (!input.policyEvaluationId) throw Object.assign(new Error('policyEvaluationId is required for policy-controlled or unknown agent actions'), { statusCode: 400 });
          const authorization = await validatedPolicyBinding(inboxId, value, currentPrincipal, input.policyEvaluationId, { requestedAction: input.actionKey, actionPayload: input.actionPayload || {}, executionId: actionId, writeAudit });
          policyExternalRefs = { ...policyExternalRefs, policyEvaluationId: input.policyEvaluationId, policyExecutionId: authorization.refreshed.id };
        }
        result = applyAgentAction(value, { id: actionId, actionKey: input.actionKey, actor: currentPrincipal.id, idempotencyKey, outcome: input.outcome, externalRefs: policyExternalRefs, reasonCode: input.reasonCode || null }, { at: now, nextState: input.nextState || null });
      }
      await saveCase(inboxId, result.case);
      if (humanCanManage && nativeBinding && ['pause', 'resume', 'revoke', 'decline'].includes(input.actionKey)) {
        const currentBinding = await store.getJson(nativeCaseBindingPath(value.id));
        if (!currentBinding?.inboxIds?.includes(inboxId)) throw Object.assign(new Error('Case binding changed'), { statusCode: 409 });
        const now = store.now();
        const updatedBinding = { ...currentBinding, pausedAt: input.actionKey === 'pause' ? now : input.actionKey === 'resume' ? null : currentBinding.pausedAt, revokedAt: ['revoke', 'decline'].includes(input.actionKey) ? now : currentBinding.revokedAt, updatedAt: now };
        await store.putJson(nativeCaseBindingPath(value.id), updatedBinding);
        for (const otherInboxId of relatedInboxIds) {
          const otherCase = await getCase(otherInboxId, value.id);
          if (!otherCase) continue;
          const mirrored = applyHumanAction(otherCase, { ...result.action, externalRefs: result.action.externalRefs }, { at: now });
          await saveCase(otherInboxId, mirrored.case);
          await writeAudit('case.action_recorded', { caseId: value.id, actionId: result.action.id, actionKey: result.action.actionKey, actor: human.id, outcome: result.action.outcome }, now, otherInboxId);
        }
      }
      if (!result.replay) await writeAudit('case.action_recorded', { caseId: value.id, actionId: result.action.id, actionKey: result.action.actionKey, actor: result.action.actor, outcome: result.action.outcome });
      return { status: result.replay ? 200 : 201, result };
    }, relatedInboxIds);
    return json(res, response.status, response.result);
  }

  const proposalRoute = suffix.match(/^cases\/([^/]+)\/proposals\/([^/]+)\/(counter|accept)$/);
  if (req.method === 'POST' && proposalRoute) {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !hasPermission(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    const response = await withInboxMutation(inboxId, async writeAudit => {
      const currentPrincipal = await getAgentPrincipal(req, inboxId);
      if (!currentPrincipal || !hasPermission(currentPrincipal, 'execute_cases')) throw Object.assign(new Error('Agent credential with execute_cases permission required'), { statusCode: 403 });
      const value = await getCase(inboxId, proposalRoute[1]);
      if (!value?.schemaVersion) throw Object.assign(new Error('Structured case not found'), { statusCode: 404 });
      if (!isCaseParticipant(value, currentPrincipal.id)) throw Object.assign(new Error('Case participant credential required'), { statusCode: 403 });
      const now = store.now();
      if (proposalRoute[3] === 'counter') {
        const options = proposalFromInput({ kind: value.proposals.find(item => item.id === proposalRoute[2])?.kind, options: input.options }, now).options;
        const updated = counterProposal(value, proposalRoute[2], { options, at: now });
        appendEvent(updated, { id: store.id('evt'), type: 'decision', actor: currentPrincipal.id, createdAt: now, payload: { proposalId: proposalRoute[2], status: 'countered', messageType: 'counterproposal' }, linkedPolicyEvaluation: null, precedingEventRef: updated.events.at(-1)?.id || null });
        await saveCase(inboxId, updated);
        await writeAudit('proposal.countered', { caseId: value.id, proposalId: proposalRoute[2], actor: currentPrincipal.id });
        return { status: 201, result: updated.proposals.find(item => item.id === proposalRoute[2]) };
      }
      const idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key'] || input.idempotencyKey, { required: true });
      if (!input.optionId || !input.policyEvaluationId) throw Object.assign(new Error('optionId and policyEvaluationId are required'), { statusCode: 400 });
      const requestDigest = actionRequestDigest({ actor: currentPrincipal.id, actionKey: 'acceptProposal', outcome: null, policyEvaluationId: input.policyEvaluationId, externalRefs: { proposalId: proposalRoute[2], optionId: input.optionId } });
      const replayEvent = value.events.find(event => event.payload?.action?.idempotencyKey === idempotencyKey);
      if (replayEvent) {
        const replayAction = replayEvent.payload.action;
        if (replayAction.actor !== currentPrincipal.id || replayAction.externalRefs?.requestDigest !== requestDigest) throw Object.assign(new Error('Idempotency key was already used for a different action'), { statusCode: 409 });
        return { status: 200, result: { case: value, action: replayAction, replay: true } };
      }
      const evaluation = value.policyEvaluations.find(item => item.id === input.policyEvaluationId);
      if (!evaluation || evaluation.actor !== currentPrincipal.id) throw Object.assign(new Error('A case policy evaluation for this agent is required'), { statusCode: 403 });
      const actionId = store.id('action');
      const authorization = await validatedPolicyBinding(inboxId, value, currentPrincipal, evaluation.id, { proposalId: proposalRoute[2], optionId: input.optionId, executionId: actionId, allowPendingHuman: true, writeAudit });
      const effectiveEvaluation = evaluation.decision === 'needsHuman' && authorization.humanApproved ? { ...evaluation, decision: 'allow', reasonCode: 'humanApproved' } : evaluation;
      const result = acceptProposal(value, proposalRoute[2], input.optionId, effectiveEvaluation, { actor: currentPrincipal.id, idempotencyKey, actionId, externalRefs: { requestDigest, policyEvaluationId: evaluation.id, policyExecutionId: authorization.refreshed.phase === 'execution' ? authorization.refreshed.id : null }, at: now });
      await saveCase(inboxId, result.case);
      if (!result.replay) await writeAudit('proposal.accept_attempted', { caseId: value.id, proposalId: proposalRoute[2], optionId: input.optionId, actor: currentPrincipal.id, outcome: result.action.outcome });
      return { status: result.action.outcome === 'needsApproval' ? 202 : 201, result };
    });
    return json(res, response.status, response.result);
  }

  if (req.method === 'POST' && caseRoute?.[2] === 'receipt') {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || principal.id === undefined || !hasPermission(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    if (!input.result || !input.authorityBasis) return fail(res, 400, 'Receipt result and authorityBasis are required');
    const nativeBinding = await store.getJson(nativeCaseBindingPath(caseRoute[1]));
    const relatedInboxIds = nativeBinding?.inboxIds?.includes(inboxId) ? nativeBinding.inboxIds.filter(id => id !== inboxId) : [];
    const receipt = await withInboxMutation(inboxId, async writeAudit => {
      const currentPrincipal = await getAgentPrincipal(req, inboxId);
      if (!currentPrincipal || !hasPermission(currentPrincipal, 'execute_cases')) throw Object.assign(new Error('Agent credential with execute_cases permission required'), { statusCode: 403 });
      const value = await getCase(inboxId, caseRoute[1]);
      if (!value?.schemaVersion) throw Object.assign(new Error('Structured case not found'), { statusCode: 404 });
      if (!isCaseParticipant(value, currentPrincipal.id)) throw Object.assign(new Error('Case participant credential required'), { statusCode: 403 });
      const currentBinding = nativeBinding ? await store.getJson(nativeCaseBindingPath(value.id)) : null;
      if (nativeBinding && (!currentBinding || currentBinding.pausedAt || currentBinding.revokedAt || currentBinding.completedAt || value.nativeOutcome?.status !== 'accepted')) {
        throw Object.assign(new Error('Native case requires an active accepted decision before completion'), { statusCode: 409 });
      }
      const now = store.now();
      const verifiedApproval = value.events.some(event => event.type === 'humanAction' && event.payload?.action?.actionKey === 'approveOnce');
      const created = { id: store.id('receipt'), result: input.result, counterparties: input.counterparties || [], externalIds: input.externalIds || {}, authorityBasis: input.authorityBasis, humanApprovalStatus: verifiedApproval ? 'approved' : input.humanApprovalStatus === 'notRequired' ? 'notRequired' : 'pending', evidenceRefs: input.evidenceRefs || [], createdAt: now };
      const updated = completeCase(value, created, { actor: currentPrincipal.id, at: now });
      await saveCase(inboxId, updated);
      for (const otherInboxId of relatedInboxIds) {
        const otherCase = await getCase(otherInboxId, value.id);
        if (!otherCase?.schemaVersion || otherCase.nativeOutcome?.status !== 'accepted') throw Object.assign(new Error('Counterparty case is not ready for completion'), { statusCode: 409 });
        assertNativeCaseParticipants(otherCase, currentBinding.agentIds[0], currentBinding.agentIds[1]);
        const mirrored = completeCase(otherCase, created, { actor: currentPrincipal.id, at: now });
        await saveCase(otherInboxId, mirrored);
        await writeAudit('case.completed', { caseId: value.id, receiptId: created.id, actor: currentPrincipal.id }, now, otherInboxId);
      }
      if (currentBinding) await store.putJson(nativeCaseBindingPath(value.id), { ...currentBinding, completedAt: now, updatedAt: now });
      await writeAudit('case.completed', { caseId: value.id, receiptId: created.id, actor: currentPrincipal.id });
      return created;
    }, relatedInboxIds);
    return json(res, 201, receipt);
  }

  if (req.method === 'GET' && suffix === 'cases') {
    const cases = await listCases(inboxId, { limit: url.searchParams.get('limit'), before: url.searchParams.get('before') });
    const human = await auth.getHuman(req);
    const agent = human ? null : await getAgentPrincipal(req, inboxId);
    return json(res, 200, human ? cases : (await Promise.all(cases.map(async value => await canAgentReadNativeCase(inboxId, value.id, agent) ? value : null))).filter(Boolean));
  }
  if (req.method === 'GET' && suffix === 'messages') {
    const caseId = url.searchParams.get('caseId');
    const human = await auth.getHuman(req);
    const agent = human ? null : await getAgentPrincipal(req, inboxId);
    if (caseId && !human) {
      const binding = await store.getJson(nativeCaseBindingPath(caseId));
      if (binding && !binding.inboxIds?.includes(inboxId)) return json(res, 200, []);
    }
    if (caseId && !human && !await canAgentReadNativeCase(inboxId, caseId, agent)) return fail(res, 403, 'Case access is paused or blocked');
    const messages = await listMessages(inboxId, caseId, { limit: url.searchParams.get('limit'), before: url.searchParams.get('before') });
    return json(res, 200, human || caseId ? messages : (await Promise.all(messages.map(async message => await canAgentReadNativeCase(inboxId, message.caseId, agent) ? message : null))).filter(Boolean));
  }
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
    const retried = await withInboxMutation(existingDelivery.senderInboxId, async writeAudit => {
      const currentDelivery = await store.getOutbox(existingDelivery.id);
      if (!currentDelivery || currentDelivery.status !== 'deadLettered') throw Object.assign(new Error('Only dead-lettered deliveries can be retried'), { statusCode: 409 });
      const message = await store.getJson(messagePath(currentDelivery.senderInboxId, currentDelivery.messageId));
      const at = store.now();
      const queued = message ? { ...message, status: 'queued', queuedAt: at, updatedAt: at, lastDeliveryError: null, deliveryAttempts: 0 } : null;
      const documents = queued ? [document(messagePath(currentDelivery.senderInboxId, queued.id), queued)] : [];
      if (queued) {
        const senderInbox = await store.getJson(path.join('inboxes', currentDelivery.senderInboxId, 'inbox.json'));
        if (senderInbox) {
          const currentCase = await ensureStructuredCase(senderInbox, { ...queued, caseId: queued.caseId }, queued.senderAgentId, queued.createdAt);
          const updatedCase = setCaseMessageDeliveryState(structuredClone(currentCase), queued, 'queued', at);
          documents.push(document(caseRecordPath(currentDelivery.senderInboxId, updatedCase.id), updatedCase));
        }
      }
      const value = await store.retryOutbox(currentDelivery.id, documents);
      if (!value) throw Object.assign(new Error('Delivery could not be retried'), { statusCode: 409 });
      await writeAudit('message.dead_letter_requeued', { messageId: currentDelivery.messageId, deliveryId: currentDelivery.id, actor: human.id }, at);
      return value;
    }, [existingDelivery.recipientInboxId].filter(Boolean));
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
    const response = await withInboxMutation(inboxId, async writeAudit => {
      const currentInvitation = await store.getJson(invitationPath(inboxId, invitationId));
      if (!currentInvitation || currentInvitation.recipientInboxId !== inboxId) throw Object.assign(new Error('Invitation not found'), { statusCode: 404 });
      if (!['pending', decision === 'accept' ? 'accepted' : 'declined'].includes(currentInvitation.state)) throw Object.assign(new Error(`Invitation is already ${currentInvitation.state}`), { statusCode: 409 });
      const now = store.now();
      const senderInbox = await store.getJson(path.join('inboxes', currentInvitation.senderInboxId, 'inbox.json'));
      const pendingMessage = await store.getJson(messagePath(currentInvitation.senderInboxId, currentInvitation.messageId));
      if (!senderInbox || !pendingMessage) throw Object.assign(new Error('Invitation message is no longer available'), { statusCode: 409 });
      if (decision === 'decline') {
        const declined = { ...currentInvitation, state: 'declined', declinedAt: currentInvitation.declinedAt || now, decidedByHumanId: human.id, updatedAt: now };
        const message = { ...pendingMessage, status: 'declined', updatedAt: now };
        await store.putJsonBatch([
          document(invitationPath(inboxId, currentInvitation.id), declined),
          document(invitationPath(currentInvitation.senderInboxId, currentInvitation.id), declined),
          document(messagePath(currentInvitation.senderInboxId, message.id), message),
          document(path.join('inboxes', inboxId, 'contacts', `${currentInvitation.senderAgentId}.json`), { agentId: currentInvitation.senderAgentId, email: currentInvitation.fromAddress, state: 'declined', approved: false, blocked: false, updatedAt: now })
        ]);
        await writeAudit('invitation.declined', { invitationId: currentInvitation.id, senderAgentId: currentInvitation.senderAgentId, humanId: human.id });
        return { status: 200, result: declined, queued: false };
      }
      const conversationId = currentInvitation.conversationId || currentInvitation.pendingConversationId || store.id('conversation');
      const accepted = { ...currentInvitation, state: 'accepted', conversationId, acceptedAt: currentInvitation.acceptedAt || now, decidedByHumanId: human.id, updatedAt: now };
      const senderContact = { agentId: currentInvitation.recipientAgentId, email: currentInvitation.toAddress, state: 'accepted', approved: true, blocked: false, conversationId, updatedAt: now };
      const recipientContact = { agentId: currentInvitation.senderAgentId, email: currentInvitation.fromAddress, state: 'accepted', approved: true, blocked: false, conversationId, updatedAt: now };
      await store.putJsonBatch([
        document(invitationPath(inboxId, currentInvitation.id), accepted),
        document(invitationPath(currentInvitation.senderInboxId, currentInvitation.id), accepted),
        document(path.join('inboxes', currentInvitation.senderInboxId, 'contacts', `${currentInvitation.recipientAgentId}.json`), senderContact),
        document(path.join('inboxes', inboxId, 'contacts', `${currentInvitation.senderAgentId}.json`), recipientContact)
      ]);
      let message = { ...pendingMessage, conversationId, caseId: conversationId, invitationId: currentInvitation.id, contactState: 'accepted' };
      if (['pendingContactApproval', 'queued'].includes(message.status)) message = await enqueueNativeMessage(message, senderInbox, inboxId, 'message.queued_after_invitation', (type, data, createdAt) => writeAudit(type, data, createdAt, currentInvitation.senderInboxId));
      await writeAudit('invitation.accepted', { invitationId: currentInvitation.id, conversationId, senderAgentId: currentInvitation.senderAgentId, recipientAgentId: currentInvitation.recipientAgentId, humanId: human.id });
      return { status: currentInvitation.state === 'accepted' ? 200 : 201, result: { invitation: accepted, message }, queued: true };
    }, [invitation.senderInboxId]);
    if (response.queued) deliveryWorker.kick();
    return json(res, response.status, response.result);
  }

  const acknowledgementRoute = suffix.match(/^messages\/([^/]+)\/acknowledgements$/);
  if (req.method === 'POST' && acknowledgementRoute) {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal) return fail(res, 401, 'Recipient agent credential required');
    const input = await body(req);
    const idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key'] || input.idempotencyKey, { required: true });
    const message = await store.getJson(messagePath(inboxId, acknowledgementRoute[1]));
    if (!message || message.recipientAgentId !== principal.id) return fail(res, 404, 'Delivered message not found for this agent');
    if (message.senderInboxId && message.senderAgentId) return fail(res, 410, 'Native agent messages require a fenced work claim and /api/agent/work/:workId settlement');
    const state = input.state || 'acknowledged';
    if (!['acknowledged', 'processed'].includes(state)) return fail(res, 400, 'Acknowledgement state must be acknowledged or processed');
    if (!['delivered', 'acknowledged', 'processed'].includes(message.status)) return fail(res, 409, 'Message has not been delivered');
    const acknowledgementDigest = semanticDigest({ messageId: message.id, state });
    const acknowledgementIdempotencyPath = scopedIdempotencyPath('acknowledgements', inboxId, principal.id, idempotencyKey);
    const response = await withInboxMutation(inboxId, async writeAudit => {
      const currentPrincipal = await getAgentPrincipal(req, inboxId);
      if (!currentPrincipal || currentPrincipal.id !== principal.id || !hasPermission(currentPrincipal, 'receive_agent_messages')) throw Object.assign(new Error('Recipient agent credential required'), { statusCode: 401 });
      const currentMessage = await store.getJson(messagePath(inboxId, acknowledgementRoute[1]));
      if (!currentMessage || currentMessage.recipientAgentId !== currentPrincipal.id) throw Object.assign(new Error('Delivered message not found for this agent'), { statusCode: 404 });
      const replay = replayResponse(await store.getJson(acknowledgementIdempotencyPath), { principalId: principal.id, requestDigest: acknowledgementDigest });
      if (replay) return { status: 200, receipt: replay };
      const receiptId = `delivery_receipt_${currentMessage.id}_${state}`;
      const existingReceipt = await store.getJson(deliveryReceiptPath(inboxId, receiptId));
      if (existingReceipt) {
        await store.putJson(acknowledgementIdempotencyPath, { principalId: principal.id, requestDigest: acknowledgementDigest, response: existingReceipt, createdAt: existingReceipt.createdAt });
        return { status: 200, receipt: existingReceipt };
      }
      const currentRank = acknowledgementStateRank[currentMessage.status];
      if (currentRank === undefined) throw Object.assign(new Error('Message has not been delivered'), { statusCode: 409 });
      if (acknowledgementStateRank[state] < currentRank) throw Object.assign(new Error(`Message acknowledgement cannot regress from ${currentMessage.status} to ${state}`), { statusCode: 409 });
      const at = store.now();
      const updated = { ...currentMessage, status: state, [`${state}At`]: at, updatedAt: at };
      const receipt = { id: receiptId, type: 'delivery', messageId: currentMessage.id, senderAgentId: currentMessage.senderAgentId, recipientAgentId: currentMessage.recipientAgentId, state, idempotencyKeyHash: hashSecret(idempotencyKey), createdAt: at };
      const documents = [];
      for (const targetInboxId of new Set([currentMessage.senderInboxId, currentMessage.recipientInboxId])) {
        const targetInbox = await store.getJson(path.join('inboxes', targetInboxId, 'inbox.json'));
        if (!targetInbox) continue;
        const currentCase = await ensureStructuredCase(targetInbox, { ...updated, caseId: updated.caseId }, updated.senderAgentId, updated.createdAt);
        const updatedCase = setCaseMessageDeliveryState(structuredClone(currentCase), updated, state, at);
        documents.push(document(messagePath(targetInboxId, currentMessage.id), updated), document(caseRecordPath(targetInboxId, updatedCase.id), updatedCase), document(deliveryReceiptPath(targetInboxId, receipt.id), receipt));
        await writeAudit(`message.${state}`, { messageId: currentMessage.id, caseId: currentMessage.caseId, senderAgentId: currentMessage.senderAgentId, recipientAgentId: currentMessage.recipientAgentId }, at, targetInboxId);
      }
      await store.putJsonBatch(documents);
      await store.putJson(acknowledgementIdempotencyPath, { principalId: principal.id, requestDigest: acknowledgementDigest, response: receipt, createdAt: at });
      return { status: 201, receipt };
    }, [message.senderInboxId, message.recipientInboxId].filter(Boolean));
    return json(res, response.status, response.receipt);
  }

  if (req.method === 'POST' && suffix === 'external-emails') {
    if (!externalEmailEnabled) return fail(res, 503, 'External email is disabled for this deployment');
    const input = await body(req);
    const idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key'] || input.idempotencyKey, { required: true });
    emailTransport.assertReady();
    const senderAgentId = assertSafeIdentifier(String(input.senderAgentId || ''), 'senderAgentId');
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
    const queued = await withInboxMutation(inboxId, async writeAudit => {
      const [currentPrincipal, currentSender] = await Promise.all([
        getAgentPrincipal(req, inboxId),
        store.getJson(path.join('inboxes', inboxId, 'agents', `${senderAgentId}.json`))
      ]);
      if (!currentSender || !currentPrincipal || currentPrincipal.id !== currentSender.id) throw Object.assign(new Error('Valid sender agent credential required'), { statusCode: 401 });
      if (!hasPermission(currentSender, 'send_agent_messages') || !hasPermission(currentSender, 'use_email_transport')) throw Object.assign(new Error('Agent lacks send_agent_messages or use_email_transport permission'), { statusCode: 403 });
      const existing = await store.getJson(messagePath(inboxId, messageId));
      if (existing) {
        if (existing.requestHash !== requestHash) throw Object.assign(new Error('Idempotency key was already used for a different email'), { statusCode: 409 });
        return { status: 200, message: existing };
      }
      if (!consumeExternalEmailLimit(currentSender.id, recipientEmail)) throw Object.assign(new Error('External email rate limit exceeded'), { statusCode: 429 });
      const createdAt = store.now();
      const caseId = input.caseId ? assertSafeIdentifier(input.caseId, 'caseId') : store.id('case');
      const replyAddress = `reply+${hashSecret(messageId).slice(0, 32)}@${emailTransport.publicDomain}`;
      const message = { id: messageId, caseId, senderInboxId: inboxId, transport: 'email', direction: 'outbound', senderType: 'agent', senderAgentId, senderEmail: publicEmailAddressForAgent(currentSender), recipientEmail, subject, type: 'email', text, html, payload: input.payload || null, replyAddress, requestHash, createdAt, queuedAt: createdAt, status: 'queued', externalDeliveryState: 'queued' };
      const currentCase = await ensureStructuredCase(inbox, { ...input, caseId, type: 'message', text, objective: subject }, currentSender.id, createdAt);
      const queuedCase = setCaseMessageDeliveryState(structuredClone(currentCase), message, 'queued', createdAt);
      const outbox = { id: `delivery_${message.id}`, kind: 'externalEmail', messageId, senderInboxId: inboxId, recipientInboxId: null, orderingKey: caseId, requestHash, status: 'queued', attempts: 0, maxAttempts: deliveryMaxAttempts, availableAt: createdAt, createdAt, updatedAt: createdAt };
      const queuedDelivery = await store.enqueueOutbox([
        document(messagePath(inboxId, message.id), message),
        document(caseRecordPath(inboxId, queuedCase.id), queuedCase),
        document(replyAddressDirectoryPath(replyAddress), { address: replyAddress, inboxId, agentId: currentSender.id, caseId, messageId })
      ], outbox);
      if (queuedDelivery.requestHash && queuedDelivery.requestHash !== requestHash) throw Object.assign(new Error('Idempotency key was already used for a different email'), { statusCode: 409 });
      await writeAudit('email.queued', { messageId, caseId, senderAgentId, senderEmail: message.senderEmail, recipientEmail }, createdAt);
      return { status: 202, message: queuedDelivery.enqueueCreated ? message : await store.getJson(messagePath(inboxId, message.id), message) };
    });
    deliveryWorker.kick();
    return json(res, queued.status, queued.message);
  }

  if (req.method === 'POST' && suffix === 'messages') {
    const input = await body(req);
    if (input.recipientAgentId != null) return fail(res, 400, 'Send by recipientEmail; raw recipient agent IDs are not accepted');
    if (!input.senderAgentId || !input.recipientEmail || !input.text) return fail(res, 400, 'senderAgentId, recipientEmail, and text are required');
    const idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key'] || input.idempotencyKey, { required: true });
    const senderAgentId = assertSafeIdentifier(String(input.senderAgentId), 'senderAgentId');
    const sender = await store.getJson(path.join('inboxes', inboxId, 'agents', `${senderAgentId}.json`));
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
    const messageId = `msg_${hashSecret(`${sender.id}:${idempotencyKey}`).slice(0, 32)}`;
    const requestedCaseId = input.caseId ? assertSafeIdentifier(input.caseId, 'caseId') : null;
    const requestHash = hashSecret(JSON.stringify({ senderAgentId, recipientEmail, caseId: requestedCaseId, taskId: input.taskId || null, correlationId: input.correlationId || null, causationId: input.causationId || null, intent: input.intent || input.type || 'message', text: input.text, content: input.content || null, payload: input.payload || null, authority: input.authority || null, artifactRefs: input.artifactRefs || [] }));
    const response = await withInboxMutation(inboxId, async writeAudit => {
      const [currentSenderInbox, currentSender, currentPrincipal, currentRecipientDirectory] = await Promise.all([
        store.getJson(path.join('inboxes', inboxId, 'inbox.json')),
        store.getJson(path.join('inboxes', inboxId, 'agents', `${senderAgentId}.json`)),
        getAgentPrincipal(req, inboxId),
        store.getJson(nativeAddressDirectoryPath(recipientEmail))
      ]);
      if (!currentSenderInbox || !currentSender || !currentPrincipal || currentPrincipal.id !== currentSender.id) throw Object.assign(new Error('Valid sender agent credential required'), { statusCode: 401 });
      if (!hasPermission(currentSender, 'send_agent_messages')) throw Object.assign(new Error('Agent is pending approval or lacks send_agent_messages permission'), { statusCode: 403 });
      if (!currentRecipientDirectory || currentRecipientDirectory.inboxId !== recipientDirectory.inboxId || currentRecipientDirectory.status !== 'active' || currentRecipientDirectory.verified !== true) throw Object.assign(new Error('Recipient is unavailable'), { statusCode: 404 });
      const currentRecipient = await store.getJson(path.join('inboxes', currentRecipientDirectory.inboxId, 'agents', `${currentRecipientDirectory.agentId}.json`));
      if (!currentRecipient || currentRecipient.address !== recipientEmail || !hasPermission(currentRecipient, 'receive_agent_messages')) throw Object.assign(new Error('Recipient is unavailable'), { statusCode: 404 });
      if (currentRecipient.id === currentSender.id) throw Object.assign(new Error('Sender and recipient must be different agents'), { statusCode: 400 });
      const [senderContact, recipientContact] = await Promise.all([
        store.getJson(path.join('inboxes', inboxId, 'contacts', `${currentRecipient.id}.json`)),
        store.getJson(path.join('inboxes', currentRecipientDirectory.inboxId, 'contacts', `${currentSender.id}.json`))
      ]);
      if (senderContact?.blocked || recipientContact?.blocked) throw Object.assign(new Error('The recipient is unavailable'), { statusCode: 403 });
      const invitationId = `invitation_${hashSecret(`${currentSender.id}:${currentRecipient.id}`).slice(0, 40)}`;
      const existingInvitation = await store.getJson(invitationPath(currentRecipientDirectory.inboxId, invitationId));
      if (requestedCaseId) {
        assertNativeCaseParticipants(await getCase(inboxId, requestedCaseId), currentSender.id, currentRecipient.id);
        assertNativeCaseParticipants(await getCase(currentRecipientDirectory.inboxId, requestedCaseId), currentSender.id, currentRecipient.id);
      }
      const existing = await store.getJson(messagePath(inboxId, messageId));
      if (existing) {
        const sameRequest = existing.requestHash ? existing.requestHash === requestHash : existing.recipientEmail === recipientEmail && existing.text === input.text && JSON.stringify(existing.payload) === JSON.stringify(input.payload || null);
        if (!sameRequest) throw Object.assign(new Error('Idempotency key was already used for a different message'), { statusCode: 409 });
        if (existing.status === 'pendingContactApproval') {
          const queued = await enqueueNativeMessage({ ...existing, requestHash }, currentSenderInbox, currentRecipientDirectory.inboxId, 'message.queued', writeAudit, req);
          if (existingInvitation?.state === 'pending' && existingInvitation.messageId === existing.id) {
            const superseded = { ...existingInvitation, state: 'superseded', updatedAt: store.now() };
            await store.putJsonBatch([
              document(invitationPath(inboxId, invitationId), superseded),
              document(invitationPath(currentRecipientDirectory.inboxId, invitationId), superseded)
            ]);
          }
          return { status: 202, payload: queued, queued: true };
        }
        return { status: 200, payload: existing, queued: false };
      }
      const createdAt = store.now();
      const conversationId = requestedCaseId || senderContact?.conversationId || existingInvitation?.conversationId || existingInvitation?.pendingConversationId || store.id('conversation');
      await assertNativeCaseBinding(conversationId, currentSender, currentRecipient, inboxId, currentRecipientDirectory.inboxId);
      const protocol = createProtocolMessage({
        messageId,
        conversationId,
        taskId: input.taskId || null,
        correlationId: input.correlationId || null,
        causationId: input.causationId || null,
        from: { agentId: currentSender.id, address: currentSender.address },
        to: [{ agentId: currentRecipient.id, address: currentRecipient.address }],
        intent: input.intent || input.type || 'message',
        text: input.text,
        content: input.content,
        proposal: input.proposal || input.payload?.proposal || null,
        // Agent-supplied authority and signatures are claims, never verified approval.
        authority: input.authority ? { scope: input.authority.scope || 'message.send', humanApproval: 'pending', policyEvaluationId: null } : undefined,
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
        recipientInboxId: currentRecipientDirectory.inboxId,
        senderType: 'agent',
        senderAgentId,
        recipientAgentId: currentRecipient.id,
        recipientEmail,
        transport: 'native',
        type: input.type || 'message',
        text: input.text,
        payload: input.payload || null,
        authorityClaimUnverified: Boolean(input.authority),
        signatureUnverified: Boolean(input.signature),
        requestHash,
        createdAt,
        queuedAt: createdAt,
        status: 'queued'
      };
      const queued = await enqueueNativeMessage(message, currentSenderInbox, currentRecipientDirectory.inboxId, 'message.queued', writeAudit, req);
      return { status: 202, payload: queued, queued: true };
    }, [recipientDirectory.inboxId]);
    if (response.queued) deliveryWorker.kick();
    return json(res, response.status, response.payload);
  }

  if (req.method === 'POST' && suffix === 'human-messages') {
    if (!humanConversationMessagingEnabled()) return fail(res, 403, 'Human conversation messaging is disabled in production');
    const input = await body(req);
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Verified human session required');
    if (!await canAccessInbox(human, inbox)) return fail(res, 403, 'Workspace membership required');
    if (!input.recipientAgentId || !input.text) return fail(res, 400, 'recipientAgentId and text are required');
    const recipientAgentId = assertSafeIdentifier(input.recipientAgentId, 'recipientAgentId');
    const recipient = await store.getJson(path.join('inboxes', inboxId, 'agents', `${recipientAgentId}.json`));
    if (!recipient) return fail(res, 404, 'Recipient agent not found');
    if (!hasPermission(recipient, 'receive_agent_messages')) return fail(res, 403, 'Recipient agent is not approved to receive messages');
    const contact = await store.getJson(path.join('inboxes', inboxId, 'contacts', `${recipientAgentId}.json`), { approved: true, blocked: false });
    if (contact.blocked) return fail(res, 403, 'Recipient is blocked');
    if (contact.approved === false) return fail(res, 403, 'Recipient is not an approved human contact');
    const message = { id: store.id('msg'), inboxId, caseId: input.caseId ? assertSafeIdentifier(input.caseId, 'caseId') : store.id('case'), senderType: 'human', senderHumanId: human.id, recipientAgentId, type: input.type || 'message', text: input.text, payload: input.payload || null, createdAt: store.now(), status: 'received' };
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
    if (input.caseId) {
      const caseId = assertSafeIdentifier(input.caseId, 'caseId');
      const value = await getCase(inboxId, caseId);
      if (!value?.schemaVersion || !isCaseParticipant(value, principal.id)) return fail(res, 403, 'Creator must participate in the case');
    }
    const idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key'] || input.idempotencyKey);
    const idempotencyPath = idempotencyKey ? scopedIdempotencyPath('asset-upload', inboxId, principal.id, idempotencyKey) : null;
    const requestDigest = idempotencyPath ? semanticDigest({ filename: input.filename, mimeType: input.mimeType, size: input.size, checksumSha256: input.checksumSha256, caseId: input.caseId || null }) : null;
    const claimed = idempotencyPath ? await claimIdempotency(store, idempotencyPath, { principalId: principal.id, requestDigest, createdAt: store.now() }) : null;
    if (claimed?.replay) return json(res, 200, claimed.replay);
    let persisted = false;
    let started;
    try {
      started = await objectStorage.beginUpload({ workspaceId: inboxId, filename: input.filename, mimeType: input.mimeType, size: input.size, checksumSha256: input.checksumSha256, caseId: input.caseId || null, createdByAgentId: principal.id });
      const response = { object: started.object, upload: browserObjectUrl(started.upload, req) };
      if (idempotencyPath) await completeIdempotency(store, idempotencyPath, { principalId: principal.id, requestDigest, response, createdAt: store.now() });
      persisted = true;
      await audit(inboxId, 'asset.upload_started', { assetId: started.object.id, caseId: started.object.caseId, createdByAgentId: principal.id, size: started.object.size, state: started.object.state });
      return json(res, 201, response);
    } catch (error) {
      if (!persisted && started) await objectStorage.abortUpload(started.object.id).catch(() => {});
      if (claimed?.claimed && !persisted) await store.deleteJson(idempotencyPath).catch(() => {});
      throw error;
    }
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
    const asset = await objectStorage.getObject(assertSafeIdentifier(downloadAsset[1], 'assetId'));
    if (!await assetGrantAccess(asset, inbox, req)) return fail(res, 404, 'Asset not found');
    if (asset.workspaceId !== inboxId) return json(res, 200, { object: asset, download: {
      url: `${publicBaseUrl(req)}/api/inboxes/${encodeURIComponent(inboxId)}/assets/${encodeURIComponent(asset.id)}/content`,
      method: 'GET', headers: {}
    } });
    return json(res, 200, { object: asset, download: browserObjectUrl(await objectStorage.createDownload(asset.id), req) });
  }

  const contentAsset = suffix.match(/^assets\/([^/]+)\/content$/);
  if (req.method === 'GET' && contentAsset) {
    const asset = await objectStorage.getObject(assertSafeIdentifier(contentAsset[1], 'assetId'));
    if (!await assetGrantAccess(asset, inbox, req)) return fail(res, 404, 'Asset not found');
    const { bytes } = await objectStorage.readCleanObject(asset.id);
    res.writeHead(200, { 'content-type': asset.mimeType, 'content-length': String(bytes.length),
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename="${String(asset.filename || 'download').replace(/[\r\n"\\]/g, '_').slice(0, 180)}"` });
    return res.end(bytes);
  }

  const assetGrantRoute = suffix.match(/^assets\/([^/]+)\/grants(?:\/(revoke))?$/);
  if (req.method === 'POST' && assetGrantRoute) {
    const assetId = assertSafeIdentifier(assetGrantRoute[1], 'assetId');
    const human = await auth.getHuman(req);
    const principal = await getAgentPrincipal(req, inboxId);
    const asset = await objectStorage.getObject(assetId);
    if (asset.workspaceId !== inboxId || !asset.caseId) return fail(res, 404, 'Case-scoped asset not found');
    if (principal?.id !== asset.createdByAgentId && !await canManageInbox(human, inbox)) return fail(res, 403, 'Asset creator or workspace administrator required');
    const value = await getCase(inboxId, asset.caseId);
    if (!value?.schemaVersion || !isCaseParticipant(value, asset.createdByAgentId)) return fail(res, 409, 'Asset case is unavailable');
    const recipientAgentId = assertSafeIdentifier((await body(req)).recipientAgentId, 'recipientAgentId');
    const directory = await store.getJson(path.join('directory', 'agents', `${recipientAgentId}.json`));
    if (!directory?.inboxId || directory.inboxId === inboxId) return fail(res, 404, 'Counterparty not found');
    const result = await withInboxMutation(inboxId, async writeAudit => {
      const [currentAsset, recipientCase, creator, recipient, senderContact, recipientContact] = await Promise.all([
        objectStorage.getObject(assetId),
        getCase(directory.inboxId, asset.caseId),
        store.getJson(path.join('inboxes', inboxId, 'agents', `${asset.createdByAgentId}.json`)),
        store.getJson(path.join('inboxes', directory.inboxId, 'agents', `${recipientAgentId}.json`)),
        store.getJson(path.join('inboxes', inboxId, 'contacts', `${recipientAgentId}.json`)),
        store.getJson(path.join('inboxes', directory.inboxId, 'contacts', `${asset.createdByAgentId}.json`))
      ]);
      if (currentAsset.workspaceId !== inboxId || currentAsset.caseId !== asset.caseId || currentAsset.state !== 'clean') throw Object.assign(new Error('Only a clean case asset can be granted'), { statusCode: 423 });
      if (!creator || !recipient || !hasPermission(creator, 'create_assets') || !hasPermission(recipient, 'receive_agent_messages') || senderContact?.blocked || recipientContact?.blocked) throw Object.assign(new Error('Case participants are unavailable'), { statusCode: 403 });
      assertNativeCaseParticipants(value, creator.id, recipient.id);
      assertNativeCaseParticipants(recipientCase, creator.id, recipient.id);
      const grantPath = assetGrantPath(directory.inboxId, assetId);
      const existing = await store.getJson(grantPath);
      if (existing && (existing.caseId !== asset.caseId || existing.recipientAgentId !== recipient.id || existing.ownerInboxId !== inboxId)) throw Object.assign(new Error('Asset grant already belongs to another counterparty'), { statusCode: 409 });
      if (existing && Boolean(existing.revokedAt) === Boolean(assetGrantRoute[2])) return existing;
      const now = store.now();
      const grant = { id: `grant_${assetId}`, assetId, caseId: asset.caseId, ownerInboxId: inboxId, recipientInboxId: directory.inboxId, createdByAgentId: creator.id, recipientAgentId: recipient.id, grantedBy: principal?.id || human.id, grantedAt: existing?.grantedAt || now, revokedAt: assetGrantRoute[2] ? now : null, updatedAt: now };
      await store.putJson(grantPath, grant);
      await writeAudit(assetGrantRoute[2] ? 'asset.grant_revoked' : 'asset.granted', { assetId, caseId: asset.caseId, recipientAgentId, recipientInboxId: directory.inboxId, actor: grant.grantedBy });
      return grant;
    }, [directory.inboxId]);
    return json(res, 200, result);
  }

  if (req.method === 'GET' && suffix === 'assets/quota') return json(res, 200, await objectStorage.quotaLedger.usage(inboxId));

  if (req.method === 'POST' && suffix === 'assets') {
    if (objectStorageProvider === 's3') return fail(res, 410, 'Direct asset uploads are disabled; use asset-uploads and signed URLs');
    const input = await body(req);
    if (!input.name || !input.contentBase64 || !input.createdByAgentId) return fail(res, 400, 'name, contentBase64, and createdByAgentId are required');
    const createdByAgentId = assertSafeIdentifier(input.createdByAgentId, 'createdByAgentId');
    const assetAgent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${createdByAgentId}.json`));
    if (!assetAgent || !hasPermission(assetAgent, 'create_assets')) return fail(res, 403, 'Agent is pending approval or lacks create_assets permission');
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || principal.id !== assetAgent.id) return fail(res, 401, 'Valid creator agent credential required');
    const asset = { id: store.id('asset'), inboxId, caseId: input.caseId ? assertSafeIdentifier(input.caseId, 'caseId') : null, name: input.name, mimeType: input.mimeType || 'application/octet-stream', size: Buffer.byteLength(input.contentBase64, 'base64'), createdByAgentId, createdAt: store.now() };
    await store.putJson(path.join('inboxes', inboxId, 'assets', `${asset.id}.json`), asset);
    await mkdir(resolvePathWithin(dataDir, 'inboxes', inboxId, 'assets', asset.id), { recursive: true });
    await writeFile(resolvePathWithin(dataDir, 'inboxes', inboxId, 'assets', asset.id, 'content.bin'), Buffer.from(input.contentBase64, 'base64'));
    await audit(inboxId, 'asset.created', { assetId: asset.id, caseId: asset.caseId, createdByAgentId: asset.createdByAgentId });
    return json(res, 201, asset);
  }

  if (req.method === 'GET' && suffix === 'assets') {
    const own = await store.listJson(path.join('inboxes', inboxId, 'assets'));
    const grants = await store.listJson(path.join('inboxes', inboxId, 'asset-grants'));
    const granted = await Promise.all(grants.map(async grant => {
      if (grant.revokedAt) return null;
      const asset = await objectStorage.getObject(grant.assetId).catch(() => null);
      return asset?.state === 'clean' && await assetGrantAccess(asset, inbox, req) ? { ...asset, grant } : null;
    }));
    return json(res, 200, [...own, ...granted.filter(Boolean)]);
  }
  const assetMatch = suffix.match(/^assets\/([^/]+)\/content$/);
  if (req.method === 'GET' && assetMatch) {
    const asset = await store.getJson(path.join('inboxes', inboxId, 'assets', `${assetMatch[1]}.json`));
    if (!asset) return fail(res, 404, 'Asset not found');
    if (asset.key || process.env.SINALOA_AUTH_MODE === 'production') return fail(res, 410, 'Use the scanner-gated signed download endpoint');
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${asset.name.replace(/"/g, '')}"`, 'x-content-type-options': 'nosniff' });
    return res.end(await readFile(resolvePathWithin(dataDir, 'inboxes', inboxId, 'assets', asset.id, 'content.bin')));
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
const objectScanWorker = scanJobStore ? setInterval(() => { void runObjectScans(); }, objectScanWorkerIntervalMs) : null;
const objectScanRetentionWorker = scanJobStore ? setInterval(() => { void runObjectScanRetention(); }, objectScanRetentionIntervalMs) : null;
objectScanWorker?.unref?.();
objectScanRetentionWorker?.unref?.();
if (scanJobStore) {
  void runObjectScans();
  void runObjectScanRetention();
}
const server = http.createServer((req, res) => route(req, res).catch((error) => {
  const requestId = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 128);
  const response = publicHttpError(error, requestId);
  if (response.status >= 500) console.error('Unhandled request error', { requestId, name: error instanceof Error ? error.name : 'Error' });
  return json(res, response.status, response.body);
}));
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.listen(port, host, () => console.log(`Sinaloa backend listening on http://${host}:${server.address().port}`));

let shutdownStarted = false;
const shutdown = () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  scanLifecycleStopping = true;
  clearInterval(objectQuotaReaper);
  if (objectScanWorker) clearInterval(objectScanWorker);
  if (objectScanRetentionWorker) clearInterval(objectScanRetentionWorker);
  for (const set of streams.values()) for (const subscription of set) {
    clearInterval(subscription.heartbeat);
    subscription.res.end();
  }
  server.close(async () => {
    await Promise.allSettled([objectScanRun, objectScanRetentionRun].filter(Boolean));
    await deliveryWorker.stop();
    if (store.close) await store.close();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
