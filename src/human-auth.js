import './envoi-environment-bootstrap.js';
import { AuthService as LocalAuthService } from './auth.js';
import { WorkOSAuthService, assertBrowserCookieNames, csrfCookieName } from './workos-auth.js';

export function createHumanAuth(store) {
  assertBrowserCookieNames();
  const configured = process.env.ENVOI_HUMAN_AUTH_PROVIDER;
  const provider = configured || (process.env.ENVOI_AUTH_MODE === 'production' ? 'workos' : 'local');
  if (provider === 'workos') return new WorkOSAuthService(store);
  if (provider !== 'local') throw new Error(`Unsupported ENVOI_HUMAN_AUTH_PROVIDER: ${provider}`);
  const auth = new LocalAuthService(store);
  auth.provider = 'local';
  auth.config = () => ({ provider: 'local', hosted: false, phoneVerification: true, totp: true, csrfCookieName: csrfCookieName() });
  return auth;
}
