import { SessionRequestCancelled } from './session-lifecycle';

// Every caller arriving during a read waits for the next read. In particular,
// refresh-after-mutation cannot resolve with a snapshot started before the write.
export function createRefreshCoordinator<T>(load: () => Promise<T>, isCurrent: () => boolean) {
  type Waiter = { resolve: (value: T) => void; reject: (error: unknown) => void };
  let pending: Waiter[] = [];
  let active: Waiter[] = [];
  let running = false;
  let stopped = false;
  const cancelled = () => new SessionRequestCancelled();
  const drain = async () => {
    while (pending.length && !stopped) {
      active = pending;
      pending = [];
      try {
        if (!isCurrent()) throw cancelled();
        const value = await load();
        if (stopped || !isCurrent()) throw cancelled();
        active.forEach(waiter => waiter.resolve(value));
      } catch (error) {
        active.forEach(waiter => waiter.reject(error));
      }
      active = [];
      if (!isCurrent()) cancel();
    }
    running = false;
  };
  const cancel = () => {
    stopped = true;
    [...active, ...pending].forEach(waiter => waiter.reject(cancelled()));
    pending = [];
  };
  return {
    refresh: () => {
      if (stopped || !isCurrent()) return Promise.reject<T>(cancelled());
      const result = new Promise<T>((resolve, reject) => { pending.push({ resolve, reject }); });
      if (!running) { running = true; void drain(); }
      return result;
    },
    cancel
  };
}

export function createViewResponseOrder() {
  let epoch = 0;
  let sequence = 0;
  let applied = 0;
  return {
    begin: () => ({ epoch, sequence: ++sequence }),
    isCurrent: (ticket: { epoch: number }) => ticket.epoch === epoch,
    accept: (ticket: { epoch: number; sequence: number }) => {
      if (ticket.epoch !== epoch) throw new SessionRequestCancelled();
      const stale = ticket.sequence < applied;
      applied = Math.max(applied, ticket.sequence);
      return stale;
    },
    reset: () => { epoch++; sequence = 0; applied = 0; }
  };
}

type ViewResponseOrder = ReturnType<typeof createViewResponseOrder>;

export type OrderedViewResponse<T> = {
  key: string;
  value: T;
  order: ViewResponseOrder;
  ticket: ReturnType<ViewResponseOrder['begin']>;
};

export function applyOrderedViewResponses<T>(current: Record<string, T>, responses: Array<OrderedViewResponse<T> | null>): Record<string, T> {
  let next = current;
  for (const response of responses) {
    if (!response || !response.order.isCurrent(response.ticket) || response.order.accept(response.ticket)) continue;
    if (Object.hasOwn(next, response.key) && next[response.key] === response.value) continue;
    if (next === current) next = { ...current };
    Object.defineProperty(next, response.key, { value: response.value, enumerable: true, writable: true, configurable: true });
  }
  return next;
}
