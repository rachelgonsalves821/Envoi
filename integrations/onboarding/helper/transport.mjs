export class ProtocolError extends Error {
  constructor(code, status = 0, body = {}, retryAfter = 0) {
    super('Envoi protocol operation did not complete');
    this.code = code; this.status = status;
    this.reason = typeof body.reason === 'string' ? body.reason : undefined;
    this.retryAfterSeconds = Math.max(0, Number(body.retryAfterSeconds) || 0, Number(retryAfter) || 0);
  }
}

export function validateOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('INVALID_ORIGIN');
  return url.origin;
}

export function createTransport(origin, fetcher = globalThis.fetch) {
  return async (method, path, { token, body } = {}) => {
    let response;
    try {
      response = await fetcher(`${origin}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new ProtocolError('NETWORK_ERROR'); }
    let text;
    try { text = await response.text(); } catch { throw new ProtocolError('NETWORK_ERROR'); }
    if (text.length > 128_000) throw new ProtocolError('INVALID_RESPONSE');
    let payload;
    try { payload = JSON.parse(text); } catch { throw new ProtocolError(response.status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'INVALID_RESPONSE', response.status); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ProtocolError('INVALID_RESPONSE', response.status);
    if (!response.ok) throw new ProtocolError(typeof payload.code === 'string' ? payload.code : response.status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'INVALID_RESPONSE', response.status, payload, response.headers.get('retry-after'));
    return payload;
  };
}

export function offered(snapshot, route = 'local_helper') {
  if (!['local_helper', 'authenticated_rest'].includes(route)) throw new ProtocolError('INVALID_RESPONSE');
  if (snapshot?.contract?.id !== 'agent-registration' || snapshot.contract.version !== 1
    || typeof snapshot.registrationEnabled !== 'boolean' || typeof snapshot.installationsEnabled !== 'boolean'
    || !Array.isArray(snapshot.routes) || !Array.isArray(snapshot.deliveryModes)) throw new ProtocolError('INVALID_RESPONSE');
  const routes = ['local_helper', 'authenticated_rest', 'remote_mcp_oauth', 'provider_connector'];
  const modes = ['provider', 'webhook', 'envoi_link', 'poll', 'on_demand', 'a2a'];
  for (const [items, key, expected] of [[snapshot.routes, 'connectionRoute', routes], [snapshot.deliveryModes, 'deliveryMode', modes]]) {
    if (items.length !== expected.length || new Set(items.map(item => item?.[key])).size !== expected.length
      || items.some(item => !expected.includes(item?.[key]) || typeof item.available !== 'boolean')) throw new ProtocolError('INVALID_RESPONSE');
  }
  const enabled = snapshot.registrationEnabled && snapshot.installationsEnabled;
  if (snapshot.routes.some(item => item.available && (!enabled || ['remote_mcp_oauth', 'provider_connector'].includes(item.connectionRoute)))
    || snapshot.deliveryModes.some(item => item.available && (!enabled || item.deliveryMode !== 'envoi_link'))) throw new ProtocolError('INVALID_RESPONSE');
  return enabled && snapshot.routes.find(item => item.connectionRoute === route)?.available === true
    && snapshot.deliveryModes.find(item => item.deliveryMode === 'envoi_link')?.available === true;
}
