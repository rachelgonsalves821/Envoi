// agent-registration v1 §1: server-only Phase B flags, default off. Clients never read them;
// they read GET /api/onboarding/routes, built here from the same flags.
export const onboardingFlagNames = ['ENVOI_INSTALLATIONS_V2', 'ENVOI_AGENT_REGISTRATION_V2', 'ENVOI_AUTHENTICATED_REST_ROUTE'];
// Schema enum order, which the routes response must follow.
export const connectionRoutes = ['local_helper', 'remote_mcp_oauth', 'provider_connector', 'authenticated_rest'];
export const deliveryModes = ['envoi_link', 'webhook', 'provider', 'poll', 'on_demand', 'a2a'];

// Only the exact string "true" turns a flag on. Any other value set is refused, so a typo cannot
// look enabled to an operator while the server keeps it off.
export function onboardingFlagErrors(env = process.env) {
  const errors = [];
  for (const name of onboardingFlagNames) {
    if (env[name] !== undefined && env[name] !== '' && !['true', 'false'].includes(env[name])) errors.push(`${name} must be true or false`);
  }
  if (env.ENVOI_AGENT_REGISTRATION_V2 === 'true' && env.ENVOI_INSTALLATIONS_V2 !== 'true') errors.push('ENVOI_AGENT_REGISTRATION_V2 requires ENVOI_INSTALLATIONS_V2');
  return errors;
}

// Fails closed at startup in every mode.
export function readOnboardingFlags(env = process.env) {
  const errors = onboardingFlagErrors(env);
  if (errors.length) throw new Error(`Invalid onboarding flags:\n- ${errors.join('\n- ')}`);
  return {
    installations: env.ENVOI_INSTALLATIONS_V2 === 'true',
    registration: env.ENVOI_AGENT_REGISTRATION_V2 === 'true',
    authenticatedRest: env.ENVOI_AUTHENTICATED_REST_ROUTE === 'true'
  };
}

export const routeAvailable = (flags, route) => flags.registration && flags.installations && (route === 'local_helper' || (route === 'authenticated_rest' && flags.authenticatedRest));
export const deliveryModeAvailable = (flags, mode) => flags.registration && flags.installations && mode === 'envoi_link';

export function routeAvailability(flags, asOf = new Date().toISOString()) {
  return {
    asOf,
    contract: { id: 'agent-registration', version: 1 },
    registrationEnabled: flags.registration,
    installationsEnabled: flags.installations,
    routes: connectionRoutes.map(connectionRoute => ({ connectionRoute, available: routeAvailable(flags, connectionRoute) })),
    deliveryModes: deliveryModes.map(deliveryMode => ({ deliveryMode, available: deliveryModeAvailable(flags, deliveryMode) }))
  };
}
