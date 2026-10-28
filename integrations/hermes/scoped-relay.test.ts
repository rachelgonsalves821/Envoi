import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer, request as httpRequest } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ScopedModelTurn } from '../agent-bridges/scoped-turn';
import { startScopedMcpRelay } from './scoped-relay';

function turn(label = 'one') {
  const controller = new AbortController();
  const effect = vi.fn(async () => ({ messageRef: `message_${label}` }));
  const model = { instruction: 'Scoped', context: { agentAddress: `${label}@example.com` }, snapshot: {},
    tools: [{ name: 'envoi_case_reply', inputSchema: { type: 'object' } }], signal: controller.signal, callTool: effect } as unknown as ScopedModelTurn;
  return { model, controller, effect };
}

function shim(server: Awaited<ReturnType<typeof startScopedMcpRelay>>['mcpServer'], overrides: Record<string, string> = {}) {
  const env = { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...Object.fromEntries(server.env.map(item => [item.name, item.value])), ...overrides };
  const child = spawn(server.command, server.args, { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: string[] = [];
  const waiting: Array<{ resolve(value: any): void; reject(error: Error): void }> = [];
  let stderr = '';
  const reader = createInterface({ input: child.stdout });
  reader.on('line', line => {
    const receiver = waiting.shift();
    if (!receiver) lines.push(line); else {
      try { receiver.resolve(JSON.parse(line)); } catch { receiver.reject(new Error('Invalid shim output')); }
    }
  });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { waiting.splice(0).forEach(item => item.reject(new Error('Shim closed'))); resolve(code); });
  });
  const notify = (request: unknown) => { child.stdin.write(JSON.stringify(request) + '\n'); };
  const rpc = (method: string, params?: unknown, id = 1) => {
    const response = new Promise<any>((resolve, reject) => {
      if (lines.length) resolve(JSON.parse(lines.shift()!)); else waiting.push({ resolve, reject });
    });
    notify({ jsonrpc: '2.0', id, method, params }); return response;
  };
  const initialize = async () => {
    const response = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return response;
  };
  return { child, rpc, notify, initialize, exited, stderr: () => stderr,
    async close() { child.stdin.end(); await exited; reader.close(); } };
}

const reply = (idempotencyKey = 'one') => ({ name: 'envoi_case_reply', arguments: { text: 'Hello', idempotencyKey } });
function connection(relay: Awaited<ReturnType<typeof startScopedMcpRelay>>) {
  const values = Object.fromEntries(relay.mcpServer.env.map(item => [item.name, item.value]));
  return { url: values.ENVOI_SCOPED_MCP_URL, token: values.ENVOI_SCOPED_MCP_TOKEN,
    headers: { authorization: `Bearer ${values.ENVOI_SCOPED_MCP_TOKEN}`, 'content-type': 'application/json' } };
}

describe('private Hermes stdio transport (Node fixtures, not Hermes)', () => {
  it('allows Hermes to reconnect its stdio server between discovery and execution', async () => {
    const source = turn(); const relay = await startScopedMcpRelay(source.model);
    const discovery = shim(relay.mcpServer);
    let execution: ReturnType<typeof shim> | undefined;
    try {
      expect((await discovery.initialize()).error).toBeUndefined();
      expect((await discovery.rpc('tools/list')).result.tools).toEqual(source.model.tools);
      await discovery.close();
      execution = shim(relay.mcpServer);
      expect((await execution.initialize()).error).toBeUndefined();
      expect((await execution.rpc('tools/list')).result.tools).toEqual(source.model.tools);
      expect((await execution.rpc('tools/call', reply())).result.isError).toBe(false);
      expect(source.effect).toHaveBeenCalledTimes(1);
      const duplicate = await execution.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
      expect(duplicate.error.code).toBe(-32602);
    } finally { await discovery.close(); await execution?.close(); await relay.close(); }
  });

  it('requires each new stdio transport to initialize before invoking the turn tools', async () => {
    const source = turn(); const relay = await startScopedMcpRelay(source.model);
    const first = shim(relay.mcpServer), second = shim(relay.mcpServer);
    try {
      await first.initialize();
      expect((await second.rpc('tools/call', reply())).error.code).toBe(-32000);
      expect(source.effect).not.toHaveBeenCalled();
      expect((await second.initialize()).error).toBeUndefined();
      expect((await second.rpc('tools/call', reply())).result.isError).toBe(false);
      expect(source.effect).toHaveBeenCalledTimes(1);
    } finally { await Promise.all([first.close(), second.close(), relay.close()]); }
  });

  it('keeps one serialized, bounded call queue across transports', async () => {
    const source = turn(); const relay = await startScopedMcpRelay(source.model); const local = connection(relay);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    source.effect.mockImplementation(async () => { await blocked; return { messageRef: 'shared' }; });
    const post = async (client: string, request: unknown) => {
      const response = await fetch(local.url, { method: 'POST', headers: { ...local.headers, 'x-envoi-mcp-connection': client }, body: JSON.stringify(request) });
      return response.status === 204 ? null : response.json() as Promise<any>;
    };
    const clients = ['1'.repeat(32), '2'.repeat(32)];
    try {
      for (const client of clients) {
        await post(client, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
        await post(client, { jsonrpc: '2.0', method: 'notifications/initialized' });
      }
      const responses = Array.from({ length: 17 }, (_, index) => post(clients[index % 2], { jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: reply(String(index)) }));
      const busy = await Promise.race(responses);
      expect(busy.result.isError).toBe(true);
      expect(JSON.parse(busy.result.content[0].text).code).toBe('TOOL_BUSY');
      expect(source.effect).toHaveBeenCalledTimes(1);
      release();
      const all = await Promise.all(responses);
      expect(all.filter(result => result.result.isError)).toHaveLength(1);
      expect(source.effect).toHaveBeenCalledTimes(16);
    } finally { release?.(); await relay.close(); }
  });

  it('bounds authenticated transport identities and rejects a missing or malformed identity', async () => {
    const source = turn(); const relay = await startScopedMcpRelay(source.model); const local = connection(relay);
    const post = (client?: string) => fetch(local.url, { method: 'POST', headers: { ...local.headers, ...(client === undefined ? {} : { 'x-envoi-mcp-connection': client }) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    try {
      expect((await post()).status).toBe(400);
      expect((await post('invalid')).status).toBe(400);
      for (let index = 0; index < 32; index++) {
        const response = await post(index.toString(16).padStart(32, '0')); expect(response.status).toBe(200); await response.body?.cancel();
      }
      expect((await post('f'.repeat(32))).status).toBe(429);
      expect(source.effect).not.toHaveBeenCalled();
    } finally { await relay.close(); }
  });

  it('stops queued calls on every transport immediately when one tool loses authority', async () => {
    const source = turn(); const relay = await startScopedMcpRelay(source.model); const local = connection(relay);
    let reject!: (error: Error) => void;
    source.effect.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const post = async (client: string, request: unknown) => {
      const response = await fetch(local.url, { method: 'POST', headers: { ...local.headers, 'x-envoi-mcp-connection': client }, body: JSON.stringify(request) });
      await response.body?.cancel(); return response.status;
    };
    const clients = ['1'.repeat(32), '2'.repeat(32)];
    try {
      for (const client of clients) {
        await post(client, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
        await post(client, { jsonrpc: '2.0', method: 'notifications/initialized' });
      }
      const first = post(clients[0], { jsonrpc: '2.0', id: 2, method: 'tools/call', params: reply('first') });
      await vi.waitFor(() => expect(source.effect).toHaveBeenCalledTimes(1));
      const second = post(clients[1], { jsonrpc: '2.0', id: 3, method: 'tools/call', params: reply('second') });
      reject(new Error('Authority lost'));
      expect(await first).toBe(410); expect(await second).toBe(410);
      expect(source.effect).toHaveBeenCalledTimes(1); expect(relay.active).toBe(false);
    } finally { reject?.(new Error('Cleanup')); await relay.close(); }
  });

  it('runs the actual standalone shim through initialization, discovery and one bound tool call', async () => {
    const source = turn(); const relay = await startScopedMcpRelay(source.model); const client = shim(relay.mcpServer);
    try {
      expect(relay.mcpServer.command).toBe(process.execPath);
      expect(relay.mcpServer.args.join(' ')).not.toContain(connection(relay).token);
      await client.initialize(); expect(relay.discovered).toBe(false);
      const catalog = await client.rpc('tools/list');
      expect(catalog.result.tools).toEqual(source.model.tools); expect(relay.discovered).toBe(true);
      const output = await client.rpc('tools/call', reply());
      expect(JSON.parse(output.result.content[0].text)).toEqual({ ok: true, tool: 'envoi_case_reply', result: { messageRef: 'message_one' } });
      expect(source.effect).toHaveBeenCalledExactlyOnceWith('envoi_case_reply', reply().arguments);
      expect(JSON.stringify(output)).not.toMatch(/ENVOI_SCOPED_MCP|leaseToken|agentAddress/);
      expect(JSON.stringify(output)).not.toContain(connection(relay).token);
      expect(client.stderr()).toBe('');
    } finally { await client.close(); await relay.close(); }
  });

  it('isolates two capabilities and keeps old callbacks permanently disconnected from the replacement', async () => {
    const first = turn('first'), second = turn('second');
    const left = await startScopedMcpRelay(first.model), right = await startScopedMcpRelay(second.model);
    const leftClient = shim(left.mcpServer), rightClient = shim(right.mcpServer);
    try {
      const leftConnection = connection(left), rightConnection = connection(right);
      expect(leftConnection.token).not.toBe(rightConnection.token);
      expect((await fetch(leftConnection.url, { method: 'POST', headers: rightConnection.headers, body: '{}' })).status).toBe(401);
      await Promise.all([leftClient.initialize(), rightClient.initialize()]);
      const [leftReply, rightReply] = await Promise.all([leftClient.rpc('tools/call', reply('first')), rightClient.rpc('tools/call', reply('second'))]);
      expect(JSON.stringify(leftReply)).toContain('message_first'); expect(JSON.stringify(rightReply)).toContain('message_second');
      await left.close();
      await rightClient.rpc('tools/call', reply('next'));
      expect(first.effect).toHaveBeenCalledTimes(1); expect(second.effect).toHaveBeenCalledTimes(2);
    } finally { await Promise.all([leftClient.close(), rightClient.close(), left.close(), right.close()]); }
  });

  it.each([
    [{ authorization: 'Bearer wrong' }, 401], [{ origin: 'https://attacker.example' }, 403],
    [{ 'content-type': 'text/plain' }, 415]
  ] as const)('rejects unauthenticated or browser-origin request headers %j', async (headers, status) => {
    const source = turn(); const relay = await startScopedMcpRelay(source.model); const local = connection(relay);
    try {
      const result = await fetch(local.url, { method: 'POST', headers: { ...local.headers, ...headers }, body: '{}' });
      expect(result.status).toBe(status); expect(source.effect).not.toHaveBeenCalled();
    } finally { await relay.close(); }
  });

  it('rejects a forged Host header on the actual HTTP wire', async () => {
    const source = turn(); const relay = await startScopedMcpRelay(source.model); const local = connection(relay);
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(local.url, { method: 'POST', headers: { ...local.headers, host: 'attacker.example' } }, response => {
          response.resume(); response.once('end', () => resolve(response.statusCode));
        });
        request.once('error', reject); request.end('{}');
      });
      expect(status).toBe(403); expect(source.effect).not.toHaveBeenCalled();
    } finally { await relay.close(); }
  });

  it('rejects other paths, methods and oversized declared bodies before dispatch', async () => {
    const source = turn(); const relay = await startScopedMcpRelay(source.model); const local = connection(relay);
    try {
      expect((await fetch(local.url + '/other', { method: 'POST', headers: local.headers, body: '{}' })).status).toBe(404);
      expect((await fetch(local.url, { headers: local.headers })).status).toBe(405);
      expect((await fetch(local.url, { method: 'POST', headers: local.headers, body: ' '.repeat(262145) })).status).toBe(413);
      expect(source.effect).not.toHaveBeenCalled();
    } finally { await relay.close(); }
  });

  it('rejects unterminated oversized stdio input without reflecting private configuration', async () => {
    const source = turn(); const relay = await startScopedMcpRelay(source.model); const client = shim(relay.mcpServer);
    try {
      client.child.stdin.end(' '.repeat(262145));
      expect(await client.exited).toBe(1);
      expect(client.stderr()).toBe('Scoped MCP transport unavailable\n');
      expect(client.stderr()).not.toContain(connection(relay).token);
      expect(source.effect).not.toHaveBeenCalled();
    } finally { await client.close(); await relay.close(); }
  });

  it.each(['http://localhost:1234/mcp', 'https://127.0.0.1:1234/mcp', 'http://127.0.0.1:1234/mcp?secret=hidden'])('refuses unsupported shim destination %s before connecting', async url => {
    const source = turn(); const relay = await startScopedMcpRelay(source.model); const client = shim(relay.mcpServer, { ENVOI_SCOPED_MCP_URL: url });
    try {
      client.child.stdin.end(); expect(await client.exited).toBe(1);
      expect(client.stderr()).toBe('Scoped MCP transport unavailable\n'); expect(source.effect).not.toHaveBeenCalled();
    } finally { await client.close(); await relay.close(); }
  });

  it('suppresses in-flight late results on scope loss and never starts an already-aborted turn', async () => {
    const source = turn(); const relay = await startScopedMcpRelay(source.model); const client = shim(relay.mcpServer);
    let release!: () => void;
    try {
      await client.initialize();
      source.effect.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return { messageRef: 'late_private' }; });
      const operation = client.rpc('tools/call', reply());
      const refused = expect(operation).rejects.toThrow('Shim closed');
      await vi.waitFor(() => expect(source.effect).toHaveBeenCalledTimes(1));
      source.controller.abort(); await refused;
      release(); expect(relay.active).toBe(false);
      await expect(startScopedMcpRelay(source.model)).rejects.toThrow();
      expect(client.stderr()).not.toContain('late_private');
    } finally { release?.(); await client.close(); await relay.close(); }
  });

  it.each(['redirect', 'oversized', 'invalid-json'] as const)('fails closed on a %s relay response', async mode => {
    const source = turn(); const relay = await startScopedMcpRelay(source.model);
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      request.resume();
      if (mode === 'redirect') {
        response.writeHead(307, { location: '/redirect-target' }); response.end();
      } else if (mode === 'oversized') {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(' '.repeat(1000001));
      } else {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('private-malformed-response');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const client = shim(relay.mcpServer, { ENVOI_SCOPED_MCP_URL: `http://127.0.0.1:${address.port}/mcp` });
    const output: string[] = [];
    client.child.stdout.on('data', chunk => output.push(String(chunk)));
    try {
      client.notify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      expect(await client.exited).toBe(1);
      expect(requests).toBe(1);
      expect(output.join('')).toBe('');
      expect(client.stderr()).toBe('Scoped MCP transport unavailable\n');
      expect(source.effect).not.toHaveBeenCalled();
    } finally {
      await client.close(); await relay.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  });
});
