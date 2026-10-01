import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface HermesRunRequest { input: string; session_id: string }
export interface HermesRunRecord {
  version: 1;
  messageId: string;
  idempotencyKey: string;
  attemptedAt: string;
  request: HermesRunRequest;
  runId?: string;
}

function safeId(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new TypeError('Invalid message ID');
  return value;
}

/** One bridge process owns this directory. The exact create request is saved before network I/O. */
export class HermesRunStore {
  constructor(private readonly directory: string) {}

  private filename(messageId: string) { return path.join(this.directory, 'work', `${safeId(messageId)}.hermes.json`); }

  async load(messageId: string): Promise<HermesRunRecord | null> {
    let value: unknown;
    try { value = JSON.parse(await readFile(this.filename(messageId), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid persisted Hermes run');
    const record = value as HermesRunRecord;
    if (record.version !== 1 || record.messageId !== messageId || !/^hermes-run-[0-9a-f-]{36}$/.test(record.idempotencyKey)
      || !Number.isFinite(Date.parse(record.attemptedAt)) || typeof record.request?.input !== 'string'
      || typeof record.request?.session_id !== 'string' || (record.runId !== undefined && typeof record.runId !== 'string')) {
      throw new Error('Invalid persisted Hermes run');
    }
    return record;
  }

  async create(messageId: string, request: HermesRunRequest): Promise<HermesRunRecord> {
    const existing = await this.load(messageId);
    if (existing) return existing;
    const record: HermesRunRecord = {
      version: 1, messageId, idempotencyKey: `hermes-run-${randomUUID()}`,
      attemptedAt: new Date().toISOString(), request
    };
    try { await writeFile(this.filename(messageId), JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const concurrent = await this.load(messageId);
        if (concurrent) return concurrent;
      }
      throw error;
    }
    return record;
  }

  async saveRunId(record: HermesRunRecord, runId: string): Promise<HermesRunRecord> {
    if (!/^run_[A-Za-z0-9_-]{1,128}$/.test(runId)) throw new Error('Hermes returned an invalid run ID');
    const current = await this.load(record.messageId);
    if (!current || current.idempotencyKey !== record.idempotencyKey || (current.runId && current.runId !== runId)) {
      throw new Error('Persisted Hermes run changed');
    }
    if (current.runId === runId) return current;
    const next = { ...current, runId };
    const filename = this.filename(record.messageId);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
    await rename(temporary, filename);
    return next;
  }
}
