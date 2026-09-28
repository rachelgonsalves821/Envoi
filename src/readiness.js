async function runCheck(check, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${check.name} readiness check timed out`)), timeoutMs);
  try {
    await Promise.race([
      check.run(controller.signal),
      new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
    ]);
    return { name: check.name, ready: true, critical: check.critical !== false };
  } catch {
    return { name: check.name, ready: false, critical: check.critical !== false,
      reason: controller.signal.aborted ? 'Readiness check timed out' : 'Dependency check failed' };
  } finally {
    clearTimeout(timer);
  }
}

export async function evaluateReadiness(checks, { timeoutMs = 5_000, at = new Date().toISOString() } = {}) {
  const results = await Promise.all(checks.map(check => runCheck(check, timeoutMs)));
  return {
    ready: results.every(result => result.ready || !result.critical),
    checkedAt: at,
    checks: Object.fromEntries(results.map(({ name, ...result }) => [name, result]))
  };
}
