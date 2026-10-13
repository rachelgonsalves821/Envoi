import { validateProductionConfiguration } from './production-config.js';
import { CONTAINER_DEFAULTS, CONTAINER_ENV_KEYS } from '../worker/runtime-config.js';
import { selectEnvironment, parseAllowedHostnames } from '../worker/router.js';
import { applyLegacyEnvironmentFallbacks, orphanedLegacyNames, retiredEnvironmentNames } from './envoi-environment.js';

export function deploymentPreflight(source) {
  const errors = [];
  // N2-config-2: a SINALOA_* setting without its ENVOI_* twin would be lost on Cloudflare.
  for (const name of orphanedLegacyNames(Object.keys(source || {}))) errors.push(`${name} is no longer read; set ENVOI_${name.slice('SINALOA_'.length)} instead`);
  let environment = {};
  try {
    source = applyLegacyEnvironmentFallbacks({ ...source });
    environment = selectEnvironment(source, CONTAINER_ENV_KEYS, CONTAINER_DEFAULTS);
    validateProductionConfiguration(environment);
  } catch (error) {
    const lines = error.message.split('\n');
    errors.push(...(lines.length > 1 ? lines.slice(1) : lines).map(line => line.replace(/^- /, '')));
  }
  const allowedHosts = parseAllowedHostnames(source.ENVOI_EDGE_ALLOWED_HOSTS);
  if (!allowedHosts.size) errors.push('ENVOI_EDGE_ALLOWED_HOSTS must explicitly list the deployment hostname');
  try {
    if (!allowedHosts.has(new URL(environment.ENVOI_PUBLIC_URL).hostname.toLowerCase())) {
      errors.push('ENVOI_EDGE_ALLOWED_HOSTS must include the ENVOI_PUBLIC_URL hostname');
    }
  } catch { /* Already covered by production validation. */ }
  return {
    ready: errors.length === 0,
    errors,
    configuredNames: CONTAINER_ENV_KEYS.filter(name => typeof source[name] === 'string' && source[name].length > 0),
    // Names only. The container never receives these; delete them once nothing older needs them.
    retiredNames: retiredEnvironmentNames(source),
    scope: 'Configuration only; does not verify account plan, credentials, migrations or provider operations.'
  };
}
