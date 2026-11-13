// agent-listening-status v1 (handoffs.md): whether an agent receives work in the background, and how much work waits.
// Read-only. The owner agent list and envoi_agent_info both use deriveBackgroundReceiving, so they always agree.

export const waitingCountCap = 50;

const newest = (list, field) => list.reduce((best, item) => (!best || String(item[field] ?? '') > String(best[field] ?? '') ? item : best), null);

// §3.1: claimable is { count, oldestAt } from the server's scan; count may exceed the cap by one (51 means "more").
export function waitingFrom(claimable) {
  const count = Math.max(0, Number(claimable?.count) || 0);
  if (count === 0) return { count: 0, more: false, oldestAt: null };
  return { count: Math.min(count, waitingCountCap), more: count > waitingCountCap, oldestAt: claimable.oldestAt ?? null };
}

// §3: the first matching row wins. subscriptions are http-wake's public records (any profile) for this agent.
export function deriveBackgroundReceiving({ onDemand, wakeAvailable, subscriptions = [], claimable }) {
  const base = { since: null, lastAlertAt: null, endedReason: null, waiting: waitingFrom(claimable) };
  if (!onDemand) return { state: 'connector', ...base };
  if (!wakeAvailable) return { state: 'unavailable', ...base };
  const active = subscriptions.filter(sub => sub.status === 'active');
  if (active.length) {
    const healthy = active.filter(sub => sub.delivery?.state !== 'failing');
    const current = newest(healthy.length ? healthy : active, 'activatedAt');
    return { ...base, state: healthy.length ? 'on' : 'failing', since: current.activatedAt ?? null, lastAlertAt: current.delivery?.lastSuccessAt ?? null };
  }
  const pending = subscriptions.filter(sub => sub.status === 'pending');
  if (pending.length) return { ...base, state: 'starting', since: newest(pending, 'createdAt').createdAt ?? null };
  const last = newest(subscriptions.filter(sub => sub.status === 'ended'), 'endedAt');
  if (!last) return { state: 'off', ...base };
  return { ...base, state: 'off', since: last.endedAt ?? null, endedReason: last.endedReason ?? null, lastAlertAt: last.delivery?.lastSuccessAt ?? null };
}
