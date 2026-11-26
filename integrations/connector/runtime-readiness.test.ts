import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvoiError } from '../../sdk/typescript/src/index';
import { ConnectorSetupError, type RuntimeBridge } from './adapter';
import { waitForRuntimeTools } from './runtime-readiness';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture() {
  let paused = false;
  const connector = {
    checkStatus: vi.fn(async () => undefined),
    lifecycle: vi.fn(async () => ({ paused })),
    run: vi.fn(), processWorkOnce: vi.fn(), sendMessage: vi.fn()
  };
  const verify = vi.fn(async (_signal?: AbortSignal) => undefined);
  const close = vi.fn(async () => undefined);
  return { bridge: { connector, verify, close } as unknown as RuntimeBridge,
    connector, verify, close, pause: () => { paused = true; } };
}

describe('runtime tool recovery without tearing down the relay', () => {
  it('backs off missed proofs against a cached catalog without requiring rediscovery', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.bridge.readyToVerify = () => true;
    let runs = 0;
    f.verify.mockImplementation(async () => { if (++runs <= 4) throw new ConnectorSetupError('TOOLS_NOT_READY', 'Missed invocation'); });
    const result = waitForRuntimeTools(f.bridge, new AbortController().signal, { timeoutMs: null });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(3);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(runs).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(4);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(runs).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();
    expect(runs).toBe(5);
    expect(f.connector.processWorkOnce).not.toHaveBeenCalled();
  });
  it('waits beyond six minutes without repeating a model proof before new tool discovery', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const stop = new AbortController(); setTimeout(() => stop.abort(), milliseconds); return stop.signal;
    });
    const f = fixture();
    const stop = new AbortController();
    let discovered = false;
    (f.bridge as RuntimeBridge & { readyToVerify: () => boolean }).readyToVerify = () => discovered;
    f.verify.mockImplementation(async () => { if (!discovered) throw new ConnectorSetupError('TOOLS_NOT_READY', 'Parked'); });
    let ended = false;
    const result = waitForRuntimeTools(f.bridge, stop.signal, { timeoutMs: null });
    void result.then(() => { ended = true; }, () => { ended = true; });
    try {
      await vi.advanceTimersByTimeAsync(12 * 60_000);
      expect(ended).toBe(false);
      expect(f.verify).toHaveBeenCalledTimes(1);
      expect(f.close).not.toHaveBeenCalled();
      expect(f.connector.processWorkOnce).not.toHaveBeenCalled();
      discovered = true;
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(result).resolves.toBeUndefined();
      expect(f.verify).toHaveBeenCalledTimes(2);
    } finally { stop.abort(); await result.catch(() => {}); }
  });
  it('outlasts the Hermes 300-second parked-server probe without claiming or closing the relay', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const start = Date.now();
    f.verify.mockImplementation(async () => {
      if (Date.now() - start < 300_000) throw new ConnectorSetupError('TOOLS_NOT_READY', 'Parked');
    });
    const waiting = vi.fn();
    const result = waitForRuntimeTools(f.bridge, new AbortController().signal, { onWaiting: waiting });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(f.verify).toHaveBeenCalledTimes(20);
    expect(waiting).toHaveBeenCalledTimes(20);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.connector.run).not.toHaveBeenCalled();
    expect(f.connector.processWorkOnce).not.toHaveBeenCalled();
    expect(f.connector.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();
    expect(f.verify).toHaveBeenCalledTimes(21);
    expect(f.close).not.toHaveBeenCalled();
  });

  it('bounds an in-flight verification without reporting readiness', async () => {
    const f = fixture();
    f.verify.mockImplementation(signal => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new ConnectorSetupError('SETUP_CANCELLED', 'Cancelled')), { once: true });
    }));
    await expect(waitForRuntimeTools(f.bridge, new AbortController().signal, { timeoutMs: 20 }))
      .rejects.toMatchObject({ code: 'TOOLS_NOT_READY' });
    expect(f.connector.run).not.toHaveBeenCalled();
  });

  it('honors the server retry-after while preserving the bridge and avoiding model calls', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.connector.checkStatus.mockRejectedValueOnce(new EnvoiError('Busy', 429, 'RATE_LIMITED', { retryAfterSeconds: 2 }));
    const result = waitForRuntimeTools(f.bridge, new AbortController().signal, { timeoutMs: null, retryMs: 1 });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();
    expect(f.verify).toHaveBeenCalledOnce();
  });

  it('stops promptly when cancelled during recovery backoff', async () => {
    const f = fixture();
    const stop = new AbortController();
    f.verify.mockRejectedValue(new ConnectorSetupError('TOOLS_NOT_READY', 'Parked'));
    await expect(waitForRuntimeTools(f.bridge, stop.signal, { onWaiting: () => stop.abort() }))
      .rejects.toMatchObject({ code: 'SETUP_CANCELLED' });
    expect(f.verify).toHaveBeenCalledTimes(1);
  });

  it.each(['CREDENTIAL_REVOKED', 'CREDENTIAL_EXPIRED'])('does not retry %s or invoke the model after denial', async code => {
    const f = fixture();
    f.connector.checkStatus.mockRejectedValue(new EnvoiError('Denied', 401, code));
    const waiting = vi.fn();
    await expect(waitForRuntimeTools(f.bridge, new AbortController().signal, { onWaiting: waiting }))
      .rejects.toMatchObject({ code });
    expect(waiting).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('does not classify Gateway authentication failure as parked tools', async () => {
    const f = fixture();
    f.verify.mockRejectedValue(new ConnectorSetupError('GATEWAY_AUTH_FAILED', 'Denied'));
    const waiting = vi.fn();
    await expect(waitForRuntimeTools(f.bridge, new AbortController().signal, { onWaiting: waiting }))
      .rejects.toMatchObject({ code: 'GATEWAY_AUTH_FAILED' });
    expect(waiting).not.toHaveBeenCalled();
  });

  it('rechecks pause before every model attempt and defers verification while paused', async () => {
    const f = fixture();
    f.verify.mockRejectedValue(new ConnectorSetupError('TOOLS_NOT_READY', 'Parked'));
    await expect(waitForRuntimeTools(f.bridge, new AbortController().signal, { retryMs: 1, onWaiting: f.pause }))
      .resolves.toBeUndefined();
    expect(f.connector.checkStatus).toHaveBeenCalledTimes(2);
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.connector.run).not.toHaveBeenCalled();
  });
});
