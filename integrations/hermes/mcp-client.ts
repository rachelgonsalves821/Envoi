import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { activateConnection } from '../connector/activation';
import { ConnectorSetupError } from '../connector/adapter';
import { readConnection } from '../connector/core';
import { privateDirectory } from '../connector/store';

/** Hermes starts this standard stdio MCP server itself. All Envoi requests go
 * through the single durable credential owner; no second process refreshes keys.
 */
export async function hermesMcpClient(stateDir: string) {
  const directory = await privateDirectory(stateDir);
  if ((await readConnection(directory)).runtime !== 'hermes') throw new ConnectorSetupError('STATE_MISMATCH', 'This MCP connection requires a saved Hermes identity.');
  const relay = JSON.parse(await readFile(directory + '/hermes-relay.json', 'utf8')) as { port: number; token: string };
  if (!Number.isSafeInteger(relay.port) || relay.port < 1 || relay.port > 65535 || !/^[a-f0-9]{64}$/.test(relay.token)) throw new ConnectorSetupError('STATE_INVALID', 'Saved Hermes relay configuration is invalid.');
  const origin = `http://127.0.0.1:${relay.port}/mcp`;
  const waitForRelay = async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const listening = await new Promise<boolean>(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port: relay.port });
        const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
        socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(500, () => done(false));
      });
      if (listening) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new ConnectorSetupError('BACKGROUND_NOT_READY', 'The saved Envoi relay did not become available.');
  };
  const forward = (body: string) => fetch(origin, { method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${relay.token}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(35_000) });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: { id?: unknown; method?: unknown };
    try {
      if (Buffer.byteLength(line) > 1_000_000) throw new Error();
      request = JSON.parse(line);
      if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.method !== 'string') throw new Error();
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid MCP request' } }) + '\n');
      continue;
    }
    try {
      await activateConnection(directory, 'hermes');
      await waitForRelay();
      let response: Response;
      try { response = await forward(line); }
      catch (error) {
        // Refused connections cannot have executed a write. Never replay an
        // ambiguous lost response, which could already have performed a send.
        if ((error as { cause?: { code?: string } }).cause?.code !== 'ECONNREFUSED') throw error;
        await activateConnection(directory, 'hermes');
        await waitForRelay();
        response = await forward(line);
      }
      if (response.status === 202 || response.status === 204) { await response.body?.cancel(); continue; }
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error();
      if (request.id !== undefined) process.stdout.write(JSON.stringify(payload) + '\n');
    } catch (error) {
      if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32000, message: error instanceof ConnectorSetupError ? error.message
          : 'Envoi connection is temporarily unavailable. Retry its saved connection; do not create another enrollment. If background startup failed, rerun setup with the saved state directory.' } }) + '\n');
    }
  }
}
