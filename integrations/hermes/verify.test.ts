import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorSetupError } from '../connector/adapter';
import { verifyHermesTools } from './verify';

const missing = () => new ConnectorSetupError('TOOLS_NOT_READY', 'Tools unavailable');
afterEach(() => vi.useRealTimers());

describe('Hermes MCP readiness recovery', () => {
  it('waits through the five-minute parked retry and probes a newly discovered catalog', async () => {
    vi.useFakeTimers();
    let discovered = 0;
    const probe = vi.fn(async () => { if (!discovered) throw missing(); });
    const waiting = vi.fn();
    const result = verifyHermesTools(probe, () => discovered, { onWaiting: waiting });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(probe).toHaveBeenCalledTimes(1); // No paid polling while discovery is parked.
    expect(waiting).toHaveBeenCalledTimes(1);
    discovered++;
    await vi.advanceTimersByTimeAsync(500);
    await result;
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it('does not accept discovery or a model claim as proof of invocation', async () => {
    vi.useFakeTimers();
    let discovered = 0;
    const probe = vi.fn(async () => { throw missing(); });
    const result = verifyHermesTools(probe, () => discovered, {}, { timeoutMs: 60_000 });
    const failed = expect(result).rejects.toMatchObject({ code: 'TOOLS_NOT_READY' });
    await vi.advanceTimersByTimeAsync(29_000);
    discovered++;
    await vi.advanceTimersByTimeAsync(31_000);
    await failed;
    expect(probe).toHaveBeenCalledTimes(3); // Initial, discovered and final real probes only.
  });
  it('recovers a Gateway restart without catalog notifications', async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockRejectedValueOnce(new ConnectorSetupError('GATEWAY_UNREACHABLE', 'Restarting')).mockResolvedValue(undefined);
    const result = verifyHermesTools(probe, () => 0);
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it('cancels its wait promptly and never retries provider or authentication failures', async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const probe = vi.fn(async () => { throw missing(); });
    const result = verifyHermesTools(probe, () => 0, { signal: stop.signal });
    const failed = expect(result).rejects.toMatchObject({ code: 'SETUP_CANCELLED' });
    await vi.advanceTimersByTimeAsync(500);
    stop.abort(); await failed;
    expect(probe).toHaveBeenCalledTimes(1);
    for (const code of ['MODEL_NOT_READY', 'GATEWAY_AUTH_FAILED']) {
      const fatal = vi.fn(async () => { throw new ConnectorSetupError(code, 'Fix configuration'); });
      await expect(verifyHermesTools(fatal, () => 0)).rejects.toMatchObject({ code });
      expect(fatal).toHaveBeenCalledTimes(1);
    }
  });
});
