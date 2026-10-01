import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { queryClamd, CLAMD_PORT } from './clamd-io.js';
import { matchesSha256Base64, MAX_SCAN_BYTES, readBoundedBody } from './clamd-protocol.js';

const never = () => new Promise(() => {});
const encode = value => new TextEncoder().encode(value);
function fixture({ stall, reply = 'PONG\0', writeFailure = false, largeReply = false, hangingCleanup = false } = {}) {
  const calls = { starts: 0, connects: 0, closes: 0, writes: [], cancels: 0, aborts: 0, readerReleases: 0, writerReleases: 0 };
  let read = false;
  const socket = {
    opened: stall === 'open' ? never() : Promise.resolve(),
    close() { calls.closes += 1; if (hangingCleanup) return never(); },
    writable: { getWriter: () => ({
      async write(bytes) { calls.writes.push(bytes); if (writeFailure) throw new Error('fixture write failed'); if (stall === 'write') return never(); },
      abort() { calls.aborts += 1; return hangingCleanup ? never() : Promise.resolve(); },
      releaseLock() { calls.writerReleases += 1; }
    }) },
    readable: { getReader: () => ({
      async read() {
        if (stall === 'read') return never();
        if (read) return { done: true };
        read = true;
        return { done: false, value: largeReply ? new Uint8Array(4097) : encode(reply) };
      },
      cancel() { calls.cancels += 1; return hangingCleanup ? never() : Promise.resolve(); },
      releaseLock() { calls.readerReleases += 1; }
    }) }
  };
  const container = {
    async start(_options, readiness) { calls.starts += 1; assert.equal(readiness.portToCheck, CLAMD_PORT); if (stall === 'start') return never(); },
    ctx: { container: { getTcpPort(port) {
      assert.equal(port, CLAMD_PORT);
      return { connect(address) { assert.equal(address, '10.0.0.1:3310'); calls.connects += 1; return socket; } };
    } } }
  };
  return { calls, socket, container };
}
const shortDeadline = { timeoutMs: 25, connectTimeoutMs: 5, retryDelayMs: 1 };

test('one total ClamAV deadline includes a stalled Container start', async () => {
  const { container, calls } = fixture({ stall: 'start' });
  await assert.rejects(queryClamd(container, 'PING', null, shortDeadline), { code: 'CLAMD_TIMEOUT' });
  assert.equal(calls.starts, 1);
  assert.equal(calls.connects, 0);
  assert.equal(calls.closes, 0);
});

test('stalled socket establishment retries within total deadline and closes every attempt', async () => {
  const { container, calls, socket } = fixture({ stall: 'open' });
  // Each attempt is a separate socket, as in the Cloudflare TCP API.
  container.ctx.container.getTcpPort = () => ({ connect() {
    calls.connects += 1;
    return { ...socket, close() { calls.closes += 1; } };
  } });
  await assert.rejects(queryClamd(container, 'PING', null, shortDeadline), { code: 'CLAMD_TIMEOUT' });
  assert.ok(calls.connects >= 1);
  assert.equal(calls.closes, calls.connects);
  assert.equal(calls.writes.length, 0);
});

test('stalled command writes are aborted and the socket closes even if cleanup stalls', async () => {
  const { container, calls } = fixture({ stall: 'write', hangingCleanup: true });
  await assert.rejects(queryClamd(container, 'PING', null, shortDeadline), { code: 'CLAMD_TIMEOUT' });
  assert.equal(calls.closes, 1);
  assert.equal(calls.aborts, 1);
  assert.equal(calls.writerReleases, 1);
  assert.equal(calls.cancels, 0);
});

test('opened socket with a never-ending read cancels reader, releases locks and closes', async () => {
  const { container, calls } = fixture({ stall: 'read', hangingCleanup: true });
  await assert.rejects(queryClamd(container, 'PING', null, shortDeadline), { code: 'CLAMD_TIMEOUT' });
  assert.equal(calls.closes, 1);
  assert.equal(calls.cancels, 1);
  assert.equal(calls.readerReleases, 1);
  assert.equal(calls.writerReleases, 1);
});

test('read budget includes startup time instead of starting a new deadline per stage', async () => {
  const { container, calls } = fixture({ stall: 'read' });
  container.start = async () => { calls.starts += 1; await new Promise(resolve => setTimeout(resolve, 15)); };
  const began = performance.now();
  await assert.rejects(queryClamd(container, 'PING', null, { ...shortDeadline, timeoutMs: 30 }), { code: 'CLAMD_TIMEOUT' });
  assert.ok(performance.now() - began < 500);
  assert.equal(calls.closes, 1);
});

test('successful PING and clean/infected INSTREAM preserve protocol and close resources', async () => {
  const health = fixture();
  assert.deepEqual(await queryClamd(health.container, 'PING'), { ready: true });
  assert.equal(new TextDecoder().decode(health.calls.writes[0]), 'zPING\0');
  assert.equal(health.calls.closes, 1);
  assert.equal(health.calls.cancels, 1);
  assert.equal(health.calls.readerReleases, 1);
  for (const [reply, expected] of [
    ['stream: OK\0', { status: 'clean', engine: 'clamav', signature: null }],
    ['stream: Eicar-Test-Signature FOUND\0', { status: 'infected', engine: 'clamav', signature: 'Eicar-Test-Signature' }]
  ]) {
    const scan = fixture({ reply });
    const body = new Uint8Array(64 * 1024 + 1).fill(7);
    assert.deepEqual(await queryClamd(scan.container, 'INSTREAM', body), expected);
    assert.equal(new TextDecoder().decode(scan.calls.writes[0]), 'zINSTREAM\0');
    assert.equal(new DataView(scan.calls.writes[1].buffer).getUint32(0, false), 64 * 1024);
    assert.equal(new DataView(scan.calls.writes[2].buffer).getUint32(0, false), 1);
    assert.deepEqual([...scan.calls.writes[3]], [0, 0, 0, 0]);
    assert.equal(scan.calls.closes, 1);
    assert.equal(scan.calls.writerReleases, 1);
  }
});

test('failure and oversized/invalid replies close sockets and release stream locks', async () => {
  const writing = fixture({ writeFailure: true });
  await assert.rejects(queryClamd(writing.container, 'PING'), /fixture write failed/);
  assert.equal(writing.calls.closes, 1);
  assert.equal(writing.calls.aborts, 1);
  for (const options of [{ largeReply: true }, { reply: 'NOPE\0' }]) {
    const reading = fixture(options);
    await assert.rejects(queryClamd(reading.container, 'PING'));
    assert.equal(reading.calls.closes, 1);
    assert.equal(reading.calls.cancels, 1);
    assert.equal(reading.calls.readerReleases, 1);
  }
});

test('a failed initial TCP connection closes before a successful bounded retry', async () => {
  const { container, socket, calls } = fixture();
  container.ctx.container.getTcpPort = () => ({ connect() {
    calls.connects += 1;
    if (calls.connects === 1) return { opened: Promise.reject(new Error('fixture connect failed')), closed: Promise.reject(new Error('fixture socket failure')), close() { calls.closes += 1; } };
    return socket;
  } });
  assert.deepEqual(await queryClamd(container, 'PING', null, { timeoutMs: 100, connectTimeoutMs: 20, retryDelayMs: 1 }), { ready: true });
  assert.equal(calls.connects, 2);
  assert.equal(calls.closes, 2);
});

test('real Web Streams release locks on successful nul-terminated replies', async () => {
  const { container, socket, calls } = fixture();
  socket.readable = new ReadableStream({ start(controller) { controller.enqueue(encode('PONG\0')); } });
  socket.writable = new WritableStream({ write(bytes) { calls.writes.push(bytes); } });
  assert.deepEqual(await queryClamd(container, 'PING'), { ready: true });
  assert.equal(socket.readable.locked, false);
  assert.equal(socket.writable.locked, false);
  assert.equal(calls.closes, 1);
});

test('public scanner admission rejects missing/wrong tokens before opening a Container', async () => {
  // Evaluate the actual public Worker handler with only the platform adapter
  // stubbed; the TCP module is tested directly above, and bearer logic is intact.
  const source = (await readFile(new URL('./worker.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace('export class ClamAVContainer', 'class ClamAVContainer').replace('export default', 'return');
  let accesses = 0;
  const handler = new Function('Container', 'getContainer', 'queryClamd', 'matchesSha256Base64', 'MAX_SCAN_BYTES', 'readBoundedBody', 'CLAMD_PORT', source)(
    class {}, () => { accesses += 1; throw new Error('unauthorized Container access'); }, queryClamd, matchesSha256Base64, MAX_SCAN_BYTES, readBoundedBody, CLAMD_PORT
  );
  for (const [path, method] of [['/health', 'GET'], ['/scan', 'POST']]) {
    for (const authorization of [null, 'Bearer wrong', 'Basic fixture']) {
      const headers = authorization ? { authorization } : {};
      const response = await handler.fetch(new Request(`https://scanner.example${path}`, { method, headers }), { SINALOA_SCANNER_TOKEN: 'fixture-token' });
      assert.equal(response.status, 401);
    }
  }
  const noConfiguredToken = await handler.fetch(new Request('https://scanner.example/health', { headers: { authorization: 'Bearer fixture-token' } }), {});
  assert.equal(noConfiguredToken.status, 401);
  assert.equal(accesses, 0);
});
