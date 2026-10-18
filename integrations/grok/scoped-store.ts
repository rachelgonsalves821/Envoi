import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface ScopedCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

export interface ScopedRunRecord {
  version: 1;
  workId: string;
  model: string;
  input: Array<Record<string, unknown>>;
  pending: ScopedCall[];
  providerCalls: number;
  completed: boolean;
}

export interface ScopedRunStore {
  load(workId: string): Promise<ScopedRunRecord | null>;
  save(record: ScopedRunRecord): Promise<void>;
  exclusive<Value>(workId: string, action: () => Promise<Value>): Promise<Value>;
}

const running = new Map<string, Promise<unknown>>();

export class FileScopedRunStore implements ScopedRunStore {
  constructor(private readonly directory: string) {}

  private filename(workId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workId)) throw new TypeError('Invalid scoped work identity');
    return path.resolve(this.directory, 'scoped-runs', `${workId}.json`);
  }

  async exclusive<Value>(workId: string, action: () => Promise<Value>): Promise<Value> {
    const target = this.filename(workId);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const resolved = path.join(await realpath(path.dirname(target)), path.basename(target));
    const filename = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const previous = running.get(filename) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    running.set(filename, current);
    try { return await current; }
    finally { if (running.get(filename) === current) running.delete(filename); }
  }

  async load(workId: string): Promise<ScopedRunRecord | null> {
    try {
      const bytes = await readFile(this.filename(workId));
      if (bytes.byteLength > 1_000_000) throw new Error('Scoped run record exceeds its limit');
      const record = JSON.parse(bytes.toString('utf8')) as ScopedRunRecord;
      if (record?.version !== 1 || record.workId !== workId || typeof record.model !== 'string'
        || !Array.isArray(record.input) || !Array.isArray(record.pending) || record.pending.length > 16
        || !Number.isSafeInteger(record.providerCalls) || record.providerCalls < 0 || record.providerCalls > 16
        || typeof record.completed !== 'boolean') throw new Error('Invalid scoped run record');
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(record: ScopedRunRecord) {
    const filename = this.filename(record.workId);
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > 1_000_000) throw new Error('Scoped run record exceeds its limit');
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(data); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, filename);
      if (process.platform !== 'win32') {
        const directory = await open(path.dirname(filename), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await rm(temporary, { force: true }); }
  }
}
