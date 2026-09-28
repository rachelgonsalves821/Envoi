const safeMessage = error => String(error?.message || error || 'Readiness check failed').slice(0, 240);

async function runCheck(check, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${check.name} readiness check timed out`)), timeoutMs);
  try {
    await Promise.race([
      check.run(controller.signal),
      new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
    ]);
    return { name: check.name, ready: true, critical: check.critical !== false };
  } catch (error) {
    return { name: check.name, ready: false, critical: check.critical !== false, reason: safeMessage(error) };
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
