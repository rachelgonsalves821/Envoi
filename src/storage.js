import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolvePathWithin } from './path-safety.js';

export class FileStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.claims = new Set();
    this.outboxMutation = Promise.resolve();
    this.objectQuotaMutation = Promise.resolve();
    this.eventSequenceMutation = Promise.resolve();
    this.transactionContext = new AsyncLocalStorage();
    this.transactionTail = Promise.resolve();
  }

  async init() {
    await mkdir(this.root, { recursive: true });
  }

  async ensureInbox(inboxId) {
    const dir = this.inboxDir(inboxId);
    await Promise.all([
      mkdir(path.join(dir, 'messages'), { recursive: true }),
      mkdir(path.join(dir, 'cases'), { recursive: true }),
      mkdir(path.join(dir, 'assets'), { recursive: true }),
      mkdir(path.join(dir, 'events'), { recursive: true }),
      mkdir(path.join(dir, 'agents'), { recursive: true }),
      mkdir(path.join(dir, 'contacts'), { recursive: true })
    ]);
    return dir;
  }

  inboxDir(inboxId) { return this.file('inboxes', inboxId); }
  file(...parts) { return resolvePathWithin(this.root, ...parts); }

  currentTransaction() {
    const context = this.transactionContext.getStore();
    if (context && !context.active) throw new Error('Transaction context is closed');
    return context;
  }

  async writeAtomic(target, content) {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: 'wx' });
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  async withTransaction(keys, operation) {
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !key || key.length > 512) || typeof operation !== 'function') throw new TypeError('Transaction keys and callback are required');
    const orderedKeys = [...new Set(keys)].sort();
    const current = this.currentTransaction();
    if (current) {
      if (orderedKeys.some(key => !current.keys.has(key))) throw new Error('Nested transaction cannot acquire additional keys');
      return operation();
    }
    const previous = this.transactionTail;
    let release;
    this.transactionTail = previous.then(() => new Promise(resolve => { release = resolve; }));
    await previous;
    const context = { keys: new Set(orderedKeys), writes: new Map(), active: true };
    try {
      const result = await this.transactionContext.run(context, operation);
      const originals = new Map();
      const applied = [];
      try {
        for (const [target, content] of context.writes) {
          try { originals.set(target, await readFile(target)); }
          catch (error) { if (error.code !== 'ENOENT') throw error; originals.set(target, null); }
          if (content === null) await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
          else await this.writeAtomic(target, content);
          applied.push(target);
        }
      } catch (error) {
        for (const target of applied.reverse()) {
          const original = originals.get(target);
          if (original === null) await unlink(target).catch(() => {});
          else await this.writeAtomic(target, original);
        }
        throw error;
      }
      return result;
    } finally { context.active = false; release(); }
  }

  async putJson(relative, value) {
    const target = this.file(relative);
    const current = this.currentTransaction();
    if (current) { current.writes.set(target, JSON.stringify(value, null, 2)); return; }
    return this.withTransaction([], () => this.putJson(relative, value));
  }

  async putJsonBatch(documents) {
    const current = this.currentTransaction();
    if (!current) return this.withTransaction([], () => this.putJsonBatch(documents));
    for (const { path: relative, value } of documents) await this.putJson(relative, value);
  }

  async withOutboxMutation(operation) {
    if (this.currentTransaction()) return operation();
    const pending = this.outboxMutation.then(() => this.withTransaction([], operation), () => this.withTransaction([], operation));
    this.outboxMutation = pending.catch(() => {});
    return pending;
  }

  async nextEventSequence(inboxId) {
    const operation = async () => {
      const relative = path.join('inboxes', inboxId, 'event-sequence.json');
      const current = await this.getJson(relative, { value: 0 });
      const value = Number(current.value || 0) + 1;
      await this.putJson(relative, { value });
      return value;
    };
    if (this.currentTransaction()) return operation();
    const pending = this.eventSequenceMutation.then(() => this.withTransaction([], operation), () => this.withTransaction([], operation));
    this.eventSequenceMutation = pending.catch(() => {});
    return pending;
  }

  async enqueueOutbox(documents, record) {
    return this.withOutboxMutation(async () => {
      const existing = await this.getOutbox(record.id);
      if (existing) return { ...existing, enqueueCreated: false };
      const records = await this.listJson('outbox');
      const persisted = { ...record, sequence: records.reduce((maximum, value) => Math.max(maximum, Number(value.sequence || 0)), 0) + 1 };
      await this.putJsonBatch(documents);
      await this.putJson(path.join('outbox', `${record.id}.json`), persisted);
      return { ...persisted, enqueueCreated: true };
    });
  }

  async getOutbox(id) { return this.getJson(path.join('outbox', `${id}.json`)); }

  async queryOutbox({ inboxId = null, status = null, orderingKey = null, senderInboxId = null, limit = 100 } = {}) {
    const values = await this.listJson('outbox');
    return values
      .filter(value => !inboxId || value.senderInboxId === inboxId || value.recipientInboxId === inboxId)
      .filter(value => !status || value.status === status)
      .filter(value => !orderingKey || value.orderingKey === orderingKey)
      .filter(value => !senderInboxId || value.senderInboxId === senderInboxId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, Math.max(1, Math.min(Number(limit) || 100, 200)));
  }

  async claimOutbox(workerId, leaseMs = 30_000) {
    return this.withOutboxMutation(async () => {
      const now = Date.now();
      const records = await this.listJson('outbox');
      const next = records
        .filter(record => {
          if (['queued', 'retrying'].includes(record.status)) return new Date(record.availableAt).getTime() <= now;
          return record.status === 'processing' && record.lockedAt && now - new Date(record.lockedAt).getTime() >= leaseMs;
        })
        .filter(record => !record.orderingKey || !records.some(earlier => earlier.id !== record.id
          && earlier.orderingKey === record.orderingKey
          && !['delivered', 'deadLettered', 'cancelled'].includes(earlier.status)
          && Number(earlier.sequence || 0) < Number(record.sequence || 0)))
        .sort((a, b) => String(a.availableAt).localeCompare(String(b.availableAt)) || Number(a.sequence || 0) - Number(b.sequence || 0))[0];
      if (!next) return null;
      next.status = 'processing';
      next.lockedAt = this.now();
      next.lockedBy = workerId;
      next.leaseToken = crypto.randomUUID();
      next.updatedAt = next.lockedAt;
      await this.putJson(path.join('outbox', `${next.id}.json`), next);
      return next;
    });
  }

  assertOutboxLease(record, lease) {
    if (!record || record.status !== 'processing' || !lease?.leaseToken || record.leaseToken !== lease.leaseToken || record.lockedBy !== lease.lockedBy) throw Object.assign(new Error('Delivery lease was lost'), { code: 'LEASE_LOST', statusCode: 409 });
  }

  async completeOutbox(id, documents, result = {}, lease = null) {
    return this.withOutboxMutation(async () => {
      const record = await this.getOutbox(id);
      this.assertOutboxLease(record, lease);
      const now = this.now();
      await this.putJsonBatch(documents);
      Object.assign(record, { status: 'delivered', deliveredAt: now, updatedAt: now, lockedAt: null, lockedBy: null, leaseToken: null, lastError: null, result });
      await this.putJson(path.join('outbox', `${id}.json`), record);
      return record;
    });
  }

  async failOutbox(id, documents, { error, nextAttemptAt, forceDeadLetter = false, lease = null }) {
    return this.withOutboxMutation(async () => {
      const record = await this.getOutbox(id);
      this.assertOutboxLease(record, lease);
      const now = this.now();
      const attempts = Number(record.attempts || 0) + 1;
      const deadLettered = forceDeadLetter || attempts >= Number(record.maxAttempts || 5);
      await this.putJsonBatch(documents);
      Object.assign(record, {
        attempts,
        status: deadLettered ? 'deadLettered' : 'retrying',
        availableAt: deadLettered ? record.availableAt : nextAttemptAt,
        deadLetteredAt: deadLettered ? now : null,
        updatedAt: now,
        lockedAt: null,
        lockedBy: null,
        leaseToken: null,
        lastError: error
      });
      await this.putJson(path.join('outbox', `${id}.json`), record);
      return record;
    });
  }

  async retryOutbox(id, documents = []) {
    return this.withOutboxMutation(async () => {
      const record = await this.getOutbox(id);
      if (!record || record.status !== 'deadLettered') return null;
      const now = this.now();
      await this.putJsonBatch(documents);
      Object.assign(record, { status: 'queued', attempts: 0, availableAt: now, updatedAt: now, lockedAt: null, lockedBy: null, leaseToken: null, lastError: null, deadLetteredAt: null });
      await this.putJson(path.join('outbox', `${id}.json`), record);
      return record;
    });
  }

  async holdOutbox(id, documents, { reason, lease = null }) {
    return this.withOutboxMutation(async () => {
      const record = await this.getOutbox(id);
      this.assertOutboxLease(record, lease);
      const now = this.now();
      await this.putJsonBatch(documents);
      Object.assign(record, {
        status: 'held',
        heldReason: reason,
        heldAt: now,
        heldFromStatus: Number(record.attempts || 0) > 0 ? 'retrying' : 'queued',
        updatedAt: now,
        lockedAt: null,
        lockedBy: null,
        leaseToken: null
      });
      await this.putJson(path.join('outbox', `${id}.json`), record);
      return record;
    });
  }

  async holdQueuedOutbox({ senderInboxId, reason, heldAt = null }) {
    if (!senderInboxId) throw new TypeError('senderInboxId is required');
    return this.withOutboxMutation(async () => {
      const now = this.now();
      const records = (await this.listJson('outbox'))
        .filter(record => record.senderInboxId === senderInboxId && ['queued', 'retrying'].includes(record.status))
        .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
      for (const record of records) {
        Object.assign(record, { heldFromStatus: record.status, status: 'held', heldReason: reason, heldAt: heldAt ?? now, updatedAt: now });
        await this.putJson(path.join('outbox', `${record.id}.json`), record);
      }
      return records;
    });
  }

  async releaseHeldOutbox({ senderInboxId }) {
    if (!senderInboxId) throw new TypeError('senderInboxId is required');
    return this.withOutboxMutation(async () => {
      const now = this.now();
      const records = (await this.listJson('outbox'))
        .filter(record => record.senderInboxId === senderInboxId && record.status === 'held')
        .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
      for (const record of records) {
        record.status = record.heldFromStatus || 'queued';
        record.updatedAt = now;
        delete record.heldReason;
        delete record.heldAt;
        delete record.heldFromStatus;
        await this.putJson(path.join('outbox', `${record.id}.json`), record);
      }
      return records;
    });
  }

  async cancelHeldOutbox(id, documents = []) {
    return this.withOutboxMutation(async () => {
      const record = await this.getOutbox(id);
      if (!record || record.status !== 'held') return null;
      const now = this.now();
      await this.putJsonBatch(documents);
      record.status = 'cancelled';
      record.cancelledAt = now;
      record.updatedAt = now;
      delete record.heldReason;
      delete record.heldAt;
      delete record.heldFromStatus;
      await this.putJson(path.join('outbox', `${id}.json`), record);
      return record;
    });
  }

  async withObjectQuotaMutation(operation) {
    if (this.currentTransaction()) return operation();
    const pending = this.objectQuotaMutation.then(() => this.withTransaction([], operation), () => this.withTransaction([], operation));
    this.objectQuotaMutation = pending.catch(() => {});
    return pending;
  }

  async reclaimExpiredObjectQuotaUnsafe(now) {
    const reservations = await this.listJson(path.join('object-storage', 'quota-reservations'));
    const expired = reservations.filter(reservation => reservation.state === 'reserved' && reservation.expiresAt && new Date(reservation.expiresAt) <= new Date(now));
    if (!expired.length) return { releasedReservations: 0, releasedBytes: 0 };
    const usageByWorkspace = new Map();
    for (const reservation of expired) {
      const usagePath = path.join('object-storage', 'quota-usage', `${reservation.workspaceId}.json`);
      const usage = usageByWorkspace.get(reservation.workspaceId) ?? await this.getJson(usagePath, { workspaceId: reservation.workspaceId, used: 0, reserved: 0, quota: reservation.bytes });
      usage.reserved = Math.max(0, Number(usage.reserved || 0) - Number(reservation.bytes));
      usageByWorkspace.set(reservation.workspaceId, usage);
      reservation.state = 'released';
      reservation.releasedAt = now;
      reservation.updatedAt = now;
    }
    await this.putJsonBatch([
      ...[...usageByWorkspace.values()].map(usage => ({ path: path.join('object-storage', 'quota-usage', `${usage.workspaceId}.json`), value: usage })),
      ...expired.map(reservation => ({ path: path.join('object-storage', 'quota-reservations', `${reservation.id}.json`), value: reservation }))
    ]);
    return { releasedReservations: expired.length, releasedBytes: expired.reduce((total, reservation) => total + Number(reservation.bytes), 0) };
  }

  async reclaimExpiredObjectQuota(now = this.now()) {
    return this.withObjectQuotaMutation(() => this.reclaimExpiredObjectQuotaUnsafe(now));
  }

  async reserveObjectQuota(workspaceId, bytes, quotaBytes, reservationTtlMs = 1_200_000, { retainUntilCleanup = false } = {}) {
    return this.withObjectQuotaMutation(async () => {
      const now = this.now();
      await this.reclaimExpiredObjectQuotaUnsafe(now);
      const usagePath = path.join('object-storage', 'quota-usage', `${workspaceId}.json`);
      const usage = await this.getJson(usagePath, { workspaceId, used: 0, reserved: 0, quota: quotaBytes });
      if (Number(usage.used || 0) + Number(usage.reserved || 0) + bytes > quotaBytes) throw Object.assign(new Error('Workspace object quota exceeded'), { code: 'QUOTA_EXCEEDED', statusCode: 413 });
      const reservation = { id: `quota_${crypto.randomUUID()}`, workspaceId, bytes, state: 'reserved', createdAt: now, expiresAt: retainUntilCleanup ? null : new Date(new Date(now).getTime() + reservationTtlMs).toISOString() };
      usage.reserved = Number(usage.reserved || 0) + bytes;
      usage.quota = quotaBytes;
      await this.putJsonBatch([
        { path: usagePath, value: usage },
        { path: path.join('object-storage', 'quota-reservations', `${reservation.id}.json`), value: reservation }
      ]);
      return reservation;
    });
  }

  async settleObjectQuota(reservationId, commit) {
    return this.withObjectQuotaMutation(async () => {
      const reservationPath = path.join('object-storage', 'quota-reservations', `${reservationId}.json`);
      const reservation = await this.getJson(reservationPath);
      if (!reservation) throw Object.assign(new Error('Unknown object quota reservation'), { code: 'UNKNOWN_RESERVATION', statusCode: 400 });
      if (reservation.state !== 'reserved') {
        if (commit && reservation.expiresAt && reservation.state === 'released') throw Object.assign(new Error('Object quota reservation has expired'), { code: 'QUOTA_RESERVATION_EXPIRED', statusCode: 409 });
        return reservation;
      }
      if (reservation.expiresAt && new Date(reservation.expiresAt) <= new Date()) {
        const usagePath = path.join('object-storage', 'quota-usage', `${reservation.workspaceId}.json`);
        const usage = await this.getJson(usagePath, { workspaceId: reservation.workspaceId, used: 0, reserved: 0, quota: reservation.bytes });
        usage.reserved = Math.max(0, Number(usage.reserved || 0) - reservation.bytes);
        reservation.state = 'released';
        reservation.releasedAt = this.now();
        reservation.updatedAt = reservation.releasedAt;
        await this.putJsonBatch([{ path: usagePath, value: usage }, { path: reservationPath, value: reservation }]);
        if (commit) throw Object.assign(new Error('Object quota reservation has expired'), { code: 'QUOTA_RESERVATION_EXPIRED', statusCode: 409 });
        return reservation;
      }
      const usagePath = path.join('object-storage', 'quota-usage', `${reservation.workspaceId}.json`);
      const usage = await this.getJson(usagePath, { workspaceId: reservation.workspaceId, used: 0, reserved: 0, quota: reservation.bytes });
      usage.reserved = Math.max(0, Number(usage.reserved || 0) - reservation.bytes);
      if (commit) usage.used = Number(usage.used || 0) + reservation.bytes;
      reservation.state = commit ? 'committed' : 'released';
      reservation.updatedAt = this.now();
      await this.putJsonBatch([{ path: usagePath, value: usage }, { path: reservationPath, value: reservation }]);
      return reservation;
    });
  }

  commitObjectQuota(reservationId) { return this.settleObjectQuota(reservationId, true); }
  releaseObjectQuota(reservationId) { return this.settleObjectQuota(reservationId, false); }
  async deleteCommittedObjectQuota(reservationId) {
    return this.withObjectQuotaMutation(async () => {
      const reservationPath = path.join('object-storage', 'quota-reservations', `${reservationId}.json`);
      const reservation = await this.getJson(reservationPath);
      if (!reservation) throw Object.assign(new Error('Unknown object quota reservation'), { code: 'UNKNOWN_RESERVATION', statusCode: 400 });
      if (reservation.state === 'released') return reservation;
      if (reservation.state !== 'committed') throw Object.assign(new Error('Object quota is not committed'), { code: 'QUOTA_NOT_COMMITTED', statusCode: 409 });
      const usagePath = path.join('object-storage', 'quota-usage', `${reservation.workspaceId}.json`);
      const usage = await this.getJson(usagePath, { workspaceId: reservation.workspaceId, used: 0, reserved: 0, quota: reservation.bytes });
      usage.used = Math.max(0, Number(usage.used || 0) - Number(reservation.bytes));
      reservation.state = 'released';
      reservation.releasedAt = this.now();
      reservation.updatedAt = reservation.releasedAt;
      await this.putJsonBatch([{ path: usagePath, value: usage }, { path: reservationPath, value: reservation }]);
      return reservation;
    });
  }
  async objectQuotaUsage(workspaceId, quotaBytes) { return this.getJson(path.join('object-storage', 'quota-usage', `${workspaceId}.json`), { workspaceId, used: 0, reserved: 0, quota: quotaBytes }); }

  async putJsonIfAbsent(relative, value) {
    const target = this.file(relative);
    const current = this.currentTransaction();
    if (!current) return this.withTransaction([], () => this.putJsonIfAbsent(relative, value));
    if (current.writes.has(target)) return current.writes.get(target) === null ? (current.writes.set(target, JSON.stringify(value, null, 2)), true) : false;
    try { await readFile(target); return false; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    current.writes.set(target, JSON.stringify(value, null, 2));
    return true;
  }

  async claimJson(relative, field, value) {
    if (this.claims.has(relative)) return null;
    this.claims.add(relative);
    try {
      const current = await this.getJson(relative);
      if (!current || current[field] != null) return null;
      current[field] = value;
      await this.putJson(relative, current);
      return current;
    } finally { this.claims.delete(relative); }
  }

  async getJson(relative, fallback = null) {
    const current = this.currentTransaction();
    if (!current) await this.transactionTail;
    const target = this.file(relative);
    if (current?.writes.has(target)) return current.writes.get(target) === null ? fallback : JSON.parse(current.writes.get(target));
    try { return JSON.parse(await readFile(target, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }

  async deleteJson(relative) {
    const current = this.currentTransaction();
    if (!current) return this.withTransaction([], () => this.deleteJson(relative));
    const target = this.file(relative);
    if (current.writes.has(target)) { const existed = current.writes.get(target) !== null; current.writes.set(target, null); return existed; }
    try { await readFile(target); current.writes.set(target, null); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  async deleteJsonTree(relativeDir) {
    const current = this.currentTransaction();
    if (!current) return this.withTransaction([], () => this.deleteJsonTree(relativeDir));
    const directory = this.file(relativeDir);
    const targets = new Set();
    const visit = async location => {
      let entries;
      try { entries = await readdir(location, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const target = path.join(location, entry.name);
        if (entry.isDirectory()) await visit(target);
        else if (entry.isFile() && entry.name.endsWith('.json')) targets.add(target);
      }
    };
    await visit(directory);
    for (const target of current.writes.keys()) if (target.startsWith(`${directory}${path.sep}`) && target.endsWith('.json')) targets.add(target);
    let deleted = 0;
    for (const target of targets) if (await this.deleteJson(path.relative(this.root, target))) deleted += 1;
    return deleted;
  }

  async listJson(relativeDir) {
    const current = this.currentTransaction();
    if (!current) await this.transactionTail;
    const directory = this.file(relativeDir);
    try {
      const names = await readdir(directory);
      const visible = new Set(names.filter(name => name.endsWith('.json')));
      if (current) for (const [target, content] of current.writes) if (path.dirname(target) === directory && target.endsWith('.json')) {
        if (content === null) visible.delete(path.basename(target));
        else visible.add(path.basename(target));
      }
      return Promise.all([...visible].map(name => this.getJson(path.join(relativeDir, name))));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!current) return [];
      return [...current.writes].filter(([target, content]) => path.dirname(target) === directory && target.endsWith('.json') && content !== null).map(([, content]) => JSON.parse(content));
    }
  }

  async queryJson(relativeDir, { limit = 100, before = null, after = null, filters = {}, sortField = 'createdAt', order = 'desc' } = {}) {
    const items = await this.listJson(relativeDir);
    if (!['asc', 'desc'].includes(order) || (before && after)) throw new TypeError('Invalid query cursor or order');
    const cursor = before || after;
    if (cursor && typeof cursor === 'object' && (typeof cursor.value !== 'string' || typeof cursor.id !== 'string')) throw new TypeError('Invalid compound cursor');
    return items
      .filter(item => Object.entries(filters).every(([key, value]) => item[key] === value))
      .filter(item => {
        if (!cursor) return true;
        const sortValue = String(item[sortField] ?? '');
        if (typeof cursor !== 'object') return after ? sortValue > String(cursor) : sortValue < String(cursor);
        return after
          ? sortValue > cursor.value || (sortValue === cursor.value && String(item.id ?? '') > cursor.id)
          : sortValue < cursor.value || (sortValue === cursor.value && String(item.id ?? '') < cursor.id);
      })
      .sort((first, second) => {
        const comparison = String(first[sortField] ?? '').localeCompare(String(second[sortField] ?? '')) || String(first.id ?? '').localeCompare(String(second.id ?? ''));
        return order === 'asc' ? comparison : -comparison;
      })
      .slice(0, Math.max(1, Math.min(Number(limit) || 100, 200)));
  }

  async countJson(relativeDir, { filters = {} } = {}) {
    const items = await this.listJson(relativeDir);
    return items.filter(item => Object.entries(filters).every(([key, value]) => item[key] === value)).length;
  }

  id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
  now() { return new Date().toISOString(); }
}
