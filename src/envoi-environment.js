// N2-config-2: SINALOA_* settings are retired. One legacy name is still honoured, because staging's
// data encryption key exists only under it and dashboard secrets cannot be read back to copy it.
// It goes when the key migration lands (docs/envoi-backend-rename-inventory.md, "Encryption key").
export const LEGACY_ENVIRONMENT_FALLBACKS = Object.freeze({
  ENVOI_DATA_ENCRYPTION_KEY: 'SINALOA_DATA_ENCRYPTION_KEY'
});

// Fill ENVOI_* from its one honoured legacy name. A conflicting pair fails closed rather than
// silently changing a secret; the message names the settings, never their values.
export function applyLegacyEnvironmentFallbacks(env = process.env) {
  for (const [current, legacy] of Object.entries(LEGACY_ENVIRONMENT_FALLBACKS)) {
    if (env[current] !== undefined && env[legacy] !== undefined && env[current] !== env[legacy]) {
      throw new Error(`Conflicting Envoi environment settings: ${current} and ${legacy}`);
    }
    if (env[current] === undefined && env[legacy] !== undefined) env[current] = env[legacy];
  }
  return env;
}

// SINALOA_* names nothing reads any more, other than the honoured fallback.
export function retiredEnvironmentNames(env = process.env) {
  const honoured = new Set(Object.values(LEGACY_ENVIRONMENT_FALLBACKS));
  return Object.keys(env).filter(key => key.startsWith('SINALOA_') && !honoured.has(key)).sort();
}

// A retired name is refused in every mode: SINALOA_AUTH_MODE=production alone would otherwise
// start a development server. The message names the settings, never their values.
export function assertNoRetiredEnvironment(env = process.env) {
  const retired = retiredEnvironmentNames(env);
  if (retired.length) {
    throw new Error(`Retired SINALOA_* settings are no longer read; rename them to ENVOI_*: ${retired.join(', ')}`);
  }
  return env;
}
