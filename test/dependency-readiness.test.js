import test from 'node:test';
import assert from 'node:assert/strict';
import { checkScannerHealth, scannerHealthUrl } from '../src/dependency-readiness.js';
import { evaluateReadiness } from '../src/readiness.js';

const env = { SINALOA_MALWARE_SCANNER_URL: 'https://scanner.example/scan', SINALOA_MALWARE_SCANNER_TOKEN: 'private-token' };

test('scanner readiness requires a positive JSON health response', async () => {
  for (const [status, body] of [[404, '{}'], [405, '{}'], [429, '{}'], [500, '{}'], [200, '{}'], [200, '{"ready":false}'], [200, '<html>login</html>']]) {
    await assert.rejects(checkScannerHealth(env, { fetchImpl: async () => new Response(body, { status }) }));
  }
  await checkScannerHealth(env, { fetchImpl: async (url, options) => {
    assert.equal(url.href, 'https://scanner.example/health');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer private-token');
    return Response.json({ ready: true });
  } });
});

test('scanner health URL cannot forward credentials to another origin', () => {
  assert.throws(() => scannerHealthUrl({ ...env, SINALOA_MALWARE_SCANNER_HEALTH_URL: 'https://elsewhere.example/health' }));
  assert.throws(() => scannerHealthUrl({ ...env, SINALOA_MALWARE_SCANNER_HEALTH_URL: 'https://user:password@scanner.example/health' }));
});

test('public readiness does not disclose provider exception contents', async () => {
  const result = await evaluateReadiness([{ name: 'database', run: async () => { throw new Error('postgresql://user:private-password@internal.example'); } }]);
  assert.equal(result.ready, false);
  assert.equal(result.checks.database.reason, 'Dependency check failed');
  assert.doesNotMatch(JSON.stringify(result), /private-password|internal.example/);
});
