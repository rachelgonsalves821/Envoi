import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { privateJson } from './store';
import { ConnectorSetupError } from './adapter';

export async function startControl(directory: string, identity: { runtime: string; address: string }, stop: () => void,
  diagnostics: () => Record<string, unknown> = () => ({ status: 'running' })) {
  const secret = randomBytes(32).toString('base64url');
  const startedAt = new Date().toISOString();
  const filename = path.join(directory, 'control.json');
  const server = createServer((req, res) => {
    const address = server.address();
    const expected = address && typeof address === 'object' ? `127.0.0.1:${address.port}` : '';
    const supplied = Buffer.from(req.headers.authorization || '');
    const token = Buffer.from(`Bearer ${secret}`);
    if (req.headers.host !== expected || req.headers.origin || supplied.length !== token.length || !timingSafeEqual(supplied, token)) {
      res.writeHead(403); res.end(); return;
    }
    if (req.method === 'GET' && (req.url === '/status' || req.url === '/doctor')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...identity, pid: process.pid, startedAt, ...diagnostics() })); return;
    }
    if (req.method === 'POST' && req.url === '/stop') { res.writeHead(202); res.end('{}'); stop(); return; }
    res.writeHead(404); res.end();
  });
  server.requestTimeout = 5_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Control listener unavailable');
  try { await privateJson(filename, { version: 1, port: address.port, secret }); }
  catch (error) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  return { close: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    const current = await readFile(filename, 'utf8').then(text => JSON.parse(text)).catch(() => null);
    if (current?.secret === secret) await rm(filename, { force: true });
  } };
}
export async function queryControl(directory: string, action: 'status' | 'stop' | 'doctor') {
  const filename = path.join(directory, 'control.json');
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) throw new ConnectorSetupError('CONTROL_INVALID', 'Invalid connector control file');
  let record: { version: number; port: number; secret: string };
  try { record = JSON.parse(await readFile(filename, 'utf8')); }
  catch { throw new ConnectorSetupError('CONTROL_INVALID', 'Invalid connector control file'); }
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== 1 || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || typeof record.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.secret)) throw new ConnectorSetupError('CONTROL_INVALID', 'Invalid connector control file');
  // The control origin is always local and never accepted from a stored URL.
  const response = await fetch(`http://127.0.0.1:${record.port}/${action}`, {
    method: action === 'stop' ? 'POST' : 'GET', redirect: 'error',
    headers: { authorization: `Bearer ${record.secret}` }, signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new ConnectorSetupError('CONNECTOR_UNREACHABLE', 'The connector is not responding to local management');
  return await response.json() as Record<string, unknown>;
}
