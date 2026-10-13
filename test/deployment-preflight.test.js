import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentPreflight } from '../src/deployment-preflight.js';

test('empty runtime configuration fails with actionable names and no secret values', () => {
  const report = deploymentPreflight({ WORKOS_API_KEY: 'never-print-this-value' });
  assert.equal(report.ready, false);
  assert.ok(report.errors.some(message => message.includes('DATABASE_URL')));
  assert.ok(report.errors.some(message => message.includes('ENVOI_EDGE_ALLOWED_HOSTS')));
  assert.ok(report.configuredNames.includes('WORKOS_API_KEY'));
  assert.doesNotMatch(JSON.stringify(report), /never-print-this-value/);
});

// N2-config-2: leftover names are reported by name, and only the honoured key is forwarded.
test('retired SINALOA_* names are reported, and the ones without a twin fail preflight', () => {
  const report = deploymentPreflight({ SINALOA_PUBLIC_URL: 'https://private.example', SINALOA_RELEASE_SHA: 'a'.repeat(40), ENVOI_RELEASE_SHA: 'a'.repeat(40), SINALOA_DATA_ENCRYPTION_KEY: 'k'.repeat(40) });
  assert.deepEqual(report.retiredNames, ['SINALOA_PUBLIC_URL', 'SINALOA_RELEASE_SHA']);
  assert.equal(report.ready, false);
  assert.ok(report.errors.includes('SINALOA_PUBLIC_URL is no longer read; set ENVOI_PUBLIC_URL instead'));
  assert.ok(!report.errors.some(message => message.includes('SINALOA_RELEASE_SHA')), 'a leftover with its twin is not an error');
  assert.ok(report.errors.some(message => message.includes('ENVOI_PUBLIC_URL is required')));
  assert.ok(report.configuredNames.includes('ENVOI_DATA_ENCRYPTION_KEY'));
  assert.doesNotMatch(JSON.stringify(report), /private\.example/);
});

test('a conflicting encryption key pair is a preflight error, not a crash', () => {
  const report = deploymentPreflight({ ENVOI_DATA_ENCRYPTION_KEY: 'n'.repeat(40), SINALOA_DATA_ENCRYPTION_KEY: 'o'.repeat(40) });
  assert.equal(report.ready, false);
  assert.ok(report.errors.includes('Conflicting Envoi environment settings: ENVOI_DATA_ENCRYPTION_KEY and SINALOA_DATA_ENCRYPTION_KEY'));
  assert.doesNotMatch(JSON.stringify(report), /nnnn|oooo/);
});
