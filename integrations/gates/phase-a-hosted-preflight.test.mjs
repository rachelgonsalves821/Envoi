import test from 'node:test';
import assert from 'node:assert/strict';
import { originOf, releaseMatches, manifestMatches, sha256 } from './phase-a-hosted-preflight.mjs';

test('requires a bare HTTPS origin', () => {
  assert.equal(originOf('https://staging.example.test'), 'https://staging.example.test');
  for (const value of ['http://staging.example.test', 'https://staging.example.test/other',
    'https://user:pass@staging.example.test/', 'https://staging.example.test/?token=x']) {
    assert.throws(() => originOf(value));
  }
});

test('requires one exact healthy release including critical providers', () => {
  const sha = 'a'.repeat(40);
  const health = { ok: true, releaseSha: sha };
  const ready = { ready: true, releaseSha: sha, checks: { database: { ready: true }, objectStorageReadAccess: { ready: true }, malwareScanner: { ready: true } } };
  assert.equal(releaseMatches(health, ready, sha), true);
  assert.equal(releaseMatches(health, { ...ready, releaseSha: 'b'.repeat(40) }, sha), false);
  assert.equal(releaseMatches(health, { ...ready, checks: { ...ready.checks, malwareScanner: { ready: false } } }, sha), false);
});

test('requires matching release metadata and both exact bundle bytes', () => {
  const bytes = Buffer.from('fixture bundle');
  const manifest = { runtimes: ['hermes'], artifacts: { 'envoi-connector.mjs': { sha256: sha256(bytes), size: bytes.length } } };
  assert.equal(manifestMatches(manifest, manifest, bytes, bytes), true);
  assert.equal(manifestMatches(manifest, manifest, bytes, Buffer.from('changed')), false);
  assert.equal(manifestMatches({ ...manifest, runtimes: ['openclaw'] }, manifest, bytes, bytes), false);
});
