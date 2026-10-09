const pendingStatuses = ['queued', 'retrying', 'processing'];
const trackedStatuses = [...pendingStatuses, 'deadLettered'];
// Outbox work held for a paused sender is durable but not pending, so it is counted without ageing the backlog.
const outboxStatuses = [...pendingStatuses, 'held', 'deadLettered'];

function summarize(rows, at, statuses = trackedStatuses) {
  const counts = Object.fromEntries(statuses.map(status => [status, 0]));
  let oldestPendingAt = null;
  for (const row of rows) {
    if (!(row.status in counts)) continue;
    counts[row.status] += Number(row.count || 0);
    if (pendingStatuses.includes(row.status) && row.oldestCreatedAt) {
      const createdAt = Date.parse(row.oldestCreatedAt);
      if (Number.isFinite(createdAt)) oldestPendingAt = Math.min(oldestPendingAt ?? createdAt, createdAt);
    }
  }
  return {
    ...counts,
    oldestPendingAgeSeconds: oldestPendingAt === null ? null : Math.max(0, Math.floor((at.getTime() - oldestPendingAt) / 1000))
  };
}

export async function operationalBacklogSnapshot({ store, scanJobStore = null, at = new Date() }) {
  const outboxRows = typeof store.query === 'function'
    ? (await store.query("SELECT status, count(*)::integer AS count, min(created_at) AS \"oldestCreatedAt\" FROM sinaloa_outbox WHERE status IN ('queued', 'retrying', 'processing', 'held', 'deadLettered') GROUP BY status")).rows
    : (await store.listJson('outbox')).map(record => ({ status: record.status, count: 1, oldestCreatedAt: record.createdAt }));
  const scanRows = scanJobStore
    ? (await scanJobStore.query("SELECT value->>'status' AS status, count(*)::integer AS count, min(value->>'createdAt') AS \"oldestCreatedAt\" FROM sinaloa_documents WHERE path LIKE 'object-storage/scan-jobs/%' AND value->>'status' IN ('queued', 'retrying', 'processing', 'deadLettered') GROUP BY value->>'status'")).rows
    : null;
  return {
    event: 'sinaloa.operational_backlog',
    at: at.toISOString(),
    outbox: summarize(outboxRows, at, outboxStatuses),
    scans: scanRows ? summarize(scanRows, at) : null
  };
}
