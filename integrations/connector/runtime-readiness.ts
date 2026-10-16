import { ConnectorSetupError, type RuntimeBridge } from './adapter';

function waitForRetry(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return; }
    const complete = () => { clearTimeout(timer); signal.removeEventListener('abort', complete); resolve(); };
    const timer = setTimeout(complete, milliseconds);
    signal.addEventListener('abort', complete, { once: true });
  });
}

export async function waitForRuntimeTools(bridge: RuntimeBridge, signal: AbortSignal,
  options: { timeoutMs?: number; retryMs?: number; onWaiting?: (code: string) => void } = {}) {
  if (!bridge.verify) return;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 360_000);
  const bounded = AbortSignal.any([signal, deadline]);
  while (!bounded.aborted) {
    try {
      await bridge.connector.checkStatus();
      if ((await bridge.connector.lifecycle()).paused) return;
      await bridge.verify(bounded);
      bounded.throwIfAborted();
      return;
    } catch (error) {
      if (signal.aborted) throw new ConnectorSetupError('SETUP_CANCELLED', 'Runtime recovery was cancelled. Saved enrollment is unchanged.');
      if (deadline.aborted) break;
      if (!(error instanceof ConnectorSetupError) || error.code !== 'TOOLS_NOT_READY') throw error;
      options.onWaiting?.(error.code);
      await waitForRetry(options.retryMs ?? 15_000, bounded);
    }
  }
  if (signal.aborted) throw new ConnectorSetupError('SETUP_CANCELLED', 'Runtime recovery was cancelled. Saved enrollment is unchanged.');
  throw new ConnectorSetupError('TOOLS_NOT_READY', 'Runtime tools did not recover within six minutes. Check the selected Gateway MCP connection; saved enrollment is unchanged.');
}
