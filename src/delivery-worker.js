import crypto from 'node:crypto';

const safeError = error => String(error?.message || error || 'Unknown delivery failure').slice(0, 1000);

export class DeliveryWorker {
  constructor({
    store,
    deliver,
    onFailure = async () => ({ documents: [] }),
    onSettled = () => {},
    workerId = `delivery_${crypto.randomUUID()}`,
    pollIntervalMs = Number(process.env.SINALOA_DELIVERY_POLL_MS || 250),
    leaseMs = Number(process.env.SINALOA_DELIVERY_LEASE_MS || 30_000),
    retryBaseMs = Number(process.env.SINALOA_DELIVERY_RETRY_BASE_MS || 1_000),
    retryMaxMs = Number(process.env.SINALOA_DELIVERY_RETRY_MAX_MS || 60_000)
  }) {
    this.store = store;
    this.deliver = deliver;
    this.onFailure = onFailure;
    this.onSettled = onSettled;
    this.workerId = workerId;
    this.pollIntervalMs = pollIntervalMs;
    this.leaseMs = leaseMs;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.running = false;
    this.processing = false;
    this.timer = null;
    this.drainPromise = null;
  }

  retryDelay(attempt) {
    const exponential = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.max(0, attempt - 1)));
    const jitter = Math.floor(exponential * 0.2 * Math.random());
    return exponential + jitter;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.kick();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.drainPromise;
  }

  kick() {
    if (!this.running || this.processing || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.launchDrain();
    }, 0);
    this.timer.unref?.();
  }

  schedule() {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.launchDrain();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  launchDrain() {
    this.drainPromise = this.drain()
      .catch(error => console.error('Sinaloa delivery worker failed', safeError(error)))
      .finally(() => { this.drainPromise = null; });
  }

  async processOne() {
    const record = await this.store.claimOutbox(this.workerId, this.leaseMs);
    if (!record) return false;
    try {
      const outcome = await this.deliver(record);
      const settled = await this.store.completeOutbox(record.id, outcome.documents || [], outcome.result || {});
      await this.onSettled(settled, outcome.events || []);
    } catch (error) {
      const attempt = Number(record.attempts || 0) + 1;
      const deadLettered = Boolean(error?.permanent) || attempt >= Number(record.maxAttempts || 5);
      const failure = await this.onFailure(record, error, { attempt, deadLettered });
      const nextAttemptAt = new Date(Date.now() + this.retryDelay(attempt)).toISOString();
      const settled = await this.store.failOutbox(record.id, failure.documents || [], { error: safeError(error), nextAttemptAt, forceDeadLetter: Boolean(error?.permanent) });
      await this.onSettled(settled, failure.events || []);
    }
    return true;
  }

  async drain(limit = 100) {
    if (this.processing) return;
    this.processing = true;
    try {
      for (let index = 0; index < limit && this.running; index += 1) {
        if (!await this.processOne()) break;
      }
    } finally {
      this.processing = false;
      this.schedule();
    }
  }
}
