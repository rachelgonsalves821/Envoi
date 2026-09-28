import path from 'node:path';

export const HISTORY_COLLECTIONS = {
  cases: ['cases', 'updatedAt'], messages: ['messages', 'createdAt'],
  assets: ['assets', 'createdAt'], recentEvents: ['events', 'createdAt'],
  deliveryReceipts: ['delivery-receipts', 'createdAt'],
  invitations: ['invitations', 'createdAt'], contacts: ['external-contacts', 'updatedAt']
};

export function parseHistoryCursors(raw) {
  if (!raw) return {};
  try {
    if (raw.length > 12000) throw new Error();
    const cursors = JSON.parse(raw);
    if (!cursors || typeof cursors !== 'object' || Array.isArray(cursors)) throw new Error();
    for (const [key, cursor] of Object.entries(cursors)) {
      if (!Object.hasOwn(HISTORY_COLLECTIONS, key) || (cursor !== null && (typeof cursor !== 'string' || cursor.length > 1600))) throw new Error();
      if (cursor) decodeHistoryCursor(cursor);
    }
    return cursors;
  } catch { throw Object.assign(new Error('Invalid history cursor'), { statusCode: 400 }); }
}

export function decodeHistoryCursor(cursor) {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!value || typeof value.value !== 'string' || typeof value.id !== 'string' || !value.id || value.id.length > 300 || value.value.length > 300) throw new Error();
    return { value: value.value, id: value.id };
  } catch { throw Object.assign(new Error('Invalid history cursor'), { statusCode: 400 }); }
}

export function historyPageSize(limit = 50) {
  const size = Number(limit);
  if (!Number.isInteger(size) || size < 1 || size > 100) {
    throw Object.assign(new Error('History limit must be an integer from 1 to 100'), { statusCode: 400 });
  }
  return size;
}

// Store queryJson must order by (sortField DESC, id DESC), with an exclusive
// composite before cursor. countJson counts the complete collection in storage.
export async function workspaceHistory(store, inboxId, cursors = {}, limit = 50) {
  const size = historyPageSize(limit);
  const entries = await Promise.all(Object.entries(HISTORY_COLLECTIONS).map(async ([key, [dir, sortField]]) => {
    const relativeDir = path.join('inboxes', inboxId, dir);
    const [rows, total] = await Promise.all([
      store.queryJson(relativeDir, { sortField, limit: size + 1, before: cursors[key] ? decodeHistoryCursor(cursors[key]) : null }),
      store.countJson(relativeDir)
    ]);
    const items = rows.slice(0, size);
    if (items.some(item => typeof item?.id !== 'string' || !item.id)) throw new Error('History record is missing its stable ID');
    const last = items.at(-1);
    const hasMore = rows.length > size;
    return [key, items, { total, hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ value: String(last[sortField] || ''), id: last.id })).toString('base64url') : null }];
  }));
  return { items: Object.fromEntries(entries.map(([key, items]) => [key, items])), history: Object.fromEntries(entries.map(([key, , metadata]) => [key, metadata])) };
}
