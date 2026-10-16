// agent-registration v1 §1 and §12: the Phase B server flags and the routes body built from them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { onboardingFlagErrors, onboardingFlagNames, readOnboardingFlags, routeAvailability } from '../src/onboarding-flags.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures', 'agent-registration');
const readFixture = async name => JSON.parse(await readFile(path.join(fixtureDir, name), 'utf8'));
const schemas = await readFixture('schemas.json');
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schemas);
function assertContract(name, value) {
  const validate = ajv.getSchema(`${schemas.$id}#/definitions/${name}`);
  assert.ok(validate(value), `${name}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}

const off = { installations: false, registration: false, authenticatedRest: false };

test('every onboarding flag defaults off', () => {
  assert.deepEqual(readOnboardingFlags({}), off);
  assert.deepEqual(readOnboardingFlags(Object.fromEntries(onboardingFlagNames.map(name => [name, '']))), off);
  assert.deepEqual(readOnboardingFlags(Object.fromEntries(onboardingFlagNames.map(name => [name, 'false']))), off);
  assert.deepEqual(onboardingFlagErrors({}), []);
});

test('only the exact string true turns a flag on', () => {
  assert.deepEqual(readOnboardingFlags({ ENVOI_INSTALLATIONS_V2: 'true' }), { ...off, installations: true });
  assert.deepEqual(readOnboardingFlags({ ENVOI_INSTALLATIONS_V2: 'true', ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_AUTHENTICATED_REST_ROUTE: 'true' }),
    { installations: true, registration: true, authenticatedRest: true });
  for (const name of onboardingFlagNames) {
    for (const value of ['TRUE', '1', 'True', 'yes', 'on', ' true']) {
      assert.throws(() => readOnboardingFlags({ ENVOI_INSTALLATIONS_V2: 'true', [name]: value }), new RegExp(`${name} must be true or false`));
    }
  }
});

test('registration without installations fails closed', () => {
  assert.throws(() => readOnboardingFlags({ ENVOI_AGENT_REGISTRATION_V2: 'true' }), /ENVOI_AGENT_REGISTRATION_V2 requires ENVOI_INSTALLATIONS_V2/);
  assert.throws(() => readOnboardingFlags({ ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_INSTALLATIONS_V2: 'false' }), /requires ENVOI_INSTALLATIONS_V2/);
  assert.deepEqual(onboardingFlagErrors({ ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_INSTALLATIONS_V2: 'TRUE' }),
    ['ENVOI_INSTALLATIONS_V2 must be true or false', 'ENVOI_AGENT_REGISTRATION_V2 requires ENVOI_INSTALLATIONS_V2']);
});

for (const name of ['routes-available.json', 'routes-available-rest.json', 'routes-disabled.json']) {
  test(`routeAvailability matches the ${name} fixture`, async () => {
    const fixture = await readFixture(name);
    const env = Object.fromEntries(Object.entries(fixture.flags).map(([flag, on]) => [flag, String(on)]));
    const body = routeAvailability(readOnboardingFlags(env), fixture.response.body.asOf);
    assert.deepEqual(body, fixture.response.body);
    assertContract(fixture.response.schema, body);
    assertContract('routeAvailability', routeAvailability(readOnboardingFlags(env)));
  });
}
