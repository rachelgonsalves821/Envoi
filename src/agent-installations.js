// agent-registration v1 §6.4–§6.5 and §9: installations are derived from credential families.
// An installation document stores only immutable fields; status, endedReason and endedAt come
// from its family at read time, so every path that revokes a family ends its installation with
// no second write. A family with no installationId is projected as a legacy installation.
import path from 'node:path';

export const installationPrefix = 'installation_';
export const legacyInstallationPrefix = 'installation_legacy_';
export const ownerInstallationEndedMax = 5;
const familyPrefix = 'credential_family_';

export const installationPath = (agentInboxId, agentId, installationId) => path.join('auth', 'agent-installations', agentInboxId, agentId, `${installationId}.json`);
export const installationDir = (agentInboxId, agentId) => path.join('auth', 'agent-installations', agentInboxId, agentId);
export const legacyInstallationId = familyId => `${legacyInstallationPrefix}${String(familyId).startsWith(familyPrefix) ? String(familyId).slice(familyPrefix.length) : familyId}`;

// §9: families of approved agents and of agents frozen by the agent-wide revoke are projected;
// pending and rejected agents have no installation.
export const projectsLegacyFamilies = agent => ['approved', 'revoked'].includes(agent?.onboardingStatus);

function derivedState(family, stored) {
  if (!family?.revokedAt) return { status: 'active', endedReason: null, endedAt: null };
  // A legacy installation has no document, so it can never have ended by activation_replay.
  const endedReason = stored?.replayDetectedAt ? 'activation_replay' : family.revokedReason || 'revoked';
  return { status: 'ended', endedReason, endedAt: family.revokedAt };
}

export function legacyInstallation(agent, family) {
  return {
    id: legacyInstallationId(family.id),
    agentId: agent.id,
    connectionRoute: 'local_helper',
    deliveryMode: 'envoi_link',
    runtime: { type: family.runtime || agent.runtime || 'unknown', version: null },
    ...derivedState(family, null),
    legacy: true,
    createdAt: family.createdAt,
    activatedAt: family.createdAt,
    familyId: family.id
  };
}

export function storedInstallation(stored, family) {
  return {
    id: stored.id,
    agentId: stored.agentId,
    connectionRoute: stored.connectionRoute,
    deliveryMode: stored.deliveryMode,
    runtime: { type: stored.runtime?.type || 'unknown', version: stored.runtime?.version ?? null },
    ...derivedState(family, stored),
    legacy: false,
    createdAt: stored.createdAt,
    activatedAt: stored.activatedAt,
    familyId: family?.id || stored.credentialFamilyId
  };
}

// Every installation of one agent, newest activation first. Internal: carries familyId, which
// publicInstallation strips before a response.
export function deriveInstallations(agent, families, storedDocuments) {
  const stored = new Map(storedDocuments.filter(Boolean).map(item => [item.credentialFamilyId, item]));
  const installations = [];
  for (const family of families) {
    if (!family?.id) continue;
    const document = family.installationId ? stored.get(family.id) : null;
    if (document && document.id === family.installationId) installations.push(storedInstallation(document, family));
    else if (!family.installationId && projectsLegacyFamilies(agent)) installations.push(legacyInstallation(agent, family));
  }
  return installations.sort((a, b) => String(b.activatedAt).localeCompare(String(a.activatedAt)) || String(b.id).localeCompare(String(a.id)));
}

export const publicInstallation = ({ familyId: _familyId, ...installation }) => installation;
export const installationSummary = installation => ({ id: installation.id, connectionRoute: installation.connectionRoute, deliveryMode: installation.deliveryMode, legacy: installation.legacy });

// §6.5: every active installation newest activatedAt first, then at most five ended ones newest
// endedAt first. Active installations are never capped.
export function ownerInstallationList(agentId, installations, endedMax = ownerInstallationEndedMax) {
  const active = installations.filter(item => item.status === 'active');
  const ended = installations.filter(item => item.status === 'ended')
    .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)) || String(b.id).localeCompare(String(a.id)))
    .slice(0, endedMax);
  return { agentId, installations: [...active, ...ended].map(publicInstallation) };
}

// §5.3: the newest active installation, which an existing_agent approval must name.
export const newestActiveInstallation = installations => installations.find(item => item.status === 'active') || null;

export function createInstallationReader({ store, agentCredentialFamilyPath }) {
  const familiesOf = (agentInboxId, agentId) => store.listJson(path.join('auth', 'agent-credential-families', agentInboxId, agentId));
  const storedOf = (agentInboxId, agentId) => store.listJson(installationDir(agentInboxId, agentId));
  return {
    familiesOf,
    async list(agentInboxId, agent) {
      const [families, stored] = await Promise.all([familiesOf(agentInboxId, agent.id), storedOf(agentInboxId, agent.id)]);
      return deriveInstallations(agent, families, stored);
    },
    async forFamily(agentInboxId, agent, familyId) {
      const family = await store.getJson(agentCredentialFamilyPath(agentInboxId, agent.id, familyId));
      if (!family) return null;
      const stored = family.installationId ? await store.getJson(installationPath(agentInboxId, agent.id, family.installationId)) : null;
      return deriveInstallations(agent, [family], stored ? [stored] : [])[0] || null;
    }
  };
}
