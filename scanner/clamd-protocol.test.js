import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clamdChunk, clamdCommand, matchesSha256Base64, parseClamdReply, readBoundedBody } from './clamd-protocol.js';

test('ClamAV command and INSTREAM frames use the nul protocol and big-endian lengths', () => {
  assert.equal(new TextDecoder().decode(clamdCommand('PING')), 'zPING\0');
  assert.deepEqual([...clamdChunk(new Uint8Array([1, 2, 3]))], [0, 0, 0, 3, 1, 2, 3]);
  assert.deepEqual([...clamdChunk(new Uint8Array())], [0, 0, 0, 0]);
  assert.throws(() => clamdCommand('SHUTDOWN'));
});

test('ClamAV replies distinguish clean, infected, and unhealthy results', () => {
  const encode = value => new TextEncoder().encode(`${value}\0`);
  assert.deepEqual(parseClamdReply(encode('PONG'), 'PING'), { ready: true });
  assert.deepEqual(parseClamdReply(encode('stream: OK'), 'INSTREAM'), { status: 'clean', engine: 'clamav', signature: null });
  assert.deepEqual(parseClamdReply(encode('stream: Eicar-Test-Signature FOUND'), 'INSTREAM'), { status: 'infected', engine: 'clamav', signature: 'Eicar-Test-Signature' });
  assert.throws(() => parseClamdReply(encode('stream: ERROR'), 'INSTREAM'));
  assert.throws(() => parseClamdReply(encode('NOPE'), 'PING'));
});

test('scan bodies are bounded before a ClamAV socket is opened', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.close(); } });
  assert.deepEqual([...await readBoundedBody(body, 2)], [1, 2]);
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
  await assert.rejects(() => readBoundedBody(oversized, 2), RangeError);
});

test('scanner checksum matches the application base64 SHA-256 contract', async () => {
  const sample = new TextEncoder().encode('hello');
  assert.equal(await matchesSha256Base64(sample, 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ='), true);
  assert.equal(await matchesSha256Base64(sample, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'), false);
  assert.equal(await matchesSha256Base64(sample, null), false);
});
