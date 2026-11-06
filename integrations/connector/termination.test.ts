import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { withTerminationSignals } from './termination';

describe('connector termination signals', () => {
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const)('cancels pending recovery on %s and removes only its own listeners', async name => {
    const source = new EventEmitter();
    const existing = () => {};
    source.on('SIGHUP', existing);
    let stopped = false;
    await withTerminationSignals(async signal => {
      const pending = new Promise<void>(resolve => signal.addEventListener('abort', () => { stopped = true; resolve(); }, { once: true }));
      source.emit(name);
      await pending;
    }, { platform: 'win32', source });
    expect(stopped).toBe(true);
    expect(source.listeners('SIGHUP')).toEqual([existing]);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) expect(source.listenerCount(signal)).toBe(0);
  });

  it('cleans up after a startup failure and does not register Windows-only signals on Unix', async () => {
    const source = new EventEmitter();
    await expect(withTerminationSignals(async () => {
      expect(source.listenerCount('SIGBREAK')).toBe(0);
      throw new Error('fixture startup failure');
    }, { platform: 'linux', source })).rejects.toThrow('fixture startup failure');
    expect(source.eventNames()).toEqual([]);
  });
});
