import { createHash, randomBytes } from 'node:crypto';
import { EnvoiError } from '../../sdk/typescript/src/index';
import schema from '../../sdk/typescript/src/case-tools-schema.json';
import { validAdmissionCheckpoint, type ScopedRunRecord, type ScopedRunStore } from '../grok/scoped-store';

const maxBytes = 262144;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const failure = (code: string) => new EnvoiError('Scoped model admission refused', undefined, code);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseAdmissionJson(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > maxBytes) throw failure('MODEL_REQUEST_INVALID');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw failure('MODEL_REQUEST_INVALID'); }
  let cursor = 0;
  let nodes = 0;
  const invalid = () => { throw failure('MODEL_REQUEST_INVALID'); };
  const space = () => { while (/[\x20\t\r\n]/.test(text[cursor] ?? '') && cursor < text.length) cursor++; };
  const string = (): string => {
    const start = cursor++;
    while (cursor < text.length) {
      const character = text[cursor++];
      if (character === '"') {
        try { return JSON.parse(text.slice(start, cursor)) as string; } catch { return invalid(); }
      }
      if (character === '\\') cursor++;
    }
    return invalid();
  };
  const value = (depth: number): unknown => {
    if (depth > 48 || ++nodes > 16384) return invalid();
    space();
    const character = text[cursor];
    if (character === '"') return string();
    if (character === '{') {
      cursor++; space();
      const result = Object.create(null) as Record<string, unknown>;
      const seen = new Set<string>();
      if (text[cursor] === '}') { cursor++; return result; }
      while (true) {
        space();
        if (text[cursor] !== '"') return invalid();
        const key = string();
        if (seen.has(key)) return invalid();
        seen.add(key); space();
        if (text[cursor++] !== ':') return invalid();
        result[key] = value(depth + 1); space();
        if (text[cursor] === '}') { cursor++; return result; }
        if (text[cursor++] !== ',') return invalid();
      }
    }
    if (character === '[') {
      cursor++; space();
      const result: unknown[] = [];
      if (text[cursor] === ']') { cursor++; return result; }
      while (true) {
        result.push(value(depth + 1)); space();
        if (text[cursor] === ']') { cursor++; return result; }
        if (text[cursor++] !== ',') return invalid();
      }
    }
    const token = text.slice(cursor).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) return invalid();
    cursor += token.length;
    const parsed: unknown = JSON.parse(token);
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) return invalid();
    return parsed;
  };
  const parsed = value(0); space();
  if (cursor !== text.length) return invalid();
  return parsed;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const clone = <Value>(value: Value): Value => parseAdmissionJson(Buffer.from(JSON.stringify(value))) as Value;

function validInput(input: unknown, tools: Set<string>): input is Array<Record<string, unknown>> {
  if (!Array.isArray(input) || !input.length || input.length > 256) return false;
  const calls = new Set<string>();
  const answered = new Set<string>();
  return input.every(entry => {
    if (!object(entry)) return false;
    const keys = Object.keys(entry);
    if (entry.type === 'function_call') {
      if (keys.some(key => !['type', 'call_id', 'name', 'arguments'].includes(key))
        || typeof entry.call_id !== 'string' || !identifier.test(entry.call_id) || calls.has(entry.call_id)
        || typeof entry.name !== 'string' || !tools.has(entry.name) || typeof entry.arguments !== 'string') return false;
      try { if (!object(parseAdmissionJson(Buffer.from(entry.arguments)))) return false; } catch { return false; }
      calls.add(entry.call_id); return true;
    }
    if (entry.type === 'function_call_output') {
      if (keys.some(key => !['type', 'call_id', 'output'].includes(key))
        || typeof entry.call_id !== 'string' || !calls.has(entry.call_id) || answered.has(entry.call_id)
        || typeof entry.output !== 'string') return false;
      answered.add(entry.call_id); return true;
    }
    if (keys.some(key => !['type', 'role', 'content'].includes(key))
      || (entry.type !== undefined && entry.type !== 'message')
      || !['system', 'developer', 'user', 'assistant'].includes(entry.role as string)) return false;
    if (typeof entry.content === 'string') return true;
    return Array.isArray(entry.content) && entry.content.length > 0 && entry.content.length <= 32
      && entry.content.every(part => object(part) && Object.keys(part).every(key => ['type', 'text'].includes(key))
        && ['input_text', 'output_text'].includes(part.type as string) && typeof part.text === 'string');
  }) && calls.size === answered.size;
}

export interface ScopedInferenceBinding {
  agentId: string;
  installationId: string;
  workId: string;
  caseId: string;
  fence: number;
  generation: string;
  providerBuild: string;
  policyDigest: string;
  model: string;
  endpoint: string;
  expiresAt: number;
  allowedTools: readonly string[];
}

export interface AdmissionTicket {
  readonly capability: string;
  readonly body: string;
}

interface Ticket {
  requestId: string;
  requestDigest: string;
  body: string;
  promise?: Promise<string>;
}

export function createScopedModelAdmission(options: {
  binding: ScopedInferenceBinding;
  signal: AbortSignal;
  store: ScopedRunStore;
  validateAuthority(): Promise<void>;
  forward(request: Readonly<{ endpoint: string; body: string; signal: AbortSignal }>): Promise<Uint8Array>;
  consumeResponse(record: ScopedRunRecord, response: unknown): ScopedRunRecord;
  now?: () => number;
}) {
  const binding = clone(options.binding);
  if ([binding.agentId, binding.installationId, binding.workId, binding.caseId, binding.generation].some(value => typeof value !== 'string' || !identifier.test(value))
    || !Number.isSafeInteger(binding.fence) || binding.fence < 1
    || typeof binding.providerBuild !== 'string' || !/^[a-f0-9]{40}$/.test(binding.providerBuild)
    || typeof binding.policyDigest !== 'string' || !digestPattern.test(binding.policyDigest)
    || typeof binding.model !== 'string' || !binding.model || binding.model.length > 128
    || !Number.isSafeInteger(binding.expiresAt) || binding.expiresAt < 1
    || !Array.isArray(binding.allowedTools) || !binding.allowedTools.includes('envoi_case_snapshot')
    || new Set(binding.allowedTools).size !== binding.allowedTools.length
    || binding.allowedTools.some(name => !schema.tools.some(tool => tool.name === name))) throw failure('MODEL_BINDING_INVALID');
  let endpoint: URL;
  try { endpoint = new URL(binding.endpoint); } catch { throw failure('MODEL_BINDING_INVALID'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.href !== binding.endpoint || endpoint.pathname !== '/v1/responses') throw failure('MODEL_BINDING_INVALID');
  const now = options.now ?? Date.now;
  const tools = schema.tools.filter(tool => binding.allowedTools.includes(tool.name))
    .map(tool => ({ type: 'function', name: tool.name, parameters: clone(tool.inputSchema) }));
  const names = new Set(binding.allowedTools);
  const bindingDigest = digest(binding);
  const tickets = new Map<string, Ticket>();
  const running = new Set<AbortController>();
  const retirement = new AbortController();
  let retired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const retire = () => {
    retired = true;
    if (timer) clearTimeout(timer);
    options.signal.removeEventListener('abort', retire);
    tickets.clear();
    retirement.abort();
    for (const controller of running) controller.abort(failure('MODEL_AUTHORITY_LOST'));
  };
  const active = () => {
    if (retired || options.signal.aborted || now() >= binding.expiresAt) { retire(); throw failure('MODEL_AUTHORITY_LOST'); }
  };
  const authority = async () => {
    active();
    let cancel!: () => void;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(failure('MODEL_AUTHORITY_LOST'));
      retirement.signal.addEventListener('abort', cancel, { once: true });
      deadline = setTimeout(cancel, 10000); deadline.unref?.();
    });
    try { await Promise.race([stopped, Promise.resolve().then(() => { active(); return options.validateAuthority(); })]); }
    catch { retire(); throw failure('MODEL_AUTHORITY_LOST'); }
    finally { if (deadline) clearTimeout(deadline); retirement.signal.removeEventListener('abort', cancel); }
    active();
  };
  const exclusive = async <Value>(action: () => Promise<Value>): Promise<Value> => {
    try {
      const result = await options.store.exclusive(binding.workId, action);
      active();
      return result;
    } catch (error) {
      active();
      if (error instanceof EnvoiError && typeof error.code === 'string' && /^MODEL_[A-Z_]{1,48}$/.test(error.code)) throw failure(error.code);
      throw failure('MODEL_JOURNAL_UNAVAILABLE');
    }
  };
  const project = (record: ScopedRunRecord) => {
    if (record.completed || record.pending.length) throw failure('MODEL_TOOLS_PENDING');
    if (!validInput(record.input, names)) throw failure('MODEL_CONTEXT_INVALID');
    const request = { model: binding.model, input: record.input, tools, store: false, stream: false, max_output_tokens: 4096 };
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > maxBytes) throw failure('MODEL_REQUEST_INVALID');
    return { body, requestDigest: digest(request) };
  };
  const load = async () => {
    let record: ScopedRunRecord | null;
    try { record = await options.store.load(binding.workId); }
    catch { active(); throw failure('MODEL_JOURNAL_INVALID'); }
    active();
    if (!record || record.workId !== binding.workId || record.model !== binding.model
      || (record.admission !== undefined && !validAdmissionCheckpoint(record.admission))) throw failure('MODEL_JOURNAL_INVALID');
    return record;
  };
  const persist = async (record: ScopedRunRecord, code: string) => {
    try { await options.store.save(record); }
    catch { active(); throw failure(code); }
    active();
  };
  options.signal.addEventListener('abort', retire, { once: true });
  if (options.signal.aborted) retire();
  const remaining = binding.expiresAt - now();
  if (!retired && (remaining <= 0 || remaining > 900000)) { retire(); throw failure('MODEL_BINDING_INVALID'); }
  if (!retired && remaining > 0 && remaining <= 2147483647) {
    timer = setTimeout(retire, remaining); timer.unref?.();
  }

  return Object.freeze({
    retire,
    async prepare(requestId: string): Promise<AdmissionTicket> {
      if (typeof requestId !== 'string' || !identifier.test(requestId)) throw failure('MODEL_REQUEST_INVALID');
      await authority();
      const result = await exclusive(async () => {
        await authority();
        const record = await load();
        const { body, requestDigest } = project(record);
        const previous = record.admission;
        if (previous?.state === 'started') throw failure('MODEL_OUTCOME_UNCERTAIN');
        if (previous?.bindingDigest !== undefined && previous.bindingDigest !== bindingDigest && binding.fence <= previous.fence) throw failure('MODEL_BINDING_STALE');
        if (previous?.history.includes(requestId) && (previous.requestId !== requestId || previous.state === 'completed')) throw failure('MODEL_REQUEST_REPLAY');
        if (previous?.state === 'prepared' && (previous.requestId !== requestId || previous.requestDigest !== requestDigest)) throw failure('MODEL_REQUEST_CONFLICT');
        if (previous?.state !== 'prepared') {
          if (record.providerCalls >= 16) throw failure('MODEL_REQUEST_LIMIT');
          record.providerCalls++;
        }
        const history = previous?.state === 'prepared' ? previous.history : [...(previous?.history ?? []), requestId];
        record.admission = { version: 1, requestId, bindingDigest, requestDigest, fence: binding.fence, history, state: 'prepared' };
        await persist(record, 'MODEL_JOURNAL_UNAVAILABLE');
        if (tickets.size >= 16) throw failure('MODEL_REQUEST_LIMIT');
        const capability = randomBytes(32).toString('hex');
        tickets.set(capability, { requestId, requestDigest, body });
        return Object.freeze({ capability, body });
      });
      active();
      return result;
    },
    async submit(capability: string, bytes: Uint8Array): Promise<string> {
      active();
      const ticket = typeof capability === 'string' ? tickets.get(capability) : undefined;
      if (!ticket) throw failure('MODEL_CAPABILITY_INVALID');
      const parsed = parseAdmissionJson(bytes);
      if (digest(parsed) !== ticket.requestDigest) throw failure('MODEL_REQUEST_MISMATCH');
      await authority();
      if (!ticket.promise) ticket.promise = (async () => {
        return exclusive(async () => {
          await authority();
          const record = await load();
          const entry = record.admission;
          if (!entry || entry.bindingDigest !== bindingDigest || entry.requestId !== ticket.requestId
            || entry.requestDigest !== ticket.requestDigest || entry.state !== 'prepared') throw failure('MODEL_OUTCOME_UNCERTAIN');
          if (project(record).requestDigest !== ticket.requestDigest) throw failure('MODEL_REQUEST_MISMATCH');
          entry.state = 'started';
          await persist(record, 'MODEL_OUTCOME_UNCERTAIN');
          active();
          const controller = new AbortController();
          running.add(controller);
          let abort!: () => void;
          const stopped = new Promise<never>((_resolve, reject) => {
            abort = () => reject(failure('MODEL_AUTHORITY_LOST'));
            controller.signal.addEventListener('abort', abort, { once: true });
          });
          try {
            let response: Uint8Array;
            try { response = await Promise.race([stopped, options.forward(Object.freeze({ endpoint: binding.endpoint, body: ticket.body, signal: controller.signal }))]); }
            catch { active(); throw failure('MODEL_OUTCOME_UNCERTAIN'); }
            if (!(response instanceof Uint8Array) || response.byteLength > maxBytes) throw failure('MODEL_OUTCOME_UNCERTAIN');
            const ownedResponse = Uint8Array.from(response);
            await authority();
            let result: ScopedRunRecord;
            try {
              const data = parseAdmissionJson(ownedResponse);
              result = options.consumeResponse(clone(record), data);
              if (!result || result.version !== 1 || result.workId !== binding.workId || result.model !== binding.model
                || !Array.isArray(result.input) || !Array.isArray(result.pending) || result.pending.length > 16
                || result.providerCalls !== record.providerCalls || typeof result.completed !== 'boolean') throw failure('MODEL_JOURNAL_INVALID');
              result.admission = { ...entry, state: 'completed' };
              active();
              await options.store.save(result);
            } catch { active(); throw failure('MODEL_OUTCOME_UNCERTAIN'); }
            active();
            return new TextDecoder().decode(ownedResponse);
          } finally { controller.signal.removeEventListener('abort', abort); running.delete(controller); }
        });
      })();
      const result = await ticket.promise;
      active();
      return result;
    }
  });
}
