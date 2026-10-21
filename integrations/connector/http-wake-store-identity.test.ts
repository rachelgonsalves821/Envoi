import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const io = vi.hoisted(() => ({
  lstat: vi.fn(), open: vi.fn(), realpath: vi.fn(), release: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ lstat: io.lstat, open: io.open, realpath: io.realpath }));
vi.mock('./store', () => ({
  privateDirectory: async (directory: string) => directory,
  acquireConnectorLock: async () => io.release,
  privateJson: vi.fn(),
}));
import { emptyWakeState, FileWakeStore } from './http-wake-store';

const directory = path.resolve('private-wake-identity-test');
const filename = path.join(directory, 'wake.json');
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const inode = 9_007_199_254_740_993n;
const bytes = Buffer.from(JSON.stringify(emptyWakeState()));
function metadata(dev = 0n, ino = inode) {
  return { dev, ino, size: BigInt(bytes.length), isFile: () => true, isSymbolicLink: () => false };
}
function handle(dev = 123n, ino = inode) {
  let position = 0;
  return {
    stat: vi.fn(async () => metadata(dev, ino)),
    read: vi.fn(async (buffer: Buffer, offset: number) => {
      const count = bytes.copy(buffer, offset, position);
      position += count;
      return { bytesRead: count };
    }),
    close: vi.fn(async () => {}),
  };
}
function setPlatform(value: string) {
  Object.defineProperty(process, 'platform', { ...platform, value });
}
let opened: ReturnType<typeof handle>;
let verification: ReturnType<typeof handle>;
beforeEach(() => {
  vi.resetAllMocks();
  setPlatform('win32');
  opened = handle();
  verification = handle();
  io.open.mockResolvedValueOnce(opened).mockResolvedValueOnce(verification);
  io.realpath.mockResolvedValue(directory);
  io.lstat.mockImplementation(async (name: string) => name === filename
    ? metadata() : { isSymbolicLink: () => false });
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); });

async function rejected() {
  await expect(FileWakeStore.open(directory)).rejects.toThrow('could not be opened');
  expect(opened.read).not.toHaveBeenCalled();
  expect(io.release).toHaveBeenCalledOnce();
}

describe('wake storage file identity', () => {
  it('reads Windows zero-device path metadata only after matching exact handle identities', async () => {
    const store = await FileWakeStore.open(directory);
    try {
      expect(io.open.mock.calls).toEqual([[filename, 'r'], [filename, 'r']]);
      expect(opened.stat).toHaveBeenCalledWith({ bigint: true });
      expect(verification.stat).toHaveBeenCalledWith({ bigint: true });
      expect(verification.close).toHaveBeenCalledOnce();
      expect(opened.close).toHaveBeenCalledOnce();
      expect(verification.read).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('keeps the ordinary matching-device path on Unix without a verification open', async () => {
    setPlatform('linux');
    io.lstat.mockImplementation(async (name: string) => name === filename
      ? metadata(123n) : { isSymbolicLink: () => false });
    const store = await FileWakeStore.open(directory);
    await store.close();
    expect(io.open).toHaveBeenCalledOnce();
  });

  it('rejects zero-device mismatch outside Windows', async () => {
    setPlatform('linux');
    await rejected();
    expect(io.open).toHaveBeenCalledOnce();
  });

  it('rejects a genuine nonzero path-device mismatch on Windows', async () => {
    io.lstat.mockImplementation(async (name: string) => name === filename
      ? metadata(456n) : { isSymbolicLink: () => false });
    await rejected();
    expect(io.open).toHaveBeenCalledOnce();
  });

  it('rejects a different inode even beyond Number precision', async () => {
    opened.stat.mockResolvedValue(metadata(123n, inode - 1n));
    await rejected();
    expect(io.open).toHaveBeenCalledOnce();
  });

  it.each(['device', 'inode'] as const)('rejects a replacement with a different handle %s', async field => {
    verification.stat.mockResolvedValue(metadata(field === 'device' ? 456n : 123n, field === 'inode' ? inode - 1n : inode));
    await rejected();
    expect(verification.close).toHaveBeenCalledOnce();
    expect(opened.close).toHaveBeenCalledOnce();
  });

  it.each(['inode', 'symlink', 'oversized'] as const)('rejects path %s changes during handle verification', async change => {
    let fileStats = 0;
    io.lstat.mockImplementation(async (name: string) => {
      if (name !== filename) return { isSymbolicLink: () => false };
      if (++fileStats === 1) return metadata();
      return { ...metadata(0n, change === 'inode' ? inode - 1n : inode),
        isSymbolicLink: () => change === 'symlink',
        size: change === 'oversized' ? 4_194_305n : BigInt(bytes.length) };
    });
    await rejected();
    expect(verification.close).toHaveBeenCalledOnce();
  });

  it('does not turn a vanished observed file into empty state', async () => {
    verification.stat.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    await rejected();
    expect(verification.close).toHaveBeenCalledOnce();
    expect(opened.close).toHaveBeenCalledOnce();
  });

  it('continues to allow an initially absent file', async () => {
    io.lstat.mockImplementation(async (name: string) => {
      if (name === filename) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return { isSymbolicLink: () => false };
    });
    const store = await FileWakeStore.open(directory);
    await store.close();
    expect(io.open).not.toHaveBeenCalled();
  });

  it('rejects path symlinks before opening', async () => {
    io.lstat.mockImplementation(async (name: string) => name === filename
      ? { ...metadata(), isSymbolicLink: () => true } : { isSymbolicLink: () => false });
    await rejected();
    expect(io.open).not.toHaveBeenCalled();
  });
});