// agent-registration v1 §6.4–§6.5 and §9 (task A-4.1): installation derivation and the owner
// list, checked against every canonical fixture that names an installation. Fixtures with a
// `stored` object are derived from that stored state. Fixtures that only show the response
// (no `stored`) are checked by rebuilding the stored state from x-legacy-projection and
// x-installation-derivation and deriving it back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  deriveInstallations, installationPath, installationSummary, legacyInstallation, legacyInstallationId, legacyInstallationPrefix,
  newestActiveInstallation, ownerInstallationEndedMax, ownerInstallationList, projectsLegacyFamilies, publicInstallation
} from '../src/agent-installations.js';

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures');
const index = JSON.parse(await readFile(path.join(fixturesRoot, 'index.json'), 'utf8'));
const contract = index.contracts.find(entry => entry.id === 'agent-registration');
const contractDir = path.join(fixturesRoot, contract.dir);
const schemas = JSON.parse(await readFile(path.join(contractDir, contract.schemas), 'utf8'));
const fixtures = await Promise.all(contract.fixtures.map(async name => JSON.parse(await readFile(path.join(contractDir, name), 'utf8'))));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schemas);
function assertContract(name, value) {
  const validate = ajv.getSchema(`${schemas.$id}#/definitions/${name}`);
  assert.ok(validate, `schema ${name} exists`);
  assert.ok(validate(value), `${name}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}

const stepsOf = fixture => fixture.steps || [{ request: fixture.request, response: fixture.response }];
const installationSchemas = new Set(['ownerInstallationList', 'agentStatusWithInstallation', 'installationRevoked', 'activated']);
// agent-registration §14.8: a step that changes storage carries storedAfter, which it and later steps read.
const relevantSteps = fixture => {
  let state = fixture.stored;
  return stepsOf(fixture)
    .map((step, stepIndex) => ({ ...step, stepIndex, state: (state = step.storedAfter || state) }))
    .filter(step => [200, 201].includes(step.response?.status) && installationSchemas.has(step.response.schema));
};

const agentIdOf = step => step.response.body.agentId || step.response.body.agent?.id || step.response.body.installation?.agentId;
function storedFor(state, agentId) {
  const { agents = [], credentialFamilies = [], installations = [] } = state;
  return {
    agent: agents.find(agent => agent.id === agentId),
    families: credentialFamilies.filter(family => family.agentId === agentId),
    documents: installations.filter(document => document.agentId === agentId)
  };
}

// The inverse of x-legacy-projection and x-installation-derivation: the stored state that the
// contract says produces these installations. Written independently of the module under test.
const familyPrefix = 'credential_family_';
function rebuildStored(agentId, installations) {
  const families = [];
  const documents = [];
  for (const installation of installations) {
    const revoked = installation.status === 'ended';
    if (installation.legacy) {
      assert.ok(installation.id.startsWith('installation_legacy_'), installation.id);
      families.push({
        id: `${familyPrefix}${installation.id.slice('installation_legacy_'.length)}`,
        agentId,
        inboxId: 'inbox_example',
        createdAt: installation.createdAt,
        refreshExpiresAt: '2099-01-01T00:00:00.000Z',
        revokedAt: revoked ? installation.endedAt : null,
        ...(revoked ? { revokedReason: installation.endedReason } : {}),
        ...(installation.runtime.type === 'unknown' ? {} : { runtime: installation.runtime.type })
      });
    } else {
      const familyId = `${familyPrefix}for_${installation.id}`;
      const replay = installation.endedReason === 'activation_replay';
      families.push({
        id: familyId,
        agentId,
        inboxId: 'inbox_example',
        createdAt: installation.createdAt,
        refreshExpiresAt: '2099-01-01T00:00:00.000Z',
        revokedAt: revoked ? installation.endedAt : null,
        ...(revoked ? { revokedReason: replay ? 'revoked' : installation.endedReason } : {}),
        runtime: installation.runtime.type,
        installationId: installation.id
      });
      documents.push({
        id: installation.id,
        agentId,
        credentialFamilyId: familyId,
        registrationId: 'registration_example',
        connectionRoute: installation.connectionRoute,
        deliveryMode: installation.deliveryMode,
        runtime: installation.runtime,
        createdAt: installation.createdAt,
        activatedAt: installation.activatedAt,
        replayDetectedAt: replay ? installation.endedAt : null
      });
    }
  }
  return { agent: { id: agentId, onboardingStatus: 'approved' }, families, documents };
}

// A summary in agent status carries no timestamps; widen it to a full active installation.
const fromSummary = (agentId, summary) => ({
  ...summary,
  agentId,
  runtime: { type: 'hermes', version: summary.legacy ? null : '0.9.0' },
  status: 'active',
  endedReason: null,
  createdAt: '2026-10-12T12:03:20.000Z',
  activatedAt: '2026-10-12T12:03:20.000Z',
  endedAt: null
});

const exercised = new Map();
const mark = (fixture, step, how) => exercised.set(`${fixture.id}#${step.stepIndex}`, how);

for (const fixture of fixtures) {
  for (const step of relevantSteps(fixture)) {
    const agentId = agentIdOf(step);
    const label = `${fixture.id} step ${step.stepIndex} (${step.response.schema}${fixture.stored ? ', stored' : ', rebuilt'})`;

    test(`fixture ${label}`, () => {
      const body = step.response.body;
      assertContract(step.response.schema, body);

      if (fixture.stored) {
        const { agent, families, documents } = storedFor(step.state, agentId);
        assert.ok(agent, `${fixture.id}: stored agent ${agentId}`);
        assertContract('storedAgent', agent);
        for (const family of families) assertContract('storedCredentialFamily', family);
        for (const document of documents) assertContract('storedInstallation', document);
        const derived = deriveInstallations(agent, families, documents);

        if (step.response.schema === 'ownerInstallationList') {
          const actual = ownerInstallationList(agentId, derived);
          assertContract('ownerInstallationList', actual);
          assert.deepEqual(actual, body);
        } else if (step.response.schema === 'agentStatusWithInstallation') {
          const active = derived.filter(installation => installation.status === 'active');
          for (const installation of derived) assertContract('installation', publicInstallation(installation));
          if (body.installation) {
            // The calling family is determinable when the agent has exactly one active installation.
            assert.equal(active.length, 1, `${fixture.id}: exactly one active installation is the caller's`);
            const summary = installationSummary(active[0]);
            assertContract('installationSummary', summary);
            assert.deepEqual(summary, body.installation);
            assert.deepEqual(installationSummary(newestActiveInstallation(derived)), body.installation);
          } else {
            // §6.4: the field is present exactly when ENVOI_INSTALLATIONS_V2 is on.
            assert.equal(fixture.flags?.ENVOI_INSTALLATIONS_V2, false, `${fixture.id}: no installation field only with the flag off`);
            assert.equal(active.length, 1, `${fixture.id}: the agent keeps one active installation`);
            assertContract('installationSummary', installationSummary(active[0]));
          }
        } else {
          const expected = body.installation;
          const match = derived.find(installation => installation.id === expected.id);
          assert.ok(match, `${fixture.id}: ${expected.id} derived`);
          assert.deepEqual(publicInstallation(match), expected);
        }
      } else {
        let expected;
        if (step.response.schema === 'ownerInstallationList') expected = body.installations;
        else if (['installationRevoked', 'activated'].includes(step.response.schema)) expected = [body.installation];
        else expected = [fromSummary(agentId, body.installation)];
        const { agent, families, documents } = rebuildStored(agentId, expected);
        for (const family of families) assertContract('storedCredentialFamily', family);
        for (const document of documents) assertContract('storedInstallation', document);
        const derived = deriveInstallations(agent, families, documents);

        if (step.response.schema === 'ownerInstallationList') {
          const actual = ownerInstallationList(agentId, derived);
          assertContract('ownerInstallationList', actual);
          assert.deepEqual(actual, body);
        } else if (step.response.schema === 'installationRevoked') {
          const actual = { installation: publicInstallation(derived[0]) };
          assertContract('installationRevoked', actual);
          assert.deepEqual(actual, body);
        } else if (step.response.schema === 'activated') {
          const actual = publicInstallation(derived[0]);
          assertContract('installation', actual);
          assert.deepEqual(actual, body.installation);
          assert.equal(newestActiveInstallation(derived).id, body.installation.id);
        } else {
          const summary = installationSummary(newestActiveInstallation(derived));
          assertContract('installationSummary', summary);
          assert.deepEqual(summary, body.installation);
        }
      }
      mark(fixture, step, fixture.stored ? 'stored' : 'rebuilt');
    });
  }
}

test('fixture coverage: the minimum installation fixtures were exercised', () => {
  const required = [
    'migration-legacy-family#0', 'migration-legacy-family#1',
    'owner-installations#0', 'owner-installations-legacy-several#0', 'owner-installations-frozen-agent#0',
    'reenable-after-rollback#0', 'reconnect-after-installation-revoke#0', 'rollback-flags-off#0',
    'agent-status-installation#0', 'agent-status-legacy-address#0', 'owner-installation-revoke#0'
  ];
  for (const key of required) assert.ok(exercised.has(key), `${key} exercised (got ${[...exercised.keys()].join(', ')})`);
  for (const id of ['migration-legacy-family', 'owner-installations-legacy-several', 'owner-installations-frozen-agent', 'reenable-after-rollback', 'reconnect-after-installation-revoke', 'rollback-flags-off']) {
    assert.equal(exercised.get(`${id}#0`), 'stored', `${id} derived from its stored state`);
  }
});

// ---- unit tests ----

const agent = (onboardingStatus = 'approved', extra = {}) => ({ id: 'agent_unit', onboardingStatus, ...extra });
const family = (suffix, extra = {}) => ({
  id: `credential_family_${suffix}`,
  agentId: 'agent_unit',
  inboxId: 'inbox_unit',
  createdAt: '2026-10-01T00:00:00.000Z',
  refreshExpiresAt: '2099-01-01T00:00:00.000Z',
  revokedAt: null,
  ...extra
});
const document = (id, familyId, extra = {}) => ({
  id,
  agentId: 'agent_unit',
  credentialFamilyId: familyId,
  registrationId: 'registration_unit',
  connectionRoute: 'local_helper',
  deliveryMode: 'envoi_link',
  runtime: { type: 'hermes', version: '1.0.0' },
  createdAt: '2026-10-02T00:00:00.000Z',
  activatedAt: '2026-10-02T00:00:00.000Z',
  replayDetectedAt: null,
  ...extra
});
const ts = n => new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString();

test('legacyInstallationId strips exactly one leading credential_family_ prefix', () => {
  assert.equal(legacyInstallationPrefix, 'installation_legacy_');
  assert.equal(legacyInstallationId('credential_family_0b6f8f9e-1c2d'), 'installation_legacy_0b6f8f9e-1c2d');
  assert.equal(legacyInstallationId('credential_family_credential_family_x'), 'installation_legacy_credential_family_x');
  assert.equal(legacyInstallationId('family_abc'), 'installation_legacy_family_abc');
  assert.equal(legacyInstallationId('x_credential_family_abc'), 'installation_legacy_x_credential_family_abc');
});

test('legacy projection follows x-legacy-projection field by field', () => {
  const projected = legacyInstallation(agent('approved', { runtime: 'openclaw' }), family('a', { runtime: 'hermes', createdAt: ts(5) }));
  assert.deepEqual(projected, {
    id: 'installation_legacy_a', agentId: 'agent_unit', connectionRoute: 'local_helper', deliveryMode: 'envoi_link',
    runtime: { type: 'hermes', version: null }, status: 'active', endedReason: null, endedAt: null, legacy: true,
    createdAt: ts(5), activatedAt: ts(5), familyId: 'credential_family_a'
  });
  assert.deepEqual(legacyInstallation(agent('approved', { runtime: 'openclaw' }), family('b')).runtime, { type: 'openclaw', version: null });
  assert.deepEqual(legacyInstallation(agent(), family('c')).runtime, { type: 'unknown', version: null });
  const ended = legacyInstallation(agent(), family('d', { revokedAt: ts(9) }));
  assert.deepEqual([ended.status, ended.endedReason, ended.endedAt], ['ended', 'revoked', ts(9)]);
  assertContract('installation', publicInstallation(ended));
  assert.equal('familyId' in publicInstallation(ended), false);
});

test('an expired but unrevoked family stays active', () => {
  const [installation] = deriveInstallations(agent(), [family('e', { refreshExpiresAt: '2000-01-01T00:00:00.000Z' })], []);
  assert.equal(installation.status, 'active');
  assert.equal(installation.endedReason, null);
});

test('a family with an installationId but no matching document is not projected at all', () => {
  const orphan = family('orphan', { installationId: 'installation_missing' });
  assert.deepEqual(deriveInstallations(agent(), [orphan], []), []);
  // A document whose id differs from the family's installationId does not match either.
  assert.deepEqual(deriveInstallations(agent(), [orphan], [document('installation_other', orphan.id)]), []);
  // A document keyed to another family is not used.
  assert.deepEqual(deriveInstallations(agent(), [orphan], [document('installation_missing', 'credential_family_elsewhere')]), []);
  // Only the matching document projects it, as non-legacy.
  const [stored] = deriveInstallations(agent(), [orphan], [document('installation_missing', orphan.id)]);
  assert.equal(stored.id, 'installation_missing');
  assert.equal(stored.legacy, false);
});

test('pending and rejected agents have no legacy installations; approved and frozen agents do', () => {
  const families = [family('p1'), family('p2', { revokedAt: ts(3) })];
  for (const status of ['pending_approval', 'rejected', undefined]) {
    const unapproved = { id: 'agent_unit', onboardingStatus: status };
    assert.equal(projectsLegacyFamilies(unapproved), false, String(status));
    assert.deepEqual(deriveInstallations(unapproved, families, []), [], String(status));
  }
  assert.deepEqual(deriveInstallations(null, families, []), []);
  for (const status of ['approved', 'revoked']) {
    assert.equal(projectsLegacyFamilies(agent(status)), true, status);
    assert.equal(deriveInstallations(agent(status), families, []).length, 2, status);
  }
});

test('activation_replay comes only from replayDetectedAt on a stored installation', () => {
  const replayed = family('r1', { installationId: 'installation_r1', revokedAt: ts(10), revokedReason: 'refresh_replay' });
  const plain = family('r2', { installationId: 'installation_r2', revokedAt: ts(11), revokedReason: 'refresh_replay' });
  const legacy = family('r3', { revokedAt: ts(12), revokedReason: 'refresh_replay' });
  const unrevoked = family('r4', { installationId: 'installation_r4' });
  const derived = deriveInstallations(agent(), [replayed, plain, legacy, unrevoked], [
    document('installation_r1', replayed.id, { replayDetectedAt: ts(10) }),
    document('installation_r2', plain.id),
    document('installation_r4', unrevoked.id, { replayDetectedAt: ts(9) })
  ]);
  const byId = Object.fromEntries(derived.map(item => [item.id, item]));
  assert.deepEqual([byId.installation_r1.status, byId.installation_r1.endedReason, byId.installation_r1.endedAt], ['ended', 'activation_replay', ts(10)]);
  assert.deepEqual([byId.installation_r2.status, byId.installation_r2.endedReason], ['ended', 'refresh_replay']);
  assert.deepEqual([byId.installation_legacy_r3.status, byId.installation_legacy_r3.endedReason], ['ended', 'refresh_replay']);
  // replayDetectedAt alone does not end an installation: status follows the family.
  assert.deepEqual([byId.installation_r4.status, byId.installation_r4.endedReason, byId.installation_r4.endedAt], ['active', null, null]);
  // A revoked family with no revokedReason defaults to revoked.
  const [defaulted] = deriveInstallations(agent(), [family('r5', { installationId: 'installation_r5', revokedAt: ts(13) })], [document('installation_r5', 'credential_family_r5')]);
  assert.equal(defaulted.endedReason, 'revoked');
  for (const item of derived) assertContract('installation', publicInstallation(item));
});

test('stored installations take derived state from the family and immutable fields from the document', () => {
  const fam = family('s1', { installationId: 'installation_s1', runtime: 'openclaw', createdAt: ts(1), revokedAt: ts(20), revokedReason: 'replaced' });
  const [installation] = deriveInstallations(agent(), [fam], [document('installation_s1', fam.id, { createdAt: ts(2), activatedAt: ts(3) })]);
  assert.deepEqual(publicInstallation(installation), {
    id: 'installation_s1', agentId: 'agent_unit', connectionRoute: 'local_helper', deliveryMode: 'envoi_link',
    runtime: { type: 'hermes', version: '1.0.0' }, status: 'ended', endedReason: 'replaced', endedAt: ts(20),
    legacy: false, createdAt: ts(2), activatedAt: ts(3)
  });
  assert.equal(installation.familyId, fam.id);
});

test('ownerInstallationList keeps every active installation and only the five newest ended ones', () => {
  assert.equal(ownerInstallationEndedMax, 5);
  const families = [];
  for (let n = 1; n <= 7; n += 1) families.push(family(`active${n}`, { createdAt: ts(n) }));
  // Ended families in scrambled createdAt order, so endedAt order differs from activatedAt order.
  const endedAt = [40, 33, 47, 31, 45, 38, 42, 36];
  endedAt.forEach((minute, n) => families.push(family(`ended${n}`, { createdAt: ts(20 - n), revokedAt: ts(minute), revokedReason: 'replaced' })));
  const derived = deriveInstallations(agent(), families, []);
  const list = ownerInstallationList('agent_unit', derived);
  assertContract('ownerInstallationList', list);
  const active = list.installations.filter(item => item.status === 'active');
  const ended = list.installations.filter(item => item.status === 'ended');
  assert.equal(active.length, 7, 'active installations are never capped');
  assert.deepEqual(active.map(item => item.id), [7, 6, 5, 4, 3, 2, 1].map(n => `installation_legacy_active${n}`), 'newest activatedAt first');
  assert.deepEqual(ended.map(item => item.endedAt), [47, 45, 42, 40, 38].map(ts), 'five newest endedAt first');
  assert.deepEqual(list.installations.slice(0, 7), active, 'active entries come first');
  assert.ok(list.installations.every(item => !('familyId' in item)));
  // The cap is a parameter; zero shows only active installations.
  assert.deepEqual(ownerInstallationList('agent_unit', derived, 0).installations.map(item => item.status), Array(7).fill('active'));
  assert.deepEqual(ownerInstallationList('agent_unit', []), { agentId: 'agent_unit', installations: [] });
});

test('ended entries with the same endedAt are ordered by id, newest first', () => {
  const derived = deriveInstallations(agent(), ['a', 'c', 'b'].map(suffix => family(suffix, { revokedAt: ts(30) })), []);
  assert.deepEqual(ownerInstallationList('agent_unit', derived).installations.map(item => item.id), ['installation_legacy_c', 'installation_legacy_b', 'installation_legacy_a']);
});

test('newestActiveInstallation is the active installation with the newest activatedAt', () => {
  assert.equal(newestActiveInstallation([]), null);
  const fam = family('n1', { installationId: 'installation_n1' });
  const derived = deriveInstallations(agent(), [
    family('old', { createdAt: ts(1) }),
    family('newest_but_ended', { createdAt: ts(50), revokedAt: ts(51) }),
    fam
  ], [document('installation_n1', fam.id, { activatedAt: ts(40) })]);
  assert.equal(newestActiveInstallation(derived).id, 'installation_n1');
  assert.equal(newestActiveInstallation(derived.filter(item => item.status === 'ended')), null);
  assert.equal(newestActiveInstallation(deriveInstallations(agent(), [family('only', { revokedAt: ts(2) })], [])), null);
});

test('installationSummary and installationPath have the contract shapes', () => {
  const [installation] = deriveInstallations(agent(), [family('sum')], []);
  const summary = installationSummary(installation);
  assertContract('installationSummary', summary);
  assert.deepEqual(summary, { id: 'installation_legacy_sum', connectionRoute: 'local_helper', deliveryMode: 'envoi_link', legacy: true });
  assert.equal(installationPath('inbox_a', 'agent_b', 'installation_c'), path.join('auth', 'agent-installations', 'inbox_a', 'agent_b', 'installation_c.json'));
});
