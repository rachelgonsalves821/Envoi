import { CaseToolError, type CaseToolInputs, type CaseToolName } from '../../sdk/typescript/src/case-tools';
import { EnvoiError } from '../../sdk/typescript/src/index';
import schema from '../../sdk/typescript/src/case-tools-schema.json';
import type { ScopedModelTurn } from '../agent-bridges/scoped-turn';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const versions = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);
const errorCodes = new Set<string>(schema.schema.definitions.toolErrorEnvelope.properties.code.enum);
const ended = Symbol('ended');

export interface ScopedMcpCallQueue { pending: number; tail: Promise<unknown>; closed: boolean }

export function bindScopedMcpTurn(turn: ScopedModelTurn, queue: ScopedMcpCallQueue = { pending: 0, tail: Promise.resolve(), closed: false }) {
  const tools = structuredClone(turn.tools);
  const allowed = new Set(tools.map(tool => tool.name));
  const callTool = turn.callTool.bind(turn);
  let initialized = false;
  let ready = false;
  let closed = false;
  let listed = false;
  let stop!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => { stop = () => reject(ended); });
  void stopped.catch(() => {});
  function close() {
    if (closed) return;
    closed = true;
    queue.closed = true;
    turn.signal.removeEventListener('abort', close);
    stop();
  }
  turn.signal.addEventListener('abort', close, { once: true });
  if (turn.signal.aborted) close();
  const available = () => !closed && !queue.closed && !turn.signal.aborted;
  const failure = (id: unknown, code: number, message: string) => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  const result = (id: unknown, value: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result: value });
  const toolResult = (id: unknown, envelope: unknown, isError: boolean) => result(id, { content: [{ type: 'text', text: JSON.stringify(envelope) }], isError });

  return Object.freeze({
    close,
    get discovered() { return listed; },
    get active() { return available(); },
    async dispatch(raw: string): Promise<string | null> {
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > 262144) return failure(null, -32600, 'Invalid MCP request');
      let request: unknown;
      try { request = JSON.parse(raw); } catch { return failure(null, -32700, 'Invalid JSON'); }
      if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
        || Object.keys(request).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key))) return failure(null, -32600, 'Invalid MCP request');
      const hasId = Object.hasOwn(request, 'id');
      const id = request.id;
      if (hasId && !(typeof id === 'string' && id.length > 0 && id.length <= 128 || typeof id === 'number' && Number.isSafeInteger(id))) return failure(null, -32600, 'Invalid MCP request identity');
      if (!available()) return hasId ? failure(id, -32000, 'Case turn is unavailable') : null;
      if (request.method === 'ping') return hasId ? result(id, {}) : null;
      if (request.method === 'initialize') {
        if (!hasId || initialized || !object(request.params) || typeof request.params.protocolVersion !== 'string'
          || !object(request.params.capabilities) || !object(request.params.clientInfo)) return hasId ? failure(id, -32602, 'Invalid initialization') : null;
        initialized = true;
        return result(id, { protocolVersion: versions.has(request.params.protocolVersion) ? request.params.protocolVersion : '2025-11-25',
          capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'envoi-scoped-turn', version: '1.0.0' } });
      }
      if (request.method === 'notifications/initialized') {
        if (initialized && !hasId) ready = true;
        return hasId ? failure(id, -32600, 'Expected initialized notification') : null;
      }
      if (!hasId) return null;
      if (!ready) return failure(id, -32000, 'Initialize this MCP connection first');
      if (request.method === 'tools/list') {
        if (request.params !== undefined && (!object(request.params) || Object.keys(request.params).length)) return failure(id, -32602, 'Invalid tool list parameters');
        listed = true;
        return result(id, { tools: tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema })) });
      }
      if (request.method !== 'tools/call') return failure(id, -32601, 'MCP method is unavailable');
      const params = request.params;
      if (!object(params) || Object.keys(params).some(key => !['name', 'arguments', '_meta'].includes(key))
        || typeof params.name !== 'string' || !allowed.has(params.name as CaseToolName) || !object(params.arguments)) return failure(id, -32602, 'Invalid scoped tool call');
      const name = params.name as CaseToolName;
      const input = params.arguments as CaseToolInputs[typeof name];
      if (queue.pending >= 16) return toolResult(id, { ok: false, tool: name, code: 'TOOL_BUSY', message: 'Case tool is busy', retryable: true }, true);
      queue.pending++;
      const operation = queue.tail.then(async () => {
        if (!available()) throw ended;
        try {
          const value = await callTool(name, input);
          if (!available()) throw ended;
          return value;
        } catch (error) {
          const correctable = error instanceof CaseToolError && error.code && errorCodes.has(error.code)
            || error instanceof EnvoiError && error.code === 'TOOL_ARGUMENTS_INVALID';
          if (!correctable) close();
          throw error;
        }
      });
      queue.tail = operation.catch(() => {});
      void operation.finally(() => { queue.pending--; }).catch(() => {});
      try {
        const value = await Promise.race([operation, stopped]);
        if (!available()) throw ended;
        const output = toolResult(id, { ok: true, tool: name, result: value }, false);
        if (Buffer.byteLength(output) > 1_000_000) return failure(id, -32603, 'Scoped result exceeds its limit');
        return output;
      } catch (error) {
        if (!available() || error === ended) return failure(id, -32000, 'Case turn is unavailable');
        if (error instanceof CaseToolError && error.code && errorCodes.has(error.code)) {
          return toolResult(id, { ok: false, tool: name, code: error.code, message: 'Case tool refused the operation', retryable: error.code === 'TOOL_BUSY' }, true);
        }
        if (error instanceof EnvoiError && error.code === 'TOOL_ARGUMENTS_INVALID') return failure(id, -32602, 'Invalid case tool arguments');
        close();
        return failure(id, -32000, 'Case turn is unavailable');
      }
    }
  });
}
