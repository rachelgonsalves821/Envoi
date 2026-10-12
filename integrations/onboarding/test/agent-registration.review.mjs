// Explicit Lane B consuming review. Run with ENVOI_AGENT_REGISTRATION_FIXTURES_ROOT
// pointing at the canonical PR #76 fixture tree; never commit a fixture copy.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { planHost } from '../host-plan.mjs';

const root = process.env.ENVOI_AGENT_REGISTRATION_FIXTURES_ROOT;
if (!root) throw new Error('Set ENVOI_AGENT_REGISTRATION_FIXTURES_ROOT to the published fixture directory');
const readFixture = async (name) => JSON.parse(await readFile(join(root, name), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../skill/skill.json', import.meta.url), 'utf8'));
const unverified = JSON.parse(await readFile(new URL('../profiles/unverified-host.json', import.meta.url), 'utf8'));

function capableProfile(route) {
  const profile = structuredClone(unverified);
  profile.runtime = { id: 'contract-review', version: '1.0', hostId: 'fixture-host' };
  profile.target = { releaseSha: 'a'.repeat(40), integrationVersion: 'fixture-review' };
  profile.capabilities.readSkill = true;
  profile.capabilities.privateStorage = true;
  profile.capabilities.outboundHttps = true;
  profile.capabilities.persistentProcess = true;
  profile.capabilities.sse = true;
  profile.capabilities[route === 'local_helper' ? 'invokeTrustedHelper' :
    route === 'authenticated_rest' ? 'authenticatedRest' :
      route === 'remote_mcp_oauth' ? 'remoteMcpOAuth' : 'providerConnector'] = true;
  return profile;
}

test('all 68 published fixtures map to v1 code and model-visible allowlists', async () => {
  const names = (await readdir(root)).filter((name) => name.endsWith('.json') && name !== 'schemas.json');
  assert.equal(names.length, 68);
  const schema = await readFixture('schemas.json');
  const allowed = new Set([
    ...Object.keys(schema['x-model-visible'].serverDerived),
    ...Object.keys(schema['x-model-visible'].helperDerived),
  ]);
  assert.equal(allowed.size, 16);
  for (const name of names) {
    const fixture = await readFixture(name);
    assert.equal(fixture.id, name.slice(0, -5), name);
    assert.equal(fixture.contract, 'agent-registration', name);
    assert.equal(fixture.version, 1, name);
    const code = fixture.response?.body?.code;
    if (code) {
      const row = schema['x-codes'][code];
      assert.ok(row, `${name}: unknown code`);
      assert.equal(fixture.response.status, row.status, name);
      const surface = row.bySurface[fixture.client.surface];
      assert.ok(surface, `${name}: missing surface`);
      for (const key of ['lifecycle', 'retry']) assert.equal(fixture.client[key], surface[key], `${name}:${key}`);
      const reason = fixture.response.body.reason;
      assert.equal(fixture.client.guidance,
        surface.guidanceByReason?.[reason] ?? surface.guidance, `${name}:guidance`);
    }
    const visible = fixture.client?.modelVisible;
    if (!visible) continue;
    for (const key of Object.keys(visible)) assert.ok(allowed.has(key), `${name}:${key}`);
    assert.doesNotMatch(JSON.stringify(visible),
      /envoi_(?:reg|agent_access|agent_refresh|mcp_read|enroll)_[A-Za-z0-9_-]+|registration_example|installation_example|agent_example|inbox_example/i,
      `${name}: model-visible token or internal ID`);
    if ('verificationCode' in visible) assert.equal(fixture.response?.body?.status, 'pending_claim', name);
  }
});

test('the exact published availability fixtures bound host-planner selections', async () => {
  const disabled = (await readFixture('routes-disabled.json')).response.body;
  const local = (await readFixture('routes-available.json')).response.body;
  const rest = (await readFixture('routes-available-rest.json')).response.body;
  const localProfile = capableProfile('local_helper');
  const remoteProfile = capableProfile('remote_mcp_oauth');
  const restProfile = capableProfile('authenticated_rest');

  assert.equal(planHost(manifest, localProfile, disabled).selectedConnectionRoute, null);
  const localPlan = planHost(manifest, localProfile, local);
  assert.equal(localPlan.selectedConnectionRoute, 'local_helper');
  assert.equal(localPlan.selectedDeliveryMode, 'envoi_link');
  assert.equal(localPlan.reachability, 'not_verified_closed_app');
  assert.equal(localPlan.liveEnrollmentAllowed, false);
  assert.equal(planHost(manifest, remoteProfile, local).selectedConnectionRoute, null);
  assert.equal(planHost(manifest, restProfile, local).selectedConnectionRoute, null);
  const restPlan = planHost(manifest, restProfile, rest);
  assert.equal(restPlan.selectedConnectionRoute, 'authenticated_rest');
  assert.equal(restPlan.selectedDeliveryMode, 'envoi_link');
  assert.equal(restPlan.plannedHelperInvocation, null);
});

test('safe examples are sourced from fixture projections and recovery cannot duplicate an agent', async () => {
  const examplesText = await readFile(new URL('../skill/HELPER-OUTPUT-EXAMPLES.md', import.meta.url), 'utf8');
  const examples = [...examplesText.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)]
    .map((match) => JSON.parse(match[1]));
  for (const [index, name] of [
    'registration-created.json', 'registration-approved.json', 'agent-status-installation.json',
  ].entries()) {
    assert.deepEqual(examples[index], (await readFixture(name)).client.modelVisible, name);
  }
  const activated = await readFixture('activation-created.json');
  const recovered = await readFixture('activation-recovered.json');
  assert.deepEqual(recovered.response.body, activated.response.body);
  assert.equal(recovered.request.body.activationId, activated.request.body.activationId);
  assert.equal((await readFixture('activation-paused-agent.json')).response.body.agent.status, 'paused');
  const schema = await readFixture('schemas.json');
  assert.equal(schema['x-limits'].registrationTtlSeconds, 600);
  assert.equal(schema['x-limits'].activationRecoverySeconds, 300);
  assert.deepEqual(schema['x-permission-labels'], {
    send_agent_messages: 'send agent messages',
    receive_agent_messages: 'receive agent messages',
    create_assets: 'create files',
    execute_cases: 'act on cases',
    use_email_transport: 'use external email',
  });
});
