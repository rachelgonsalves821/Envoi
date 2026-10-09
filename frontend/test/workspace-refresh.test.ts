import { describe, expect, it, vi } from 'vitest';
import { applyOrderedViewResponse, applyOrderedViewResponses, createRefreshCoordinator, createViewResponseOrder } from '../src/workspace-refresh';
import type { OrderedViewResponse } from '../src/workspace-refresh';
import { mergeHistory } from '../src/history';
import type { HumanView } from '../src/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('quiet workspace refreshes', () => {
  it('does not restore an active conversation from a queued read after Done resets its epoch', () => {
    const order = createViewResponseOrder();
    const ticket = order.begin();
    const beforeDone = { archived: false };
    const afterDone = { archived: true };
    const queuedUpdate = (current: typeof beforeDone) => applyOrderedViewResponse(current, beforeDone, order, ticket, (_previous, incoming) => incoming);
    expect(order.isCurrent(ticket)).toBe(true);
    order.reset();
    expect(queuedUpdate(afterDone)).toBe(afterDone);
  });

  it('validates refresh order at updater execution rather than fetch completion', () => {
    const order = createViewResponseOrder();
    const older = order.begin();
    const newer = order.begin();
    const merge = (_current: string, incoming: string, stale: boolean) => stale ? _current : incoming;
    const fresh = applyOrderedViewResponse('initial', 'after-done', order, newer, merge);
    expect(applyOrderedViewResponse(fresh, 'before-done', order, older, merge)).toBe('after-done');
  });

  it('turns ten triggers into one active read and one follow-up', async () => {
    const first = deferred<number>(); const next = deferred<number>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
    const coordinator = createRefreshCoordinator<number>(load, () => true);
    const requests = Array.from({ length: 10 }, () => coordinator.refresh());
    expect(load).toHaveBeenCalledTimes(1);
    first.resolve(1);
    await expect(requests[0]).resolves.toBe(1);
    expect(load).toHaveBeenCalledTimes(2);
    next.resolve(2);
    expect(await Promise.all(requests.slice(1))).toEqual(Array(9).fill(2));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('waits for a read after the action, and catches up events during that read', async () => {
    const reads = [deferred<number>(), deferred<number>(), deferred<number>()];
    const load = vi.fn().mockReturnValueOnce(reads[0].promise).mockReturnValueOnce(reads[1].promise).mockReturnValueOnce(reads[2].promise);
    const coordinator = createRefreshCoordinator<number>(load, () => true);
    const beforeAction = coordinator.refresh();
    let actionRefreshFinished = false;
    const afterAction = coordinator.refresh().then(value => { actionRefreshFinished = true; return value; });
    reads[0].resolve(1);
    await beforeAction;
    expect(actionRefreshFinished).toBe(false);
    const laterEvent = coordinator.refresh();
    reads[1].resolve(2);
    await expect(afterAction).resolves.toBe(2);
    expect(load).toHaveBeenCalledTimes(3);
    reads[2].resolve(3);
    await expect(laterEvent).resolves.toBe(3);
  });

  it('rejects active and queued readers immediately when the scope ends', async () => {
    const read = deferred<number>();
    const load = vi.fn().mockReturnValue(read.promise);
    const coordinator = createRefreshCoordinator<number>(load, () => true);
    const active = expect(coordinator.refresh()).rejects.toMatchObject({ name: 'AbortError' });
    const queued = expect(coordinator.refresh()).rejects.toMatchObject({ name: 'AbortError' });
    coordinator.cancel();
    await Promise.all([active, queued]);
    read.resolve(9);
    await Promise.resolve();
    await expect(coordinator.refresh()).rejects.toMatchObject({ name: 'AbortError' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not continue queued work for an obsolete workspace or generation', async () => {
    let current = true;
    const read = deferred<number>(); const load = vi.fn().mockReturnValue(read.promise);
    const coordinator = createRefreshCoordinator<number>(load, () => current);
    const active = expect(coordinator.refresh()).rejects.toMatchObject({ name: 'AbortError' });
    const queued = expect(coordinator.refresh()).rejects.toMatchObject({ name: 'AbortError' });
    current = false; read.resolve(1);
    await Promise.all([active, queued]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 503])('preserves denial/failure %s and permits a later current-scope retry', async status => {
    const error = { status };
    const load = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(2);
    const coordinator = createRefreshCoordinator<number>(load, () => true);
    await expect(coordinator.refresh()).rejects.toBe(error);
    await expect(coordinator.refresh()).resolves.toBe(2);
  });
});

describe('concurrent pagination and snapshots', () => {
  const view = (canManageInbox: boolean, ids: string[]): HumanView => ({
    inbox: { id: 'workspace' }, canManageInbox,
    agents: [{ id: 'agent', status: canManageInbox ? 'active' : 'revoked' }],
    cases: ids.map(id => ({ id })), caseQueue: [], messages: [], assets: [], invitations: [], contacts: [], recentEvents: [], deliveryReceipts: [],
    history: { cases: { total: 10, hasMore: true, nextCursor: 'older' } }
  } as unknown as HumanView);

  it('merges an older history page without restoring permissions or agent state', () => {
    const order = createViewResponseOrder();
    const history = order.begin(); const refresh = order.begin();
    const fresh = view(false, ['new']);
    expect(order.accept(refresh)).toBe(false);
    const merged = mergeHistory(fresh, view(true, ['old']), { cases: 'older' }, order.accept(history));
    expect(merged.canManageInbox).toBe(false);
    expect(merged.agents[0].status).toBe('revoked');
    expect(new Set(merged.cases.map(item => item.id))).toEqual(new Set(['old', 'new']));
  });

  it('does not let a late quiet refresh overwrite a newer history response', () => {
    const order = createViewResponseOrder();
    const refresh = order.begin(); const history = order.begin();
    const current = view(false, ['new', 'old']);
    order.accept(history);
    const merged = mergeHistory(current, view(true, ['new']), undefined, order.accept(refresh));
    expect(merged.canManageInbox).toBe(false);
    expect(merged.cases).toHaveLength(2);
  });

  it('does not replace a newly reopened history cursor with an obsolete page cursor', () => {
    const current = view(false, ['new']); current.history!.cases!.nextCursor = 'gap';
    const incoming = view(true, ['old']); incoming.history!.cases!.nextCursor = 'exhausted';
    expect(mergeHistory(current, incoming, { cases: 'older' }, true).history!.cases!.nextCursor).toBe('gap');
  });

  it('rejects responses across workspace switches even when returning to the same workspace', () => {
    const order = createViewResponseOrder();
    const previous = order.begin(); order.reset(); order.reset();
    expect(order.isCurrent(previous)).toBe(false);
    expect(() => order.accept(previous)).toThrow(expect.objectContaining({ name: 'AbortError' }));
  });
});

describe('applying ordered inbox responses', () => {
  it('skips a resolved batch response reset by a mutation while another inbox is pending', async () => {
    const firstOrder = createViewResponseOrder();
    const secondOrder = createViewResponseOrder();
    const firstRead = deferred<OrderedViewResponse<string>>();
    const secondRead = deferred<OrderedViewResponse<string>>();
    const firstResponse = { key: 'inbox_one', value: 'before-write', order: firstOrder, ticket: firstOrder.begin() };
    const secondResponse = { key: 'inbox_two', value: 'fresh-second', order: secondOrder, ticket: secondOrder.begin() };
    const batch = Promise.all([firstRead.promise, secondRead.promise]);
    firstRead.resolve(firstResponse);
    await firstRead.promise;
    firstOrder.reset();
    const current = Object.freeze({ inbox_one: 'after-write', inbox_two: 'old-second' });
    secondRead.resolve(secondResponse);
    const updated = applyOrderedViewResponses(current, await batch);
    expect(updated).toEqual({ inbox_one: 'after-write', inbox_two: 'fresh-second' });
    expect(updated).not.toBe(current);
    expect(current.inbox_two).toBe('old-second');
  });

  it('keeps a newer manual response when an older batch is applied later', () => {
    const order = createViewResponseOrder();
    const oldResponse = { key: 'inbox_one', value: 'old', order, ticket: order.begin() };
    const newResponse = { key: 'inbox_one', value: 'new', order, ticket: order.begin() };
    const current = { inbox_one: 'initial', untouched: 'preserved' };
    const updated = applyOrderedViewResponses(current, [newResponse]);
    expect(updated).toEqual({ inbox_one: 'new', untouched: 'preserved' });
    expect(applyOrderedViewResponses(updated, [oldResponse])).toBe(updated);
    expect(applyOrderedViewResponses(current, [newResponse, oldResponse])).toEqual(updated);
  });

  it('returns the current record when every response is absent, obsolete or unchanged', () => {
    const order = createViewResponseOrder();
    const stale = { key: 'inbox_one', value: 'stale', order, ticket: order.begin() };
    order.reset();
    const current = { inbox_one: 'current' };
    expect(applyOrderedViewResponses(current, [])).toBe(current);
    expect(applyOrderedViewResponses(current, [null, stale])).toBe(current);
    const unchanged = { key: 'inbox_one', value: current.inbox_one, order, ticket: order.begin() };
    expect(applyOrderedViewResponses(current, [unchanged])).toBe(current);
    expect(order.accept(unchanged.ticket)).toBe(false);
  });

  it('allows replaying an accepted updater and preserves untouched record identities', () => {
    const order = createViewResponseOrder();
    const untouched = { version: 0 };
    const current = Object.freeze({ inbox_one: { version: 1 }, untouched });
    const response = { key: 'inbox_one', value: { version: 2 }, order, ticket: order.begin() };
    const updated = applyOrderedViewResponses(current, [response]);
    expect(applyOrderedViewResponses(current, [response])).toEqual(updated);
    expect(updated.untouched).toBe(untouched);
    expect(updated.inbox_one).toBe(response.value);
    expect(current.inbox_one.version).toBe(1);
  });
});
