import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { consumeHostPlan, planHost, requiredChecks } from '../host-plan.mjs';

const manifest = JSON.parse(await readFile(new URL('../skill/skill.json', import.meta.url), 'utf8'));
const seed = JSON.parse(await readFile(new URL('../profiles/unverified-host.json', import.meta.url), 'utf8'));

function supportedProfile(runtime = 'arbitrary-agent') {
  const profile = structuredClone(seed);
  profile.runtime = { id: runtime, version: '1.0', hostId: 'test-host' };
  profile.target = { releaseSha: 'a'.repeat(40), helperVersion: 'test-only' };
  for (const key of ['invokeTrustedHelper', 'privateStorage', 'outboundHttps']) profile.capabilities[key] = true;
  return profile;
}

function evidenceFor(profile, mode) {
  return {
    mode, runtime: { ...profile.runtime }, releaseSha: 'a'.repeat(40), helperVersion: 'test-only',
    checks: Object.fromEntries(requiredChecks.map((key) => [key, {
      result: 'pass', reference: `https://example.invalid/test-fixture/${key}`,
    }])),
  };
}

test('Muse, Instinct, Dots and arbitrary hosts use the same skill and helper plan', () => {
  for (const runtime of ['muse', 'instinct', 'chatgpt-dots', 'arbitrary-agent', 'hermes', 'openclaw']) {
    const result = planHost(manifest, supportedProfile(runtime));
    assert.equal(result.selectedMode, 'on_demand');
    assert.equal(result.liveEnrollmentAllowed, false);
    assert.deepEqual(result.plannedHelperInvocation, {
      executable: 'envoi-link', args: ['connect', 'https://www.envoi-agents.com'],
    });
  }
});

test('reading a skill without a trusted helper or private storage cannot self-onboard', async () => {
  const result = await consumeHostPlan(new URL('../profiles/unverified-host.json', import.meta.url));
  assert.equal(result.state, 'unsupported_host');
  assert.equal(result.selectedMode, null);
  assert.equal(result.plannedHelperInvocation, null);
  for (const key of ['readSkill', 'invokeTrustedHelper', 'privateStorage', 'outboundHttps']) {
    const profile = supportedProfile();
    profile.capabilities[key] = false;
    assert.deepEqual(planHost(manifest, profile).missingCapabilities, [key]);
  }
});

test('capability flags and an open-chat reply do not establish unattended reachability', () => {
  const profile = supportedProfile();
  for (const key of Object.keys(profile.capabilities)) profile.capabilities[key] = true;
  assert.equal(planHost(manifest, profile).selectedMode, 'on_demand');
  const evidence = evidenceFor(profile, 'provider');
  evidence.checks.closedAppWake = { result: 'unproven' };
  profile.evidence = [evidence];
  assert.equal(planHost(manifest, profile).reachability, 'on_demand');
});

test('v3 section 45 priority considers only capable modes with complete evidence', () => {
  const profile = supportedProfile();
  for (const key of Object.keys(profile.capabilities)) profile.capabilities[key] = true;
  const ordered = ['provider', 'webhook', 'envoi_link', 'poll'];
  profile.evidence = ordered.map((mode) => evidenceFor(profile, mode));
  for (const mode of ordered) {
    const result = planHost(manifest, profile);
    assert.equal(result.selectedMode, mode);
    assert.equal(result.reachability, 'unattended_evidence_recorded');
    assert.equal(result.liveEnrollmentAllowed, false);
    profile.evidence.shift();
  }
  assert.equal(planHost(manifest, profile).selectedMode, 'on_demand');
});

test('restart, duplicate wake, pause, revocation and secret isolation are mandatory', () => {
  for (const check of requiredChecks) {
    for (const result of ['fail', 'unproven', 'missing']) {
      const profile = supportedProfile();
      profile.capabilities.scheduledPolling = true;
      const evidence = evidenceFor(profile, 'poll');
      if (result === 'missing') delete evidence.checks[check];
      else evidence.checks[check] = { result };
      profile.evidence = [evidence];
      assert.equal(planHost(manifest, profile).selectedMode, 'on_demand', `${check}: ${result}`);
    }
  }
});

test('evidence is scoped to runtime version and host and requires release/helper pins', () => {
  for (const key of ['id', 'version', 'hostId']) {
    const profile = supportedProfile();
    const evidence = evidenceFor(profile, 'provider');
    evidence.runtime[key] = 'different';
    profile.evidence = [evidence];
    assert.throws(() => planHost(manifest, profile), /Evidence must pin/);
  }
  for (const key of ['releaseSha', 'helperVersion']) {
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
  assert.equal(planHost(manifest, profile).selectedMode, 'on_demand');
  profile.capabilities.persistentProcess = true;
  assert.equal(planHost(manifest, profile).selectedMode, 'envoi_link');
});

test('evidence from a different Envoi release or helper cannot qualify the current host', () => {
  for (const change of [{ releaseSha: 'b'.repeat(40) }, { helperVersion: 'new-helper' }, { releaseSha: null, helperVersion: null }]) {
    const profile = supportedProfile();
    profile.capabilities.providerInvocation = true;
    profile.evidence = [evidenceFor(profile, 'provider')];
    profile.target = { ...profile.target, ...change };
    assert.equal(planHost(manifest, profile).selectedMode, 'on_demand');
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

test('tampered helper commands and published manifests cannot bypass the draft gate', () => {
  for (const change of [{ published: true }, { helperCommand: 'malicious-command' }, { connectUrl: 'https://example.invalid/connect' }]) {
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
