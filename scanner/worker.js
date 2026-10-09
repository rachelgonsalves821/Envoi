import { Container, getContainer } from '@cloudflare/containers';
import { matchesSha256Base64, MAX_SCAN_BYTES, readBoundedBody } from './clamd-protocol.js';
import { CLAMD_PORT, queryClamd } from './clamd-io.js';

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

export class ClamAVContainer extends Container {
  requiredPorts = [CLAMD_PORT];
  sleepAfter = '10m';
  enableInternet = true;

  async fetch(request) {
    // This handler uses raw TCP instead of Container.fetch(), so renew the
    // activity timer that the base HTTP proxy would normally renew.
    this.renewActivityTimeout();
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
    const scannerToken = env.ENVOI_SCANNER_TOKEN ?? env.SINALOA_SCANNER_TOKEN;
    if (env.ENVOI_SCANNER_TOKEN !== undefined && env.SINALOA_SCANNER_TOKEN !== undefined
      && env.ENVOI_SCANNER_TOKEN !== env.SINALOA_SCANNER_TOKEN) return json({ error: 'SCANNER_CONFIGURATION_CONFLICT' }, 503);
    if (!await authorized(request, scannerToken)) return json({ error: 'UNAUTHORIZED' }, 401);
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
