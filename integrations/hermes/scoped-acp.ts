import type { Readable, Writable } from 'node:stream';
import type { startScopedMcpRelay } from './scoped-relay';

type McpServer = Awaited<ReturnType<typeof startScopedMcpRelay>>['mcpServer'];
type Pending = { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function scopedAcpTransport(streams: { input: Writable; output: Readable }, options: {
  sessionId: string;
  timeoutMs?: number;
  onUpdate?: (update: Record<string, unknown>) => void;
}) {
  if (!options.sessionId || options.sessionId.length > 1024) throw new Error('Invalid ACP session');
  const sessionId = options.sessionId;
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000) throw new Error('Invalid ACP timeout');
  const pending = new Map<number, Pending>();
  let nextId = 0, buffered = '', total = 0, queuedBytes = 0;
  let active = true, initialized = false, loaded = false, prompting = false;
  let initializing = false, loading = false;
  const unavailable = () => new Error('Scoped ACP transport unavailable');
  const close = () => {
    if (!active) return;
    active = false;
    for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(unavailable()); }
    pending.clear(); buffered = '';
    streams.input.destroy(); streams.output.destroy();
  };
  streams.input.on('error', close);
  streams.input.on('close', close);
  streams.input.on('finish', close);
  streams.output.on('error', close);
  streams.output.on('end', close);
  streams.output.on('close', close);
  const write = (message: unknown) => {
    if (!active) throw unavailable();
    const frame = JSON.stringify(message) + '\n';
    const bytes = Buffer.byteLength(frame);
    if (bytes > 1000000 || queuedBytes + bytes > 1000000) { close(); throw unavailable(); }
    queuedBytes += bytes;
    streams.input.write(frame, error => { queuedBytes -= bytes; if (error) close(); });
  };
  const request = (method: string, params: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
    if (!active || pending.size >= 4) { reject(unavailable()); return; }
    const id = ++nextId;
    const timer = setTimeout(close, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { write({ jsonrpc: '2.0', id, method, params }); } catch { close(); }
  });
  const receive = (frame: string) => {
    const message: unknown = JSON.parse(frame);
    if (!object(message) || message.jsonrpc !== '2.0') throw unavailable();
    if (typeof message.method === 'string') {
      if ('result' in message || 'error' in message) throw unavailable();
      if ('id' in message) {
        if (!(typeof message.id === 'string' || Number.isSafeInteger(message.id))) throw unavailable();
        if (message.method === 'session/request_permission') {
          const params = message.params;
          if ((!loaded && !loading) || !object(params) || params.sessionId !== sessionId || !Array.isArray(params.options)) throw unavailable();
          const rejection = params.options.find(option => object(option) && typeof option.optionId === 'string' && option.kind === 'reject_once');
          write({ jsonrpc: '2.0', id: message.id, result: { outcome: rejection
            ? { outcome: 'selected', optionId: rejection.optionId } : { outcome: 'cancelled' } } });
        } else {
          write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client capability unavailable' } });
        }
      } else if (message.method === 'session/update') {
        const params = message.params;
        if ((!loaded && !loading) || !object(params) || params.sessionId !== sessionId || !object(params.update)) throw unavailable();
        options.onUpdate?.(structuredClone(params.update));
      }
      return;
    }
    if (!Number.isSafeInteger(message.id) || typeof message.id !== 'number') throw unavailable();
    const operation = pending.get(message.id);
    if (!operation || ('result' in message) === ('error' in message)) throw unavailable();
    if ('error' in message || !object(message.result)) { close(); return; }
    pending.delete(message.id); clearTimeout(operation.timer);
    operation.resolve(message.result);
  };
  streams.output.setEncoding('utf8');
  streams.output.on('data', (chunk: string) => {
    if (!active) return;
    try {
      total += Buffer.byteLength(chunk);
      if (total > 16000000) throw unavailable();
      buffered += chunk;
      let newline: number;
      while (active && (newline = buffered.indexOf('\n')) !== -1) {
        const frame = buffered.slice(0, newline).replace(/\r$/, '');
        buffered = buffered.slice(newline + 1);
        if (Buffer.byteLength(frame) > 1000000) throw unavailable();
        if (frame.trim()) receive(frame);
      }
      if (Buffer.byteLength(buffered) > 1000000) throw unavailable();
    } catch { close(); }
  });
  if (streams.input.destroyed || streams.input.writableEnded || streams.output.destroyed || streams.output.readableEnded) close();
  return Object.freeze({
    close,
    get active() { return active; },
    async initialize() {
      if (!active || initialized || initializing) throw unavailable();
      initializing = true;
      try {
        const result = await request('initialize', { protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'envoi-scoped-host', version: '1' } });
        if (!active || result.protocolVersion !== 1 || !object(result.agentInfo) || result.agentInfo.name !== 'hermes-agent'
          || !object(result.agentCapabilities) || result.agentCapabilities.loadSession !== true) throw unavailable();
        initialized = true;
        return result;
      } catch { close(); throw unavailable(); } finally { initializing = false; }
    },
    async load(cwd: string, mcpServers: readonly McpServer[]) {
      if (!active || !initialized || loaded || loading || !cwd || mcpServers.length !== 1) throw unavailable();
      loading = true;
      try {
        const result = await request('session/load', { sessionId, cwd, mcpServers: structuredClone(mcpServers) });
        if (!active) throw unavailable();
        loaded = true;
        return result;
      } catch { close(); throw unavailable(); } finally { loading = false; }
    },
    async prompt(text: string) {
      if (!active || !loaded || prompting || !text || Buffer.byteLength(text) > 262144) throw unavailable();
      prompting = true;
      try {
        const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
        if (!active || typeof result.stopReason !== 'string') throw unavailable();
        return result;
      } catch { close(); throw unavailable(); } finally { prompting = false; }
    },
    cancel() { if (active && loaded) write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }); }
  });
}
