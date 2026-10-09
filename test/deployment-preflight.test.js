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
