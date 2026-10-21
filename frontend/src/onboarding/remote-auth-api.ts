import { request } from '../api';
import { onboardingApi } from './api';
import type { RemoteAuthApi } from './remote-auth-types';
const path = (handle: string) => '/api/oauth/authorization-requests/' + encodeURIComponent(handle);
/** Uses the existing human-session, CSRF, expected-account and cancellation boundary. */
export const remoteAuthApi: RemoteAuthApi = {
  view: (handle, signal) => request(path(handle), { signal }),
  approve: (handle, body, signal) => request(path(handle) + '/approve', { method: 'POST', body: JSON.stringify(body), signal }),
  deny: (handle, signal) => request(path(handle) + '/deny', { method: 'POST', body: '{}', signal }),
  withdraw: onboardingApi.withdraw,
  bootstrap: (body, signal) => request('/api/oauth/bootstrap-codes', { method: 'POST', body: JSON.stringify(body), signal })
};
