// agent-registration v1 §2–§5 (task A-4.2): pending registrations, status polling and the human
// claim. A registration grants nothing; its state lives in path-keyed documents on both stores
// (§9), every window ends by time, and every decision moves through a locked conditional write.
import crypto from 'node:crypto';
import path from 'node:path';
import { agentPermissions, approvalSlotIndexPath, approverIndexDir, approverIndexPath, effectivePermissions, liveApproval, organizationMaximumPermissions, registrationPath } from './agent-approval.js';
import { newestActiveInstallation } from './agent-installations.js';
import { routeAvailable } from './onboarding-flags.js';
import { approverEmailHint, displayName, displayVerificationCode, generateBootstrapToken, generateVerificationCode, hashToken, isBootstrapToken, normalizeVerificationCode, tokenLikePattern, unsafeNameCharacters, validRequestedName, verificationCodeHmac } from './agent-registration-codes.js';

export const registrationTtlSeconds = 600;
export const activationWindowSeconds = 600;
export const activationRecoverySeconds = 300;
export const pollAfterSeconds = 5;
export const approvalsAwaitingActivationPerHuman = 3;
export const ownerClaimListMax = 20;
export const listWindowMs = 24 * 3_600_000;
export const registrationBodyMaxBytes = 4096;

export const tokenIndexPath = tokenHash => path.join('auth', 'agent-registration-tokens', `${tokenHash}.json`);
export const codeIndexPath = codeHmac => path.join('auth', 'agent-registration-codes', `${codeHmac}.json`);
export const addressKey = address => encodeURIComponent(String(address).toLowerCase());
export const addressHoldPath = address => path.join('auth', 'agent-address-holds', `${addressKey(address)}.json`);
// Hourly buckets by creation time: cleanup and the owner list read only the buckets they need.
export const hourBucket = iso => String(iso).slice(0, 13).replace(/[^0-9T]/g, '');
export const createdBucketPath = (createdAt, registrationId) => path.join('auth', 'agent-registration-created', hourBucket(createdAt), `${registrationId}.json`);
export const createdBucketDir = bucket => path.join('auth', 'agent-registration-created', bucket);
export const decidedBucketPath = (createdAt, registrationId) => path.join('auth', 'agent-registration-approvals', 'by-hour', hourBucket(createdAt), `${registrationId}.json`);
export const decidedBucketDir = bucket => path.join('auth', 'agent-registration-approvals', 'by-hour', bucket);
export const registrationLockKey = registrationId => `registration:${registrationId}`;
export const addressHoldLockKey = address => `address-hold:${addressKey(address)}`;

const registrationIdPattern = /^registration_[A-Za-z0-9_-]{1,80}$/;
const inboxIdPattern = /^inbox_[A-Za-z0-9_-]{1,80}$/;
const agentIdPattern = /^agent_[A-Za-z0-9_-]{1,80}$/;
const installationIdPattern = /^installation_[A-Za-z0-9_-]{1,80}$/;
const localPartPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const runtimeTypePattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const helperNamePattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const helperVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;
const capabilityKeys = ['persistentProcess', 'outboundHttps', 'sse', 'webhook', 'scheduledPolling', 'a2a'];
const connectionRouteValues = ['local_helper', 'remote_mcp_oauth', 'provider_connector', 'authenticated_rest'];

export const coded = (statusCode, code, message, publicFields) => Object.assign(new Error(message), { statusCode, code, ...(publicFields ? { publicFields } : {}) });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value, allowed) => isObject(value) && Object.keys(value).every(key => allowed.includes(key));
const permissionList = value => Array.isArray(value) && value.length >= 1 && value.length <= 5 && new Set(value).size === value.length && value.every(item => agentPermissions.includes(item));
const validLocalPart = value => typeof value === 'string' && value.length >= 3 && value.length <= 32 && localPartPattern.test(value);
const validRuntime = value => closed(value, ['type', 'version']) && 'type' in value && 'version' in value && typeof value.type === 'string' && runtimeTypePattern.test(value.type)
  && (value.version === null || (typeof value.version === 'string' && value.version.length >= 1 && value.version.length <= 32 && versionPattern.test(value.version)));

// Mirrors schemas.json registrationCreateRequest; test/agent-registration-validation.test.js
// checks that both agree.
export function validRegistrationCreate(value) {
  if (!closed(value, ['requestedName', 'requestedLocalPart', 'requestedPermissions', 'connectionRoute', 'runtime', 'deliveryCapabilities', 'helper'])) return false;
  if (!validRequestedName(value.requestedName)) return false;
  if ('requestedLocalPart' in value && !validLocalPart(value.requestedLocalPart)) return false;
  if (!permissionList(value.requestedPermissions)) return false;
  if (!connectionRouteValues.includes(value.connectionRoute)) return false;
  if (!validRuntime(value.runtime)) return false;
  const capabilities = value.deliveryCapabilities;
  if (!closed(capabilities, capabilityKeys) || !capabilityKeys.every(key => typeof capabilities[key] === 'boolean')) return false;
  if ('helper' in value) {
    const helper = value.helper;
    if (!closed(helper, ['name', 'version']) || typeof helper.name !== 'string' || !helperNamePattern.test(helper.name) || typeof helper.version !== 'string' || !helperVersionPattern.test(helper.version)) return false;
  }
  return true;
}

// Mirrors claimApproveRequest, apart from verificationCode, which every claim route checks first.
export function validApproveBody(value) {
  if (!closed(value, ['verificationCode', 'target', 'grantedPermissions', 'policyProfile'])) return false;
  if (value.policyProfile !== 'default' || !permissionList(value.grantedPermissions)) return false;
  const target = value.target;
  if (target?.kind === 'new_agent') {
    return closed(target, ['kind', 'workspaceInboxId', 'name', 'localPart']) && typeof target.workspaceInboxId === 'string' && inboxIdPattern.test(target.workspaceInboxId)
      && validRequestedName(target.name) && validLocalPart(target.localPart);
  }
  if (target?.kind === 'existing_agent') {
    return closed(target, ['kind', 'agentId', 'replacesInstallationId']) && 'replacesInstallationId' in target && typeof target.agentId === 'string' && agentIdPattern.test(target.agentId)
      && (target.replacesInstallationId === null || (typeof target.replacesInstallationId === 'string' && installationIdPattern.test(target.replacesInstallationId)));
  }
  return false;
}
export const validCodeOnlyBody = value => closed(value, ['verificationCode']);

const plus = (iso, ms) => new Date(new Date(iso).getTime() + ms).toISOString();
const timingEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// §4: status is derived from time on every route, whether or not a job has run.
export function derivedStatus(registration, now = new Date()) {
  if (registration.status === 'pending_claim' && new Date(registration.expiresAt) <= now) return 'expired';
  if (registration.status === 'approved' && new Date(registration.activationExpiresAt) <= now) return 'expired';
  return registration.status;
}
// §2: the token record becomes a tombstone when the recovery window ends.
export const recoveryWindowOver = (registration, now = new Date()) => registration.status === 'activated' && new Date(plus(registration.activatedAt, activationRecoverySeconds * 1000)) <= now;

function responseAgent(registration) {
  const target = registration.target;
  return { ...(target.kind === 'existing_agent' ? { id: target.agentId } : {}), name: target.agentName, address: target.address };
}

export function statusView(registration, now = new Date()) {
  const status = derivedStatus(registration, now);
  const base = { registrationId: registration.id, status };
  if (status === 'pending_claim') return { ...base, expiresAt: registration.expiresAt, pollAfterSeconds };
  if (status === 'approved') {
    return { ...base, target: registration.target.kind, workspaceName: registration.workspaceName, agent: responseAgent(registration), effectivePermissions: registration.effectivePermissions, activationExpiresAt: registration.activationExpiresAt, approverEmailHint: registration.approverEmailHint };
  }
  if (status === 'activated') return { ...base, installationId: registration.installationId };
  return base;
}

// §4: first character of the verified email local part, ***, the full domain. Local development
// auth has phone-only humans and is refused in production, so it gets a fixed hint there.
export function hintForHuman(human) {
  return approverEmailHint(human?.email) || 'd***@development.invalid';
}

export function createAgentRegistrations({
  store, flags, codeKey, limits, pollLimiter, agentSlots, installations, withInboxMutation, canManageLive,
  normalizeLocalPart, addressForLocalPart, identityTaken, semanticDigest, log = event => console.log(JSON.stringify(event))
}) {
  const now = () => new Date();
  const nowIso = () => store.now();
  const getRegistration = id => registrationIdPattern.test(String(id)) ? store.getJson(registrationPath(id)) : Promise.resolve(null);
  const sourceHash = ip => hashToken(`agent-registration-source:${ip}`).slice(0, 32);

  function assertRegistrationEnabled(message = 'Agent-led setup is not available yet.') {
    if (!flags.registration) throw coded(404, 'FEATURE_DISABLED', message);
  }

  // §9 address holds: live while the holding registration is approved and inside its window.
  async function liveHold(address, exceptRegistrationId = null) {
    const hold = await store.getJson(addressHoldPath(address));
    if (!hold?.registrationId || hold.registrationId === exceptRegistrationId) return null;
    const registration = await store.getJson(registrationPath(hold.registrationId));
    return liveApproval(registration, now()) ? hold : null;
  }
  const addressTaken = async (address, exceptRegistrationId = null) => await identityTaken(address) || Boolean(await liveHold(address, exceptRegistrationId));

  // ------------------------------------------------------------------ §3 registration

  async function create(input, { ip, claimUrl }) {
    assertRegistrationEnabled();
    if (!validRegistrationCreate(input)) throw coded(400, 'REGISTRATION_INVALID', 'The registration request is not valid.');
    if (input.requestedLocalPart !== undefined) {
      try { normalizeLocalPart(input.requestedLocalPart); } catch { throw coded(400, 'REGISTRATION_INVALID', 'The registration request is not valid.'); }
    }
    if (!routeAvailable(flags, input.connectionRoute)) throw coded(400, 'ROUTE_NOT_AVAILABLE', 'That connection route is not available.');
    const limited = await limits.consumeCreation(ip);
    if (!limited.allowed) {
      log({ event: 'agent_registration.limited', source: sourceHash(ip), route: input.connectionRoute, reason: 'registration_limit' });
      throw coded(429, 'RATE_LIMITED', 'Too many setup attempts. Try again later.', { retryAfterSeconds: limited.retryAfterSeconds, reason: 'registration_limit' });
    }
    const createdAt = nowIso();
    const expiresAt = plus(createdAt, registrationTtlSeconds * 1000);
    const bootstrapToken = generateBootstrapToken();
    const registration = {
      id: store.id('registration'), status: 'pending_claim', createdAt, expiresAt, tokenHash: hashToken(bootstrapToken), codeHmac: null,
      requested: { name: input.requestedName, localPart: input.requestedLocalPart ?? null, permissions: [...input.requestedPermissions] },
      connectionRoute: input.connectionRoute, runtime: { type: input.runtime.type, version: input.runtime.version },
      deliveryCapabilities: { ...input.deliveryCapabilities }, helper: input.helper ? { ...input.helper } : null, sourceHash: sourceHash(ip)
    };
    let code = null;
    await store.withTransaction([registrationLockKey(registration.id)], async () => {
      // A new code that collides with a live one is drawn again (§2).
      for (let attempt = 0; attempt < 8 && !code; attempt += 1) {
        const drawn = generateVerificationCode();
        const codeHmac = verificationCodeHmac(drawn.normalized, codeKey);
        const existing = await store.getJson(codeIndexPath(codeHmac));
        const holder = existing?.registrationId ? await store.getJson(registrationPath(existing.registrationId)) : null;
        if (holder && derivedStatus(holder, now()) === 'pending_claim') continue;
        await store.putJson(codeIndexPath(codeHmac), { registrationId: registration.id });
        registration.codeHmac = codeHmac;
        code = drawn;
      }
      if (!code) throw new Error('Could not draw a free verification code');
      await store.putJsonBatch([
        { path: tokenIndexPath(registration.tokenHash), value: { registrationId: registration.id } },
        { path: registrationPath(registration.id), value: registration },
        { path: createdBucketPath(createdAt, registration.id), value: { registrationId: registration.id, createdAt } }
      ]);
    });
    log({ event: 'agent_registration.created', source: registration.sourceHash, route: registration.connectionRoute });
    return {
      registrationId: registration.id, status: 'pending_claim', bootstrapToken,
      claim: { url: claimUrl, verificationCode: code.display, expiresAt }, expiresAt, pollAfterSeconds
    };
  }

  // The registration a bootstrap token belongs to, or REGISTRATION_TOKEN_INVALID (§4, §6.1 row 3).
  async function registrationForToken(rawToken, registrationId) {
    const invalid = () => coded(401, 'REGISTRATION_TOKEN_INVALID', 'This setup is no longer valid.');
    if (!isBootstrapToken(rawToken) || !registrationIdPattern.test(String(registrationId))) throw invalid();
    const tokenHash = hashToken(rawToken);
    const index = await store.getJson(tokenIndexPath(tokenHash));
    if (index?.registrationId !== registrationId) throw invalid();
    const registration = await store.getJson(registrationPath(registrationId));
    if (!registration || !timingEqual(registration.tokenHash, tokenHash)) throw invalid();
    return registration;
  }
  const recoveryExpired = () => coded(401, 'ACTIVATION_RECOVERY_EXPIRED', 'Setup can no longer be recovered. Ask the owner to reconnect.');

  // ------------------------------------------------------------------ §4 status

  async function status(rawToken, registrationId) {
    assertRegistrationEnabled();
    const registration = await registrationForToken(rawToken, registrationId);
    if (recoveryWindowOver(registration, now())) throw recoveryExpired();
    const retryAfterSeconds = pollLimiter.check(registration.id);
    if (retryAfterSeconds) throw coded(429, 'RATE_LIMITED', 'Polling too quickly.', { retryAfterSeconds, reason: 'poll_interval' });
    return statusView(registration, now());
  }

  // ------------------------------------------------------------------ §5 claim

  async function assertClaimAllowed(human) {
    const retryAfterSeconds = await limits.claimLockRetryAfter(human.id);
    if (retryAfterSeconds) throw coded(429, 'RATE_LIMITED', 'Too many incorrect codes. Try again later.', { retryAfterSeconds, reason: 'claim_attempts' });
  }
  // `counted` is false under a lock: the failure counter runs its own transaction, which must
  // never nest inside another one. A re-check under the lock only loses a race, which is no guess.
  async function codeInvalid(human, counted = true) {
    if (counted) await limits.recordClaimFailure(human.id);
    return coded(404, 'CLAIM_CODE_INVALID', 'That code is not valid. Check the code your agent shows.');
  }
  const codeMatches = (registration, normalized) => Boolean(registration && normalized && timingEqual(registration.codeHmac, verificationCodeHmac(normalized, codeKey)));
  const decisionDigest = (kind, normalized, input) => semanticDigest({ kind, verificationCode: normalized, target: input.target ?? null, grantedPermissions: input.grantedPermissions ?? null, policyProfile: input.policyProfile ?? null });

  // §5.3 precedence step 3, shared by approve and reject. Returns { replay } for this human's own
  // identical decision, or the pending registration; throws otherwise.
  async function decisionTarget(human, registration, normalized, kind, input, { counted = true } = {}) {
    if (codeMatches(registration, normalized) && registration.decision?.humanId === human.id) {
      if (registration.decision.kind === kind && registration.decision.digest === decisionDigest(kind, normalized, input)) return { replay: registration.decision.response };
      throw coded(409, 'CLAIM_ALREADY_DECIDED', kind === 'approve' && registration.decision.kind === 'approve'
        ? 'You already approved this agent. Withdraw it and have the agent register again to change the decision.'
        : 'You already decided this registration.');
    }
    if (!codeMatches(registration, normalized) || derivedStatus(registration, now()) !== 'pending_claim') throw await codeInvalid(human, counted);
    return { registration };
  }

  async function lookup(human, input) {
    assertRegistrationEnabled('This feature is not available.');
    await assertClaimAllowed(human);
    const normalized = normalizeVerificationCode(input?.verificationCode);
    if (!normalized) throw await codeInvalid(human);
    const index = await store.getJson(codeIndexPath(verificationCodeHmac(normalized, codeKey)));
    const registration = index?.registrationId ? await store.getJson(registrationPath(index.registrationId)) : null;
    if (!codeMatches(registration, normalized) || derivedStatus(registration, now()) !== 'pending_claim') throw await codeInvalid(human);
    if (!validCodeOnlyBody(input)) throw coded(400, 'CLAIM_INVALID', 'The claim request is not valid.');
    const maximum = organizationMaximumPermissions();
    return {
      registrationId: registration.id, verificationCode: displayVerificationCode(normalized),
      requestedName: displayName(registration.requested.name, registration.requested.localPart || 'agent'), requestedLocalPart: registration.requested.localPart,
      requestedPermissions: registration.requested.permissions, grantablePermissions: registration.requested.permissions.filter(permission => maximum.includes(permission)),
      connectionRoute: registration.connectionRoute, runtime: registration.runtime, deliveryCapabilities: registration.deliveryCapabilities,
      createdAt: registration.createdAt, expiresAt: registration.expiresAt
    };
  }

  const workspaceNameOf = async inbox => {
    const parent = inbox.kind === 'agent' && inbox.parentInboxId ? await store.getJson(path.join('inboxes', inbox.parentInboxId, 'inbox.json')) : null;
    const source = parent || inbox;
    return displayName(source.name, 'workspace');
  };
  const localPartOf = address => String(address).split('@')[0];

  // The approval's target, resolved and authorized (§5.1 "Managing the target", CLAIM_FORBIDDEN).
  async function resolveTarget(human, target) {
    const forbidden = () => coded(403, 'CLAIM_FORBIDDEN', 'You cannot connect agents there.');
    if (target.kind === 'new_agent') {
      const inbox = await store.getJson(path.join('inboxes', target.workspaceInboxId, 'inbox.json'));
      if (!inbox || inbox.kind !== 'workspace' || inbox.status === 'removed' || !await canManageLive(human, inbox)) throw forbidden();
      return { inbox };
    }
    const directory = await store.getJson(path.join('directory', 'agents', `${target.agentId}.json`));
    const inbox = directory?.inboxId ? await store.getJson(path.join('inboxes', directory.inboxId, 'inbox.json')) : null;
    const agent = inbox ? await store.getJson(path.join('inboxes', inbox.id, 'agents', `${target.agentId}.json`)) : null;
    if (!agent || inbox.ownerAgentId !== agent.id || inbox.status === 'removed' || !await canManageLive(human, inbox)) throw forbidden();
    return { inbox, agent };
  }

  async function liveApprovalsBy(humanId) {
    let count = 0;
    for (const index of await store.listJson(approverIndexDir(humanId))) {
      if (liveApproval(await store.getJson(registrationPath(index.registrationId)), now())) count += 1;
    }
    return count;
  }

  async function approve(human, registrationId, input) {
    assertRegistrationEnabled('This feature is not available.');
    await assertClaimAllowed(human);
    const normalized = normalizeVerificationCode(input?.verificationCode);
    const found = await decisionTarget(human, await getRegistration(registrationId), normalized, 'approve', input || {});
    if (found.replay) return found.replay;
    if (!validApproveBody(input)) {
      throw coded(400, 'CLAIM_INVALID', Array.isArray(input?.grantedPermissions) && !input.grantedPermissions.length ? 'Choose at least one permission.' : 'The approval request is not valid.');
    }
    const target = input.target;
    let address = null;
    if (target.kind === 'new_agent') {
      try { address = addressForLocalPart(normalizeLocalPart(target.localPart)); }
      catch { throw coded(400, 'CLAIM_INVALID', 'Choose another agent address.'); }
    }
    const resolved = await resolveTarget(human, target);
    const principalHumanId = target.kind === 'new_agent' ? human.id : resolved.agent.principalHumanId || resolved.inbox.ownerHumanId;
    const lockKeys = [registrationLockKey(registrationId), `human:${principalHumanId}:active-agents`, `human:${human.id}:agent-approvals`, ...(address ? [addressHoldLockKey(address)] : [])];
    const outcome = await withInboxMutation(resolved.inbox.id, async writeAudit => {
      // First decision wins: re-read under the lock.
      const again = await decisionTarget(human, await getRegistration(registrationId), normalized, 'approve', input, { counted: false });
      if (again.replay) return again.replay;
      const registration = again.registration;
      const at = nowIso();
      let agentFields;
      if (target.kind === 'existing_agent') {
        const agent = await store.getJson(path.join('inboxes', resolved.inbox.id, 'agents', `${target.agentId}.json`));
        if (!agent || agent.onboardingStatus !== 'approved' || !['active', 'paused'].includes(agent.status)) throw coded(409, 'AGENT_NOT_RECONNECTABLE', 'That agent cannot be reconnected here.');
        const current = newestActiveInstallation(await installations.list(resolved.inbox.id, agent));
        if ((current?.id ?? null) !== target.replacesInstallationId) throw coded(409, 'CLAIM_STALE', 'This agent\'s connection changed. Review it again.');
        if (!await agentSlots.agentHasLiveFamily(resolved.inbox.id, agent.id, now())) await assertSlot(principalHumanId, { excludingAgentId: agent.id });
        agentFields = { agentId: agent.id, agentInboxId: resolved.inbox.id, agentName: displayName(agent.name, localPartOf(agent.address)), address: agent.address, accessGeneration: agent.accessGeneration || 0, replacesInstallationId: target.replacesInstallationId };
      } else {
        if (await identityTaken(address) || await liveHold(address, registration.id)) throw coded(409, 'ADDRESS_TAKEN', 'That agent address is already taken.');
        await assertSlot(human.id);
        agentFields = { workspaceInboxId: resolved.inbox.id, organizationId: resolved.inbox.organizationId, agentName: displayName(target.name, localPartOf(address)), name: target.name, localPart: localPartOf(address), address };
      }
      if (await liveApprovalsBy(human.id) >= approvalsAwaitingActivationPerHuman) throw coded(409, 'PENDING_ACTIVATION_LIMIT', 'Too many approvals are still waiting for their agents.');
      const activationExpiresAt = plus(at, activationWindowSeconds * 1000);
      const effective = effectivePermissions(registration.requested.permissions, input.grantedPermissions);
      const approved = {
        ...registration, status: 'approved', target: { kind: target.kind, ...agentFields }, workspaceName: await workspaceNameOf(resolved.inbox),
        approverHumanId: human.id, principalHumanId, approverEmailHint: hintForHuman(human), effectivePermissions: effective, policyProfile: 'default',
        approvedAt: at, activationExpiresAt
      };
      const response = {
        registrationId: registration.id, status: 'approved', target: target.kind, workspaceName: approved.workspaceName, agent: responseAgent(approved),
        effectivePermissions: effective, policyProfile: 'default', activationExpiresAt
      };
      approved.decision = { kind: 'approve', humanId: human.id, digest: decisionDigest('approve', normalized, input), response, decidedAt: at };
      const documents = [
        { path: registrationPath(registration.id), value: approved },
        { path: approvalSlotIndexPath(principalHumanId, registration.id), value: { registrationId: registration.id } },
        { path: approverIndexPath(human.id, registration.id), value: { registrationId: registration.id } },
        { path: decidedBucketPath(registration.createdAt, registration.id), value: { registrationId: registration.id } }
      ];
      // Replacing an ended hold: read, check, put, inside this transaction (§9).
      if (address) documents.push({ path: addressHoldPath(address), value: { registrationId: registration.id, expiresAt: activationExpiresAt } });
      await store.putJsonBatch(documents);
      await writeAudit('agent.registration_approved', { registrationId: registration.id, target: target.kind, ...(target.kind === 'existing_agent' ? { agentId: target.agentId } : { address }), effectivePermissions: effective, humanId: human.id }, at);
      return response;
    }, [], lockKeys);
    return outcome;
  }
  async function assertSlot(humanId, options = {}) {
    try { await agentSlots.assertActiveAgentSlot(humanId, options); }
    catch (error) {
      if (error.code === 'ACTIVE_AGENT_LIMIT') throw coded(409, 'ACTIVE_AGENT_LIMIT', 'You already have the maximum number of agents.');
      throw error;
    }
  }

  async function reject(human, registrationId, input) {
    assertRegistrationEnabled('This feature is not available.');
    await assertClaimAllowed(human);
    const normalized = normalizeVerificationCode(input?.verificationCode);
    const found = await decisionTarget(human, await getRegistration(registrationId), normalized, 'reject', input || {});
    if (found.replay) return found.replay;
    if (!validCodeOnlyBody(input)) throw coded(400, 'CLAIM_INVALID', 'The claim request is not valid.');
    return store.withTransaction([registrationLockKey(registrationId)], async () => {
      const again = await decisionTarget(human, await getRegistration(registrationId), normalized, 'reject', input, { counted: false });
      if (again.replay) return again.replay;
      const at = nowIso();
      const response = { registrationId, status: 'rejected' };
      await store.putJsonBatch([
        { path: registrationPath(registrationId), value: { ...again.registration, status: 'rejected', rejectedAt: at, decision: { kind: 'reject', humanId: human.id, digest: decisionDigest('reject', normalized, input), response, decidedAt: at } } }
      ]);
      // A pending registration belongs to no workspace, so its rejection is logged, not audited
      // into an inbox feed.
      log({ event: 'agent.registration_rejected', registrationId, humanId: human.id });
      return response;
    });
  }

  // §5.4: approvals of registrations created in the last 24 hours whose target the caller can
  // manage now, whoever approved them.
  async function listClaims(human) {
    assertRegistrationEnabled('This feature is not available.');
    await assertClaimAllowed(human);
    const current = now();
    const manageable = new Map();
    const canManageTarget = async target => {
      const inboxId = target.kind === 'new_agent' ? target.workspaceInboxId : target.agentInboxId;
      if (!manageable.has(inboxId)) {
        const inbox = await store.getJson(path.join('inboxes', inboxId, 'inbox.json'));
        manageable.set(inboxId, Boolean(inbox && inbox.status !== 'removed' && await canManageLive(human, inbox)));
      }
      return manageable.get(inboxId);
    };
    const claims = [];
    for (let hour = 0; hour <= 24; hour += 1) {
      const bucket = hourBucket(new Date(current.getTime() - hour * 3_600_000).toISOString());
      for (const index of await store.listJson(decidedBucketDir(bucket))) {
        const registration = await store.getJson(registrationPath(index.registrationId));
        if (!registration?.approvedAt || new Date(registration.createdAt) <= new Date(current.getTime() - listWindowMs)) continue;
        if (!await canManageTarget(registration.target)) continue;
        const status = derivedStatus(registration, current);
        claims.push({
          registrationId: registration.id, status, target: registration.target.kind, agent: responseAgent(registration),
          effectivePermissions: registration.effectivePermissions, approvedAt: registration.approvedAt, activationExpiresAt: registration.activationExpiresAt,
          installationId: status === 'activated' ? registration.installationId : null, approvedByMe: registration.approverHumanId === human.id
        });
      }
    }
    claims.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt) || b.registrationId.localeCompare(a.registrationId));
    return { claims: claims.slice(0, ownerClaimListMax) };
  }

  async function withdraw(human, registrationId) {
    assertRegistrationEnabled('This feature is not available.');
    const notFound = () => coded(404, 'CLAIM_NOT_FOUND', 'That approval cannot be withdrawn.');
    const replayed = registration => registration?.status === 'withdrawn' && registration.withdrawnBy === 'owner' && registration.withdrawnByHumanId === human.id;
    const registration = await getRegistration(registrationId);
    if (replayed(registration)) return { registrationId, status: 'withdrawn' };
    if (!registration || derivedStatus(registration, now()) !== 'approved') throw notFound();
    const inboxId = registration.target.kind === 'new_agent' ? registration.target.workspaceInboxId : registration.target.agentInboxId;
    const inbox = await store.getJson(path.join('inboxes', inboxId, 'inbox.json'));
    if (!inbox || !await canManageLive(human, inbox)) throw notFound();
    const address = registration.target.kind === 'new_agent' ? registration.target.address : null;
    return withInboxMutation(inboxId, async writeAudit => {
      const current = await getRegistration(registrationId);
      if (replayed(current)) return { registrationId, status: 'withdrawn' };
      if (!current || derivedStatus(current, now()) !== 'approved') throw notFound();
      const at = nowIso();
      await store.putJson(registrationPath(registrationId), { ...current, status: 'withdrawn', withdrawnAt: at, withdrawnByHumanId: human.id, withdrawnBy: 'owner' });
      if (address && (await store.getJson(addressHoldPath(address)))?.registrationId === registrationId) await store.deleteJson(addressHoldPath(address));
      await writeAudit('agent.registration_withdrawn', { registrationId, humanId: human.id, target: current.target.kind }, at);
      return { registrationId, status: 'withdrawn' };
    }, [], [registrationLockKey(registrationId), ...(address ? [addressHoldLockKey(address)] : [])]);
  }

  return { create, status, lookup, approve, reject, listClaims, withdraw, registrationForToken, liveHold, addressTaken, getRegistration, recoveryExpired };
}

export { tokenLikePattern, unsafeNameCharacters };
