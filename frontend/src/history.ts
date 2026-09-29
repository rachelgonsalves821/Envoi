import type { HumanView, HistoryCollection, HistoryMetadata } from './types';

const collections: HistoryCollection[] = ['cases', 'messages', 'assets', 'recentEvents', 'deliveryReceipts', 'invitations', 'contacts'];
export function olderCursors(view: HumanView): Partial<Record<HistoryCollection, string>> {
  return Object.fromEntries(Object.entries(view.history || {}).filter(([, page]) => page.hasMore && page.nextCursor).map(([key, page]) => [key, page.nextCursor]));
}
function mergeRows<T extends { id: string; updatedAt?: string; createdAt?: string }>(oldRows: T[], newRows: T[]): T[] {
  const rows = new Map(oldRows.map(row => [row.id, row]));
  newRows.forEach(row => rows.set(row.id, row));
  return [...rows.values()].sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')) || b.id.localeCompare(a.id));
}
// Refreshes update loaded records without discarding older pages. Paging keeps
// the latest summary and replaces only the cursors that were advanced.
export function mergeHistory(current: HumanView | null, incoming: HumanView, advanced?: Partial<Record<HistoryCollection, string>>): HumanView {
  if (!current || current.inbox.id !== incoming.inbox.id) return incoming;
  // A history response also carries current authorization and agent state.
  // Keep those projections fresh while merging the paged collections below.
  const result = { ...incoming };
  result.canManageInbox = incoming.canManageInbox === true;
  for (const key of collections) {
    const oldRows: { id: string; updatedAt?: string; createdAt?: string }[] = current[key] || [];
    const newRows: typeof oldRows = incoming[key] || [];
    Object.assign(result, { [key]: advanced?.[key] ? mergeRows(newRows, oldRows) : mergeRows(oldRows, newRows) });
  }
  result.caseQueue = advanced?.cases ? mergeRows(incoming.caseQueue, current.caseQueue) : mergeRows(current.caseQueue, incoming.caseQueue);
  const directoryById = (directory: HumanView['participantDirectory']) => Object.fromEntries(Object.values(directory || {}).map(person => [person.id, person]));
  result.participantDirectory = { ...directoryById(current.participantDirectory), ...directoryById(incoming.participantDirectory) };
  const history: HistoryMetadata = { ...current.history };
  for (const key of collections) {
    const fresh = incoming.history?.[key];
    if (!fresh) continue;
    if (advanced?.[key]) {
      history[key] = fresh;
    } else {
      const loadedIds = new Set((current[key] || []).map(row => row.id));
      const overlaps = (incoming[key] || []).some(row => loadedIds.has(row.id));
      // A wholly new head may conceal a gap between this page and the loaded
      // tail. Walk from its cursor again instead of preserving an exhausted tail.
      history[key] = !overlaps && fresh.hasMore ? fresh : { ...fresh, ...(current.history?.[key] ? { nextCursor: current.history[key]!.nextCursor, hasMore: current.history[key]!.hasMore } : {}) };
    }
    const metadata = history[key];
    if (metadata && (result[key] || []).length >= metadata.total) history[key] = { ...metadata, hasMore: false, nextCursor: null };
  }
  result.history = history;
  if (result.publicEmailTransport) result.publicEmailTransport = { ...result.publicEmailTransport, contacts: result.contacts || [] };
  return result;
}
