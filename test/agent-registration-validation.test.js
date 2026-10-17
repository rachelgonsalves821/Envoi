// agent-registration v1 (task A-4.2): src/agent-registration.js validates request bodies by hand,
// because src/ cannot read test/ at runtime (the Docker image leaves test/ out). This test proves
// that each hand validator agrees with its schemas.json definition (Ajv, draft-07) on every fixture
// body and on a large corpus of systematic mutations of valid bodies:
//
//   validRegistrationCreate  <->  registrationCreateRequest
//   validApproveBody         <->  claimApproveRequest, apart from verificationCode
//   validCodeOnlyBody        <->  claimLookupRequest and claimRejectRequest, apart from verificationCode
//   validRequestedName       <->  registrationCreateRequest.properties.requestedName (and target.name)
//
// verificationCode is not checked by the body validators: every claim route normalizes the code
// first and answers CLAIM_CODE_INVALID when it cannot (handoffs.md §5.2 "Malformed codes", §5.3
// precedence step 3). So the drift comparison always sends a valid typedCode, and a separate test
// pins down that the body validators accept any code value and that every code the routes can
// normalize is a valid typedCode (the route check is at least as strict as the schema's).
//
// Every corpus body goes through JSON text first, as a request body does. The source uses \u
// escapes only: no literal invisible or non-ASCII characters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { validApproveBody, validCodeOnlyBody, validRegistrationCreate } from '../src/agent-registration.js';
import { normalizeVerificationCode, validRequestedName } from '../src/agent-registration-codes.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures', 'agent-registration');
const schemas = JSON.parse(await readFile(path.join(fixtureDir, 'schemas.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schemas);
function definition(name) {
  const validate = ajv.getSchema(`${schemas.$id}#/definitions/${name}`);
  assert.ok(validate, `schemas.json has no definition ${name}`);
  return validate;
}
const definitions = schemas.definitions;
const requestedNameSchema = ajv.compile(definitions.registrationCreateRequest.properties.requestedName);
const typedCodeSchema = definition('typedCode');

const handValidators = {
  registrationCreateRequest: validRegistrationCreate,
  claimApproveRequest: validApproveBody,
  claimLookupRequest: validCodeOnlyBody,
  claimRejectRequest: validCodeOnlyBody
};

// ------------------------------------------------------------------ corpus helpers

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// A key that JSON.parse makes an own property but an object literal or assignment would not.
const protoPlaceholder = '__agent_registration_validation_proto__';
const toText = value => JSON.stringify(value).replaceAll(`"${protoPlaceholder}"`, '"__proto__"');
const visible = text => text.replace(/[^\x20-\x7E]/g, char => `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
const shown = value => (value === undefined ? 'missing' : visible(JSON.stringify(value)));

function getAt(value, keys) {
  let node = value;
  for (const key of keys) {
    if (node === null || typeof node !== 'object' || !(key in node)) return undefined;
    node = node[key];
  }
  return node;
}

// One mutation of a valid base body: { label, keys, op, value }. apply() returns the JSON text of
// the mutated copy, or null when the path no longer exists (only possible in combinations).
function applyMutations(base, mutations) {
  let copy = structuredClone(base);
  for (const { keys, op, value } of mutations) {
    if (!keys.length) {
      if (op !== 'set') return null;
      copy = structuredClone(value);
      continue;
    }
    const parent = getAt(copy, keys.slice(0, -1));
    const last = keys.at(-1);
    if (parent === null || typeof parent !== 'object') return null;
    if (op === 'delete') {
      if (!(last in parent)) return null;
      if (Array.isArray(parent)) parent.splice(last, 1);
      else delete parent[last];
    } else if (op === 'set') {
      if (Array.isArray(parent) && !(last in parent)) return null;
      parent[last] = structuredClone(value);
    } else if (op === 'add') {
      const node = parent[last];
      if (!isPlainObject(node)) return null;
      node[value.key] = structuredClone(value.value);
    } else if (op === 'push') {
      const node = parent[last];
      if (!Array.isArray(node)) return null;
      node.push(structuredClone(value));
    }
  }
  return toText(copy);
}
const set = (keys, value) => ({ label: `${keys.join('.') || '(body)'} = ${shown(value)}`, keys, op: 'set', value });
const remove = keys => ({ label: `${keys.join('.')} removed`, keys, op: 'delete' });
const add = (keys, key, value) => ({ label: `${keys.join('.') || '(body)'} + ${key === protoPlaceholder ? '__proto__' : key}: ${shown(value)}`, keys: keys.length ? keys : null, op: 'add', value: { key, value } });

function* nodePaths(value, keys = []) {
  yield keys;
  if (Array.isArray(value)) for (let index = 0; index < value.length; index += 1) yield* nodePaths(value[index], [...keys, index]);
  else if (isPlainObject(value)) for (const key of Object.keys(value)) yield* nodePaths(value[key], [...keys, key]);
}

const wrongTypes = [null, true, false, 0, -1, 1.5, 1e21, '', 'x', [], ['x'], {}, { x: 1 }];
const extraKeys = ['extra', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', protoPlaceholder, '', 'requestedName', 'kind', 'verificationCode'];

// Structural mutations at every node: removed, every wrong type, extra keys on objects, and extra,
// duplicate and null items on arrays. `skip` names top-level keys left alone (verificationCode).
function structuralMutations(base, skip = []) {
  const mutations = [];
  for (const keys of nodePaths(base)) {
    if (keys.length && skip.includes(keys[0])) continue;
    if (keys.length) mutations.push(remove(keys));
    for (const value of wrongTypes) mutations.push(set(keys, value));
    const node = getAt(base, keys);
    if (isPlainObject(node)) {
      for (const key of extraKeys) {
        if (key in node && key !== protoPlaceholder) continue;
        for (const value of ['x', null, {}]) mutations.push({ ...add(keys, key, value), keys: [...keys, '__self__'] });
      }
    }
    if (Array.isArray(node)) {
      for (const value of [node[0], 'x', null, [], {}]) mutations.push({ label: `${keys.join('.')} + item ${shown(value)}`, keys: [...keys, '__self__'], op: 'push', value });
    }
  }
  // 'add' and 'push' act on the node itself: address it through a sentinel last key.
  return mutations.map(mutation => (mutation.keys.at(-1) === '__self__' ? { ...mutation, keys: mutation.keys.slice(0, -1), self: true } : mutation));
}

// applyMutations for self-addressed ops (add/push on the node at keys).
function applyAll(base, mutations) {
  const lowered = mutations.map(mutation => {
    if (!mutation.self) return mutation;
    // Wrap so that applyMutations finds the node through its parent.
    return { ...mutation, keys: ['__root__', ...mutation.keys] };
  });
  const needsRoot = lowered.some(mutation => mutation.keys[0] === '__root__');
  if (!needsRoot) return applyMutations(base, lowered);
  const wrapped = { __root__: base };
  const rest = lowered.map(mutation => (mutation.keys[0] === '__root__' ? mutation : { ...mutation, keys: ['__root__', ...mutation.keys] }));
  const text = applyMutations(wrapped, rest.map(mutation => (mutation.keys.length === 1 && mutation.op === 'set' ? { ...mutation } : mutation)));
  if (text === null) return null;
  return toText(JSON.parse(text.replaceAll('"__proto__"', `"${protoPlaceholder}"`)).__root__);
}

const valueMutations = (keys, values) => values.map(value => (value === undefined ? remove(keys) : set(keys, value)));

// Deterministic PRNG for the combination sample.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Pairs and triples of single mutations on different top-level fields, so interactions (one field
// valid, another invalid; two invalid at once) are covered too.
function combinations(mutations, count, seed) {
  const random = mulberry32(seed);
  const usable = mutations.filter(mutation => mutation.keys.length > 0);
  const combined = [];
  for (let index = 0; index < count; index += 1) {
    const size = 2 + Math.floor(random() * 2);
    const picked = [];
    const fields = new Set();
    for (let tries = 0; picked.length < size && tries < 20; tries += 1) {
      const candidate = usable[Math.floor(random() * usable.length)];
      if (fields.has(candidate.keys[0])) continue;
      fields.add(candidate.keys[0]);
      picked.push(candidate);
    }
    combined.push(picked);
  }
  return combined;
}

// Runs every corpus item through Ajv and the hand validator (each on its own fresh parse) and
// returns the counts and every disagreement.
function compare(schemaName, validator, items) {
  const validate = definition(schemaName);
  const disagreements = [];
  let accepted = 0;
  for (const { label, text } of items) {
    const expected = validate(JSON.parse(text));
    const errors = expected ? '' : ajv.errorsText(validate.errors);
    const actual = validator(JSON.parse(text));
    if (expected === true) accepted += 1;
    if (actual !== expected) disagreements.push(`${label}\n    body: ${visible(text)}\n    schema: ${expected} ${errors}\n    hand validator: ${actual}`);
  }
  return { total: items.length, accepted, refused: items.length - accepted, disagreements };
}
function assertAgreement(t, schemaName, validator, items, { minAccepted, minRefused }) {
  const result = compare(schemaName, validator, items);
  t.diagnostic(`${schemaName}: ${result.total} bodies, ${result.accepted} valid, ${result.refused} invalid, ${result.disagreements.length} disagreements`);
  assert.equal(result.disagreements.length, 0, `${validator.name} disagrees with ${schemaName} on ${result.disagreements.length} bodies:\n${result.disagreements.slice(0, 25).join('\n')}`);
  // The corpus must exercise both outcomes, so agreement is never vacuous.
  assert.ok(result.accepted >= minAccepted, `${schemaName}: only ${result.accepted} valid bodies`);
  assert.ok(result.refused >= minRefused, `${schemaName}: only ${result.refused} invalid bodies`);
}
function corpus(base, mutationGroups, { seed, combined = 3000 } = {}) {
  const items = [{ label: 'base', text: toText(base) }];
  const singles = mutationGroups.flat();
  for (const mutation of singles) {
    const text = applyAll(base, [mutation]);
    if (text !== null) items.push({ label: mutation.label, text });
  }
  for (const picked of combinations(singles, combined, seed)) {
    const text = applyAll(base, picked);
    if (text !== null) items.push({ label: picked.map(mutation => mutation.label).join(' & '), text });
  }
  return items;
}

// ------------------------------------------------------------------ value lists

const hex4 = cp => cp.toString(16).toUpperCase().padStart(4, '0');
// handoffs.md §3: control, zero-width and bidirectional formatting characters, incl. U+061C, U+180E.
const unsafeRanges = [[0x0000, 0x001F], [0x007F, 0x009F], [0x061C, 0x061C], [0x180E, 0x180E], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2069], [0xFEFF, 0xFEFF]];
const tokenPrefixes = ['envoi_agent_access_', 'envoi_agent_refresh_', 'sinaloa_agent_access_', 'sinaloa_agent_refresh_', 'envoi_mcp_read_', 'sinaloa_mcp_read_', 'envoi_enroll_', 'sinaloa_enroll_', 'envoi_reg_'];
const emoji = '😀'; // U+1F600, one code point, two UTF-16 units
const permissions = definitions.permission.enum;

function nameValues() {
  const values = [
    '', ' ', '  ', 'a', 'Example agent', 'x'.repeat(79), 'x'.repeat(80), 'x'.repeat(81), 'x'.repeat(400),
    emoji, emoji.repeat(40), emoji.repeat(41), emoji.repeat(79), emoji.repeat(80), emoji.repeat(81),
    'x'.repeat(79) + emoji, 'x'.repeat(80) + emoji, emoji + 'x'.repeat(79), emoji + 'x'.repeat(80),
    'é'.repeat(40), 'é'.repeat(40) + 'e', // combining marks count as code points
    '中文'.repeat(40), '中文'.repeat(40) + '中',
    '\uD800', '\uDC00', '\uDC00\uD800', 'a\uD83Db', 'x'.repeat(79) + '\uD800', 'x'.repeat(80) + '\uD800', 'x'.repeat(79) + '\uDE00\uD83D',
    '👨\u200D👩', // ZWJ sequence: U+200D is refused
    '🇺🇸', '󠀁', '󠁿', '􏿿', '𐀀',
    ' ', '­', ' ', ' ', '　', '�', '￾', '￿', '͏', '឴', 'ᅟ', 'ㅤ',
    'Example\nagent', 'Example\tagent', 'Example\ragent', '\u0000', 'Example\u0000', 'Example\u202Etnega'
  ];
  for (const [low, high] of unsafeRanges) {
    for (let cp = low - 1; cp <= high + 1; cp += 1) {
      if (cp < 0) continue;
      const char = String.fromCharCode(cp);
      values.push(char, `${char}Example`, `Exa${char}mple`, `Example${char}`, 'x'.repeat(79) + char, 'x'.repeat(80) + char);
    }
  }
  for (const prefix of tokenPrefixes) {
    values.push(prefix, `${prefix}abc123`, `My ${prefix}abc agent`, `x${prefix}`, `${prefix}`.repeat(2), prefix.toUpperCase(), `${prefix[0].toUpperCase()}${prefix.slice(1)}`,
      prefix.slice(0, -1), `${prefix.slice(0, -1)}-`, prefix.replaceAll('_', '-'), prefix.replaceAll('_', ' '), `${prefix.slice(0, 3)}\u200B${prefix.slice(3)}`,
      `${prefix.slice(0, 3)}­${prefix.slice(3)}`, 'x'.repeat(80 - prefix.length) + prefix, 'x'.repeat(81 - prefix.length) + prefix);
  }
  values.push('envoi_agent_', 'envoi_agent_token_', 'sinaloa_reg_', 'envoi_mcp_', 'envoi_mcp_write_', 'envoi__reg_', 'envoireg_', 'envoi_regx', 'envoi_agent_access', 'sinaloa_enroll', 'envoi_enroll-');
  return values;
}

const localPartValues = [
  undefined, 'abc', 'ab', 'a', '', 'a'.repeat(32), 'a'.repeat(33), 'a'.repeat(31) + '1', `a${'.b'.repeat(15)}c`, `a${'.b'.repeat(15)}cd`, '1abc', '9', 'abc-', 'abc.', '-abc', '.abc',
  'a..b', 'a--b', 'a.-b', 'a-.b', 'a.b', 'a-b', 'a-1', 'a.1', 'a1-2.b3', 'Abc', 'aBc', 'ABC', 'ab_c', 'a b', 'abc ', ' abc', 'abc\n', '\nabc', 'abc\u0000',
  'аbc', 'abé', 'abc\u200B', 'example', 'example-agent', 'example.agent', 'x1', 'x12', 'a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p', 'a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q',
  null, 0, true, ['abc'], { abc: 1 }
];
const shortIdValues = ['', 'a', 'a'.repeat(32), 'a'.repeat(33), '0', '9a', '_a', '-a', 'a_b-c', 'a.b', 'a b', 'A', 'aB', 'a\n', 'aé', 'abc+1'];
const runtimeVersionValues = [
  undefined, null, '', '1', '0.9.0', 'x'.repeat(32), 'x'.repeat(33), '1'.repeat(31) + '.', '.1', '-1', '+1', '_1', '1._+-', '1.0+build_x-7', 'v1.2.3-rc.1',
  '1.0 beta', '1.0\n', '1/2', '1:2', '1@2', 'é1', '1\u200B', 'V', 'Z9', 0, 1.5, true, [], ['1'], {}
];
const helperVersionValues = [...runtimeVersionValues.filter(value => value !== undefined && value !== null), undefined, null];
const routeValues = [...definitions.connectionRoute.enum, 'LOCAL_HELPER', 'local-helper', 'local_helper ', '', 'unknown', 'webhook', 'envoi_link', null, 0, ['local_helper'], {}];
const permissionListValues = [
  undefined, [], ...permissions.map(permission => [permission]), [...permissions], [...permissions].reverse(), permissions.slice(0, 4), permissions.slice(1),
  [...permissions, permissions[0]], [...permissions, 'admin'], [permissions[0], permissions[0]], [permissions[0], permissions[1], permissions[0]], ['admin'],
  [permissions[0].toUpperCase()], [`${permissions[0]} `], [null], [0], [[permissions[0]]], [{}], [permissions[0], null], ['receive_agent_messages', 'receive_agent_messages'],
  permissions[0], {}, null
];
const policyValues = [undefined, 'default', 'Default', 'DEFAULT', 'default ', '', 'strict', null, 0, true, ['default'], { default: true }];
function idValues(prefix) {
  return [
    `${prefix}x`, prefix, `${prefix}${'a'.repeat(80)}`, `${prefix}${'a'.repeat(81)}`, `${prefix}a-b_C9`, `${prefix}__`, `${prefix}-`, `${prefix}a.b`, `${prefix}a b`, `${prefix}a/b`,
    `${prefix}a\n`, `\n${prefix}a`, `${prefix.toUpperCase()}a`, `x${prefix}a`, `${prefix}é`, `${prefix}a\u200B`, prefix.slice(0, -1), `${prefix.slice(0, -1)}-a`,
    'inbox_x', 'agent_x', 'installation_x', 'installation_legacy_0b6f8f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', '', null, 0, ['x'], {}
  ];
}

// ------------------------------------------------------------------ fixture bodies

const fixtureRequests = [];
for (const file of (await readdir(fixtureDir)).filter(name => name.endsWith('.json') && name !== 'schemas.json').sort()) {
  const fixture = JSON.parse(await readFile(path.join(fixtureDir, file), 'utf8'));
  for (const request of [fixture.request, ...(fixture.steps || []).map(step => step.request)]) {
    if (request && (request.schema || request.invalidAgainst) && 'body' in request) fixtureRequests.push({ file, request });
  }
}

test('every fixture request body for these schemas gets the same answer from the hand validator', t => {
  let checked = 0;
  for (const [schemaName, validator] of Object.entries(handValidators)) {
    const items = [];
    for (const { file, request } of fixtureRequests) {
      if (request.schema === schemaName || request.invalidAgainst === schemaName) items.push({ label: `${file} (${request.schema ? 'schema' : 'invalidAgainst'})`, text: toText(request.body) });
      // A fixture's own verdict, so the comparison cannot hide a fixture that both get wrong.
      if (request.schema === schemaName) assert.equal(validator(JSON.parse(toText(request.body))), true, `${file}: ${schemaName} fixture body refused`);
      if (request.invalidAgainst === schemaName) assert.equal(validator(JSON.parse(toText(request.body))), false, `${file}: invalidAgainst ${schemaName} fixture body accepted`);
    }
    const result = compare(schemaName, validator, items);
    assert.equal(result.disagreements.length, 0, result.disagreements.join('\n'));
    checked += items.length;
    t.diagnostic(`${schemaName}: ${items.length} fixture bodies`);
  }
  assert.ok(fixtureRequests.some(({ request }) => request.schema === 'registrationCreateRequest'));
  assert.ok(fixtureRequests.some(({ request }) => request.invalidAgainst === 'registrationCreateRequest'));
  assert.ok(fixtureRequests.some(({ request }) => request.schema === 'claimApproveRequest'));
  assert.ok(fixtureRequests.some(({ request }) => request.invalidAgainst === 'claimApproveRequest'));
  assert.ok(fixtureRequests.some(({ request }) => request.schema === 'claimLookupRequest'));
  assert.ok(fixtureRequests.some(({ request }) => request.schema === 'claimRejectRequest'));
  assert.ok(checked >= 30, `only ${checked} fixture bodies`);
});

test('the corpus\'s unsafe ranges are exactly the schema\'s refused characters, and both name subschemas are one rule', () => {
  const rendered = `[${unsafeRanges.map(([low, high]) => (low === high ? `\\u${hex4(low)}` : `\\u${hex4(low)}-\\u${hex4(high)}`)).join('')}]`;
  const [tokenLike, unsafe] = definitions.registrationCreateRequest.properties.requestedName.allOf.map(rule => rule.not.pattern);
  assert.equal(rendered, unsafe);
  assert.deepEqual(definitions.claimApproveRequest.properties.target.oneOf[0].properties.name, definitions.registrationCreateRequest.properties.requestedName);
  assert.deepEqual(definitions.claimLookupRequest, definitions.claimRejectRequest);
  // Every token prefix is one alternative of the schema's token-like pattern.
  const tokenLikeRegExp = new RegExp(tokenLike, 'u');
  for (const prefix of tokenPrefixes) assert.ok(tokenLikeRegExp.test(prefix), prefix);
});

test('validRequestedName agrees with the requestedName subschema on every BMP code point and the name corpus', t => {
  const disagreements = [];
  const check = (label, value) => {
    const expected = requestedNameSchema(value);
    const actual = validRequestedName(value);
    if (actual !== expected) disagreements.push(`${label}: ${shown(value)} schema ${expected}, validRequestedName ${actual}`);
  };
  let count = 0;
  for (let cp = 0; cp <= 0xFFFF; cp += 1) {
    const char = String.fromCharCode(cp);
    check(`U+${hex4(cp)} alone`, char);
    check(`U+${hex4(cp)} inside`, `Ex${char}ample`);
    check(`U+${hex4(cp)} at 80`, 'x'.repeat(79) + char);
    check(`U+${hex4(cp)} at 81`, 'x'.repeat(80) + char);
    count += 4;
  }
  for (const cp of [0x10000, 0x1F600, 0x1F3FB, 0xE0001, 0xE0020, 0xE007F, 0xE0100, 0xF0000, 0x10FFFF]) {
    const char = String.fromCodePoint(cp);
    check(`U+${cp.toString(16).toUpperCase()}`, char);
    check(`U+${cp.toString(16).toUpperCase()} at 80`, 'x'.repeat(79) + char);
    check(`U+${cp.toString(16).toUpperCase()} at 81`, 'x'.repeat(80) + char);
    count += 3;
  }
  for (const value of [...nameValues(), ...wrongTypes, undefined]) { check('name corpus', value); count += 1; }
  t.diagnostic(`${count} names, ${disagreements.length} disagreements`);
  assert.equal(disagreements.length, 0, disagreements.slice(0, 25).join('\n'));
  // Non-vacuous: code points, not UTF-16 units, are counted, and each refusal rule fires.
  assert.equal(validRequestedName(emoji.repeat(80)), true);
  assert.equal(validRequestedName(emoji.repeat(81)), false);
  assert.equal(validRequestedName('\u061C'), false);
  assert.equal(validRequestedName('envoi_reg_'), false);
});

// ------------------------------------------------------------------ registrationCreateRequest

const createBase = {
  requestedName: 'Example agent', requestedLocalPart: 'example', requestedPermissions: ['send_agent_messages', 'receive_agent_messages'], connectionRoute: 'local_helper',
  runtime: { type: 'hermes', version: '0.9.0' },
  deliveryCapabilities: { persistentProcess: true, outboundHttps: true, sse: true, webhook: false, scheduledPolling: false, a2a: false },
  helper: { name: 'envoi-link', version: '0.1.0' }
};
const capabilityKeys = Object.keys(definitions.deliveryCapabilities.properties);

function createMutations() {
  return [
    structuralMutations(createBase),
    valueMutations(['requestedName'], nameValues()),
    valueMutations(['requestedLocalPart'], localPartValues),
    valueMutations(['requestedPermissions'], permissionListValues),
    valueMutations(['connectionRoute'], routeValues),
    valueMutations(['runtime', 'type'], [...shortIdValues, undefined, null, 0]),
    valueMutations(['runtime', 'version'], runtimeVersionValues),
    valueMutations(['runtime'], [{ type: 'hermes', version: null }, { type: 'hermes' }, { version: null }, {}, { type: 'hermes', version: null, extra: 1 }, { type: 'unknown', version: null }]),
    valueMutations(['helper'], [undefined, null, {}, { name: 'envoi-link' }, { version: '0.1.0' }, { name: 'envoi-link', version: '0.1.0', extra: true }, { name: 'h', version: 'v' }]),
    valueMutations(['helper', 'name'], [...shortIdValues, undefined, null, 0]),
    valueMutations(['helper', 'version'], helperVersionValues),
    valueMutations(['deliveryCapabilities'], [
      {}, Object.fromEntries(capabilityKeys.map(key => [key, false])), Object.fromEntries(capabilityKeys.map(key => [key, true])),
      ...capabilityKeys.map(missing => Object.fromEntries(capabilityKeys.filter(key => key !== missing).map(key => [key, true]))),
      { ...createBase.deliveryCapabilities, poll: true }, { ...createBase.deliveryCapabilities, envoi_link: false }, capabilityKeys
    ]),
    ...capabilityKeys.map(key => valueMutations(['deliveryCapabilities', key], [undefined, true, false, 0, 1, 'true', 'false', null, [], {}]))
  ];
}

test('validRegistrationCreate agrees with registrationCreateRequest on the mutation corpus', t => {
  const bases = [createBase, { ...createBase, helper: undefined }, { ...createBase, requestedLocalPart: undefined }, { ...createBase, runtime: { type: 'hermes', version: null } }]
    .map(base => JSON.parse(JSON.stringify(base)));
  const items = bases.flatMap((base, index) => corpus(base, createMutations(), { seed: 0xA42 + index, combined: 2500 }));
  for (const value of [null, true, 0, 'x', [], [createBase], {}]) items.push({ label: `body ${shown(value)}`, text: toText(value) });
  assertAgreement(t, 'registrationCreateRequest', validRegistrationCreate, items, { minAccepted: 400, minRefused: 4000 });
});

test('validRegistrationCreate agrees with the schema on every BMP code point in requestedName', t => {
  const items = [];
  for (let cp = 0; cp <= 0xFFFF; cp += 1) items.push({ label: `requestedName with U+${hex4(cp)}`, text: toText({ ...createBase, requestedName: `Ex${String.fromCharCode(cp)}ample` }) });
  assertAgreement(t, 'registrationCreateRequest', validRegistrationCreate, items, { minAccepted: 60000, minRefused: 70 });
});

// ------------------------------------------------------------------ claimApproveRequest

const validCode = 'F7KQ-PM4D';
const newAgentTarget = { kind: 'new_agent', workspaceInboxId: 'inbox_workspace_example', name: 'Example agent', localPart: 'example' };
const existingAgentTarget = { kind: 'existing_agent', agentId: 'agent_example', replacesInstallationId: 'installation_legacy_0b6f8f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b' };
const approveBase = target => ({ verificationCode: validCode, target, grantedPermissions: ['send_agent_messages', 'receive_agent_messages', 'execute_cases'], policyProfile: 'default' });

function approveMutations(base) {
  const shared = [
    structuralMutations(base, ['verificationCode']),
    valueMutations(['grantedPermissions'], permissionListValues),
    valueMutations(['policyProfile'], policyValues),
    valueMutations(['target'], [
      newAgentTarget, existingAgentTarget, { ...existingAgentTarget, replacesInstallationId: null },
      { kind: 'existing_agent', agentId: 'agent_example' }, { ...newAgentTarget, kind: 'existing_agent' }, { ...existingAgentTarget, kind: 'new_agent' },
      { ...newAgentTarget, ...existingAgentTarget }, { ...existingAgentTarget, ...newAgentTarget }, { kind: 'new_agent' }, { kind: 'existing_agent' }, {},
      { ...newAgentTarget, kind: null }, { ...newAgentTarget, kind: 'NEW_AGENT' }, { ...newAgentTarget, kind: ['new_agent'] }, { ...existingAgentTarget, kind: 'agent' },
      { ...newAgentTarget, kind: undefined }, { ...existingAgentTarget, kind: undefined }, { ...newAgentTarget, agentId: 'agent_example' }, { ...existingAgentTarget, name: 'Example agent' },
      { ...existingAgentTarget, replacesInstallationId: null, workspaceInboxId: 'inbox_x' }, [newAgentTarget], 'new_agent', null
    ].map(target => JSON.parse(JSON.stringify(target ?? null))))
  ];
  if (base.target.kind === 'new_agent') {
    shared.push(
      valueMutations(['target', 'workspaceInboxId'], [...idValues('inbox_'), undefined]),
      valueMutations(['target', 'name'], [...nameValues(), undefined]),
      valueMutations(['target', 'localPart'], localPartValues),
      valueMutations(['target', 'kind'], ['new_agent', 'existing_agent', undefined, null, ''])
    );
  } else {
    shared.push(
      valueMutations(['target', 'agentId'], [...idValues('agent_'), undefined]),
      valueMutations(['target', 'replacesInstallationId'], [...idValues('installation_'), undefined]),
      valueMutations(['target', 'kind'], ['new_agent', 'existing_agent', undefined, null, ''])
    );
  }
  return shared;
}

test('validApproveBody agrees with claimApproveRequest on the mutation corpus (with a valid typedCode)', t => {
  const bases = [approveBase(newAgentTarget), approveBase(existingAgentTarget), approveBase({ ...existingAgentTarget, replacesInstallationId: null })];
  const items = bases.flatMap((base, index) => corpus(base, approveMutations(base), { seed: 0xC1A1 + index, combined: 2500 }));
  for (const value of [null, true, 0, 'x', [], [approveBase(newAgentTarget)], {}, { verificationCode: validCode }]) items.push({ label: `body ${shown(value)}`, text: toText(value) });
  assertAgreement(t, 'claimApproveRequest', validApproveBody, items, { minAccepted: 300, minRefused: 4000 });
});

test('validApproveBody agrees with the schema on every BMP code point in target.name', t => {
  const items = [];
  for (let cp = 0; cp <= 0xFFFF; cp += 1) items.push({ label: `target.name with U+${hex4(cp)}`, text: toText(approveBase({ ...newAgentTarget, name: `Ex${String.fromCharCode(cp)}ample` })) });
  assertAgreement(t, 'claimApproveRequest', validApproveBody, items, { minAccepted: 60000, minRefused: 70 });
});

// ------------------------------------------------------------------ claimLookupRequest / claimRejectRequest

test('validCodeOnlyBody agrees with claimLookupRequest and claimRejectRequest (with a valid typedCode)', () => {
  const bodies = [
    { verificationCode: validCode }, { verificationCode: 'f7kq pm4d' }, { verificationCode: 'x' }, { verificationCode: 'x'.repeat(32) },
    { verificationCode: validCode, target: newAgentTarget }, { verificationCode: validCode, grantedPermissions: ['send_agent_messages'] },
    { verificationCode: validCode, policyProfile: 'default' }, { verificationCode: validCode, registrationId: 'registration_example' },
    { verificationCode: validCode, extra: null }, null, true, 0, 'x', [], [{ verificationCode: validCode }]
  ];
  for (const name of ['claimLookupRequest', 'claimRejectRequest']) {
    const validate = definition(name);
    for (const body of bodies) assert.equal(validCodeOnlyBody(body), validate(body), `${name}: ${JSON.stringify(body)}`);
  }
});

// ------------------------------------------------------------------ verificationCode

test('the body validators accept any verificationCode, and every code the routes can normalize is a valid typedCode', () => {
  const codes = [
    undefined, null, 0, 12345678, true, [], [validCode], {}, '', ' ', '-', 'x', 'x'.repeat(32), 'x'.repeat(33), validCode, 'F7KQPM4D', 'f7kq pm4d', ' F7KQ PM4D ', 'F7KQ--PM4D',
    '-F7KQ-PM4D-', `F7KQ${' '.repeat(23)}PM4D`, `F7KQ${' '.repeat(24)}PM4D`, `F7KQ${' '.repeat(25)}PM4D`, 'FIKQ-PM4D', 'FLKQ-PM4D', 'O0O0-1111', 'F7KQ_PM4D', 'F7KQ\tPM4D',
    'F7KQ\nPM4D', 'F7KQ PM4D', 'F7KQ‐PM4D', 'F7KQ-PM4\u0000', 'F7KQPM4D\u200B', 'F7KQ-PM4U', 'F7KQ-PM4', 'F7KQ-PM4DX', 'Ｆ７KQ-PM4D', 'ß7KQ-PM4D',
    'ı7KQ-PM4D', emoji.repeat(8), emoji.repeat(16), emoji.repeat(17)
  ];
  for (const code of codes) {
    const approve = { ...approveBase(newAgentTarget), verificationCode: code };
    const codeOnly = { verificationCode: code };
    const approveBody = JSON.parse(toText(approve));
    const codeOnlyBody = JSON.parse(toText(codeOnly));
    // The deliberate difference: the body validators never look at the code.
    assert.equal(validApproveBody(approveBody), true, `validApproveBody refused verificationCode ${shown(code)}`);
    assert.equal(validCodeOnlyBody(codeOnlyBody), true, `validCodeOnlyBody refused verificationCode ${shown(code)}`);
    // ...which is safe because the route refuses, before the body check, every code that is not a
    // valid typedCode: normalizable implies schema-valid.
    const normalized = normalizeVerificationCode(approveBody.verificationCode);
    const schemaValid = typedCodeSchema(approveBody.verificationCode);
    if (normalized !== null) assert.equal(schemaValid, true, `${shown(code)} normalizes to ${normalized} but is not a typedCode`);
    assert.equal(definition('claimApproveRequest')(approveBody), schemaValid, `${shown(code)}: claimApproveRequest should differ from the base only by the code`);
    assert.equal(definition('claimLookupRequest')(codeOnlyBody), schemaValid, `${shown(code)}: claimLookupRequest`);
  }
  // The other direction does not hold, and need not: a valid typedCode that does not normalize
  // gets CLAIM_CODE_INVALID, never CLAIM_INVALID (§5.2).
  assert.equal(typedCodeSchema('x'), true);
  assert.equal(normalizeVerificationCode('x'), null);
  // Over-long: 33 characters that would normalize to 8 symbols are refused by length, as the schema
  // refuses them.
  assert.equal(normalizeVerificationCode(`F7KQ${' '.repeat(25)}PM4D`), null);
  assert.equal(normalizeVerificationCode(`F7KQ${' '.repeat(24)}PM4D`), 'F7KQPM4D');
  // Missing code: validCodeOnlyBody({}) is true while the schema refuses {} (required), and the
  // route answers CLAIM_CODE_INVALID because normalizeVerificationCode(undefined) is null.
  assert.equal(validCodeOnlyBody({}), true);
  assert.equal(definition('claimLookupRequest')({}), false);
  assert.equal(normalizeVerificationCode(undefined), null);
  // Every BMP code point as a separator: only space and hyphen are ignored.
  for (let cp = 0; cp <= 0xFFFF; cp += 1) {
    const typed = `F7KQ${String.fromCharCode(cp)}PM4D`;
    const normalized = normalizeVerificationCode(typed);
    if (normalized !== null) assert.equal(typedCodeSchema(typed), true, `U+${hex4(cp)}`);
    if (cp !== 0x20 && cp !== 0x2D) assert.equal(normalized, null, `U+${hex4(cp)} accepted as a separator`);
  }
});
