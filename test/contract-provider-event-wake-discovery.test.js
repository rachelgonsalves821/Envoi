// Publication validation only; no runtime or provider is contacted.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv from 'ajv';

const read = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));
const [registry, schema, fixture, original] = await Promise.all([
  read('./contract-fixtures/index.json'),
  read('./contract-fixtures/provider-event-wake-discovery/schemas.json'),
  read('./contract-fixtures/provider-event-wake-discovery/discover-events-capability.json'),
  read('./contract-fixtures/provider-event-wake/discover-events-capability.json')
]);
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(schema);
const validate = ajv.getSchema(`${schema.$id}#/definitions/discoveryResult`);

test('discovery amendment is separately approved and supersedes only the original discovery result', () => {
  const entry = registry.contracts.find(contract => contract.id === 'provider-event-wake-discovery');
  assert.equal(entry.version, 1);
  assert.equal(entry.status, 'approved');
  assert.deepEqual(entry.fixtures, ['discover-events-capability.json']);
  assert.deepEqual(schema['x-amends'], { contract: 'provider-event-wake', version: 1, section: '2 MCP Events discovery', fixture: 'discover-events-capability.json' });
  assert.equal(schema['x-approval'].proposalSha256, '637ff3a31d2d0e0c86e8fbb761c6240394b9739cc9c0c034023f98d8467c1219');
  assert.deepEqual(fixture.request, original.request);
  assert.deepEqual(original.response.body.result, { protocolVersion: '2026-07-28', capabilities: { tools: {}, events: {} }, serverInfo: { name: 'envoi' } });
  assert.equal(registry.contracts.find(contract => contract.id === 'provider-event-wake').version, 1);
  assert.equal(fixture.flags.ENVOI_GROK_TRIGGER_V1, false, 'MCP Events does not require the Grok profile');
});

test('complete discovery declares its supported version without changing event capabilities', () => {
  assert.equal(validate(fixture.response.body.result), true, ajv.errorsText(validate.errors));
  assert.deepEqual(fixture.response.body.result.capabilities, original.response.body.result.capabilities);
  assert.equal(validate(original.response.body.result), false, 'historical initialize-shaped discovery is superseded');
});

test('incomplete, incompatible and authority-bearing discovery responses are rejected', () => {
  const result = fixture.response.body.result;
  for (const invalid of [
    { ...result, resultType: 'partial' },
    { supportedVersions: result.supportedVersions, capabilities: result.capabilities },
    { resultType: result.resultType, capabilities: result.capabilities },
    { ...result, supportedVersions: [] },
    { ...result, supportedVersions: ['2025-11-25'] },
    { ...result, supportedVersions: ['2026-07-28', '2026-07-28'] },
    { ...result, supportedVersions: '2026-07-28' },
    { ...result, capabilities: { events: {} } },
    { ...result, capabilities: { ...result.capabilities, accessToken: 'FIXTURE_ONLY' } },
    { ...result, installationId: 'FIXTURE_ONLY' }
  ]) assert.equal(validate(invalid), false, JSON.stringify(invalid));
});
