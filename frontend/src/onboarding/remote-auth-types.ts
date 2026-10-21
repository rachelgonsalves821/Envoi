import type { ClaimApproval, RegistrationPermission } from './types';

export type ConsentApproval = Omit<ClaimApproval, 'verificationCode'>;
export type ConsentStatus = 'pending_exchange' | 'completed' | 'expired' | 'withdrawn';
export interface ConsentDecided {
  status: ConsentStatus; registrationId: string; target: 'new_agent' | 'existing_agent'; workspaceName: string;
  agent: { id?: string; name: string; address: string }; effectivePermissions: RegistrationPermission[];
  policyProfile: 'default'; codeExpiresAt: string;
}
export type ConsentApproved = Omit<ConsentDecided, 'status'> & { redirectTo: string };
export interface ConsentView {
  client: { name: string; clientIdHost: string | null; redirectHost: string; loopbackRedirect: boolean;
    registration: 'metadata_document' | 'pre_registered'; provider?: string };
  connectionRoute: 'remote_mcp_oauth' | 'provider_connector';
  requestedPermissions: RegistrationPermission[]; grantablePermissions: RegistrationPermission[]; expiresAt: string;
  decision?: ConsentDecided | { status: 'denied' };
}
export type BootstrapRequest = ConsentApproval & { clientId: string };
export type BootstrapIssued = Omit<ConsentDecided, 'status' | 'codeExpiresAt'> & {
  bootstrapCode: string; expiresAt: string; clientName: string; provider: string;
};
/** Responses remain unknown until checked against the canonical static validators. */
export interface RemoteAuthApi {
  view(handle: string, signal?: AbortSignal): Promise<unknown>;
  approve(handle: string, body: ConsentApproval, signal?: AbortSignal): Promise<unknown>;
  deny(handle: string, signal?: AbortSignal): Promise<unknown>;
  withdraw(registrationId: string, signal?: AbortSignal): Promise<unknown>;
  bootstrap(body: BootstrapRequest, signal?: AbortSignal): Promise<unknown>;
}
