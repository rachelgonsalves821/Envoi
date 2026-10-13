import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { applyLegacyEnvironmentFallbacks, assertNoRetiredEnvironment, orphanedLegacyNames, retiredEnvironmentNames } from '../src/envoi-environment.js';

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

test('orphaned legacy names are the ones without an ENVOI_* twin', () => {
  assert.deepEqual(orphanedLegacyNames(['SINALOA_DB_CA', 'SINALOA_PUBLIC_URL', 'ENVOI_PUBLIC_URL', 'SINALOA_DATA_ENCRYPTION_KEY']), ['SINALOA_DB_CA']);
});

// Every entry point that reads settings refuses a retired one before doing anything.
for (const entry of ['src/server.js', 'src/migrate.js', 'scripts/export-waitlist.mjs']) {
  test(`${entry} refuses to start with a retired setting`, () => {
    const env = { ...process.env, DATABASE_URL: 'postgresql://fixture@127.0.0.1:1/envoi', ENVOI_PORT: '0', ENVOI_AUTH_MODE: 'development', SINALOA_DB_SSL_MODE: 'verify-full' };
    const result = spawnSync(process.execPath, [entry, 'unused-output.csv'], { env, encoding: 'utf8', timeout: 15_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Retired SINALOA_\* settings are no longer read; rename them to ENVOI_\*: SINALOA_DB_SSL_MODE/);
  });

  // Without a database URL the bootstrap is the only guard: the entry point refuses before anything else.
  test(`${entry} refuses a retired setting before reading any other`, () => {
    const env = { ...process.env, DATABASE_URL: '', ENVOI_PORT: '0', ENVOI_AUTH_MODE: 'development', SINALOA_PUBLIC_URL: 'https://private.example' };
    const result = spawnSync(process.execPath, [entry], { env, encoding: 'utf8', timeout: 15_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Retired SINALOA_\* settings are no longer read; rename them to ENVOI_\*: SINALOA_PUBLIC_URL/);
    assert.doesNotMatch(result.stderr + result.stdout, /private\.example/);
  });
}
