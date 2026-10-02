/** Versioned, short-lived handoff shared by the UI and runtime setup tools. */
export const CONNECTOR_RUNTIMES = ['openclaw', 'hermes', 'grok'] as const;
export type ConnectorRuntime = typeof CONNECTOR_RUNTIMES[number];
export interface QuickConnectHandoff {
  version: 1;
  runtime: ConnectorRuntime;
  apiUrl: string;
  enrollmentToken: string;
  expiresAt: string;
  agentName: string;
  address: string;
  operation?: 'enroll' | 'reconnect';
}

/** Only static, locally authored diagnostics; safe for a setup CLI to display. */
export class QuickConnectHandoffError extends TypeError {
  constructor(message: string) { super(message); this.name = 'QuickConnectHandoffError'; }
}

export function quickConnectOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new QuickConnectHandoffError('The Envoi URL must be an HTTPS origin'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new QuickConnectHandoffError('Envoi requires HTTPS; HTTP is supported only on loopback for development');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new QuickConnectHandoffError('The Envoi URL must be an origin without credentials, a path, or a query');
  }
  return url.origin;
}

/** Returns only the supported fields; setup files cannot supply executable commands or Gateway secrets. */
export function validateQuickConnectHandoff(value: unknown, options: { now?: number; allowExpired?: boolean } = {}): QuickConnectHandoff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QuickConnectHandoffError('Invalid Envoi setup file');
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || !CONNECTOR_RUNTIMES.includes(input.runtime as ConnectorRuntime)) throw new QuickConnectHandoffError('Unsupported Envoi setup version or runtime');
  if (input.operation !== undefined && !['enroll', 'reconnect'].includes(input.operation as string)) throw new QuickConnectHandoffError('Unsupported setup operation');
  if (typeof input.apiUrl !== 'string') throw new QuickConnectHandoffError('The setup file is missing the Envoi URL');
  const apiUrl = quickConnectOrigin(input.apiUrl);
  if (typeof input.enrollmentToken !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(input.enrollmentToken)) {
    throw new QuickConnectHandoffError('The setup file has an invalid one-time enrollment token');
  }
  if (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt))) throw new QuickConnectHandoffError('The setup file has an invalid expiry');
  if (!options.allowExpired && Date.parse(input.expiresAt) <= (options.now ?? Date.now())) {
    throw new QuickConnectHandoffError('This setup link expired. Create a new connection in Envoi and copy its setup prompt');
  }
  if (typeof input.agentName !== 'string' || !input.agentName.trim() || input.agentName.length > 200) throw new QuickConnectHandoffError('The setup file has an invalid agent name');
  if (typeof input.address !== 'string' || !/^[a-z][a-z0-9.-]{2,31}@[a-z0-9.-]+$/i.test(input.address) || input.address.length > 254) {
    throw new QuickConnectHandoffError('The setup file has an invalid Envoi address');
  }
  return { version: 1, runtime: input.runtime as ConnectorRuntime, apiUrl, enrollmentToken: input.enrollmentToken,
    expiresAt: input.expiresAt, agentName: input.agentName.trim(), address: input.address,
    ...(input.operation ? { operation: input.operation as 'enroll' | 'reconnect' } : {}) };
}
