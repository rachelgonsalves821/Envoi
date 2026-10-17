import type { Agent } from '../types';

export type RegistrationPermission = 'send_agent_messages' | 'receive_agent_messages' | 'create_assets' | 'execute_cases' | 'use_email_transport';
// agent-registration v1 x-permission-labels; consuming tests check the canonical table.
export const PERMISSION_LABELS: Record<RegistrationPermission, string> = {
  send_agent_messages: 'send agent messages', receive_agent_messages: 'receive agent messages',
  create_assets: 'create files', execute_cases: 'act on cases', use_email_transport: 'use external email'
};
export type ConnectionRoute = 'local_helper' | 'remote_mcp_oauth' | 'provider_connector' | 'authenticated_rest';
export type DeliveryMode = 'envoi_link' | 'webhook' | 'provider' | 'poll' | 'on_demand' | 'a2a';
export interface RuntimeDeclaration { type: string; version: string | null }
export interface ClaimLookup {
  registrationId: string; verificationCode: string; requestedName: string; requestedLocalPart: string | null;
  requestedPermissions: RegistrationPermission[]; grantablePermissions: RegistrationPermission[];
  connectionRoute: ConnectionRoute; runtime: RuntimeDeclaration;
  deliveryCapabilities: { persistentProcess: boolean; outboundHttps: boolean; sse: boolean; webhook: boolean; scheduledPolling: boolean; a2a: boolean };
  createdAt: string; expiresAt: string;
}
export interface ClaimAgent extends Agent { inboxId: string }
export type ClaimTarget = { kind: 'new_agent'; workspaceInboxId: string; name: string; localPart: string }
  | { kind: 'existing_agent'; agentId: string; replacesInstallationId: string | null };
export interface ClaimApproval { verificationCode: string; target: ClaimTarget; grantedPermissions: RegistrationPermission[]; policyProfile: 'default' }
export interface ApprovedClaim {
  registrationId: string; status: 'approved'; target: 'new_agent' | 'existing_agent'; workspaceName: string;
  agent: { id?: string; name: string; address: string }; effectivePermissions: RegistrationPermission[];
  policyProfile: 'default'; activationExpiresAt: string;
}
export interface RejectedClaim { registrationId: string; status: 'rejected' }
export interface OwnerClaim {
  registrationId: string; status: 'approved' | 'activated' | 'expired' | 'withdrawn';
  target: 'new_agent' | 'existing_agent'; agent: { id?: string; name: string; address: string };
  effectivePermissions: RegistrationPermission[]; approvedAt: string; activationExpiresAt: string;
  installationId: string | null; approvedByMe: boolean;
}
export interface Installation {
  id: string; agentId: string; connectionRoute: ConnectionRoute; deliveryMode: DeliveryMode;
  runtime: RuntimeDeclaration; status: 'active' | 'ended';
  endedReason: 'revoked' | 'replaced' | 'refresh_replay' | 'activation_replay' | null;
  legacy: boolean; createdAt: string; activatedAt: string; endedAt: string | null;
}
export interface OnboardingApi {
  lookup(code: string, signal?: AbortSignal): Promise<ClaimLookup>;
  approve(registrationId: string, body: ClaimApproval, signal?: AbortSignal): Promise<ApprovedClaim>;
  reject(registrationId: string, verificationCode: string, signal?: AbortSignal): Promise<RejectedClaim>;
  claims(signal?: AbortSignal): Promise<{ claims: OwnerClaim[] }>;
  withdraw(registrationId: string, signal?: AbortSignal): Promise<{ registrationId: string; status: 'withdrawn' }>;
  installations(inboxId: string, agentId: string, signal?: AbortSignal): Promise<{ agentId: string; installations: Installation[] }>;
  revoke(inboxId: string, agentId: string, installationId: string, signal?: AbortSignal): Promise<{ installation: Installation }>;
}
export function permissionLabel(permission: string) { return PERMISSION_LABELS[permission as RegistrationPermission] ?? 'Unrecognized permission'; }
export function canReconnectAgent(agent: Agent) { return agent.onboardingStatus === 'approved' && ['active', 'paused'].includes(agent.status); }
export function routeLabel(route: string) { return ({ local_helper: 'Local helper', authenticated_rest: 'Authenticated REST', remote_mcp_oauth: 'Remote MCP with OAuth', provider_connector: 'Provider connector' } as Record<string, string>)[route] ?? 'Unknown route'; }
export function deliveryLabel(mode: string) { return ({ envoi_link: 'Envoi Link', webhook: 'Webhook', provider: 'Provider', poll: 'Polling', on_demand: 'On demand', a2a: 'A2A' } as Record<string, string>)[mode] ?? 'Unknown delivery mode'; }
