import type { AuthConfig, Human, HumanActionKey, HumanView, Inbox, Organization } from './types';

const SESSION_KEY = 'sinaloa.human-session';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export function getSessionToken() {
  return localStorage.getItem(SESSION_KEY);
}

export function saveSessionToken(token: string) {
  localStorage.setItem(SESSION_KEY, token);
}

export function clearSessionToken() {
  localStorage.removeItem(SESSION_KEY);
}

export async function request<T>(pathname: string, options: RequestInit = {}): Promise<T> {
  const token = getSessionToken();
  const response = await fetch(pathname, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error || 'The request could not be completed.', response.status);
  return payload as T;
}

export const api = {
  authConfig: () => request<AuthConfig>('/api/auth/config'),
  me: () => request<Human>('/api/auth/me'),
  phoneStart: (phoneNumber: string, displayName: string) => request<{ challengeId: string; expiresAt: string; developmentCode?: string }>('/api/auth/phone/start', { method: 'POST', body: JSON.stringify({ phoneNumber, displayName }) }),
  phoneVerify: (challengeId: string, code: string) => request<{ human: Human; sessionToken: string; secondFactorRequired: boolean }>('/api/auth/phone/verify', { method: 'POST', body: JSON.stringify({ challengeId, code }) }),
  totpSetup: () => request<{ secret: string; otpauthUri: string; developmentCode?: string }>('/api/auth/totp/setup', { method: 'POST', body: '{}' }),
  totpVerify: (code: string) => request<{ human: Human; assurance: string }>('/api/auth/totp/verify', { method: 'POST', body: JSON.stringify({ code }) }),
  logout: () => request<{ revoked: boolean; logoutUrl?: string | null }>('/api/auth/logout', { method: 'POST', body: '{}' }),
  organizations: () => request<Organization[]>('/api/organizations'),
  workspaces: (organizationId: string) => request<Inbox[]>(`/api/organizations/${organizationId}/workspaces`),
  createWorkspace: (name: string, organizationId?: string) => request<Inbox>('/api/inboxes', { method: 'POST', body: JSON.stringify({ name, organizationId }) }),
  humanView: (inboxId: string) => request<HumanView>(`/api/inboxes/${inboxId}/human-view`),
  action: (inboxId: string, caseId: string, actionKey: HumanActionKey, externalRefs: Record<string, unknown> = {}) => request<{ case: unknown; action: unknown; replay?: boolean }>(`/api/inboxes/${inboxId}/cases/${caseId}/actions`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `${actionKey}-${caseId}-${crypto.randomUUID()}` },
    body: JSON.stringify({ actionKey, externalRefs })
  }),
  enrollmentToken: (inboxId: string, name: string, permissions: string[]) => request<{ enrollmentToken: string; enrollmentUrl: string; expiresAt: string; permissions: string[] }>(`/api/inboxes/${inboxId}/agent-enrollment-tokens`, {
    method: 'POST',
    body: JSON.stringify({ permissions, agentProfile: { name, slug: name } })
  }),
  approveAgent: (inboxId: string, agentId: string, permissions: string[]) => request<{ agent: unknown; agentApiToken?: string }>(`/api/inboxes/${inboxId}/agent-onboarding/${agentId}/approve`, { method: 'POST', body: JSON.stringify({ permissions }) })
};
