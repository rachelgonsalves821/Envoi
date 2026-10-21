import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHelper } from '../helper/state.mjs';
import { offered } from '../helper/transport.mjs';

const fixture = async name => JSON.parse(await readFile(new URL(`../../../test/contract-fixtures/agent-registration/${name}.json`, import.meta.url), 'utf8'));
const contract = (await fixture('schemas'));
const origin = 'https://www.envoi-agents.com';
const runtime = { type: 'generic_https', version: '1.0.0' };
const deliveryCapabilities = { persistentProcess: true, outboundHttps: true, sse: true, webhook: false, scheduledPolling: false, a2a: false };

function privateStore() {
  const records = new Map();
  return { records, directory: 'private-host-store',
    read: async key => structuredClone(records.get(key) ?? null),
    write: async (key, value) => { records.set(key, structuredClone(value)); },
    lock: operation => operation() };
}

async function client(available = true) {
  const store = privateStore();
  const calls = []; const adopted = []; let confirmed = false;
  const created = (await fixture('registration-created')).response.body;
  const approved = (await fixture('registration-approved')).response.body;
  const activated = (await fixture('activation-created')).response.body;
  activated.installation.connectionRoute = 'authenticated_rest';
  const status = (await fixture('agent-status-installation')).response.body;
  status.installation.connectionRoute = 'authenticated_rest';
  const availability = (await fixture(available ? 'routes-available-rest' : 'routes-available')).response.body;
  const responses = [availability, created, approved, activated, status];
  let time = Date.parse('2026-10-12T12:00:00.000Z');
  const helper = await createHelper({ contract, origin, runtime, connectionRoute: 'authenticated_rest', deliveryCapabilities,
    helper: { name: 'rest-host', version: '1.0.0' }, store, now: () => time,
    randomId: () => 'activation_7f3c9a1e',
    confirm: async () => { confirmed = true; return true; },
    adopt: async (secret, context) => { adopted.push({ secret, context }); },
    request: async (method, path, options) => { calls.push({ method, path, options });
      const response = responses.shift(); assert.ok(response, `unexpected ${method} ${path}`); return structuredClone(response); } });
  return { helper, store, calls, adopted, confirmed: () => confirmed, tick: ms => { time += ms; } };
}

test('REST route requires independent availability and actual private host capabilities', async () => {
  const offeredRest = (await fixture('routes-available-rest')).response.body;
  assert.equal(offered(offeredRest, 'authenticated_rest'), true);
  assert.equal(offered((await fixture('routes-available')).response.body, 'authenticated_rest'), false);
  const unavailable = await client(false);
  assert.equal((await unavailable.helper.connect()).guidance, 'route_unavailable');
  assert.equal(unavailable.calls.length, 1);
  await assert.rejects(createHelper({ contract, origin, runtime, connectionRoute: 'authenticated_rest', store: privateStore(), adopt: async () => {} }), /DELIVERY_CAPABILITIES_REQUIRED/);
  await assert.rejects(createHelper({ contract, origin, runtime, connectionRoute: 'authenticated_rest', deliveryCapabilities: { ...deliveryCapabilities, sse: false }, store: privateStore(), adopt: async () => {} }), /DELIVERY_CAPABILITIES_REQUIRED/);
});

test('generic HTTPS host reuses private registration and verifies authenticated identity after activation', async () => {
  const host = await client();
  const pending = await host.helper.connect();
  assert.equal(pending.state, 'pending_approval');
  assert.equal(host.calls[1].path, '/api/agent-registrations');
  assert.equal(host.calls[1].options.body.connectionRoute, 'authenticated_rest');
  assert.deepEqual(host.calls[1].options.body.runtime, runtime);
  assert.deepEqual(host.calls[1].options.body.deliveryCapabilities, deliveryCapabilities);
  assert.equal((await host.store.read('helper-state.json')).bootstrapToken, 'envoi_reg_PLACEHOLDER_example');
  host.tick(5000);
  const connected = await host.helper.resume();
  assert.equal(host.confirmed(), true);
  assert.equal(connected.state, 'connected');
  assert.equal(connected.connectionRoute, 'authenticated_rest');
  assert.equal(connected.reachability, 'not_verified_closed_app');
  assert.equal(host.adopted.length, 1);
  assert.equal(host.adopted[0].secret.agentApiToken, 'envoi_agent_access_PLACEHOLDER_example');
  assert.equal(host.calls.at(-1).path, '/api/agent/status');
  assert.equal((await host.store.read('helper-state.json')).bootstrapToken, undefined);
  assert.doesNotMatch(JSON.stringify(connected), /envoi_agent_|envoi_reg_|installation_example|private-host-store/);
});
