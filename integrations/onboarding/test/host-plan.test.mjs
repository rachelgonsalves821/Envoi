import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { consumeHostPlan, planHost, planApprovalConfirmation, requiredChecks } from '../host-plan.mjs';

const manifest = JSON.parse(await readFile(new URL('../skill/skill.json', import.meta.url), 'utf8'));
const seed = JSON.parse(await readFile(new URL('../profiles/unverified-host.json', import.meta.url), 'utf8'));

function supportedProfile(runtime = 'arbitrary-agent') {
  const profile = structuredClone(seed);
  profile.runtime = { id: runtime, version: '1.0', hostId: 'test-host' };
  profile.target = { releaseSha: 'a'.repeat(40), integrationVersion: 'test-only' };
  for (const key of ['invokeTrustedHelper', 'privateStorage', 'outboundHttps']) profile.capabilities[key] = true;
  return profile;
}

function evidenceFor(profile, mode, connectionRoute = 'local_helper') {
  return {
    connectionRoute, mode, runtime: { ...profile.runtime }, releaseSha: 'a'.repeat(40), integrationVersion: 'test-only',
    checks: Object.fromEntries(requiredChecks.map((key) => [key, {
      result: 'pass', reference: `https://example.invalid/test-fixture/${key}`,
    }])),
  };
}

function v1Availability({ rest = false, enabled = true } = {}) {
  return {
    asOf: '2026-10-12T12:00:00.000Z',
    contract: { id: 'agent-registration', version: 1 },
    registrationEnabled: enabled, installationsEnabled: enabled,
    routes: [
      { connectionRoute: 'local_helper', available: enabled },
      { connectionRoute: 'remote_mcp_oauth', available: false },
      { connectionRoute: 'provider_connector', available: false },
      { connectionRoute: 'authenticated_rest', available: enabled && rest },
    ],
    deliveryModes: [
      { deliveryMode: 'envoi_link', available: enabled },
      ...['webhook', 'provider', 'poll', 'on_demand', 'a2a'].map((deliveryMode) => ({ deliveryMode, available: false })),
    ],
  };
}

test('Muse, Instinct, Dots and arbitrary hosts use the same route-neutral plan', () => {
  for (const runtime of ['muse', 'instinct', 'chatgpt-dots', 'arbitrary-agent', 'hermes', 'openclaw']) {
    const result = planHost(manifest, supportedProfile(runtime));
    assert.equal(result.selectedConnectionRoute, null);
    assert.equal(result.selectedDeliveryMode, null);
    assert.ok(result.candidateConnectionRoutes.includes('local_helper'));
    assert.equal(result.liveEnrollmentAllowed, false);
    assert.equal(result.plannedHelperInvocation, null);
  }
});

test('reading a skill without an approved connection route or private storage cannot self-onboard', async () => {
  const result = await consumeHostPlan(new URL('../profiles/unverified-host.json', import.meta.url));
  assert.equal(result.state, 'unsupported_host');
  assert.equal(result.selectedConnectionRoute, null);
  assert.equal(result.selectedDeliveryMode, null);
  assert.equal(result.plannedHelperInvocation, null);
  for (const key of ['readSkill', 'privateStorage', 'outboundHttps']) {
    const profile = supportedProfile();
    profile.capabilities[key] = false;
    assert.deepEqual(planHost(manifest, profile).missingCapabilities, [key]);
  }
  const profile = supportedProfile();
  profile.capabilities.invokeTrustedHelper = false;
  assert.deepEqual(planHost(manifest, profile).missingCapabilities, ['supported_connection_route']);
});

test('cloud-only MCP, reviewed provider and REST routes do not require a local helper', () => {
  for (const [capability, route] of [
    ['remoteMcpOAuth', 'remote_mcp_oauth'],
    ['providerConnector', 'provider_connector'],
    ['authenticatedRest', 'authenticated_rest'],
  ]) {
    const profile = supportedProfile(route);
    profile.capabilities.invokeTrustedHelper = false;
    profile.capabilities[capability] = true;
    const result = planHost(manifest, profile);
    assert.equal(result.state, 'contract_blocked');
    assert.equal(result.liveEnrollmentAllowed, false);
    assert.equal(result.selectedConnectionRoute, null);
    assert.equal(result.selectedDeliveryMode, null);
    assert.ok(result.candidateConnectionRoutes.includes(route));
    assert.equal(result.plannedHelperInvocation, null);
  }
});

test('connection route and closed-app wake are independently assessed', () => {
  const profile = supportedProfile('remote-mcp-host');
  profile.capabilities.invokeTrustedHelper = false;
  profile.capabilities.remoteMcpOAuth = true;
  profile.capabilities.providerInvocation = true;
  const before = planHost(manifest, profile);
  assert.equal(before.selectedConnectionRoute, null);
  assert.equal(before.selectedDeliveryMode, null);
  profile.evidence = [evidenceFor(profile, 'provider', 'remote_mcp_oauth')];
  const after = planHost(manifest, profile);
  assert.equal(after.selectedConnectionRoute, null);
  assert.equal(after.selectedDeliveryMode, null);
  assert.equal(after.liveEnrollmentAllowed, false);
  assert.equal(after.plannedHelperInvocation, null);
});

test('wake evidence for one connection route cannot certify another route', () => {
  const profile = supportedProfile('multi-route-host');
  profile.capabilities.authenticatedRest = true;
  profile.capabilities.persistentProcess = true;
  profile.capabilities.sse = true;
  profile.evidence = [evidenceFor(profile, 'envoi_link', 'authenticated_rest')];
  const restProven = planHost(manifest, profile, v1Availability({ rest: true }));
  assert.equal(restProven.selectedConnectionRoute, 'authenticated_rest');
  assert.equal(restProven.reachability, 'unattended_evidence_recorded');
  profile.evidence[0].checks.closedAppWake = { result: 'unproven' };
  const noProvenWake = planHost(manifest, profile, v1Availability({ rest: true }));
  assert.equal(noProvenWake.selectedConnectionRoute, 'local_helper');
  assert.equal(noProvenWake.selectedDeliveryMode, 'envoi_link');
  assert.equal(noProvenWake.reachability, 'not_verified_closed_app');
});

test('capability flags and an open-chat reply do not establish unattended reachability', () => {
  const profile = supportedProfile();
  for (const key of Object.keys(profile.capabilities)) profile.capabilities[key] = true;
  assert.equal(planHost(manifest, profile, v1Availability()).reachability, 'not_verified_closed_app');
  const evidence = evidenceFor(profile, 'envoi_link');
  evidence.checks.closedAppWake = { result: 'unproven' };
  profile.evidence = [evidence];
  assert.equal(planHost(manifest, profile, v1Availability()).reachability, 'not_verified_closed_app');
});

test('host wake evidence alone cannot select any mode without server availability', () => {
  const profile = supportedProfile();
  for (const key of Object.keys(profile.capabilities)) profile.capabilities[key] = true;
  const ordered = ['provider', 'webhook', 'envoi_link', 'poll'];
  profile.evidence = ordered.map((mode) => evidenceFor(profile, mode));
  for (const mode of ordered) {
    const result = planHost(manifest, profile);
    assert.equal(result.selectedDeliveryMode, null);
    assert.equal(result.reachability, 'unavailable');
    assert.equal(result.liveEnrollmentAllowed, false);
    profile.evidence.shift();
  }
  assert.equal(planHost(manifest, profile).selectedDeliveryMode, null);
});

test('restart, duplicate wake, pause, revocation and secret isolation are mandatory', () => {
  for (const check of requiredChecks) {
    for (const result of ['fail', 'unproven', 'missing']) {
      const profile = supportedProfile();
      profile.capabilities.persistentProcess = true;
      profile.capabilities.sse = true;
      const evidence = evidenceFor(profile, 'envoi_link');
      if (result === 'missing') delete evidence.checks[check];
      else evidence.checks[check] = { result };
      profile.evidence = [evidence];
      const plan = planHost(manifest, profile, v1Availability());
      assert.equal(plan.selectedDeliveryMode, 'envoi_link', `${check}: ${result}`);
      assert.equal(plan.reachability, 'not_verified_closed_app', `${check}: ${result}`);
    }
  }
});

test('evidence is scoped to runtime version and host and requires release/integration pins', () => {
  for (const key of ['id', 'version', 'hostId']) {
    const profile = supportedProfile();
    const evidence = evidenceFor(profile, 'provider');
    evidence.runtime[key] = 'different';
    profile.evidence = [evidence];
    assert.throws(() => planHost(manifest, profile), /Evidence must pin/);
  }
  for (const key of ['releaseSha', 'integrationVersion']) {
    const profile = supportedProfile();
    const evidence = evidenceFor(profile, 'provider');
    delete evidence[key];
    profile.evidence = [evidence];
    assert.throws(() => planHost(manifest, profile));
  }
});

test('SSE needs a persistent process and evidence cannot invent host capabilities', () => {
  const profile = supportedProfile();
  profile.capabilities.sse = true;
  profile.evidence = [evidenceFor(profile, 'envoi_link')];
  assert.equal(planHost(manifest, profile).selectedDeliveryMode, null);
  profile.capabilities.persistentProcess = true;
  assert.equal(planHost(manifest, profile, v1Availability()).selectedDeliveryMode, 'envoi_link');
});

test('agent-registration v1 availability, not a host claim, controls the offered route and mode', () => {
  const local = supportedProfile('local-host');
  local.capabilities.persistentProcess = true;
  local.capabilities.sse = true;
  local.evidence = [evidenceFor(local, 'envoi_link')];
  assert.equal(planHost(manifest, local).selectedConnectionRoute, null);
  assert.equal(planHost(manifest, local, v1Availability({ enabled: false })).selectedConnectionRoute, null);
  const offered = planHost(manifest, local, v1Availability());
  assert.equal(offered.selectedConnectionRoute, 'local_helper');
  assert.equal(offered.selectedDeliveryMode, 'envoi_link');
  assert.equal(offered.liveEnrollmentAllowed, false);
  assert.deepEqual(offered.plannedHelperInvocation, {
    executable: 'envoi-link', args: ['connect', 'https://www.envoi-agents.com'],
  });
  const unverified = structuredClone(local);
  unverified.evidence = [];
  const declared = planHost(manifest, unverified, v1Availability());
  assert.equal(declared.selectedDeliveryMode, 'envoi_link');
  assert.equal(declared.reachability, 'not_verified_closed_app');
  assert.equal(declared.liveEnrollmentAllowed, false);

  const rest = supportedProfile('rest-host');
  rest.capabilities.invokeTrustedHelper = false;
  rest.capabilities.authenticatedRest = true;
  rest.capabilities.persistentProcess = true;
  rest.capabilities.sse = true;
  rest.evidence = [evidenceFor(rest, 'envoi_link', 'authenticated_rest')];
  assert.equal(planHost(manifest, rest, v1Availability()).selectedConnectionRoute, null);
  const restOffered = planHost(manifest, rest, v1Availability({ rest: true }));
  assert.equal(restOffered.selectedConnectionRoute, 'authenticated_rest');
  assert.equal(restOffered.selectedDeliveryMode, 'envoi_link');
  assert.equal(restOffered.plannedHelperInvocation, null);
});

test('unavailable remote, provider, poll and on-demand modes cannot be selected by synthetic evidence', () => {
  const profile = supportedProfile('multi-route-host');
  for (const key of Object.keys(profile.capabilities)) profile.capabilities[key] = true;
  profile.evidence = [
    evidenceFor(profile, 'provider', 'remote_mcp_oauth'),
    evidenceFor(profile, 'webhook', 'provider_connector'),
    evidenceFor(profile, 'poll', 'local_helper'),
  ];
  const result = planHost(manifest, profile, v1Availability());
  assert.equal(result.selectedConnectionRoute, 'local_helper');
  assert.equal(result.selectedDeliveryMode, 'envoi_link');
  assert.deepEqual(result.candidateDeliveryModes, ['envoi_link']);
  assert.equal(result.reachability, 'not_verified_closed_app');
  assert.equal(result.nextAction, 'await_phase_b_server_and_hosted_gate');
});

test('malformed or incomplete route availability is rejected rather than guessed', () => {
  for (const availability of [
    { ...v1Availability(), routes: [] },
    { ...v1Availability(), deliveryModes: [{ deliveryMode: 'on_demand', available: true }] },
    { ...v1Availability(), contract: { id: 'unknown', version: 1 } },
    { ...v1Availability(), routes: v1Availability().routes.map((item) => ({ ...item, available: 'true' })) },
  ]) {
    assert.throws(() => planHost(manifest, supportedProfile(), availability), /Invalid route availability/);
  }
});

test('evidence from a different Envoi release or integration cannot qualify the current host', () => {
  for (const change of [{ releaseSha: 'b'.repeat(40) }, { integrationVersion: 'new-integration' }, { releaseSha: null, integrationVersion: null }]) {
    const profile = supportedProfile();
    profile.capabilities.persistentProcess = true;
    profile.capabilities.sse = true;
    profile.evidence = [evidenceFor(profile, 'envoi_link')];
    profile.target = { ...profile.target, ...change };
    assert.equal(planHost(manifest, profile, v1Availability()).reachability, 'not_verified_closed_app');
  }
});

test('unknown fields, truthy flags and URL secrets are rejected without echoing input', () => {
  const profile = supportedProfile();
  profile.accessToken = 'test-secret-never-output';
  assert.throws(() => planHost(manifest, profile), /Invalid host-plan input/);
  delete profile.accessToken;
  profile.capabilities.providerInvocation = 'true';
  assert.throws(() => planHost(manifest, profile), /explicit booleans/);
  profile.capabilities.providerInvocation = true;
  for (const reference of ['http://example.invalid/proof', 'https://user:secret@example.invalid/proof', 'https://example.invalid/proof?token=secret']) {
    const evidence = evidenceFor(profile, 'provider');
    evidence.checks.closedAppWake.reference = reference;
    profile.evidence = [evidence];
    assert.throws(() => planHost(manifest, profile));
  }
});

test('tampered helper commands, route catalog and published manifests cannot bypass the draft gate', () => {
  for (const change of [
    { published: true },
    { helperCommand: 'malicious-command' },
    { connectUrl: 'https://example.invalid/connect' },
    { connectionRoutes: ['local_helper', 'raw_model_token'] },
    { deliveryModes: ['provider', 'on_demand'] },
    { offeredConnectionRoutes: ['local_helper'] },
    { offeredDeliveryModes: ['envoi_link'] },
  ]) {
    assert.throws(() => planHost({ ...manifest, ...change }, supportedProfile()), /reviewed unpublished/);
  }
});

test('CLI consumes bundled JSON, emits bounded safe output and never runs a helper', () => {
  const command = fileURLToPath(new URL('../host-plan.mjs', import.meta.url));
  const profile = fileURLToPath(new URL('../profiles/unverified-host.json', import.meta.url));
  const result = spawnSync(process.execPath, [command, profile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), planHost(manifest, seed));
  const invalid = spawnSync(process.execPath, [command, 'missing-profile-test-secret'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stderr, /missing-profile-test-secret/);
  assert.equal(invalid.stdout, '');
});

test('a separately trusted deployment origin pins served metadata and fixed helper arguments', () => {
  const origin = 'https://staging.envoi.example';
  const served = {
    ...manifest, connectUrl: `${origin}/connect`, helperCommand: `envoi-link connect ${origin}`,
    offeredConnectionRoutes: ['local_helper'], offeredDeliveryModes: ['envoi_link'],
  };
  const profile = supportedProfile();
  profile.capabilities.persistentProcess = true;
  profile.capabilities.sse = true;
  const result = planHost(served, profile, v1Availability(), { origin: `${origin}/` });
  assert.deepEqual(result.plannedHelperInvocation, { executable: 'envoi-link', args: ['connect', origin] });
  assert.equal(result.liveEnrollmentAllowed, false);
  assert.equal(result.reachability, 'not_verified_closed_app');
  assert.throws(() => planHost(served, profile, v1Availability()), /reviewed unpublished/);
  assert.throws(() => planHost(manifest, profile, v1Availability(), { origin }), /reviewed unpublished/);
});

test('served metadata cannot replace the independently trusted origin or execute a command', () => {
  const origin = 'https://staging.envoi.example';
  const served = { ...manifest, connectUrl: `${origin}/connect`, helperCommand: `envoi-link connect ${origin}` };
  for (const change of [
    { connectUrl: 'https://other.example/connect' },
    { helperCommand: 'envoi-link connect https://other.example' },
    { connectUrl: `${origin}/connect?token=test-secret` },
    { helperCommand: `envoi-link connect ${origin}; malicious-command` },
  ]) {
    assert.throws(() => planHost({ ...served, ...change }, supportedProfile(), null, { origin }), /reviewed unpublished/);
  }
  const profile = supportedProfile();
  profile.origin = origin;
  assert.throws(() => planHost(served, profile, null, { origin }), /Invalid host-plan input/);
});

test('operator origins require clean HTTPS origins without secret-bearing input', () => {
  for (const origin of [
    'http://staging.envoi.example', 'https://user:test-secret@staging.envoi.example',
    'https://staging.envoi.example/path', 'https://staging.envoi.example?token=test-secret',
    'https://staging.envoi.example#test-secret', ' https://staging.envoi.example', null, 123,
  ]) {
    assert.throws(() => planHost(manifest, supportedProfile(), null, { origin }), (error) => {
      assert.doesNotMatch(error.message, /test-secret/);
      return true;
    });
  }
});

test('served offers must match separately validated server availability and never grant a route', () => {
  const served = { ...manifest, offeredConnectionRoutes: ['local_helper'], offeredDeliveryModes: ['envoi_link'] };
  assert.throws(() => planHost(served, supportedProfile()), /reviewed unpublished/);
  assert.throws(() => planHost(served, supportedProfile(), v1Availability({ enabled: false })), /reviewed unpublished/);
  assert.throws(() => planHost({ ...served, offeredConnectionRoutes: ['provider_connector'] }, supportedProfile(), v1Availability()), /reviewed unpublished/);
  assert.throws(() => planHost({ ...served, offeredDeliveryModes: ['provider'] }, supportedProfile(), v1Availability()), /reviewed unpublished/);
  const result = planHost(served, supportedProfile(), v1Availability());
  assert.equal(result.selectedConnectionRoute, 'local_helper');
  assert.equal(result.liveEnrollmentAllowed, false);
});

test('consumer and CLI accept explicit local deployment files without fetching or executing a helper', async (testContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'envoi-host-origin-'));
  testContext.after(() => rm(directory, { recursive: true, force: true }));
  const origin = 'https://staging.envoi.example';
  const served = {
    ...manifest, connectUrl: `${origin}/connect`, helperCommand: `envoi-link connect ${origin}`,
    offeredConnectionRoutes: ['local_helper'], offeredDeliveryModes: ['envoi_link'],
  };
  const profile = supportedProfile();
  const profilePath = join(directory, 'profile.json');
  const manifestPath = join(directory, 'skill.json');
  const availabilityPath = join(directory, 'routes.json');
  await Promise.all([
    writeFile(profilePath, JSON.stringify(profile)), writeFile(manifestPath, JSON.stringify(served)),
    writeFile(availabilityPath, JSON.stringify(v1Availability())),
  ]);
  const expected = planHost(served, profile, v1Availability(), { origin });
  assert.deepEqual(await consumeHostPlan(profilePath, { origin, manifestPath, availabilityPath }), expected);
  const command = fileURLToPath(new URL('../host-plan.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [command, profilePath, '--origin', origin, '--manifest', manifestPath, '--availability', availabilityPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  for (const argumentsList of [
    ['--origin'], ['--unknown', 'test-secret'], ['--origin', origin, '--origin', origin],
    ['__proto__', 'test-secret'], ['constructor', 'test-secret'],
    ['--origin', 'https://user:test-secret@staging.envoi.example'], ['--manifest', '--origin'],
    ['--manifest', manifestPath, '--availability', availabilityPath],
  ]) {
    const rejected = spawnSync(process.execPath, [command, profilePath, ...argumentsList], { encoding: 'utf8' });
    assert.equal(rejected.status, 1, JSON.stringify(argumentsList));
    assert.equal(rejected.stdout, '');
    assert.doesNotMatch(rejected.stderr, /test-secret/);
    assert.match(rejected.stderr, /No helper was executed/);
  }
});

test('local confirmation prefers a host-native prompt and never treats chat as attributable human input', () => {
  const profile = supportedProfile();
  profile.capabilities.persistentProcess = true;
  profile.capabilities.sse = true;
  profile.capabilities.hostNativePrompt = true;
  const native = planHost(manifest, profile, v1Availability());
  assert.equal(native.liveEnrollmentAllowed, false);
  assert.equal(native.plannedApprovalConfirmation.method, 'host_native');
  assert.equal(native.plannedApprovalConfirmation.attributableToHuman, true);
  assert.equal(native.plannedApprovalConfirmation.lifecycle, 'CONFIRMING');
  assert.equal(native.plannedApprovalConfirmation.state, 'confirm_approval');
  assert.equal(native.plannedApprovalConfirmation.onDeclineOrTimeout, 'delete_bootstrap_without_activation');
  delete profile.capabilities.hostNativePrompt;
  const advisory = planApprovalConfirmation(profile);
  assert.equal(advisory.method, 'chat_advisory');
  assert.equal(advisory.attributableToHuman, false);
  assert.equal(advisory.requiresExplicitHumanAnswer, true);
  assert.match(advisory.nextAction, /advisory.*never answer for the human/);
  profile.capabilities.hostNativePrompt = false;
  assert.deepEqual(planApprovalConfirmation(profile), advisory);
  profile.capabilities.hostNativePrompt = 'true';
  assert.throws(() => planApprovalConfirmation(profile), /explicit booleans/);
});

test('local confirmation never attaches to unavailable routes and does not unlock the draft', () => {
  const profile = supportedProfile();
  profile.capabilities.hostNativePrompt = true;
  assert.equal(planHost(manifest, profile).plannedApprovalConfirmation, null);
  assert.equal(planHost(manifest, profile, v1Availability({ enabled: false })).plannedApprovalConfirmation, null);
  assert.equal(planHost(manifest, profile, v1Availability()).liveEnrollmentAllowed, false);
});
