import { ConnectorSetupError, type RuntimeBridge } from './adapter';
import { EnvoiError } from '../../sdk/typescript/src/index';
import { lifecyclePolicy, retryDelay } from '../../sdk/typescript/src/lifecycle';

function waitForRetry(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return; }
    const complete = () => { clearTimeout(timer); signal.removeEventListener('abort', complete); resolve(); };
    const timer = setTimeout(complete, milliseconds);
    signal.addEventListener('abort', complete, { once: true });
  });
}

export async function waitForRuntimeTools(bridge: RuntimeBridge, signal: AbortSignal,
  options: { timeoutMs?: number | null; retryMs?: number; onWaiting?: (code: string) => void } = {}) {
  if (!bridge.verify) return;
  const deadline = options.timeoutMs === null ? undefined : AbortSignal.timeout(options.timeoutMs ?? 360_000);
  const bounded = deadline ? AbortSignal.any([signal, deadline]) : signal;
  let discoveryRequired = false;
  let transientFailures = 0;
  while (!bounded.aborted) {
    try {
      await bridge.connector.checkStatus();
      if ((await bridge.connector.lifecycle()).paused) return;
      if (discoveryRequired && bridge.readyToVerify && !bridge.readyToVerify()) {
        options.onWaiting?.('TOOLS_NOT_READY');
        await waitForRetry(options.retryMs ?? 15_000, bounded);
        continue;
      }
      discoveryRequired = false;
      await bridge.verify(bounded);
      bounded.throwIfAborted();
      return;
    } catch (error) {
      if (signal.aborted) throw new ConnectorSetupError('SETUP_CANCELLED', 'Runtime recovery was cancelled. Saved enrollment is unchanged.');
      if (deadline?.aborted) break;
      const retryable = error instanceof ConnectorSetupError && ['TOOLS_NOT_READY', 'GATEWAY_UNREACHABLE', 'PROVIDER_UNREACHABLE', 'ENVOI_UNREACHABLE'].includes(error.code)
        || error instanceof EnvoiError && lifecyclePolicy(error).lifecycle === 'DEGRADED';
      if (!retryable) throw error;
      if (error instanceof ConnectorSetupError && error.code === 'TOOLS_NOT_READY') discoveryRequired = true;
      options.onWaiting?.(error instanceof ConnectorSetupError || error instanceof EnvoiError ? error.code ?? 'CONNECTION_TEMPORARILY_UNAVAILABLE' : 'CONNECTION_TEMPORARILY_UNAVAILABLE');
      const retryAfter = error instanceof EnvoiError ? error.retryAfterSeconds ?? 0 : 0;
      const delay = error instanceof ConnectorSetupError && error.code === 'TOOLS_NOT_READY' ? options.retryMs ?? 15_000
        : options.retryMs ?? retryDelay(++transientFailures, Math.random(), retryAfter);
      await waitForRetry(Math.max(delay, retryAfter * 1000), bounded);
    }
  }
  if (signal.aborted) throw new ConnectorSetupError('SETUP_CANCELLED', 'Runtime recovery was cancelled. Saved enrollment is unchanged.');
  throw new ConnectorSetupError('TOOLS_NOT_READY', 'Runtime tools did not recover within the setup check deadline. Check the selected Gateway MCP connection; saved enrollment is unchanged.');
}
