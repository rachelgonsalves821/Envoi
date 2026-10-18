import { EnvoiError } from '../../sdk/typescript/src/index';
import { parseAdmissionJson } from './model-admission';

const limit = 262144;
const refused = (code: string) => new EnvoiError('Scoped model transport refused', undefined, code);

async function interrupted<Value>(signal: AbortSignal, action: () => Promise<Value>): Promise<Value> {
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(refused('MODEL_TRANSPORT_CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([stopped, Promise.resolve().then(() => { signal.throwIfAborted(); return action(); })]);
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener('abort', abort); }
}

export function createScopedModelTransport(options: {
  endpoint: string;
  token: string;
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
}) {
  const endpoint = options.endpoint;
  const token = options.token;
  const fetcher = options.fetch;
  const timeoutMs = options.timeoutMs ?? 120000;
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw refused('MODEL_TRANSPORT_CONFIG_INVALID'); }
  if (parsed.href !== endpoint || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== '/v1/responses' || typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)
    || typeof fetcher !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw refused('MODEL_TRANSPORT_CONFIG_INVALID');
  }
  return async (request: Readonly<{ endpoint: string; body: string; signal: AbortSignal }>): Promise<Uint8Array> => {
    if (request.endpoint !== endpoint) throw refused('MODEL_TRANSPORT_ROUTE_INVALID');
    if (typeof request.body !== 'string' || !request.body || Buffer.byteLength(request.body) > limit) throw refused('MODEL_TRANSPORT_REQUEST_INVALID');
    try { parseAdmissionJson(Buffer.from(request.body)); } catch { throw refused('MODEL_TRANSPORT_REQUEST_INVALID'); }
    const timeout = new AbortController();
    const signal = AbortSignal.any([request.signal, timeout.signal]);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; timeout.abort(); }, timeoutMs);
    timer.unref?.();
    const startedAt = performance.now();
    const checkDeadline = () => {
      if (performance.now() - startedAt >= timeoutMs) { timedOut = true; timeout.abort(); }
      signal.throwIfAborted();
    };
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let consumed = false;
    try {
      const body = request.body;
      const result = await interrupted(signal, () => {
        checkDeadline();
        const pending = fetcher(endpoint, {
          method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity' }, body
        });
        void pending.then(late => {
          if (late instanceof Response) {
            response = late;
            if (signal.aborted && late.body) void late.body.cancel().catch(() => {});
          }
        }, () => {});
        return pending;
      });
      if (!(result instanceof Response)) throw refused('MODEL_TRANSPORT_RESPONSE_INVALID');
      response = result;
      checkDeadline();
      if (response.status !== 200 || response.redirected || (response.url && response.url !== endpoint)) throw refused('MODEL_TRANSPORT_RESPONSE_INVALID');
      if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(response.headers.get('content-type') ?? '')) throw refused('MODEL_TRANSPORT_RESPONSE_INVALID');
      const encoding = response.headers.get('content-encoding');
      if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') throw refused('MODEL_TRANSPORT_RESPONSE_INVALID');
      const header = response.headers.get('content-length');
      if (header !== null && (!/^\d{1,10}$/.test(header) || Number(header) > limit)) throw refused('MODEL_TRANSPORT_RESPONSE_INVALID');
      reader = response.body?.getReader();
      if (!reader) throw refused('MODEL_TRANSPORT_RESPONSE_INVALID');
      let size = 0;
      let reads = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        checkDeadline();
        if (++reads > 4096) throw refused('MODEL_TRANSPORT_RESPONSE_INVALID');
        const part = await interrupted(signal, () => reader!.read());
        checkDeadline();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || (size += part.value.byteLength) > limit) throw refused('MODEL_TRANSPORT_RESPONSE_INVALID');
        chunks.push(Uint8Array.from(part.value));
      }
      signal.throwIfAborted();
      if (header !== null && Number(header) !== size) throw refused('MODEL_TRANSPORT_RESPONSE_INVALID');
      const output = Buffer.concat(chunks);
      try { parseAdmissionJson(output); } catch { throw refused('MODEL_TRANSPORT_RESPONSE_INVALID'); }
      signal.throwIfAborted();
      consumed = true;
      return output;
    } catch (error) {
      if (signal.aborted) throw refused(timedOut ? 'MODEL_TRANSPORT_TIMEOUT' : 'MODEL_TRANSPORT_CANCELLED');
      if (error instanceof EnvoiError && error.message === 'Scoped model transport refused') throw refused(error.code ?? 'MODEL_TRANSPORT_UNAVAILABLE');
      throw refused('MODEL_TRANSPORT_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      if (reader) {
        if (!consumed) void reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch {}
      } else if (response?.body && !consumed) void response.body.cancel().catch(() => {});
    }
  };
}
