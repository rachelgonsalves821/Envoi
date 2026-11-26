import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { EnvoiConnector } from '../../sdk/typescript/src/connector';
import { EnvoiError } from '../../sdk/typescript/src/index';

const readTools = new Set([
  'envoi_agent_info', 'envoi_list_cases', 'envoi_read_case', 'envoi_read_group_case',
  'envoi_list_messages', 'envoi_list_assets', 'envoi_asset_download'
]);
const collaborationTools = new Set([
  'envoi_start_case', 'envoi_send_message', 'envoi_start_group_case', 'envoi_send_group_message',
  'envoi_send_proposal', 'envoi_send_decision'
]);
const methods = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call']);
const maxRequestBytes = 1_000_000;
const maxResponseBytes = 4_000_000;

function send(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function authorized(req: IncomingMessage, secret: Buffer) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const candidate = Buffer.from(header.slice(7));
  return candidate.length === secret.length && timingSafeEqual(candidate, secret);
}

export interface McpRelayOptions {
  connector: EnvoiConnector;
  bearerToken: string;
  port?: number;
  allowCollaborationWrites?: boolean;
  /** Optional subset of collaboration tools; defaults to all for OpenClaw compatibility. */
  collaborationToolNames?: string[];
  /** Checked before forwarding a write, for example against a live work lease. */
  authorizeWrite?: (name: string, arguments_: Record<string, unknown>) => boolean | Promise<boolean>;
  /** Local diagnostic hook; invoked only after a successful upstream tool response. */
  onSuccessfulToolCall?: (name: string) => void;
  /** Metadata observation only; it never proves a tool was invoked. */
  onToolDiscovery?: (names: string[]) => void;
  /** Persist a completed native write before reporting success to the MCP client. */
  onSuccessfulWrite?: (name: string, arguments_: Record<string, unknown>) => Promise<void>;
}

/** Local MCP endpoint; the Envoi refresh credential stays in the bridge store. */
export async function startMcpRelay({ connector, bearerToken, port = 8788, allowCollaborationWrites = false, collaborationToolNames, authorizeWrite, onSuccessfulToolCall, onSuccessfulWrite, onToolDiscovery }: McpRelayOptions) {
  if (typeof bearerToken !== 'string' || bearerToken.length < 32 || /[\r\n]/.test(bearerToken)) {
    throw new TypeError('A private MCP relay bearer token of at least 32 characters is required');
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new RangeError('Invalid MCP relay port');
  const secret = Buffer.from(bearerToken);
  if (collaborationToolNames?.some(name => !collaborationTools.has(name))) throw new TypeError('Invalid collaboration tool allowlist');
  const allowedWrites = allowCollaborationWrites ? new Set(collaborationToolNames ?? collaborationTools) : new Set<string>();
  const allowedTools = new Set([...readTools, ...allowedWrites]);
  let contextKey: string | undefined;
  let initialization: { requestedVersion: string; result: Record<string, unknown> } | undefined;
  let catalog: Record<string, unknown> | undefined;
  let catalogRetryAt = 0;
  const invalidate = () => { initialization = undefined; catalog = undefined; catalogRetryAt = 0; };
  const discovered = (result: Record<string, unknown>) => {
    const names = Array.isArray(result.tools) ? result.tools.map(tool => (tool as { name: string }).name) : [];
    try { onToolDiscovery?.(names); } catch { /* Observation cannot grant readiness. */ }
  };
  const sendCatalog = (res: ServerResponse, id: unknown, result: Record<string, unknown>) => {
    discovered(result);
    return send(res, 200, { jsonrpc: '2.0', id, result });
  };
  const context = async () => {
    const key = JSON.stringify(await connector.mcpRelayContext());
    if (key !== contextKey) { invalidate(); contextKey = key; }
    return key;
  };
  const toolUnavailable = (res: ServerResponse, id: unknown) => send(res, 200, { jsonrpc: '2.0', id,
    result: { isError: true, content: [{ type: 'text', text: 'Envoi is temporarily unavailable. No execution success is confirmed. For a write, preserve its idempotencyKey and check its outcome before retrying.' }] } });
  const sendFailure = (res: ServerResponse, error: unknown) => {
    if (!(error instanceof EnvoiError)) return send(res, 502, { error: 'Envoi MCP relay request failed' });
    if (!['NETWORK_ERROR', 'TIMEOUT', 'REQUEST_CANCELLED'].includes(error.code ?? '')) invalidate();
    const code = error.code ?? 'AUTH_UNAVAILABLE';
    const status = error.status ?? (code === 'AGENT_PAUSED' || code === 'CONNECTOR_STOPPED' || code === 'REQUEST_CANCELLED' ? 409
      : ['CREDENTIAL_REVOKED', 'CREDENTIAL_EXPIRED', 'ROTATION_ID_REQUIRED', 'REFRESH_TOKEN_INVALID', 'REFRESH_REPLAY', 'REFRESH_RECOVERY_EXPIRED', 'ACCESS_TOKEN_EXPIRED', 'AUTHENTICATION_REQUIRED'].includes(code) ? 401
      : code === 'LEGACY_MODEL_ACCESS_DISABLED' ? 403 : 503);
    if (error.retryAfterSeconds) res.setHeader('retry-after', String(error.retryAfterSeconds));
    return send(res, status, { code, error: code, message: 'Envoi MCP is unavailable; preserve the saved connection and follow its status guidance.',
      requestId: error.requestId ?? randomUUID(), ...(error.reason ? { reason: error.reason } : {}),
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) });
  };
  const server = createServer((req, res) => { void handle(req, res).catch(error => {
    if (res.headersSent) res.destroy();
    else sendFailure(res, error);
  }); });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const address = server.address();
    const expectedHost = address && typeof address === 'object' ? `127.0.0.1:${address.port}` : '';
    if (req.headers.host !== expectedHost || req.headers.origin) return send(res, 403, { error: 'MCP relay origin is unavailable' });
    if (req.url !== '/mcp') return send(res, 404, { error: 'Not found' });
    if (!authorized(req, secret)) {
      res.setHeader('www-authenticate', 'Bearer realm="Envoi local MCP relay"');
      return send(res, 401, { error: 'MCP relay credential required' });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Only POST is supported' });
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'JSON is required' });

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxRequestBytes) return send(res, 413, { error: 'MCP request is too large' });
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    let request: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      request = parsed as Record<string, unknown>;
    } catch { return send(res, 400, { error: 'Invalid MCP JSON-RPC request' }); }
    if (typeof request.method !== 'string' || !methods.has(request.method)) return send(res, 403, { error: 'MCP method is not available' });
    if (request.method === 'tools/call') {
      const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params)
        ? request.params as Record<string, unknown> : null;
      if (!params || typeof params.name !== 'string' || !allowedTools.has(params.name)) {
        return send(res, 403, { error: 'MCP tool is not available through this relay' });
      }
      if (collaborationTools.has(params.name)) {
        const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? params.arguments as Record<string, unknown> : null;
        const key = args?.idempotencyKey;
        if (!args || typeof key !== 'string' || key.length < 1 || key.length > 200 || /[\x00-\x1f\x7f]/.test(key)) {
          return send(res, 400, { error: 'A stable idempotencyKey is required for collaboration writes' });
        }
        if (authorizeWrite && !await authorizeWrite(params.name, args)) {
          return send(res, 403, { error: 'MCP write is unavailable outside active work' });
        }
      }
    }

    const protocolVersion = typeof req.headers['mcp-protocol-version'] === 'string' ? req.headers['mcp-protocol-version'] : undefined;
    if (protocolVersion && !/^\d{4}-\d{2}-\d{2}$/.test(protocolVersion)) return send(res, 400, { error: 'Invalid MCP protocol version' });
    let key: string | undefined;
    let upstream: Response;
    const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params as Record<string, unknown> : {};
    const hasId = typeof request.id === 'string' || typeof request.id === 'number' && Number.isSafeInteger(request.id);
    const validParams = request.params === undefined || request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params);
    const cachedCatalogAvailable = () => request.jsonrpc === '2.0' && request.method === 'tools/list' && hasId
      && validParams && initialization && catalog && Object.keys(params).length === 0
      && (!protocolVersion || protocolVersion === initialization.result.protocolVersion);
    try {
      key = await context();
      const compatible = initialization && (!protocolVersion || protocolVersion === initialization.result.protocolVersion);
      if (request.jsonrpc === '2.0' && validParams && compatible) {
        if (request.method === 'initialize' && hasId && params.protocolVersion === initialization!.requestedVersion)
          return send(res, 200, { jsonrpc: '2.0', id: request.id, result: initialization!.result });
        if (request.method === 'ping' && hasId) return send(res, 200, { jsonrpc: '2.0', id: request.id, result: {} });
        if (request.method === 'notifications/initialized' && !('id' in request)) { res.writeHead(202, { 'cache-control': 'no-store' }); return res.end(); }
        if (cachedCatalogAvailable() && Date.now() < catalogRetryAt)
          return sendCatalog(res, request.id, catalog!);
      }
      upstream = await connector.forwardMcpRequest(body, { protocolVersion, preserveErrorResponse: true,
        ...(cachedCatalogAvailable() ? { signal: AbortSignal.timeout(5_000) } : {}) });
    } catch (error) {
      if (!(error instanceof EnvoiError)) throw error;
      if (['NETWORK_ERROR', 'TIMEOUT'].includes(error.code ?? '')) await context();
      if (['NETWORK_ERROR', 'TIMEOUT'].includes(error.code ?? '') && cachedCatalogAvailable() && await context() === key) {
        catalogRetryAt = Date.now() + 60_000;
        return sendCatalog(res, request.id, catalog!);
      }
      if (request.method === 'tools/call' && hasId && ['NETWORK_ERROR', 'TIMEOUT'].includes(error.code ?? ''))
        return toolUnavailable(res, request.id);
      return sendFailure(res, error);
    }
    if (!upstream.ok) {
      if ([401, 403, 409].includes(upstream.status)) invalidate();
      if (upstream.status >= 500 && cachedCatalogAvailable() && await context() === key) {
        catalogRetryAt = Date.now() + 60_000;
        return sendCatalog(res, request.id, catalog!);
      }
      if (upstream.status >= 500 && request.method === 'tools/call' && hasId) return toolUnavailable(res, request.id);
      const retryAfter = upstream.headers.get('retry-after');
      if (retryAfter) res.setHeader('retry-after', retryAfter);
    }
    if (upstream.status === 202 || upstream.status === 204) {
      res.writeHead(upstream.status, { 'cache-control': 'no-store' });
      return res.end();
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length > maxResponseBytes) return send(res, 502, { error: 'Envoi MCP response is too large' });
    let output: Buffer = bytes;
    if (upstream.ok && request.method === 'initialize' && request.jsonrpc === '2.0' && hasId) {
      invalidate();
      try {
        const payload = JSON.parse(bytes.toString('utf8'));
        const result = payload?.result;
        if (!payload.error && payload.jsonrpc === '2.0' && payload.id === request.id && result
          && typeof params.protocolVersion === 'string' && typeof result.protocolVersion === 'string'
          && /^\d{4}-\d{2}-\d{2}$/.test(result.protocolVersion) && result.capabilities && typeof result.capabilities === 'object' && !Array.isArray(result.capabilities)
          && result.serverInfo && typeof result.serverInfo.name === 'string' && typeof result.serverInfo.version === 'string'
          && await context() === key) initialization = { requestedVersion: params.protocolVersion, result };
      } catch { /* An unproven handshake is never cached. Preserve the upstream response. */ }
    }
    if (upstream.ok && request.method === 'tools/list') {
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(bytes.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        payload = parsed as Record<string, unknown>;
        const result = payload.result as Record<string, unknown> | undefined;
        if (!Array.isArray(result?.tools)) throw new Error();
        output = Buffer.from(JSON.stringify({ ...payload, result: { ...result, tools: result.tools.filter(
          tool => tool && typeof tool === 'object' && allowedTools.has((tool as Record<string, unknown>).name as string)
        ) } }));
        if (payload.jsonrpc === '2.0' && payload.id === request.id && !payload.error)
          discovered((JSON.parse(output.toString('utf8')) as { result: Record<string, unknown> }).result);
        if (initialization && payload.jsonrpc === '2.0' && payload.id === request.id && !payload.error
          && Object.keys(params).length === 0 && !result.nextCursor
          && (!protocolVersion || protocolVersion === initialization.result.protocolVersion) && await context() === key)
          { catalog = (JSON.parse(output.toString('utf8')) as { result: Record<string, unknown> }).result;
            catalogRetryAt = Date.now() + 60_000; }
      } catch { return send(res, 502, { error: 'Envoi MCP tool catalog is invalid' }); }
    }
    if (upstream.ok && request.method === 'tools/call' && (onSuccessfulToolCall || onSuccessfulWrite)) {
      let payload: Record<string, unknown> | null = null;
      try {
        payload = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      } catch { /* Invalid upstream JSON remains visible to the MCP client. */ }
      const result = payload?.result as Record<string, unknown> | undefined;
      if (payload && !payload.error && result?.isError !== true && Array.isArray(result?.content) && result.content.length > 0) {
        const params = request.params as Record<string, unknown>;
        const name = params.name as string;
        if (collaborationTools.has(name) && onSuccessfulWrite) {
          try {
            const content = result.content[0] as Record<string, unknown>;
            const value = typeof content?.text === 'string' ? JSON.parse(content.text) as Record<string, unknown> : null;
            if (typeof value?.status === 'number' && value.status >= 200 && value.status < 300) {
              await onSuccessfulWrite(name, params.arguments as Record<string, unknown>);
            }
          } catch { return send(res, 502, { error: 'Envoi MCP write could not be recorded' }); }
        }
        try { onSuccessfulToolCall?.(name); } catch { /* Diagnostics do not alter the MCP result. */ }
      }
    }
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
    res.end(output);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MCP relay did not bind to loopback');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}
