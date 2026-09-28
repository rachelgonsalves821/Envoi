import type { AgentConnectionInvitation, AgentConnectionInvitationDecision, ApprovedEmailContact, Asset, AuthConfig, CalendarConnector, CalendarProvider, EmailTransportStatus, Human, HumanActionKey, HumanView, Inbox, Organization } from './types';

export const SESSION_EXPIRED_EVENT = 'sinaloa:session-expired';
let configuredCsrfCookieName = 'sinaloa_csrf';

export function setCsrfCookieName(name?: string) {
  configuredCsrfCookieName = name && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) ? name : 'sinaloa_csrf';
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function shouldNotifySessionExpired(pathname: string) {
  return ![
    '/api/auth/config',
    '/api/auth/phone/start',
    '/api/auth/phone/verify',
    '/api/auth/totp/setup',
    '/api/auth/totp/verify',
    '/api/auth/workos/sign-in',
    '/api/auth/workos/sign-up',
    '/api/auth/workos/callback'
  ].some(path => pathname.startsWith(path));
}

export function csrfToken(cookieHeader = typeof document === 'undefined' ? '' : document.cookie) {
  const encodedName = encodeURIComponent(configuredCsrfCookieName);
  const value = cookieHeader.split(';').map(item => item.trim()).find(item => item.startsWith(`${encodedName}=`))?.slice(encodedName.length + 1);
  return value ? decodeURIComponent(value) : null;
}

export function csrfHeaders(method = 'GET', cookieHeader?: string): Record<string, string> {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return {};
  const token = csrfToken(cookieHeader);
  return token ? { 'x-sinaloa-csrf': token } : {};
}

export async function request<T>(pathname: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(pathname, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...csrfHeaders(options.method),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({})) as { error?: string; code?: string; details?: Record<string, unknown> };
  if (!response.ok) {
    if (response.status === 401 && shouldNotifySessionExpired(pathname) && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
    throw new ApiError(payload.error || 'The request could not be completed.', response.status, payload.code, payload.details);
  }
  return payload as T;
}

export function safeDownloadUrl(value: string, baseUrl = typeof window === 'undefined' ? 'https://localhost/' : window.location.href) {
  try {
    const base = new URL(baseUrl);
    const target = new URL(value, base);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return null;
    if (base.protocol === 'https:' && target.protocol !== 'https:') return null;
    return target.href;
  } catch {
    return null;
  }
}

export const api = {
  authConfig: async () => {
    const config = await request<AuthConfig>('/api/auth/config');
    setCsrfCookieName(config.csrfCookieName);
    return config;
  },
  me: () => request<Human>('/api/auth/me'),
  phoneStart: (phoneNumber: string, displayName: string) => request<{ challengeId: string; expiresAt: string; developmentCode?: string }>('/api/auth/phone/start', { method: 'POST', body: JSON.stringify({ phoneNumber, displayName }) }),
  phoneVerify: (challengeId: string, code: string) => request<{ human: Human; secondFactorRequired: boolean; expiresAt?: string }>('/api/auth/phone/verify', { method: 'POST', body: JSON.stringify({ challengeId, code }) }),
  totpSetup: () => request<{ secret: string; otpauthUri: string; developmentCode?: string }>('/api/auth/totp/setup', { method: 'POST', body: '{}' }),
  totpVerify: (code: string) => request<{ human: Human; assurance: string }>('/api/auth/totp/verify', { method: 'POST', body: JSON.stringify({ code }) }),
  logout: () => request<{ revoked: boolean; logoutUrl?: string | null }>('/api/auth/logout', { method: 'POST', body: '{}' }),
  organizations: () => request<Organization[]>('/api/organizations'),
  workspaces: (organizationId: string) => request<Inbox[]>(`/api/organizations/${organizationId}/workspaces`),
  createWorkspace: (name: string, organizationId?: string) => request<Inbox>('/api/inboxes', { method: 'POST', body: JSON.stringify({ name, organizationId }) }),
  humanView: (inboxId: string) => request<HumanView>(`/api/inboxes/${inboxId}/human-view`),
  invitations: (inboxId: string) => request<AgentConnectionInvitation[]>(`/api/inboxes/${encodeURIComponent(inboxId)}/invitations`),
  acceptInvitation: (inboxId: string, invitationId: string) => request<AgentConnectionInvitationDecision>(`/api/inboxes/${encodeURIComponent(inboxId)}/invitations/${encodeURIComponent(invitationId)}/accept`, { method: 'POST' }),
  declineInvitation: (inboxId: string, invitationId: string) => request<AgentConnectionInvitation>(`/api/inboxes/${encodeURIComponent(inboxId)}/invitations/${encodeURIComponent(invitationId)}/decline`, { method: 'POST' }),
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
  ,downloadAsset: (inboxId: string, assetId: string) => request<{ object: Asset; download: { url: string; method: 'GET'; headers?: Record<string, string> } }>(`/api/inboxes/${inboxId}/assets/${assetId}/download`)
  ,emailTransport: (inboxId: string) => request<EmailTransportStatus>(`/api/inboxes/${inboxId}/email-transport`)
  ,approveExternalContact: (inboxId: string, input: { email: string; displayName: string; direction: ApprovedEmailContact['direction'] }) => request<ApprovedEmailContact>(`/api/inboxes/${encodeURIComponent(inboxId)}/external-contacts`, { method: 'POST', body: JSON.stringify(input) })
  ,setExternalContactBlocked: (inboxId: string, contactId: string, blocked: boolean) => request<ApprovedEmailContact>(`/api/inboxes/${encodeURIComponent(inboxId)}/external-contacts/${encodeURIComponent(contactId)}/${blocked ? 'block' : 'unblock'}`, { method: 'POST', body: '{}' })
  ,calendarConnectors: (inboxId: string) => request<{ providers: Record<CalendarProvider['id'], CalendarProvider>; connectors: CalendarConnector[] }>(`/api/inboxes/${inboxId}/calendar-connectors`)
  ,connectCalendar: (inboxId: string, provider: CalendarProvider['id']) => request<{ provider: CalendarProvider['id']; authorizationUrl: string; expiresAt: string }>(`/api/inboxes/${inboxId}/calendar-connectors/${provider}/connect`, { method: 'POST', body: '{}' })
  ,disconnectCalendar: (inboxId: string, provider: CalendarProvider['id']) => request<CalendarConnector>(`/api/inboxes/${inboxId}/calendar-connectors/${provider}/disconnect`, { method: 'POST', body: '{}' })
};
