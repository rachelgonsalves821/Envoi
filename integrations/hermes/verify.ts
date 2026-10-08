import { ConnectorSetupError } from '../connector/adapter';

const recoverable = (error: unknown): error is ConnectorSetupError => error instanceof ConnectorSetupError
  && ['TOOLS_NOT_READY', 'GATEWAY_UNREACHABLE'].includes(error.code);

/** Keep the live relay available across Hermes's five-minute parked MCP retry.
 * Catalog discovery schedules a new real probe; it never passes the check itself.
 * Limit paid model runs to discovery changes, Gateway recovery and one final probe.
 */
export async function verifyHermesTools(probe: () => Promise<void>, discovery: () => number,
  options: { signal?: AbortSignal; onWaiting?: () => void } = {},
  limits: { timeoutMs?: number; pollMs?: number; retryMs?: number } = {}) {
  const deadline = Date.now() + (limits.timeoutMs ?? 360_000);
  const retryMs = limits.retryMs ?? 30_000;
  let seen = discovery();
  let last: ConnectorSetupError;
  if (options.signal?.aborted) throw new ConnectorSetupError('SETUP_CANCELLED', 'Hermes verification was cancelled.');
  try { await probe(); return; }
  catch (error) { if (!recoverable(error)) throw error; last = error; }
  options.onWaiting?.();
  let retryAt = Date.now() + retryMs;
  while (!options.signal?.aborted) {
    const final = Date.now() >= deadline;
    if (final || Date.now() >= retryAt && (discovery() !== seen || last.code === 'GATEWAY_UNREACHABLE')) {
      seen = discovery();
      try { await probe(); return; }
      catch (error) { if (!recoverable(error)) throw error; last = error; }
      if (final) throw last;
      retryAt = Date.now() + retryMs;
    }
    await new Promise<void>(resolve => {
      const complete = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', complete); resolve(); };
      const timer = setTimeout(complete, Math.min(limits.pollMs ?? 500, Math.max(1, deadline - Date.now())));
      options.signal?.addEventListener('abort', complete, { once: true });
      if (options.signal?.aborted) complete();
    });
  }
  throw new ConnectorSetupError('SETUP_CANCELLED', 'Hermes verification was cancelled. Enrollment is saved; resume using the same state directory.');
}
