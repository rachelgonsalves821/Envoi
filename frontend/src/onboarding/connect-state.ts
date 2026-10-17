import validate from './route-availability.validator.mjs';
import schemas from '../../../test/contract-fixtures/agent-registration/schemas.json';

export interface RouteAvailability {
  asOf: string;
  contract: { id: 'agent-registration'; version: 1 };
  registrationEnabled: boolean; installationsEnabled: boolean;
  routes: Array<{ connectionRoute: string; available: boolean }>;
  deliveryModes: Array<{ deliveryMode: string; available: boolean }>;
}

/** One canonical schema source; no client flags or optimistic route fallback. */
export function connectionOffer(value: unknown): { localHelper: boolean; availability: RouteAvailability } {
  if (!validate(value)) throw new Error('Connection options are unavailable. Try again later.');
  const availability = value as RouteAvailability;
  const enabled = availability.registrationEnabled && availability.installationsEnabled;
  const routes = availability.routes;
  const modes = availability.deliveryModes;
  if (JSON.stringify(routes.map(route => route.connectionRoute)) !== JSON.stringify(schemas.definitions.connectionRoute.enum)
    || JSON.stringify(modes.map(mode => mode.deliveryMode)) !== JSON.stringify(schemas.definitions.deliveryMode.enum)) throw new Error('Connection options are unavailable. Try again later.');
  if (routes.some(route => route.available && (!enabled || !['local_helper', 'authenticated_rest'].includes(route.connectionRoute)))
    || modes.some(mode => mode.available && (!enabled || mode.deliveryMode !== 'envoi_link'))
    || modes.find(mode => mode.deliveryMode === 'envoi_link')?.available !== enabled
    || routes.find(route => route.connectionRoute === 'local_helper')?.available !== enabled) {
    throw new Error('Connection options are unavailable. Try again later.');
  }
  return { localHelper: enabled && routes.some(route => route.connectionRoute === 'local_helper' && route.available), availability };
}
export async function readConnectionOffer(signal?: AbortSignal, fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/onboarding/routes', { credentials: 'omit', redirect: 'error', signal });
  if (!response.ok) throw new Error('Connection options are unavailable. Try again later.');
  return connectionOffer(await response.json());
}
export function connectionPrompt(origin: string) {
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use a trusted Envoi origin.');
  return `Connect to Envoi at ${origin}/connect. Read its instructions and use the trusted envoi-link helper on your Hermes or OpenClaw host. Show me the claim URL and code, then wait for my approval and local confirmation. Keep all credentials private.`;
}
export function claimSignInPath(path: string) {
  const url = new URL(path, 'https://www.envoi-agents.com');
  if (!['https:', 'http:'].includes(url.protocol)) return '/api/auth/workos/sign-in?returnTo=%2Fclaim';
  url.searchParams.set('returnTo', '/claim');
  return url.origin === 'https://www.envoi-agents.com' && path.startsWith('/') ? `${url.pathname}${url.search}` : url.href;
}
