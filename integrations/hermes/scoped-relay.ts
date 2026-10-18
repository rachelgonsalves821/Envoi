import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { bindScopedMcpTurn } from './scoped-mcp';
import { scopedMcpStdioSource } from './scoped-stdio';
import type { ScopedModelTurn } from '../agent-bridges/scoped-turn';

export async function startScopedMcpRelay(turn: ScopedModelTurn) {
  turn.signal.throwIfAborted();
  const binding = bindScopedMcpTurn(turn);
  const token = randomBytes(32).toString('hex');
  const secret = Buffer.from(token);
  let expectedHost = '';
  let closing: Promise<void> | null = null;
  const send = (res: ServerResponse, status: number, payload?: string) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(payload);
  };
  const server = createServer((req, res) => { void handle(req, res).catch(() => {
    if (res.headersSent) res.destroy(); else send(res, 502, JSON.stringify({ error: 'Scoped MCP request unavailable' }));
  }); });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.host !== expectedHost || req.headers.origin !== undefined) return send(res, 403);
    if (req.url !== '/mcp') return send(res, 404);
    const supplied = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!req.headers.authorization?.startsWith('Bearer ') || supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) return send(res, 401);
    if (!binding.active) return send(res, 410);
    if (req.method !== 'POST') return send(res, 405);
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415);
    if (Number(req.headers['content-length']) > 262144) { send(res, 413); req.resume(); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 262144) return send(res, 413);
      chunks.push(chunk);
    }
    const reply = await binding.dispatch(Buffer.concat(chunks).toString('utf8'));
    if (!binding.active) return send(res, 410);
    return reply === null ? send(res, 204) : send(res, 200, reply);
  }

  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) { binding.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') { binding.close(); server.close(); throw new Error('Private MCP relay unavailable'); }
  expectedHost = `127.0.0.1:${address.port}`;
  const url = `http://${expectedHost}/mcp`;
  const close = () => {
    binding.close();
    turn.signal.removeEventListener('abort', onAbort);
    if (!closing) closing = new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    return closing;
  };
  const onAbort = () => { void close(); };
  turn.signal.addEventListener('abort', onAbort, { once: true });
  if (turn.signal.aborted) { await close(); turn.signal.throwIfAborted(); }
  return Object.freeze({
    close,
    get active() { return binding.active; },
    get discovered() { return binding.discovered; },
    mcpServer: Object.freeze({ name: `envoi_turn_${randomBytes(8).toString('hex')}`, command: process.execPath,
      args: ['--input-type=module', '-e', scopedMcpStdioSource],
      env: [{ name: 'ENVOI_SCOPED_MCP_URL', value: url }, { name: 'ENVOI_SCOPED_MCP_TOKEN', value: token }] })
  });
}
