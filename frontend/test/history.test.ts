import { describe, expect, it } from 'vitest';
import { mergeHistory, olderCursors } from '../src/history';
import type { HumanView } from '../src/types';
function view(ids: string[], cursor = 'next'): HumanView {
  return { inbox: { id: 'one' }, cases: ids.map(id => ({ id })), caseQueue: ids.map(id => ({ id })), messages: [], assets: [], recentEvents: [], deliveryReceipts: [], invitations: [], contacts: [], history: { cases: { total: 200, hasMore: !!cursor, nextCursor: cursor || null } } } as unknown as HumanView;
}
describe('workspace history', () => {
  it('keeps loaded pages across live refresh while advancing only requested cursors', () => {
    const first = view(['c', 'b']);
    const older = mergeHistory(first, view(['b', 'a'], 'oldest'), olderCursors(first));
    expect(older.cases.map(row => row.id)).toEqual(['c', 'b', 'a']);
    const fresh = mergeHistory(older, view(['d', 'c'], 'new-latest'));
    expect(fresh.cases.map(row => row.id)).toEqual(['d', 'c', 'b', 'a']);
    expect(fresh.history?.cases?.nextCursor).toBe('oldest');
  });
  it('does not mix workspaces or resurrect exhausted cursors', () => {
    expect(olderCursors(view([], ''))).toEqual({});
    expect(mergeHistory(view(['a'], ''), view(['b', 'a'])).history?.cases?.hasMore).toBe(false);
    const next = view(['x']); next.inbox.id = 'two';
    expect(mergeHistory(view(['a']), next)).toBe(next);
  });
  it('reopens an exhausted cursor when a whole new head conceals unseen rows', () => {
    const original = view(['old'], ''); original.history!.cases!.total = 1;
    const head = view(['new5', 'new4'], 'gap'); head.history!.cases!.total = 6;
    const refreshed = mergeHistory(original, head);
    expect(olderCursors(refreshed)).toEqual({ cases: 'gap' });
    const middle = view(['new3', 'new2'], 'gap2'); middle.history!.cases!.total = 6;
    const next = mergeHistory(refreshed, middle, olderCursors(refreshed));
    const tail = view(['new1', 'old'], ''); tail.history!.cases!.total = 6;
    const complete = mergeHistory(next, tail, olderCursors(next));
    expect(complete.cases).toHaveLength(6);
    expect(olderCursors(complete)).toEqual({});
  });
  it('marks all loaded records exhausted and merges array directories by identity', () => {
    const first = view(['b']);
    first.participantDirectory = [{ id: 'agent1', displayName: 'One' }] as HumanView['participantDirectory'];
    const next = view(['a']); next.history!.cases!.total = 2;
    next.participantDirectory = [{ id: 'agent2', displayName: 'Two' }] as HumanView['participantDirectory'];
    const merged = mergeHistory(first, next, olderCursors(first));
    expect(Object.keys(merged.participantDirectory!)).toEqual(['agent2', 'agent1']);
    expect(olderCursors(merged)).toEqual({});
  });
});
