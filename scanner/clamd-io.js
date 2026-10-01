import { clamdChunk, clamdCommand, MAX_SCAN_BYTES, parseClamdReply } from './clamd-protocol.js';

export const CLAMD_PORT = 3310;
export const CLAMD_TIMEOUT_MS = 180_000;

function timeoutError() {
  return Object.assign(new Error('ClamAV operation timed out'), { code: 'CLAMD_TIMEOUT' });
}
// Closing/cancelling a stalled stream can itself stall. Start cleanup and release
// locks, but never wait on it beyond the deadline; socket close interrupts I/O.
function discard(operation) {
  try { Promise.resolve(operation()).catch(() => {}); } catch { /* Resource already closed. */ }
}

export async function queryClamd(container, command, body = null, {
  timeoutMs = CLAMD_TIMEOUT_MS, connectTimeoutMs = 3_000, retryDelayMs = 500
} = {}) {
  const commandBytes = clamdCommand(command);
  if (command === 'INSTREAM' && (!(body instanceof Uint8Array) || body.length > MAX_SCAN_BYTES)) throw new TypeError('Invalid scan body');
  if (![timeoutMs, connectTimeoutMs, retryDelayMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Invalid ClamAV timeout');
  const timers = new Set();
  const closedSockets = new Set();
  const arm = (callback, milliseconds) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, milliseconds);
    timers.add(timer);
    return timer;
  };
  const clear = timer => { clearTimeout(timer); timers.delete(timer); };
  const close = socket => {
    if (socket && !closedSockets.has(socket)) {
      closedSockets.add(socket);
      discard(() => socket.close());
    }
  };
  let expired = false;
  const timeout = timeoutError();
  const deadline = new Promise((_, reject) => arm(() => { expired = true; reject(timeout); }, timeoutMs));
  const bounded = operation => {
    if (expired) return Promise.reject(timeout);
    return Promise.race([Promise.resolve().then(operation), deadline]);
  };
  let socket;
  let reader;
  let writer;
  try {
    // clamd speaks raw TCP, so do not use the HTTP port readiness helper.
    await bounded(() => container.start(undefined, { retries: 200, waitInterval: 300, portToCheck: CLAMD_PORT }));
    for (;;) {
      let candidate;
      let openTimer;
      try {
        candidate = container.ctx.container.getTcpPort(CLAMD_PORT).connect('10.0.0.1:3310');
        discard(() => candidate.closed);
        await bounded(() => Promise.race([
          candidate.opened,
          new Promise((_, reject) => { openTimer = arm(() => reject(timeoutError()), connectTimeoutMs); })
        ]));
        socket = candidate;
        break;
      } catch (error) {
        close(candidate);
        if (expired) throw timeout;
        await bounded(() => new Promise(resolve => arm(resolve, retryDelayMs)));
      } finally {
        if (openTimer !== undefined) clear(openTimer);
      }
    }
    writer = socket.writable.getWriter();
    await bounded(() => writer.write(commandBytes));
    if (command === 'INSTREAM') {
      for (let offset = 0; offset < body.length; offset += 64 * 1024) {
        await bounded(() => writer.write(clamdChunk(body.subarray(offset, offset + 64 * 1024))));
      }
      await bounded(() => writer.write(clamdChunk(new Uint8Array())));
    }
    writer.releaseLock();
    writer = null;
    reader = socket.readable.getReader();
    const parts = [];
    let length = 0;
    for (;;) {
      const { done, value } = await bounded(() => reader.read());
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError('Invalid ClamAV reply');
      length += value.length;
      if (length > 4096) throw new Error('ClamAV reply is too large');
      parts.push(value);
      if (value.includes(0)) break;
    }
    const reply = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { reply.set(part, offset); offset += part.length; }
    return parseClamdReply(reply, command);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (reader) {
      discard(() => reader.cancel());
      try { reader.releaseLock(); } catch { /* Pending read is being interrupted. */ }
    }
    if (writer) {
      discard(() => writer.abort());
      try { writer.releaseLock(); } catch { /* Pending write is being interrupted. */ }
    }
    close(socket);
  }
}
