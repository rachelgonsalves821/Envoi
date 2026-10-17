import { request } from '../api';
import type { OnboardingApi } from './types';
const id = encodeURIComponent;
const installationPath = (inboxId: string, agentId: string) => `/api/inboxes/${id(inboxId)}/agents/${id(agentId)}/installations`;

/** Human-session transport retains CSRF, expected account and request-generation checks. */
export const onboardingApi: OnboardingApi = {
  lookup: (verificationCode, signal) => request('/api/agent-claims/lookup', { method: 'POST', body: JSON.stringify({ verificationCode }), signal }),
  approve: (registrationId, body, signal) => request(`/api/agent-registrations/${id(registrationId)}/approve`, { method: 'POST', body: JSON.stringify(body), signal }),
  reject: (registrationId, verificationCode, signal) => request(`/api/agent-registrations/${id(registrationId)}/reject`, { method: 'POST', body: JSON.stringify({ verificationCode }), signal }),
  claims: signal => request('/api/agent-claims', { signal }),
  withdraw: (registrationId, signal) => request(`/api/agent-claims/${id(registrationId)}/withdraw`, { method: 'POST', signal }),
  installations: (inboxId, agentId, signal) => request(installationPath(inboxId, agentId), { signal }),
  revoke: (inboxId, agentId, installationId, signal) => request(`${installationPath(inboxId, agentId)}/${id(installationId)}/revoke`, { method: 'POST', signal })
};
