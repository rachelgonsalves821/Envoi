// Contract/schema verification only. This deliberately does not implement runtime negotiation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const read = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));
const [registry, amendment, original] = await Promise.all([
  read('./contract-fixtures/index.json'),
  read('./contract-fixtures/agent-remote-auth-cimd/schemas.json'),
  read('./contract-fixtures/agent-remote-auth/schemas.json')
]);
const entry = registry.contracts.find(contract => contract.id === 'agent-remote-auth-cimd');
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(amendment);
ajv.addSchema(original);
const validate = ajv.getSchema(`${amendment.$id}#/definitions/clientAuthMetadata`);
const oldDocument = ajv.getSchema(`${original.$id}#/definitions/clientMetadataDocument`);
const cases = await Promise.all(entry.fixtures.map(name => read(`./contract-fixtures/${entry.dir}/${name}`)));

test('CIMD amendment is independently versioned and preserves the approved base entry', () => {
  assert.equal(entry.version, 1);
  assert.ok(['published', 'approved'].includes(entry.status));
  assert.deepEqual(amendment['x-amends'], { contract: 'agent-remote-auth', version: 1, revision: 4, section: '3.1 client metadata auth method' });
  assert.equal(registry.contracts.find(contract => contract.id === 'agent-remote-auth').status, 'approved');
  assert.equal(amendment['x-selected-method'], 'none');
  assert.equal(cases.length, 24);
});

for (const row of cases) {
  test(`CIMD publication schema: ${row.id}`, () => {
    assert.equal(validate(row.document), row.expected.valid, ajv.errorsText(validate.errors));
    // Every fixture isolates auth metadata. Existing non-auth document fields stay governed by v1.
    const normalized = { ...row.document, token_endpoint_auth_method: 'none' };
    delete normalized.token_endpoint_auth_methods_supported;
    assert.equal(oldDocument(normalized), true, ajv.errorsText(oldDocument.errors));
    if (row.expected.valid) assert.equal(row.expected.selectedMethod, 'none');
    else assert.equal(row.expected.rejection, 'auth_method_not_none');
  });
}

test('modern ChatGPT vector captures the additive change rather than pretending v1 already accepts it', () => {
  const row = cases.find(candidate => candidate.id === 'modern-chatgpt-preference');
  assert.equal(oldDocument(row.document), false);
  assert.equal(validate(row.document), true);
  assert.deepEqual(row.document.token_endpoint_auth_methods_supported, ['none', 'private_key_jwt']);
  assert.equal(row.document.token_endpoint_auth_method, 'private_key_jwt');
  assert.equal(row.expected.selectedMethod, 'none');
});

test('publication fixtures cover both exact proposed bounds and refusal one beyond each', () => {
  const byId = Object.fromEntries(cases.map(row => [row.id, row]));
  assert.equal(byId['modern-max-method-count'].document.token_endpoint_auth_methods_supported.length, amendment['x-limits'].methodsMax);
  assert.equal(byId['modern-over-method-count'].document.token_endpoint_auth_methods_supported.length, amendment['x-limits'].methodsMax + 1);
  assert.equal(byId['modern-max-method-length'].document.token_endpoint_auth_methods_supported[1].length, amendment['x-limits'].methodLengthMax);
  assert.equal(byId['modern-over-method-length'].document.token_endpoint_auth_methods_supported[1].length, amendment['x-limits'].methodLengthMax + 1);
});
