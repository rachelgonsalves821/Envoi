import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { applyLegacyEnvironmentFallbacks, assertNoRetiredEnvironment, retiredEnvironmentNames } from '../src/envoi-environment.js';

// N2-config-2: SINALOA_* settings are retired; only the data encryption key keeps a legacy name.
test('only the data encryption key is filled from its legacy name', () => {
  assert.deepEqual(applyLegacyEnvironmentFallbacks({ SINALOA_DATA_ENCRYPTION_KEY: 'k' }), { SINALOA_DATA_ENCRYPTION_KEY: 'k', ENVOI_DATA_ENCRYPTION_KEY: 'k' });
  assert.deepEqual(applyLegacyEnvironmentFallbacks({ SINALOA_PUBLIC_URL: 'https://www.envoi-agents.com' }), { SINALOA_PUBLIC_URL: 'https://www.envoi-agents.com' });
  assert.deepEqual(applyLegacyEnvironmentFallbacks({ ENVOI_PUBLIC_URL: 'https://www.envoi-agents.com' }), { ENVOI_PUBLIC_URL: 'https://www.envoi-agents.com' });
});

test('a conflicting encryption key pair fails without revealing values', () => {
  const values = { ENVOI_DATA_ENCRYPTION_KEY: 'new-private-value', SINALOA_DATA_ENCRYPTION_KEY: 'old-private-value' };
  assert.throws(() => applyLegacyEnvironmentFallbacks(values), error => {
    assert.match(error.message, /Conflicting Envoi environment settings: ENVOI_DATA_ENCRYPTION_KEY and SINALOA_DATA_ENCRYPTION_KEY/);
    assert.equal(error.message.includes('private-value'), false);
    return true;
  });
});

test('every other SINALOA_* name is retired and refused by name only', () => {
  const env = { SINALOA_PUBLIC_URL: 'https://private.example', SINALOA_AUTH_MODE: 'production', SINALOA_DATA_ENCRYPTION_KEY: 'k', ENVOI_PORT: '0' };
  assert.deepEqual(retiredEnvironmentNames(env), ['SINALOA_AUTH_MODE', 'SINALOA_PUBLIC_URL']);
  assert.throws(() => assertNoRetiredEnvironment(env), error => {
    assert.equal(error.message, 'Retired SINALOA_* settings are no longer read; rename them to ENVOI_*: SINALOA_AUTH_MODE, SINALOA_PUBLIC_URL');
    return true;
  });
  assert.doesNotThrow(() => assertNoRetiredEnvironment({ SINALOA_DATA_ENCRYPTION_KEY: 'k', ENVOI_PORT: '0' }));
});

test('the server refuses to start with a retired setting', () => {
  const env = { ...process.env, DATABASE_URL: '', ENVOI_PORT: '0', ENVOI_AUTH_MODE: 'development', SINALOA_AUTH_MODE: 'production' };
  const result = spawnSync(process.execPath, ['src/server.js'], { env, encoding: 'utf8', timeout: 15_000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Retired SINALOA_\* settings are no longer read; rename them to ENVOI_\*: SINALOA_AUTH_MODE/);
});
