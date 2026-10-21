import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { acquireConnectorLock, privateDirectory, privateJson } from './store';
import { isWakeState, type WakeState, type WakeStore } from './http-wake-receiver';

const maximumBytes = 4 * 1024 * 1024;

export function emptyWakeState(): WakeState {
  return { version: 1, subscriptions: {}, accepted: {}, endedReasons: {} };
}

export function validateWakeState(value: unknown): asserts value is WakeState {
  if (!isWakeState(value)) throw new Error('Invalid private wake state');
}

export class FileWakeStore implements WakeStore {
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  private constructor(private readonly directory: string, private readonly release: () => Promise<void>) {}

  static async open(directory: string): Promise<FileWakeStore> {
    const canonical = await privateDirectory(directory);
    const release = await acquireConnectorLock(canonical);
    const store = new FileWakeStore(canonical, release);
    try { await store.read(); return store; }
    catch { await release(); throw new Error('Private wake storage could not be opened'); }
  }

  private async filename(): Promise<string> {
    if (this.closed) throw new Error('Private wake storage is closed');
    const canonical = path.resolve(await realpath(this.directory));
    if ((await lstat(this.directory)).isSymbolicLink() || (process.platform === 'win32' ? canonical.toLowerCase() !== this.directory.toLowerCase() : canonical !== this.directory)) throw new Error('Private wake storage changed');
    return path.join(this.directory, 'wake.json');
  }

  async read(): Promise<WakeState> {
    const filename = await this.filename();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let observed = false;
    try {
      const metadata = await lstat(filename, { bigint: true });
      observed = true;
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) throw new Error();
      handle = await open(filename, 'r');
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.size > maximumBytes || opened.ino !== metadata.ino) throw new Error();
      if (opened.dev !== metadata.dev) {
        // Windows Node 22 can omit the volume ID in path stats. Compare two
        // handle stats instead; never discard a real volume or inode mismatch.
        if (process.platform !== 'win32' || metadata.dev !== 0n || opened.dev === 0n || metadata.ino === 0n) throw new Error();
        const verification = await open(filename, 'r');
        try {
          const confirmed = await verification.stat({ bigint: true });
          const current = await lstat(filename, { bigint: true });
          if (!confirmed.isFile() || confirmed.size > maximumBytes
            || confirmed.dev !== opened.dev || confirmed.ino !== opened.ino
            || !current.isFile() || current.isSymbolicLink() || current.size > maximumBytes
            || current.dev !== metadata.dev || current.ino !== metadata.ino
            || await this.filename() !== filename) throw new Error();
        } finally { await verification.close(); }
      }
      const bytes = Buffer.alloc(maximumBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > maximumBytes) throw new Error();
      const state: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
      validateWakeState(state);
      return state;
    } catch (error) {
      if (!observed && (error as NodeJS.ErrnoException).code === 'ENOENT') return emptyWakeState();
      throw new Error('Private wake state is unreadable');
    } finally { await handle?.close(); }
  }

  update(mutator: (state: WakeState) => void): Promise<void> {
    const operation = this.writes.then(async () => {
      const state = await this.read();
      mutator(state);
      validateWakeState(state);
      if (Buffer.byteLength(JSON.stringify(state)) > maximumBytes) throw new Error('Private wake state is full');
      await privateJson(await this.filename(), state);
    });
    this.writes = operation.catch(() => {});
    return operation;
  }

  async close(): Promise<void> {
    await this.writes;
    if (this.closed) return;
    this.closed = true;
    await this.release();
  }
}
