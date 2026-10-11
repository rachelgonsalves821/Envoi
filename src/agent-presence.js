import path from 'node:path';

// a5-presence v1: an installation-presence projection, one record per credential family.
// Stored apart from the family document so a presence write can never overwrite a revocation.
export const presenceFields = ['lastSeenAt', 'lastSuccessfulRefreshAt', 'lastWorkClaimAt', 'lastProcessedAt'];
export const presenceThrottleMs = 60_000;
export const recentWindowSeconds = 300;
export const agentPresencePath = (inboxId, agentId, familyId) => path.join('auth', 'agent-presence', inboxId, agentId, `${familyId}.json`);
export const agentPresenceDir = (inboxId, agentId) => path.join('auth', 'agent-presence', inboxId, agentId);

const emptyPresence = () => Object.fromEntries(presenceFields.map(field => [field, null]));
const time = value => (value ? Date.parse(value) : NaN);

export function presenceOf(record) {
  const presence = emptyPresence();
  for (const field of presenceFields) if (typeof record?.[field] === 'string') presence[field] = record[field];
  return presence;
}

// a5-presence §2 write rules. Returns the next record, or null when nothing advances.
// Throttled per field; monotonic; any other field advancing also advances lastSeenAt.
export function advancePresence(stored, at, fields) {
  const next = presenceOf(stored);
  const due = field => !next[field] || time(at) - time(next[field]) >= presenceThrottleMs;
  let otherAdvanced = false;
  for (const field of fields) {
    if (field === 'lastSeenAt' || !presenceFields.includes(field) || !due(field)) continue;
    next[field] = at;
    otherAdvanced = true;
  }
  const seenDue = fields.includes('lastSeenAt') && due('lastSeenAt');
  if (!otherAdvanced && !seenDue) return null;
  if (!next.lastSeenAt || time(at) > time(next.lastSeenAt)) next.lastSeenAt = at;
  return next;
}

// Records presence outside every request transaction. Writes are best effort: a failure is logged
// and never changes the response. A per-process cache skips storage when nothing can be due.
export function createPresenceRecorder({ store, now = () => new Date().toISOString(), onError = () => {}, cacheLimit = 10_000 }) {
  const known = new Map();
  const remember = (key, record) => {
    if (known.size >= cacheLimit) known.clear();
    known.set(key, presenceOf(record));
  };
  const nothingDue = (key, at, fields) => {
    const cached = known.get(key);
    return Boolean(cached) && fields.every(field => cached[field] && time(at) - time(cached[field]) < presenceThrottleMs);
  };
  return {
    async record({ inboxId, agentId, familyId }, fields) {
      if (!inboxId || !agentId || !familyId || !fields.length) return;
      const key = agentPresencePath(inboxId, agentId, familyId);
      const at = now();
      if (nothingDue(key, at, fields)) return;
      try {
        // The stored value is never older than what this process caches, so skipping stays safe.
        const stored = await store.updateJson(key, current => advancePresence(current, at, fields));
        if (stored) remember(key, stored);
      } catch (error) { onError(error); }
    },
    forget(inboxId, agentId) {
      const prefix = agentPresenceDir(inboxId, agentId);
      for (const key of known.keys()) if (key.startsWith(prefix)) known.delete(key);
    }
  };
}

const latest = values => values.filter(Boolean).reduce((max, value) => (max === null || time(value) > time(max) ? value : max), null);

// a5-presence §4.2: the newest non-revoked family, else the newest family, else none.
export function reportedFamily(families) {
  const byNewest = [...families].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  return byNewest.find(family => !family.revokedAt) || byNewest[0] || null;
}

// a5-presence §4.2: derive the owner connection from the agent control state, the reported
// family and its presence record. `state` is the agentControlState projection.
export function ownerConnection(state, family, record, nowIso) {
  const presence = presenceOf(record);
  const asOf = latest([nowIso, ...Object.values(presence)]);
  const credentialExpiresAt = family && !family.revokedAt ? family.refreshExpiresAt || null : null;
  const resumeGrace = Boolean(state.resumedAt)
    && time(asOf) - time(state.resumedAt) <= recentWindowSeconds * 1000
    && (!presence.lastWorkClaimAt || time(presence.lastWorkClaimAt) < time(state.resumedAt));
  const seenAt = state.paused || resumeGrace ? presence.lastSeenAt : presence.lastWorkClaimAt;
  const connectionState = state.status === 'revoked' || state.credentialRevoked ? 'revoked'
    : state.onboardingStatus === 'rejected' ? 'rejected'
      : state.onboardingStatus !== 'approved' ? 'pending_approval'
        : !family ? 'not_connected'
          : !credentialExpiresAt || time(credentialExpiresAt) <= time(asOf) ? 'needs_reconnect'
            : !seenAt ? 'never_seen'
              : time(asOf) - time(seenAt) <= recentWindowSeconds * 1000 ? 'seen_recently'
                : 'not_seen_recently';
  return { state: connectionState, asOf, recentWindowSeconds, seenAt, credentialExpiresAt, presence };
}

// a5-presence §4.1: the agent's own family, with asOf never earlier than a reported timestamp.
export function agentStatusPresence(record, nowIso) {
  const presence = presenceOf(record);
  return { asOf: latest([nowIso, ...Object.values(presence)]), presence };
}
