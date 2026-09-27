import { AuthService as LocalAuthService } from './auth.js';
import { WorkOSAuthService } from './workos-auth.js';

export function createHumanAuth(store) {
  const configured = process.env.SINALOA_HUMAN_AUTH_PROVIDER;
  const provider = configured || (process.env.SINALOA_AUTH_MODE === 'production' ? 'workos' : 'local');
  if (provider === 'workos') return new WorkOSAuthService(store);
  if (provider !== 'local') throw new Error(`Unsupported SINALOA_HUMAN_AUTH_PROVIDER: ${provider}`);
  const auth = new LocalAuthService(store);
  auth.provider = 'local';
  auth.config = () => ({ provider: 'local', hosted: false, phoneVerification: true, totp: true });
  return auth;
}
