import { McpWakeClient, type EventInput, type EventSubscription } from './mcp-wake-client';
import type { McpEventHint } from './mcp-events-receiver';
import { HostRequestError } from './private-host-http';

export interface McpEventsHostStore {
  read(): Promise<{ subscription: EventSubscription | null; cursor: string | null }>;
  save(value: { subscription: EventSubscription | null; cursor: string | null }): Promise<void>;
  pending(): Promise<McpEventHint[]>;
  processed(eventId: string): Promise<void>;
}
export interface McpEventsWorkDriver {
  /** Fetch authoritative installation/lifecycle state and reconcile a4 delta; hints grant no authority. */
  catchUp(cursor: string | null, truncated: boolean): Promise<void>;
  processWorkOnce(): Promise<void>;
}

/** Invoke tick on host startup and a trusted scheduler (at most 900 seconds apart), never a model timer. */
export class McpEventsHost {
  #nextPoll = 0;
  #ready = false;
  #flight: Promise<void> | null = null;
  #stopped = false;
  #pollMs: number;
  #now: () => number;
  constructor(private readonly client: McpWakeClient, private readonly store: McpEventsHostStore,
    private readonly driver: McpEventsWorkDriver, private readonly privateInput: () => Promise<EventInput>, options: { pollMs?: number; now?: () => number } = {}) {
    this.#pollMs = options.pollMs ?? 60000;
    if (!Number.isSafeInteger(this.#pollMs) || this.#pollMs < 1000 || this.#pollMs > 900000) throw new TypeError('Safety poll must be between 1 and 900 seconds');
    this.#now = options.now ?? Date.now;
  }
  tick(): Promise<void> {
    if (this.#flight) return this.#flight;
    const operation = this.#tick(); this.#flight = operation;
    void operation.finally(() => { this.#flight = null; }).catch(() => {});
    return operation;
  }
  async #tick() {
    if (this.#stopped || this.client.lifecycle !== 'RUNNING') return;
    if (!this.#ready) {
      if (!await this.client.discoverEvents()) throw new HostRequestError('EVENTS_UNAVAILABLE');
      this.#ready = true;
    }
    let state = await this.store.read();
    let claimed = false;
    // Renewal is early enough for a tick at the maximum allowed safety interval.
    if (!state.subscription || Date.parse(state.subscription.refreshBefore) - this.#now() <= this.#pollMs) {
      const input = await this.privateInput();
      const subscription = await this.client.subscribe({ ...input, cursor: state.cursor });
      state = { subscription, cursor: subscription.cursor };
      await this.store.save(state); // persist the cursor before any uncertain work effect
      await this.driver.catchUp(subscription.cursor, subscription.truncated);
      await this.driver.processWorkOnce(); // every subscribe/reconnect claims even without a hint
      claimed = true;
    }
    for (const hint of await this.store.pending()) {
      if (this.#stopped || this.client.lifecycle !== 'RUNNING') return;
      await this.driver.catchUp(hint.cursor, false);
      await this.driver.processWorkOnce();
      // Mark only after authoritative processing; a restart replays safely under work fences.
      await this.store.processed(hint.eventId);
      // Out-of-order deliveries must not move a durable cursor backwards.
      if (hint.cursor && (!state.cursor || hint.cursor > state.cursor)) {
        state = { ...state, cursor: hint.cursor }; await this.store.save(state);
      }
      claimed = true;
    }
    if (!claimed && this.#now() >= this.#nextPoll) {
      await this.driver.catchUp(state.cursor, false);
      await this.driver.processWorkOnce();
      claimed = true;
    }
    if (claimed) this.#nextPoll = this.#now() + this.#pollMs;
  }
  /** Stop scheduling immediately on owner unsubscribe/revoke; private receiver custody is destroyed separately. */
  stop() { this.#stopped = true; }
}
