// agent-saved-setup v1 (handoffs.md): the owner saves a Dot's name, address and permissions once in the Connect wizard.
// The approval page pre-fills from it and the wizard follows its status. A saved setup is owner data, never a credential:
// it holds no address, slot or permission, and approval re-checks everything exactly as agent-remote-auth §5.2 does.
import path from 'node:path';

export const savedSetupLimits = Object.freeze({ ttlSeconds: 1800, retentionSeconds: 86_400, createsPerHumanPerHour: 20 });
const permissionOrder = ['receive_agent_messages', 'send_agent_messages', 'create_assets', 'execute_cases'];
const setupIdPattern = /^setup_[A-Za-z0-9_-]{1,80}$/;
const hourMs = 3_600_000;

export const validSavedSetupId = value => typeof value === 'string' && setupIdPattern.test(value);

export function createSavedSetups({ store, enabled, coded, now = () => new Date(), newId, normalizeLocalPart, addressFor, addressTaken,
  canManage, getInbox, workspaceNameOf, getRegistration, lastSeenFor, audit }) {
  const setupPath = (humanId, setupId) => path.join('saved-setups', humanId, `${setupId}.json`);
  const disabled = () => coded(404, 'FEATURE_DISABLED', 'Saved setup is not available on this deployment.');
  const notFound = () => coded(404, 'SETUP_NOT_FOUND', 'This setup is no longer available. Start again.');
  const invalid = () => coded(400, 'SETUP_INVALID', 'This setup could not be saved. Check the agent details and try again.');
  const ms = value => Date.parse(value);

  // This human's setups inside retention, newest first. Records past retention are removed on the way (best effort).
  async function listFor(humanId) {
    const cutoff = now().getTime() - savedSetupLimits.retentionSeconds * 1000;
    const all = await store.listJson(path.join('saved-setups', humanId));
    for (const record of all.filter(item => ms(item.createdAt) <= cutoff)) await store.deleteJson(setupPath(humanId, record.id)).catch(() => {});
    return all.filter(item => item.humanId === humanId && ms(item.createdAt) > cutoff).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  }
  const isLiveWaiting = record => record.status === 'waiting' && ms(record.expiresAt) > now().getTime();

  function parseCreate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
    if (Object.keys(input).some(key => !['runtime', 'name', 'localPart', 'permissions'].includes(key))) throw invalid();
    if (input.runtime !== 'dots') throw invalid();
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80) throw invalid();
    let localPart;
    try { localPart = normalizeLocalPart(input.localPart); } catch { throw invalid(); }
    const requested = input.permissions;
    if (!Array.isArray(requested) || requested.length > 4 || new Set(requested).size !== requested.length || requested.some(value => !permissionOrder.includes(value))) throw invalid();
    const permissions = permissionOrder.filter(value => value === 'receive_agent_messages' || requested.includes(value));
    return { runtime: 'dots', name, localPart, permissions };
  }

  // §3: the status is derived on every read, from the stored record and, once linked, from the linked registration.
  async function view(record) {
    const base = { setupId: record.id, runtime: record.runtime, workspaceInboxId: record.workspaceInboxId, workspaceName: record.workspaceName,
      name: record.name, localPart: record.localPart, address: record.address, permissions: record.permissions, createdAt: record.createdAt, expiresAt: record.expiresAt };
    if (record.status === 'replaced') return { ...base, status: 'replaced' };
    if (record.status === 'linked') {
      const registration = await getRegistration(record.registrationId);
      const agentName = registration?.target?.agentName || registration?.target?.name || record.name;
      if (registration?.status === 'activated' && registration.agentId) {
        return { ...base, status: 'connected', agent: { id: registration.agentId, name: agentName, address: registration.target.address, lastSeenAt: await lastSeenFor(registration) },
          effectivePermissions: registration.effectivePermissions };
      }
      if (registration?.status === 'approved' && ms(registration.activationExpiresAt) > now().getTime()) {
        return { ...base, status: 'approved', agent: { name: agentName, address: registration.target.address } };
      }
      return { ...base, status: 'expired', reason: 'approval_lapsed' };
    }
    if (!isLiveWaiting(record)) return { ...base, status: 'expired', reason: 'not_used' };
    return { ...base, status: 'waiting' };
  }

  // §2: save. Precedence: flag, session (caller), rate limit, body, workspace management, address.
  async function create(human, inbox, input) {
    if (!enabled) throw disabled();
    const existing = await listFor(human.id);
    const recent = existing.filter(item => ms(item.createdAt) > now().getTime() - hourMs);
    if (recent.length >= savedSetupLimits.createsPerHumanPerHour) {
      const oldest = Math.min(...recent.map(item => ms(item.createdAt)));
      throw coded(429, 'RATE_LIMITED', 'Too many saved setups. Try again later.', { retryAfterSeconds: Math.max(1, Math.ceil((oldest + hourMs - now().getTime()) / 1000)) });
    }
    const parsed = parseCreate(input);
    if (!await canManage(human, inbox)) throw coded(403, 'SETUP_FORBIDDEN', 'Choose a workspace you manage.');
    const address = addressFor(parsed.localPart);
    if (await addressTaken(address)) throw coded(409, 'ADDRESS_TAKEN', 'That agent address is already taken. Choose another.');
    const createdAt = now().toISOString();
    const record = { id: newId('setup'), humanId: human.id, organizationId: inbox.organizationId ?? null, workspaceInboxId: inbox.id,
      workspaceName: await workspaceNameOf(inbox), ...parsed, address, status: 'waiting', createdAt,
      expiresAt: new Date(now().getTime() + savedSetupLimits.ttlSeconds * 1000).toISOString() };
    // One live setup per human per runtime: a new save replaces the previous waiting one.
    const replaced = existing.filter(item => item.runtime === record.runtime && isLiveWaiting(item))
      .map(item => ({ path: setupPath(human.id, item.id), value: { ...item, status: 'replaced', replacedBy: record.id } }));
    await store.putJsonBatch([{ path: setupPath(human.id, record.id), value: record }, ...replaced]);
    await audit(inbox.id, 'agent.setup_saved', { setupId: record.id, humanId: human.id, runtime: record.runtime });
    return view(record);
  }

  // §3: only the human who saved it can read it; anything else is SETUP_NOT_FOUND, identical in every case.
  async function status(human, inbox, setupId) {
    if (!enabled) throw disabled();
    if (!validSavedSetupId(setupId)) throw notFound();
    const record = await store.getJson(setupPath(human.id, setupId));
    if (!record || record.humanId !== human.id || record.workspaceInboxId !== inbox.id
      || ms(record.createdAt) <= now().getTime() - savedSetupLimits.retentionSeconds * 1000) throw notFound();
    return view(record);
  }

  // §4: consentView.savedSetup, or null. The caller checks the flag, the decision and the route.
  async function forConsent(human, requestedPermissions) {
    if (!enabled) return null;
    const record = (await listFor(human.id)).find(item => item.runtime === 'dots' && isLiveWaiting(item));
    if (!record) return null;
    const workspace = await getInbox(record.workspaceInboxId);
    if (!workspace || !await canManage(human, workspace)) return null;
    return { setupId: record.id, workspaceInboxId: record.workspaceInboxId, workspaceName: record.workspaceName, name: record.name, localPart: record.localPart,
      address: record.address, permissions: record.permissions, notRequested: record.permissions.filter(value => !requestedPermissions.includes(value)),
      addressAvailable: !await addressTaken(record.address), expiresAt: record.expiresAt };
  }

  // §5: the documents that link a usable setup inside the approval's own batch. An unusable id links nothing.
  async function linkDocuments(human, setupId, { registrationId, at, targetKind }) {
    if (!enabled || targetKind !== 'new_agent' || !validSavedSetupId(setupId)) return { documents: [], linked: false };
    const record = await store.getJson(setupPath(human.id, setupId));
    if (!record || record.humanId !== human.id || !isLiveWaiting(record)) return { documents: [], linked: false };
    return { documents: [{ path: setupPath(human.id, setupId), value: { ...record, status: 'linked', registrationId, linkedAt: at } }], linked: true };
  }

  return { enabled: Boolean(enabled), create, status, forConsent, linkDocuments };
}
