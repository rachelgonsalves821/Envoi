import test from 'node:test';
import assert from 'node:assert/strict';
import { api, launch } from './a3-harness.js';

// Connectors start only when /health reports exactly this service identity
// (integrations/connector/core.ts); changing one side alone strands installed connectors.
test('health and readiness keep the service identity installed connectors check', async t => {
  const server = await launch();
  t.after(() => server.stop());
  for (const route of ['/health', '/ready']) {
    const response = await api(server.baseUrl, route);
    assert.equal(response.payload.service, 'envoi', `${route}: ${response.text}`);
  }
});
