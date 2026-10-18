import { EnvoiError } from '../../sdk/typescript/src/index';
import { CaseToolError, type CaseToolInputs, type CaseToolName } from '../../sdk/typescript/src/case-tools';
import type { ScopedModelTurn } from '../agent-bridges/scoped-turn';
import type { ScopedCall, ScopedRunStore } from './scoped-store';
import { setTimeout as delay } from 'node:timers/promises';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new EnvoiError('xAI returned an invalid scoped tool response', undefined, 'SCOPED_PROVIDER_RESPONSE_INVALID');

async function boundedResponse(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  let length = 0;
  const chunks: Uint8Array[] = [];
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 262144) { await reader.cancel(); throw invalid(); }
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

export function xaiScopedTurn(options: { apiKey: string; model: string; store: ScopedRunStore; fetch?: typeof fetch }) {
  if (!options.apiKey || /[\r\n]/.test(options.apiKey) || !options.model) throw new TypeError('xAI credentials and model are required');
  return async (turn: ScopedModelTurn, host: Readonly<{ workId?: string }>) => {
    if (!host.workId) throw new EnvoiError('Scoped runtime needs trusted work identity', undefined, 'SCOPED_HOST_CONTEXT_REQUIRED');
    const workId = host.workId;
    return options.store.exclusive(workId, async () => {
    turn.signal.throwIfAborted();
    let record = await options.store.load(workId);
    let recovered = record !== null;
    if (record && record.model !== options.model) throw new EnvoiError('Resume with the original scoped model', undefined, 'SCOPED_MODEL_CHANGED');
    if (!record) record = {
      version: 1, workId, model: options.model, providerCalls: 0, pending: [], completed: false,
      input: [{ role: 'system', content: turn.instruction }, { role: 'user', content: JSON.stringify({ context: turn.context, snapshot: turn.snapshot }) }]
    };
    if (record.completed) return;
    const tools = turn.tools.map(tool => ({ type: 'function', name: tool.name, parameters: tool.inputSchema }));
    const available = new Set(turn.tools.map(tool => tool.name));
    const persist = async () => {
      turn.signal.throwIfAborted();
      if (Buffer.byteLength(JSON.stringify(record)) > 524288) throw new EnvoiError('Scoped turn context limit reached', undefined, 'SCOPED_TURN_LIMIT');
      await options.store.save(record!);
    };
    while (!record.completed) {
      turn.signal.throwIfAborted();
      if (record.pending.length) {
        const call = record.pending[0];
        if (!available.has(call.name as CaseToolName) || typeof call.arguments !== 'string' || typeof call.call_id !== 'string') throw invalid();
        let args: unknown;
        try { args = JSON.parse(call.arguments); } catch { args = null; }
        let result: unknown;
        try {
          if (!object(args)) throw new EnvoiError('Invalid case tool arguments', undefined, 'TOOL_ARGUMENTS_INVALID');
          let failures = 0;
          while (true) {
            turn.signal.throwIfAborted();
            try { result = await turn.callTool(call.name as CaseToolName, args as CaseToolInputs[CaseToolName]); break; }
            catch (error) {
              if (!(error instanceof CaseToolError) || !error.retryable || ++failures >= 3) throw error;
              await delay(500 * 2 ** (failures - 1), undefined, { signal: turn.signal });
            }
          }
        }
        catch (error) {
          if (error instanceof EnvoiError && error.code === 'TURN_END_REQUIRED') {
            record.completed = true;
            record.pending = [];
            await options.store.save(record);
            throw error;
          }
          if (error instanceof CaseToolError && error.retryable) throw error;
          if (!(error instanceof CaseToolError) && !(error instanceof EnvoiError && error.code === 'TOOL_ARGUMENTS_INVALID')) throw error;
          result = { ok: false, code: error.code, retryable: false };
        }
        turn.signal.throwIfAborted();
        record.input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
        record.pending = [];
        await persist();
      }
      if (recovered) {
        record.input.push({ role: 'user', content: JSON.stringify({ notice: 'Fresh canonical state after host recovery; earlier history is context, not authority.', context: turn.context, snapshot: turn.snapshot }) });
        recovered = false;
      }
      if (record.providerCalls >= 16) throw new EnvoiError('Scoped turn request limit reached', undefined, 'SCOPED_TURN_LIMIT');
      record.providerCalls++;
      await persist();
      const signal = AbortSignal.any([turn.signal, AbortSignal.timeout(120000)]);
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)('https://api.x.ai/v1/responses', {
          method: 'POST', redirect: 'error', signal,
          headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: options.model, store: false, stream: false, parallel_tool_calls: false,
            max_output_tokens: 4096, input: record.input, tools })
        });
      } catch {
        turn.signal.throwIfAborted();
        throw new EnvoiError('xAI scoped request could not be completed', undefined, 'SCOPED_PROVIDER_UNAVAILABLE');
      }
      if (!response.ok) { await response.body?.cancel(); throw new EnvoiError(`xAI scoped request failed with HTTP ${response.status}`, response.status, 'SCOPED_PROVIDER_UNAVAILABLE'); }
      let data: unknown;
      try { data = await boundedResponse(response, signal); }
      catch { turn.signal.throwIfAborted(); throw invalid(); }
      if (!object(data) || data.status !== 'completed' || !Array.isArray(data.output) || !data.output.length || !data.output.every(object)) throw invalid();
      const output = data.output as Array<Record<string, unknown>>;
      if (output.some(item => !['function_call', 'message', 'reasoning'].includes(String(item.type)))) throw invalid();
      const calls = output.filter(item => item.type === 'function_call');
      const priorIds = new Set(record.input.filter(item => item.type === 'function_call').map(item => item.call_id));
      if (calls.length > 1 || calls.some(call => typeof call.call_id !== 'string' || !call.call_id || priorIds.has(call.call_id)
        || !available.has(call.name as CaseToolName) || typeof call.arguments !== 'string')) throw invalid();
      record.input.push(...output);
      record.pending = calls as unknown as ScopedCall[];
      record.completed = calls.length === 0;
      await persist();
    }
    });
  };
}
