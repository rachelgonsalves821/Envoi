export function scannerHealthUrl(env) {
  const scanner = new URL(env.SINALOA_MALWARE_SCANNER_URL);
  const health = env.SINALOA_MALWARE_SCANNER_HEALTH_URL
    ? new URL(env.SINALOA_MALWARE_SCANNER_HEALTH_URL)
    : new URL('/health', scanner);
  if (health.origin !== scanner.origin || health.username || health.password) {
    throw new Error('Scanner health endpoint must use the scanner origin');
  }
  return health;
}

export async function checkScannerHealth(env, { signal, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(scannerHealthUrl(env), {
    method: 'GET', redirect: 'error', signal,
    headers: env.SINALOA_MALWARE_SCANNER_TOKEN
      ? { authorization: `Bearer ${env.SINALOA_MALWARE_SCANNER_TOKEN}` }
      : {}
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error('Scanner is not ready');
  }
  const status = await response.json();
  if (status?.ready !== true) throw new Error('Scanner did not confirm readiness');
}

// These probes establish connectivity/configuration, not end-to-end provider
// functionality. Signed uploads and actual sign-in are separate release gates.
export function dependencyReadinessChecks({ store, adapter, provider, env, externalEmailEnabled, emailTransport }) {
  const production = env.SINALOA_AUTH_MODE === 'production';
  return [
    { name: 'database', run: () => store.queryJson('readiness-probe', { limit: 1 }) },
    { name: 'objectStorageReadAccess', critical: production, run: async () => {
      if (provider === 's3') await adapter.headObject('__sinaloa_readiness_probe__');
    } },
    { name: 'malwareScanner', critical: production, run: signal => checkScannerHealth(env, { signal }) },
    { name: 'publicEmailConfiguration', critical: externalEmailEnabled, run: async () => {
      if (externalEmailEnabled) emailTransport.assertReady();
    } }
  ];
}
