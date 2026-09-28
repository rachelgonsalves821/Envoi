import assert from 'node:assert/strict';
import test from 'node:test';
import { clientIp, publicHttpError } from '../src/http-security.js';

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
