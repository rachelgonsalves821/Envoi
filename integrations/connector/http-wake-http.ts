import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpWakeReceiver } from './http-wake-receiver';
import type { HttpWakeHost } from './http-wake-host';

export function createWakeHttpHandler(options: {
  path: string;
  receiver: Pick<HttpWakeReceiver, 'receive'>;
  host: Pick<HttpWakeHost, 'dispatchPending' | 'acknowledge'>;
  signal: AbortSignal;
  onError?: (code: 'WAKE_DISPATCH_FAILED') => void;
}) {
  if (!options.path.startsWith('/') || options.path.includes('?') || options.path.includes('#') || /[\r\n]/.test(options.path)) throw new TypeError('A fixed receiver path is required');
  return (request: IncomingMessage, response: ServerResponse): void => {
    const finish = (status: number) => { if (!response.headersSent) { response.writeHead(status, { 'cache-control': 'no-store' }); response.end(); } };
    if (request.url !== options.path) { finish(404); request.resume(); return; }
    if (options.signal.aborted) { finish(503); request.resume(); return; }
    if (request.method !== 'POST') { finish(400); request.resume(); return; }
    const chunks: Buffer[] = [];
    let length = 0;
    let stopped = false;
    const timeout = setTimeout(() => { stopped = true; finish(408); request.destroy(); }, 5000);
    const abort = () => { stopped = true; finish(503); request.destroy(); };
    options.signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timeout); options.signal.removeEventListener('abort', abort); };
    request.on('error', () => { stopped = true; cleanup(); finish(400); });
    request.on('aborted', () => { stopped = true; cleanup(); });
    request.on('data', (chunk: Buffer) => {
      if (stopped) return;
      length += chunk.length;
      if (length > 1024) { stopped = true; cleanup(); finish(400); request.resume(); return; }
      chunks.push(Buffer.from(chunk));
    });
    request.on('end', () => {
      cleanup();
      if (stopped || options.signal.aborted) return;
      void (async () => {
        let verificationTimer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          options.receiver.receive({ method: request.method!, headers: request.headers, body: Buffer.concat(chunks) }),
          new Promise<never>((_, reject) => { verificationTimer = setTimeout(() => reject(new Error('Wake verification deadline')), 3500); })
        ]).finally(() => clearTimeout(verificationTimer));
        if (options.signal.aborted) { finish(503); return; }
        if (result.status >= 200 && result.status < 300) response.once('finish', () => {
          if (!options.signal.aborted) void (async () => {
            if (result.acceptedId) await options.host.acknowledge(result.acceptedId);
            await options.host.dispatchPending(options.signal);
          })().catch(() => options.onError?.('WAKE_DISPATCH_FAILED'));
        });
        if (!response.headersSent) { response.writeHead(result.status, { ...result.headers, 'cache-control': 'no-store' }); response.end(); }
      })().catch(() => finish(503));
    });
  };
}
