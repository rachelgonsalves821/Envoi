import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReadiness } from '../src/readiness.js';

test('readiness fails closed for critical dependencies without exposing errors verbatim', async () => {
  const result = await evaluateReadiness([
    { name: 'database', run: async () => true },
    { name: 'objectStorage', run: async () => { throw new Error('credential secret=do-not-log '.repeat(30)); } },
    { name: 'optionalEmail', critical: false, run: async () => { throw new Error('disabled'); } }
  ], { at: '2026-09-27T00:00:00.000Z' });
  assert.equal(result.ready, false);
  assert.equal(result.checks.database.ready, true);
  assert.equal(result.checks.objectStorage.ready, false);
  assert.equal(result.checks.objectStorage.reason.length <= 240, true);
  assert.equal(result.checks.optionalEmail.critical, false);
});

test('readiness bounds slow dependency checks', async () => {
  const result = await evaluateReadiness([{ name: 'scanner', run: signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) }], { timeoutMs: 10 });
  assert.equal(result.ready, false);
  assert.match(result.checks.scanner.reason, /timed out/);
});
