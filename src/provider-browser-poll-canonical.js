import path from 'node:path';
import { browserPollAvailable, providerGatewayAuthority } from './onboarding-flags.js';
import { registrationPath } from './agent-approval.js';
import { installationPath } from './agent-installations.js';
import { createProviderBrowserPoll, gatewayError } from './provider-browser-poll.js';
import { createProviderBrowserPollHttp } from './provider-browser-poll-http.js';

// This adapter is deliberately not a general proxy: Stage 1 can only register, privately
// activate, validate canonical authority and project pending native messages.
export function createCanonicalBrowserGateway({ store, flags, key, registrations, activateRegistration, auth,
  canManageInbox, verifyOwnerCsrf, ownerCsrf, publicOrigin, clientIp, familyPath, rateLimit, pendingAllowed, writeAudit, publishAudit }) {
  const enabled = () => browserPollAvailable(flags);
  const fail = (status, code) => { throw gatewayError(status, code); };
  const adapter = {
    audit: writeAudit,
    publish: publishAudit,
    lockKeys: b => [...new Set([`gateway-installation:${b.installationId}`, `inbox:${b.inboxId}:mutations`, `inbox:${b.workspaceInboxId}:mutations`])],
    createRegistration: (input, { req }) => registrations.create({ ...input, connectionRoute: 'authenticated_rest',
      deliveryCapabilities: { persistentProcess: false, outboundHttps: true, sse: false, webhook: false, scheduledPolling: true, a2a: false } },
    { ip: clientIp(req), claimUrl: `${publicOrigin(req)}/claim`, authority: providerGatewayAuthority }),
    registrationStatus: async registration => {
      const value = await registrations.status(registration.bootstrapToken, registration.registrationId);
      // No installation/internal IDs, registration IDs or raw bootstrap material in the view.
      return { state: value.status, ...(value.approverEmailHint ? { approverEmailHint: value.approverEmailHint, workspaceName: value.workspaceName,
        agent: { name: value.agent?.name, address: value.agent?.address }, permissionSummary: value.effectivePermissions } : {}) };
    },
    confirmOwner: async (registration, req) => {
      const human = await auth.getHuman(req), current = await registrations.getRegistration(registration.registrationId);
      if (!human || !current?.providerBrowserPoll || current.status !== 'approved' || current.approverHumanId !== human.id) fail(403, 'GATEWAY_SCOPE_DENIED');
      const workspaceInboxId = current.target.kind === 'new_agent' ? current.target.workspaceInboxId : current.target.agentInboxId;
      const workspace = await store.getJson(path.join('inboxes', workspaceInboxId, 'inbox.json'));
      if (!workspace || !await canManageInbox(human, workspace, { maxAgeMs: 0 })) fail(403, 'GATEWAY_SCOPE_DENIED');
      return { humanId: human.id, workspaceInboxId };
    },
    activate: async (registration, activationId, confirmed) => {
      const current = await registrations.getRegistration(registration.registrationId);
      if (!current?.providerBrowserPoll || current.approverHumanId !== confirmed.humanId) fail(403, 'GATEWAY_SCOPE_DENIED');
      const result = await activateRegistration(registration.bootstrapToken, { registrationId: registration.registrationId, activationId, deliveryMode: 'poll' }, providerGatewayAuthority);
      const value = result.body, installation = await store.getJson(installationPath(value.inboxId, value.agent.id, value.installation.id));
      return { ownerId: confirmed.humanId, workspaceInboxId: confirmed.workspaceInboxId, inboxId: value.inboxId, agentId: value.agent.id,
        installationId: value.installation.id, credentialFamilyId: installation.credentialFamilyId, generation: value.installation.id,
        // Stored only in the gateway's encrypted record; never returned to a runtime.
        credentials: { access: value.agentApiToken, refresh: value.agentRefreshToken } };
    },
    authorize: async b => {
      const [agent, inbox, family, installation, human, workspace] = await Promise.all([
        store.getJson(path.join('inboxes', b.inboxId, 'agents', `${b.agentId}.json`)),
        store.getJson(path.join('inboxes', b.inboxId, 'inbox.json')), store.getJson(familyPath(b.inboxId, b.agentId, b.credentialFamilyId)),
        store.getJson(installationPath(b.inboxId, b.agentId, b.installationId)), store.getJson(path.join('humans', `${b.ownerId}.json`)),
        store.getJson(path.join('inboxes', b.workspaceInboxId, 'inbox.json'))
      ]);
      if (!family || family.revokedAt || !agent || agent.status === 'revoked' || agent.onboardingStatus !== 'approved' || !installation
        || installation.credentialFamilyId !== b.credentialFamilyId || installation.agentId !== b.agentId || installation.deliveryMode !== 'poll'
        || inbox?.status === 'removed' || family.installationId !== b.installationId) fail(401, 'CREDENTIAL_REVOKED');
      if (!Number.isFinite(Date.parse(family.refreshExpiresAt)) || Date.parse(family.refreshExpiresAt) <= Date.now()) fail(401, 'CREDENTIAL_EXPIRED');
      if (!human || !workspace || !await canManageInbox(human, workspace, { maxAgeMs: 0 }) || !agent.permissions?.includes('receive_agent_messages')) fail(403, 'GATEWAY_SCOPE_DENIED');
      return { address: agent.address, paused: agent.status === 'paused' };
    },
    highWater: async b => Number((await store.getJson(path.join('inboxes', b.inboxId, 'event-sequence.json')))?.value || 0),
    pending: async (b, { high, after }) => {
      const deadline = Date.now() + 120_000;
      const events = (await store.listJson(path.join('inboxes', b.inboxId, 'events')))
        .filter(e => e.type === 'message.delivered' && e.recipientAgentId === b.agentId && e.sequence > after && e.sequence <= high)
        .sort((a, c) => a.sequence - c.sequence);
      const result = [], emitted = new Set();
      for (const e of events) {
        if (Date.now() >= deadline) fail(503, 'GATEWAY_TEMPORARILY_UNAVAILABLE');
        if (emitted.has(e.messageId)) continue;
        const message = await store.getJson(path.join('inboxes', b.inboxId, 'messages', `${e.messageId}.json`));
        if (!message || message.recipientAgentId !== b.agentId || message.senderType === 'human' || !['delivered', 'acknowledged'].includes(message.status)) continue;
        const claim = await store.getJson(path.join('inboxes', b.inboxId, 'work-claims', `${message.id}.json`));
        if (claim && (['completed', 'failed'].includes(claim.status) || Date.parse(claim.retryAt) > Date.now() || (['claimed', 'acknowledged'].includes(claim.status) && Date.parse(claim.leaseExpiresAt) > Date.now()))) continue;
        if (!await pendingAllowed(message, b)) continue;
        emitted.add(message.id); result.push({ id: message.id, version: 1, sequence: e.sequence, caseId: message.caseId || null,
          senderAddress: message.senderEmail || message.senderAddress || '', summary: message.text || '' });
      }
      return result;
    }
  };
  const gateway = createProviderBrowserPoll({ store, key, enabled, adapter });
  const requireOwner = async req => {
    const human = await auth.getHuman(req);
    if (!human) fail(401, 'GATEWAY_SESSION_REQUIRED');
    return { human, csrf: ownerCsrf(req) };
  };
  const ownerMutation = (req, csrf) => { if (!verifyOwnerCsrf(req, csrf)) fail(403, 'GATEWAY_CSRF_INVALID'); };
  const handler = createProviderBrowserPollHttp({ gateway, enabled, origin: publicOrigin, rateLimit,
    owner: requireOwner,
    ownerConfirm: async (req, payload, csrf) => { await requireOwner(req); ownerMutation(req, csrf); return gateway.confirm(payload, req); },
    policy: async (req, match, payload, csrf) => {
      const { human } = await requireOwner(req); ownerMutation(req, csrf);
      if (match.slice(1).some(id => !/^[A-Za-z0-9_-]{1,100}$/.test(id))) fail(400, 'GATEWAY_REQUEST_INVALID');
      const [, inboxId, agentId, installationId] = match;
      const inbox = await store.getJson(path.join('inboxes', inboxId, 'inbox.json'));
      const installation = await store.getJson(installationPath(inboxId, agentId, installationId));
      if (!inbox || !installation || installation.deliveryMode !== 'poll' || !await canManageInbox(human, inbox, { maxAgeMs: 0 })) fail(403, 'GATEWAY_SCOPE_DENIED');
      return gateway.updatePolicy({ inboxId, workspaceInboxId: inbox.parentInboxId || inbox.id, installationId, agentId }, payload, async () => {
        const currentHuman = await auth.getHuman(req);
        const currentInbox = await store.getJson(path.join('inboxes', inboxId, 'inbox.json'));
        const family = await store.getJson(familyPath(inboxId, agentId, installation.credentialFamilyId));
        if (!currentHuman || currentHuman.id !== human.id || !currentInbox || !family || family.revokedAt || !await canManageInbox(currentHuman, currentInbox, { maxAgeMs: 0 })) fail(403, 'GATEWAY_SCOPE_DENIED');
      });
    }
  });
  handler.cleanup = gateway.cleanup;
  return handler;
}
