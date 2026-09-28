import { validateProductionConfiguration } from './production-config.js';
import { CONTAINER_DEFAULTS, CONTAINER_ENV_KEYS } from '../worker/runtime-config.js';
import { selectEnvironment, parseAllowedHostnames } from '../worker/router.js';

export function deploymentPreflight(source) {
  const environment = selectEnvironment(source, CONTAINER_ENV_KEYS, CONTAINER_DEFAULTS);
  const errors = [];
  try { validateProductionConfiguration(environment); }
  catch (error) { errors.push(...error.message.split('\n').slice(1).map(line => line.replace(/^- /, ''))); }
  const allowedHosts = parseAllowedHostnames(source.SINALOA_EDGE_ALLOWED_HOSTS);
  if (!allowedHosts.size) errors.push('SINALOA_EDGE_ALLOWED_HOSTS must explicitly list the deployment hostname');
  try {
    if (!allowedHosts.has(new URL(environment.SINALOA_PUBLIC_URL).hostname.toLowerCase())) {
      errors.push('SINALOA_EDGE_ALLOWED_HOSTS must include the SINALOA_PUBLIC_URL hostname');
    }
  } catch { /* Already covered by production validation. */ }
  return {
    ready: errors.length === 0,
    errors,
    configuredNames: CONTAINER_ENV_KEYS.filter(name => typeof source[name] === 'string' && source[name].length > 0),
    scope: 'Configuration only; does not verify account plan, credentials, migrations or provider operations.'
  };
}
