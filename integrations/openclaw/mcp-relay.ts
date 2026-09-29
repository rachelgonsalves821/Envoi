import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { SinaloaConnector } from '../../sdk/typescript/src/connector';

const readTools = new Set([
  'sinaloa_agent_info', 'sinaloa_list_cases', 'sinaloa_read_case',
  'sinaloa_list_messages', 'sinaloa_list_assets', 'sinaloa_asset_download'
]);
const collaborationTools = new Set([
  'sinaloa_start_case', 'sinaloa_send_message',
  'sinaloa_send_proposal', 'sinaloa_send_decision'
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
  connector: SinaloaConnector;
  bearerToken: string;
  port?: number;
  allowCollaborationWrites?: boolean;
}

/** Local OpenClaw MCP endpoint; the Sinaloa refresh credential stays in the bridge store. */
export async function startOpenClawMcpRelay({ connector, bearerToken, port = 8788, allowCollaborationWrites = false }: McpRelayOptions) {
  if (typeof bearerToken !== 'string' || bearerToken.length < 32 || /[\r\n]/.test(bearerToken)) {
    throw new TypeError('A private MCP relay bearer token of at least 32 characters is required');
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new RangeError('Invalid MCP relay port');
  const secret = Buffer.from(bearerToken);
  const allowedTools = allowCollaborationWrites ? new Set([...readTools, ...collaborationTools]) : readTools;
  const server = createServer((req, res) => { void handle(req, res).catch(() => {
    if (res.headersSent) res.destroy();
    else send(res, 502, { error: 'Sinaloa MCP relay request failed' });
  }); });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const address = server.address();
    const expectedHost = address && typeof address === 'object' ? `127.0.0.1:${address.port}` : '';
    if (req.headers.host !== expectedHost || req.headers.origin) return send(res, 403, { error: 'MCP relay origin is unavailable' });
    if (req.url !== '/mcp') return send(res, 404, { error: 'Not found' });
    if (!authorized(req, secret)) {
      res.setHeader('www-authenticate', 'Bearer realm="Sinaloa local MCP relay"');
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
        if (typeof key !== 'string' || key.length < 1 || key.length > 200 || /[\x00-\x1f\x7f]/.test(key)) {
          return send(res, 400, { error: 'A stable idempotencyKey is required for collaboration writes' });
        }
      }
    }

    const protocolVersion = typeof req.headers['mcp-protocol-version'] === 'string' ? req.headers['mcp-protocol-version'] : undefined;
    const upstream = await connector.forwardMcpRequest(body, { protocolVersion });
    if (upstream.status === 202 || upstream.status === 204) {
      res.writeHead(upstream.status, { 'cache-control': 'no-store' });
      return res.end();
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length > maxResponseBytes) return send(res, 502, { error: 'Sinaloa MCP response is too large' });
    let output: Buffer = bytes;
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
      } catch { return send(res, 502, { error: 'Sinaloa MCP tool catalog is invalid' }); }
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
