import path from 'node:path';

// Use this during migration of historical records before querying by cursor.
// Normalizing only after a SQL query cannot fix missing sort/filter keys.
export function persistedEventCursor(event) {
  return event.cursor || (event.sequence ? String(event.sequence).padStart(20, '0') : `${event.createdAt}|${event.id}`);
}

export async function fetchEventPage(store, inboxId, { cursor = '', limit = 100 } = {}) {
  if (typeof cursor !== 'string' || cursor.length > 512 || /[\r\n\0]/.test(cursor)) {
    throw Object.assign(new Error('Event cursor is invalid'), { statusCode: 400 });
  }
  const size = Number(limit);
  if (!Number.isInteger(size) || size < 1 || size > 200) {
    throw Object.assign(new Error('Event limit must be an integer from 1 to 200'), { statusCode: 400 });
  }
  const rows = await store.queryJson(path.join('inboxes', inboxId, 'events'), {
    sortField: 'cursor', order: 'asc', limit: size + 1,
    // IDs are generated ASCII identifiers. Exclude the whole sequence cursor,
    // including its existing row, rather than replay it at every boundary.
    after: cursor ? { value: cursor, id: '\uffff' } : null
  });
  if (rows.some(event => !event.cursor || !event.id)) {
    throw Object.assign(new Error('Event history requires cursor migration'), { statusCode: 503 });
  }
  const events = rows.slice(0, size);
  const nextCursor = events.at(-1)?.cursor || cursor || null;
  const hasMore = size === 200 && events.length === 200
    ? (await store.queryJson(path.join('inboxes', inboxId, 'events'), { sortField: 'cursor', order: 'asc', limit: 1, after: { value: nextCursor, id: '\uffff' } })).length > 0
    : rows.length > size;
  return { events, nextCursor, hasMore };
}
