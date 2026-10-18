import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { api, launch, owner, pauseAgent } from './a3-harness.js';

const key = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const enabled = { ENVOI_INSTALLATIONS_V2: 'true', ENVOI_HTTP_WAKE_V1: 'true', ENVOI_WAKE_SIGNING_KEYS: JSON.stringify([{ kid: 'route-tests', privateKey: key, activeFrom: '2026-01-01T00:00:00.000Z' }]) };
for (const backend of [{ name: 'FileStore', env: {}, prefix: '97' }, ...(process.env.DATABASE_URL ? [{ name: 'PostgreSQL', env: { DATABASE_URL: process.env.DATABASE_URL }, prefix: '98' }] : [])]) {
  test(`[${backend.name}] wake flag gates routes before authentication`, async t => {
    const server = await launch(backend.env); t.after(() => server.stop());
    for (const route of ['/.well-known/envoi-wake-keys.json', '/api/agent/wake-subscriptions', '/api/inboxes/inbox_unknown/agents/agent_unknown/wake-subscriptions']) {
      const response = await api(server.baseUrl, route);
      assert.equal(response.status, 404, response.text); assert.equal(response.payload.code, 'FEATURE_DISABLED');
    }
  });
  test(`[${backend.name}] wake HTTP keys status auth pause and unsafe destinations consume actual routes`, async t => {
    const server = await launch({ ...backend.env, ...enabled }); t.after(() => server.stop());
    const { baseUrl } = server;
    const alice = await owner(baseUrl, `${backend.prefix}00`), bob = await owner(baseUrl, `${backend.prefix}01`);
    const keys = await api(baseUrl, '/.well-known/envoi-wake-keys.json');
    assert.equal(keys.status, 200, keys.text); assert.equal(keys.headers.get('cache-control'), 'public, max-age=300, s-maxage=0');
    assert.equal(keys.payload.keys[0].kid, 'route-tests'); assert.ok(!keys.text.includes('privateKey'));
    assert.ok(!Object.hasOwn(keys.payload.keys[0], 'd'));
    const noAuth = await api(baseUrl, '/api/agent/wake-subscriptions');
    assert.equal(noAuth.status, 401, noAuth.text);
    for (const token of ['envoi_case_session_' + 'x'.repeat(43), 'envoi_mcp_read_' + 'x'.repeat(43), 'envoi_reg_example']) {
      assert.equal((await api(baseUrl, '/api/agent/wake-subscriptions', { token })).status, 401);
    }
    const initial = await api(baseUrl, '/api/agent/status', { token: alice.agentApiToken });
    assert.deepEqual(initial.payload.httpWake, { available: true, version: 1, subscription: null });
    const own = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/agents/${alice.agent.id}/wake-subscriptions`, { session: alice.session });
    assert.deepEqual(own.payload, { agentId: alice.agent.id, subscriptions: [] });
    const foreign = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/agents/${alice.agent.id}/wake-subscriptions`, { session: bob.session });
    assert.equal(foreign.status, 403, foreign.text);
    const malformed = await api(baseUrl, '/api/agent/wake-subscriptions', { token: alice.agentApiToken, body: { url: 'https://localhost/', extra: true } });
    assert.equal(malformed.payload.code, 'WAKE_SUBSCRIPTION_INVALID');
    const rejected = await api(baseUrl, '/api/agent/wake-subscriptions', { token: alice.agentApiToken, body: { url: 'https://localhost/' } });
    assert.equal(rejected.status, 400, rejected.text); assert.equal(rejected.payload.code, 'WAKE_URL_REJECTED');
    assert.equal(rejected.payload.reason, 'reserved_name');
    const tooLongUrl = await api(baseUrl, '/api/agent/wake-subscriptions', { token: alice.agentApiToken, body: { url: 'https://hooks.example.com/' + 'a'.repeat(2049) } });
    assert.equal(tooLongUrl.payload.code, 'WAKE_URL_REJECTED', tooLongUrl.text);
    assert.equal(tooLongUrl.payload.reason, 'url_too_long');
    const invalidField = await api(baseUrl, '/api/agent/wake-subscriptions', { token: alice.agentApiToken, body: { url: 'a'.repeat(8193) } });
    assert.equal(invalidField.payload.code, 'WAKE_SUBSCRIPTION_INVALID', invalidField.text);
    await pauseAgent(baseUrl, alice);
    const pausedList = await api(baseUrl, '/api/agent/wake-subscriptions', { token: alice.agentApiToken });
    assert.equal(pausedList.status, 200, pausedList.text);
    const pausedCreate = await api(baseUrl, '/api/agent/wake-subscriptions', { token: alice.agentApiToken, body: { url: 'http://localhost/' } });
    assert.equal(pausedCreate.payload.code, 'WAKE_URL_REJECTED', 'pause permits managing connectivity');
    const ended = await api(baseUrl, '/api/agent/wake-subscriptions/wake_sub_unknown/end', { token: alice.agentApiToken, body: {} });
    assert.equal(ended.status, 404, ended.text); assert.equal(ended.payload.code, 'WAKE_SUBSCRIPTION_NOT_FOUND');
  });
}
