import assert from 'node:assert/strict';
import test from 'node:test';
import { clientIp, publicHttpError } from '../src/http-security.js';

test('temporary session failures offer recovery without exposing provider details', () => {
  const response = publicHttpError({ statusCode: 503, code: 'auth_unavailable', message: 'private provider credentials' }, 'request-auth');
  assert.deepEqual(response, {
    status: 503,
    body: { error: 'AUTH_UNAVAILABLE', message: 'Your session could not be checked right now. Please try again.', requestId: 'request-auth' }
  });
});

test('client IP ignores spoofed forwarding headers unless Cloudflare proxy mode is explicit', () => {
  const request = {
    headers: { 'x-forwarded-for': '198.51.100.10' },
    socket: { remoteAddress: '203.0.113.5' }
  };
  assert.equal(clientIp(request, ''), '203.0.113.5');
  assert.equal(clientIp(request, 'cloudflare'), '198.51.100.10');
});

test('client IP rejects malformed forwarding values', () => {
  const request = {
    headers: { 'x-forwarded-for': 'attacker.example' },
    socket: { remoteAddress: '::ffff:127.0.0.1' }
  };
  assert.equal(clientIp(request, 'cloudflare'), '127.0.0.1');
});

test('unexpected server errors are sanitized while expected client errors remain useful', () => {
  assert.deepEqual(publicHttpError(new Error('postgres://secret@db/private'), 'req_internal'), {
    status: 500,
    body: { error: 'INTERNAL_SERVER_ERROR', message: 'An internal error occurred', requestId: 'req_internal' }
  });
  assert.deepEqual(publicHttpError(Object.assign(new Error('Object is not clean'), { statusCode: 423, code: 'OBJECT_NOT_CLEAN' }), 'req_client'), {
    status: 423,
    body: { error: 'OBJECT_NOT_CLEAN', message: 'Object is not clean', requestId: 'req_client' }
  });
});

// Exercise the actual HTTP handler: a unit test of a fixed key cannot detect
// an attacker-controlled bearer/cookie accidentally becoming the limiter key.
test('REST flood stays limited when bearer tokens, cookies and forwarded IP headers rotate', { timeout: 30000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sinaloa-http-rate-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, DATABASE_URL: '', SINALOA_HOST: '127.0.0.1', SINALOA_PORT: '0',
      SINALOA_RELEASE_SHA: '0123456789abcdef0123456789abcdef01234567', SINALOA_DATA_DIR: dataDir, SINALOA_AUTH_MODE: 'development', SINALOA_HUMAN_AUTH_PROVIDER: 'local',
      SINALOA_OBJECT_STORAGE_PROVIDER: 'local', SINALOA_TRUSTED_PROXY: '',
      SINALOA_ENABLE_EXTERNAL_EMAIL: 'false', SINALOA_ENABLE_CALENDAR_WRITES: 'false',
      SINALOA_ENABLE_CONSEQUENTIAL_ACTIONS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await stopped;
    }
    const relative = path.relative(tmpdir(), dataDir);
    assert.ok(relative.startsWith('sinaloa-http-rate-') && !relative.includes(path.sep));
    await rm(dataDir, { recursive: true, force: true });
  });
  const baseUrl = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('HTTP rate test server did not start')), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('HTTP rate test server exited before readiness')); });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  for (const route of ['/health', '/ready']) {
    const response = await fetch(baseUrl + route);
    assert.equal((await response.json()).releaseSha, '0123456789abcdef0123456789abcdef01234567');
  }
  for (let index = 0; index < 181; index += 1) {
    const response = await fetch(`${baseUrl}/api/inboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${index % 250 + 1}`,
        ...(index % 2 ? { cookie: `untrusted=${index}` } : { authorization: `Bearer invalid-${index}` }) },
      body: '{}', signal: AbortSignal.timeout(5000)
    });
    await response.body?.cancel();
    assert.equal(response.status, index < 180 ? 401 : 429, `request ${index + 1}`);
    if (index === 180) assert.ok(Number(response.headers.get('retry-after')) > 0);
  }
});