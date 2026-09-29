import { Container, getContainer } from '@cloudflare/containers';
import { clamdChunk, clamdCommand, matchesSha256Base64, MAX_SCAN_BYTES, parseClamdReply, readBoundedBody } from './clamd-protocol.js';

const CLAMD_PORT = 3310;
const CONTAINER_NAME = 'staging-clamav-primary';
const encoder = new TextEncoder();

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'private, no-store' } });
}

async function authorized(request, token) {
  if (!token || !request.headers.get('authorization')?.startsWith('Bearer ')) return false;
  const supplied = request.headers.get('authorization').slice(7);
  if (supplied.length > 512) return false;
  const digests = await Promise.all([token, supplied].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const expected = new Uint8Array(digests[0]);
  const actual = new Uint8Array(digests[1]);
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected[i] ^ actual[i];
  return mismatch === 0;
}

async function queryClamd(container, command, body = null) {
  // Cloudflare's startAndWaitForPorts probes with HTTP, which clamd does not speak.
  await container.start(undefined, { retries: 200, waitInterval: 300, portToCheck: CLAMD_PORT });
  const deadline = Date.now() + 180_000;
  let socket;
  for (;;) {
    let candidate;
    try {
      candidate = container.ctx.container.getTcpPort(CLAMD_PORT).connect('10.0.0.1:3310');
      await Promise.race([
        candidate.opened,
        new Promise((_, reject) => setTimeout(() => reject(new Error('ClamAV TCP connection timed out')), 3_000))
      ]);
      socket = candidate;
      break;
    } catch (error) {
      try { candidate?.close(); } catch { /* Connection was never opened. */ }
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  try {
    const writer = socket.writable.getWriter();
    await writer.write(clamdCommand(command));
    if (command === 'INSTREAM') {
      for (let offset = 0; offset < body.length; offset += 64 * 1024) {
        await writer.write(clamdChunk(body.subarray(offset, offset + 64 * 1024)));
      }
      await writer.write(clamdChunk(new Uint8Array()));
    }
    writer.releaseLock();
    const reader = socket.readable.getReader();
    const parts = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 4096) throw new Error('ClamAV reply is too large');
        parts.push(value);
        if (value.includes(0)) break;
      }
    } finally {
      reader.releaseLock();
    }
    const reply = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { reply.set(part, offset); offset += part.length; }
    return parseClamdReply(reply, command);
  } finally {
    socket.close();
  }
}

export class ClamAVContainer extends Container {
  requiredPorts = [CLAMD_PORT];
  sleepAfter = '10m';
  enableInternet = true;

  async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/health' && request.method === 'GET') {
        return json(await queryClamd(this, 'PING'));
      }
      if (path === '/scan' && request.method === 'POST') {
        const body = await readBoundedBody(request.body);
        if (!await matchesSha256Base64(body, request.headers.get('x-sinaloa-sha256'))) return json({ error: 'CHECKSUM_MISMATCH' }, 422);
        return json(await queryClamd(this, 'INSTREAM', body));
      }
      return json({ error: 'NOT_FOUND' }, 404);
    } catch (error) {
      if (error instanceof RangeError) return json({ error: 'SCAN_TOO_LARGE' }, 413);
      console.error('Scanner unavailable', { name: error instanceof Error ? error.name : 'Error' });
      return json({ ready: false, error: 'SCANNER_UNAVAILABLE' }, 503);
    }
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!((path === '/health' && request.method === 'GET') || (path === '/scan' && request.method === 'POST'))) {
      return json({ error: 'NOT_FOUND' }, 404);
    }
    if (!await authorized(request, env.SINALOA_SCANNER_TOKEN)) return json({ error: 'UNAUTHORIZED' }, 401);
    if (path === '/scan') {
      const length = Number(request.headers.get('content-length'));
      if (Number.isFinite(length) && length > MAX_SCAN_BYTES) return json({ error: 'SCAN_TOO_LARGE' }, 413);
    }
    try {
      return await getContainer(env.CLAMAV_CONTAINER, CONTAINER_NAME).fetch(request);
    } catch (error) {
      console.error('Scanner container unavailable', { name: error instanceof Error ? error.name : 'Error' });
      return json({ ready: false, error: 'SCANNER_UNAVAILABLE' }, 503);
    }
  },

  async scheduled(_event, env) {
    const container = getContainer(env.CLAMAV_CONTAINER, CONTAINER_NAME);
    const response = await container.fetch(new Request('https://scanner.internal/health'));
    response.body?.cancel();
    if (!response.ok) throw new Error('Scanner failed scheduled health check');
  }
};
