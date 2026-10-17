import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createTransport, offered, validateOrigin, ProtocolError } from '../helper/transport.mjs';
import { safeOutput } from '../helper/output.mjs';
const fixture = async name => JSON.parse(await readFile(new URL(`../../../test/contract-fixtures/agent-registration/${name}.json`, import.meta.url), 'utf8'));
const origin = 'https://www.envoi-agents.com';

test('transport confines bootstrap to explicit authenticated request, rejects redirects and logs nothing', async () => {
  const saved = await fixture('registration-approved'); let observed;
  const request = createTransport(origin, async (url, options) => { observed = { url, options }; return new Response(JSON.stringify(saved.response.body)); });
  assert.equal((await request('GET', saved.request.path, { token: 'envoi_reg_private' })).status, 'approved');
  assert.equal(observed.options.redirect, 'error'); assert.equal(observed.options.headers.authorization, 'Bearer envoi_reg_private');
  assert.equal(observed.url, `${origin}${saved.request.path}`);
  const failed = createTransport(origin, async () => { throw new Error('raw private token secret'); });
  await assert.rejects(failed('GET', '/api/onboarding/routes'), error => error instanceof ProtocolError && !error.message.includes('secret'));
});

test('transport derives retry delay from canonical body/header and treats malformed edge failure as outage', async () => {
  const saved = await fixture('registration-rate-limited');
  const request = createTransport(origin, async () => new Response(JSON.stringify(saved.response.body), { status: 429, headers: { 'retry-after': '2000' } }));
  await assert.rejects(request('POST', saved.request.path, { body: saved.request.body }), error => error.code === 'RATE_LIMITED' && error.retryAfterSeconds === 2000 && error.reason === 'registration_limit');
  const edge = createTransport(origin, async () => new Response('<html>private raw gateway failure</html>', { status: 502 }));
  await assert.rejects(edge('GET', '/api/onboarding/routes'), error => error.code === 'INTERNAL_SERVER_ERROR' && !error.message.includes('private'));
  const oversized = createTransport(origin, async () => new Response(JSON.stringify({ raw: 'x'.repeat(130_000) })));
  await assert.rejects(oversized('GET', '/api/onboarding/routes'), error => error.code === 'INVALID_RESPONSE');
});

test('only canonical offered local route and delivery can be selected', async () => {
  assert.equal(offered((await fixture('routes-available')).response.body), true);
  assert.equal(offered((await fixture('routes-available-rest')).response.body), true);
  assert.equal(offered((await fixture('routes-disabled')).response.body), false);
  for (const mutate of [body => body.routes.push(body.routes[0]), body => body.routes[0].available = 'true',
    body => body.routes.find(item => item.connectionRoute === 'remote_mcp_oauth').available = true,
    body => body.deliveryModes.find(item => item.deliveryMode === 'poll').available = true]) {
    const body = (await fixture('routes-available')).response.body; mutate(body); assert.throws(() => offered(body), /protocol operation/);
  }
  for (const value of [`${origin}/connect`, `${origin}?token=secret`, 'https://user:secret@www.envoi-agents.com', 'http://www.envoi-agents.com']) assert.throws(() => validateOrigin(value));
});

test('projection strips unknown fields and rejects secret-bearing free text, UUIDs and invalid helper states', async () => {
  const contract = await fixture('schemas');
  const safe = safeOutput(contract, { state: 'connected', raw: 'never-public', bootstrapToken: 'envoi_reg_private' });
  assert.deepEqual(safe, { state: 'connected' });
  for (const values of [{ nextAction: 'token envoi_agent_access_secret' }, { workspaceName: 'bad\nworkspace' }, { nextAction: 'id 12345678-1234-1234-1234-123456789abc' }, { state: 'automatic' }, { nextAction: 'secret-fragment' }]) {
    assert.throws(() => safeOutput(contract, values, ['secret-fragment']));
  }
  assert.equal(safeOutput(contract, { agentAddress: '12345678-1234-1234-1234-123456789abc@envoi.mail' }).agentAddress, '12345678-1234-1234-1234-123456789abc@envoi.mail');
});
