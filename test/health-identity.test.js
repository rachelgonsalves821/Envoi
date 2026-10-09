import test from 'node:test';
import assert from 'node:assert/strict';
import { api, launch } from './a3-harness.js';

// Every connector bundle shipped so far starts only when /health reports service 'sinaloa'
// (integrations/connector/core.ts). Renaming it strands installed connectors as unreachable.
test('health and readiness keep the service identity installed connectors check', async t => {
  const server = await launch();
  t.after(() => server.stop());
  for (const route of ['/health', '/ready']) {
    const response = await api(server.baseUrl, route);
    assert.equal(response.payload.service, 'sinaloa', `${route}: ${response.text}`);
  }
});
