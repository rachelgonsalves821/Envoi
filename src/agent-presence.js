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

// A malformed stored timestamp counts as absent, so it can never freeze a field.
export function presenceOf(record) {
  const presence = emptyPresence();
  for (const field of presenceFields) if (typeof record?.[field] === 'string' && Number.isFinite(Date.parse(record[field]))) presence[field] = record[field];
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
// and never changes the response.
// - A per-process cache skips storage when nothing can be due. The stored value is never older
//   than what this process caches, so a skip never loses a due write.
// - Writes run from a FIFO queue, at most `maxConcurrent` at once, so a burst cannot tie up the
//   storage pool. Past `maxQueued` a write is dropped and reported.
// - With `familyPath`, a write happens only while the family exists and is not revoked, so a request
//   finishing after a removal or revocation cannot recreate the record.
export function createPresenceRecorder({ store, familyPath = null, now = () => new Date().toISOString(), onError = () => {}, cacheLimit = 10_000, maxConcurrent = 2, maxQueued = 500 }) {
  const known = new Map();
  const queue = [];
  let running = 0;
  const remember = (key, record) => {
    if (known.size >= cacheLimit) known.clear();
    known.set(key, presenceOf(record));
  };
  const nothingDue = (key, at, fields) => {
    const cached = known.get(key);
    return Boolean(cached) && fields.every(field => cached[field] && time(at) - time(cached[field]) < presenceThrottleMs);
  };
  const guardFor = ({ inboxId, agentId, familyId }) => (familyPath ? { path: familyPath(inboxId, agentId, familyId), valid: family => Boolean(family) && !family.revokedAt } : null);
  // Starts synchronously, so jobs reach storage in queue order.
  const run = async job => {
    try {
      if (nothingDue(job.key, job.at, job.fields)) return;
      const stored = await store.updateJson(job.key, current => advancePresence(current, job.at, job.fields), { guard: job.guard });
      if (stored) remember(job.key, stored);
    } catch (error) { onError(error); }
    finally { job.done(); }
  };
  const pump = () => {
    while (running < maxConcurrent && queue.length) {
      running += 1;
      run(queue.shift()).finally(() => { running -= 1; pump(); });
    }
  };
  return {
    record(ref, fields) {
      const { inboxId, agentId, familyId } = ref || {};
      if (!inboxId || !agentId || !familyId || !fields.length) return Promise.resolve();
      const key = agentPresencePath(inboxId, agentId, familyId);
      const at = now();
      if (nothingDue(key, at, fields)) return Promise.resolve();
      if (queue.length >= maxQueued) {
        onError(Object.assign(new Error('Presence write queue is full'), { code: 'PRESENCE_QUEUE_FULL' }));
        return Promise.resolve();
      }
      return new Promise(done => {
        queue.push({ key, at, fields, guard: guardFor(ref), done });
        pump();
      });
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
  const byNewest = [...families].sort((left, right) => (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0));
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
          : credentialExpiresAt && time(credentialExpiresAt) <= time(asOf) ? 'needs_reconnect'
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
