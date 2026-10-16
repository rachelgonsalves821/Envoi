// agent-registration v1 (task A-4.2): codes, tokens, names, hints and the §6.2 recovery envelope,
// checked against handoffs.md §2, §3, §6.2 and the approved schemas.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  activationRecoveryKey, approverEmailHint, decryptActivation, displayName, displayVerificationCode, encryptActivation,
  generateBootstrapToken, generateVerificationCode, hashToken, isBootstrapToken, normalizeVerificationCode, tokenLikePattern,
  unsafeNameCharacters, validActivationId, validRequestedName, verificationAlphabet, verificationCodeHmac, verificationCodeKey
} from '../src/agent-registration-codes.js';

const schemas = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures', 'agent-registration', 'schemas.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schemas);
const schemaValid = (name, value) => ajv.getSchema(`${schemas.$id}#/definitions/${name}`)(value);
const requestedNameSchema = ajv.compile(schemas.definitions.registrationCreateRequest.properties.requestedName);

test('the alphabet and both name patterns equal the schema', () => {
  assert.equal(verificationAlphabet, schemas['x-limits'].verificationCode.alphabet);
  assert.equal(verificationAlphabet.length, 32);
  const [tokenLike, unsafe] = schemas.definitions.registrationCreateRequest.properties.requestedName.allOf.map(rule => rule.not.pattern);
  assert.equal(tokenLikePattern.source, tokenLike);
  assert.equal(unsafeNameCharacters.source, unsafe);
  assert.equal(tokenLikePattern.flags, '');
  assert.equal(unsafeNameCharacters.flags, '');
  const displayRules = schemas.definitions.displayName.allOf.map(rule => rule.not.pattern);
  assert.deepEqual(displayRules, [tokenLike, unsafe]);
});

test('typed codes normalize per §2', () => {
  const cases = [
    ['F7KQPM4D', 'F7KQPM4D'],
    ['F7KQ-PM4D', 'F7KQPM4D'],
    ['f7kq pm4d', 'F7KQPM4D'],
    ['  f7kq--pm4d  ', 'F7KQPM4D'],
    ['IIII-LLLL', '11111111'],
    ['iiii llll', '11111111'],
    ['OOOO-oooo', '00000000'],
    ['0123-4567', '01234567'],
    ['89AB-CDEF', '89ABCDEF'],
    ['GHJK-MNPQ', 'GHJKMNPQ'],
    ['RSTV-WXYZ', 'RSTVWXYZ'],
    ['F7KQ-PM4U', null], // U is not in the alphabet
    ['F7KQ-PM4', null], // 7 symbols
    ['F7KQ-PM4DX', null], // 9 symbols
    ['F7KQ_PM4D', null], // only spaces and hyphens are ignored
    ['F7KQ\tPM4D', null],
    ['F7KQ.PM4D', null],
    ['ß7KQPM4D', null], // never upper-cased to SS
    ['ı7KQPM4D', null], // dotless i is not I
    ['Ｆ7KQPM4D', null], // full-width F
    ['', null],
    [`F7KQPM4D${' '.repeat(25)}`, null], // 33 characters
    [`F7KQPM4D${' '.repeat(24)}`, 'F7KQPM4D'], // 32 characters
    [null, null],
    [undefined, null],
    [12345678, null],
    [['F7KQPM4D'], null]
  ];
  for (const [input, expected] of cases) assert.equal(normalizeVerificationCode(input), expected, JSON.stringify(input));
});

test('generated codes match the schema, round-trip and are uniform', () => {
  const counts = new Map([...verificationAlphabet].map(symbol => [symbol, 0]));
  const draws = 10_000;
  for (let index = 0; index < draws; index += 1) {
    const { normalized, display } = generateVerificationCode();
    assert.match(normalized, /^[0-9A-HJKMNP-TV-Z]{8}$/);
    assert.equal(display, `${normalized.slice(0, 4)}-${normalized.slice(4)}`);
    assert.equal(displayVerificationCode(normalized), display);
    assert.ok(schemaValid('verificationCode', display), display);
    assert.equal(normalizeVerificationCode(display), normalized);
    assert.equal(normalizeVerificationCode(normalized), normalized);
    assert.equal(normalizeVerificationCode(display.toLowerCase()), normalized);
    for (const symbol of normalized) counts.set(symbol, counts.get(symbol) + 1);
  }
  for (const [symbol, count] of counts) {
    const frequency = count / (draws * 8);
    assert.ok(frequency >= 0.02 && frequency <= 0.045, `${symbol}: ${frequency}`);
  }
});

test('code HMAC is stable and depends on the derived key', () => {
  const dataKey = crypto.randomBytes(32);
  const key = verificationCodeKey(dataKey);
  assert.ok(Buffer.isBuffer(key));
  assert.equal(key.length, 32);
  assert.deepEqual(verificationCodeKey(dataKey), key);
  assert.notDeepEqual(verificationCodeKey(crypto.randomBytes(32)), key);
  const expected = Buffer.from(crypto.hkdfSync('sha256', dataKey, Buffer.alloc(0), Buffer.from('envoi-agent-registration-code-v1'), 32));
  assert.deepEqual(key, expected);
  const mac = verificationCodeHmac('F7KQPM4D', key);
  assert.match(mac, /^[a-f0-9]{64}$/);
  assert.equal(verificationCodeHmac('F7KQPM4D', key), mac);
  assert.equal(mac, crypto.createHmac('sha256', key).update('F7KQPM4D').digest('hex'));
  assert.notEqual(verificationCodeHmac('F7KQPM4E', key), mac);
  assert.notEqual(verificationCodeHmac('F7KQPM4D', verificationCodeKey(crypto.randomBytes(32))), mac);
});

test('bootstrap tokens and activation ids', () => {
  const seen = new Set();
  for (let index = 0; index < 200; index += 1) {
    const token = generateBootstrapToken();
    assert.match(token, /^envoi_reg_[A-Za-z0-9_-]{43}$/);
    assert.equal(token.length, 53);
    assert.equal(Buffer.from(token.slice('envoi_reg_'.length), 'base64url').length, 32);
    assert.ok(isBootstrapToken(token));
    seen.add(token);
  }
  assert.equal(seen.size, 200);
  const token = generateBootstrapToken();
  for (const bad of [token.slice(0, -1), `${token}A`, token.replace('envoi_reg_', 'envoi_rex_'), `${token.slice(0, -1)}=`, `${token.slice(0, -1)}+`, ` ${token}`, null, 42]) assert.equal(isBootstrapToken(bad), false, String(bad));
  assert.equal(hashToken(token), crypto.createHash('sha256').update(token).digest('hex'));
  assert.match(hashToken(token), /^[a-f0-9]{64}$/);

  const activationIdSchema = ajv.compile(schemas.definitions.activationId);
  const ids = ['abcdefgh', 'A1234567', `a${'b'.repeat(127)}`, '1_-_-_-_', 'abcdefg', `a${'b'.repeat(128)}`, '_abcdefgh', '-abcdefgh', 'abcd efgh', 'abcdéfgh', ''];
  for (const id of ids) assert.equal(validActivationId(id), activationIdSchema(id), id);
  assert.equal(validActivationId('abcdefgh'), true);
  assert.equal(validActivationId('abcdefg'), false);
  for (const bad of [null, undefined, 12345678, ['abcdefgh']]) assert.equal(validActivationId(bad), false);
});

test('validRequestedName agrees with the schema', () => {
  const names = [
    'Claude Code', 'a', 'x'.repeat(80), 'x'.repeat(81), '😀'.repeat(80), '😀'.repeat(81), 'Ágente ñ 日本語', 'name with  spaces',
    '', 'tab\there', 'line\nbreak', 'nul\u0000', 'del\u007F', 'c1\u0085', 'arabic\u061Cmark', 'mongolian\u180Esep', 'zero\u200Bwidth',
    'rlm\u200F', 'lre\u202A', 'rlo\u202Eoverride', 'wj\u2060', 'isolate\u2069', 'bom\uFEFF',
    'envoi_reg_x', 'my envoi_reg_abc', 'envoi_agent_access_x', 'sinaloa_agent_refresh_', 'envoi_mcp_read_1', 'sinaloa_enroll_z',
    'envoi_reg', 'ENVOI_REG_x', 'envoi-reg-x', 'envoi_agent_x'
  ];
  for (const name of names) assert.equal(validRequestedName(name), requestedNameSchema(name), JSON.stringify(name));
  for (const good of ['Claude Code', 'x'.repeat(80), '😀'.repeat(80)]) assert.equal(validRequestedName(good), true, good);
  for (const bad of ['', 'x'.repeat(81), 'arabic\u061Cmark', 'mongolian\u180Esep', 'zero\u200Bwidth', 'rlo\u202Eoverride', 'envoi_reg_x']) assert.equal(validRequestedName(bad), false, JSON.stringify(bad));
  for (const bad of [null, undefined, 7, ['name']]) assert.equal(validRequestedName(bad), false);
});

test('displayName follows §3 and always matches the schema', () => {
  const cases = [
    ['Claude Code', 'Claude Code'],
    ['  padded  ', 'padded'],
    ['zero\u200Bwidth', 'zerowidth'],
    ['rlo\u202Eoverride\u202C', 'rlooverride'],
    ['arabic\u061C mongolian\u180E bom\uFEFF', 'arabic mongolian bom'],
    ['token envoi_reg_abcDEF-123_xyz!', 'token [redacted]!'],
    ['envoi_agent_access_abc and sinaloa_mcp_read_def', '[redacted] and [redacted]'],
    ['sinaloa_enroll_', '[redacted]'],
    ['envoi\u200B_reg_secret', '[redacted]'], // removal comes before redaction
    ['envoi_envoi_reg_secret', 'envoi_[redacted]'],
    ['x'.repeat(80), 'x'.repeat(80)],
    ['x'.repeat(81), `${'x'.repeat(79)}…`],
    ['😀'.repeat(81), `${'😀'.repeat(79)}…`],
    [`${'y'.repeat(78)}\u200B\u200Bzz`, 'y'.repeat(78) + 'zz'],
    ['\u200B\u202E', 'fallback-part'],
    ['   ', 'fallback-part'],
    ['', 'fallback-part'],
    [null, 'fallback-part'],
    [42, 'fallback-part']
  ];
  for (const [input, expected] of cases) {
    const result = displayName(input, 'fallback-part');
    assert.equal(result, expected, JSON.stringify(input));
    assert.ok(schemaValid('displayName', result), `${JSON.stringify(input)} -> ${JSON.stringify(result)}`);
  }
  // A long name whose cut falls inside the redaction marker still validates.
  const long = displayName(`${'a'.repeat(75)} envoi_reg_${'s'.repeat(40)} tail`, 'fallback-part');
  assert.equal([...long].length, 80);
  assert.ok(schemaValid('displayName', long));
  // Randomized: arbitrary mixes of unsafe characters, token prefixes and text always validate.
  const pieces = ['a', 'Z', ' ', '😀', '\u200B', '\u202E', '\u0000', '\u061C', 'envoi_reg_', 'sinaloa_enroll_', 'envoi_agent_refresh_', '_', '-', 'é'];
  for (let index = 0; index < 2000; index += 1) {
    let value = '';
    const length = crypto.randomInt(0, 60);
    for (let piece = 0; piece < length; piece += 1) value += pieces[crypto.randomInt(pieces.length)];
    const result = displayName(value, 'fallback-part');
    assert.ok(schemaValid('displayName', result), `${JSON.stringify(value)} -> ${JSON.stringify(result)}`);
  }
});

test('approverEmailHint follows §4 and matches the schema', () => {
  const cases = [
    ['Owner@Example.COM', 'o***@example.com'],
    ['owner@example.com', 'o***@example.com'],
    ['a@b.co', 'a***@b.co'],
    ['Zed.Smith+tag@mail.sub.example.org', 'z***@mail.sub.example.org'],
    ['9lives@cats-r-us.io', '9***@cats-r-us.io'],
    ['Élodie@example.fr', 'é***@example.fr'],
    ['İstanbul@example.com', 'i***@example.com'],
    ['"a@b"@example.com', '"***@example.com'],
    ['@example.com', null],
    ['@@example.com', null],
    [' owner@example.com', null],
    ['*owner@example.com', null],
    ['owner@localhost', null],
    ['owner@example.c', null],
    ['owner@exa mple.com', null],
    ['owner@example.com.', null],
    ['owner@exämple.com', null],
    ['owner', null],
    ['', null],
    [null, null],
    [42, null]
  ];
  for (const [input, expected] of cases) {
    const hint = approverEmailHint(input);
    assert.equal(hint, expected, JSON.stringify(input));
    if (hint !== null) assert.ok(schemaValid('approverEmailHint', hint), hint);
  }
});

test('§6.2 activation recovery round-trips and binds token, registration and activation', () => {
  const salt = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest();
  const token = generateBootstrapToken();
  const registrationId = 'registration_abc123';
  const activationIdHash = hashToken('activation-12345678');
  const body = { agent: { id: 'agent_1', name: 'Claude Code' }, agentApiToken: 'envoi_agent_access_x', nested: [1, 2, 3] };
  const key = activationRecoveryKey(token, salt);
  assert.equal(key.length, 32);
  assert.deepEqual(key, Buffer.from(crypto.hkdfSync('sha256', Buffer.from(token), salt, Buffer.from('envoi-agent-activation-recovery-v1'), 32)));

  const envelope = encryptActivation(token, salt, registrationId, activationIdHash, body);
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'iv', 'tag']);
  for (const field of Object.values(envelope)) assert.match(field, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(Buffer.from(envelope.iv, 'base64').length, 12);
  assert.equal(Buffer.from(envelope.tag, 'base64').length, 16);
  assert.ok(!JSON.stringify(envelope).includes('envoi_agent_access_x'));
  assert.deepEqual(decryptActivation(token, salt, registrationId, activationIdHash, envelope), body);

  const otherSalt = crypto.createHash('sha256').update('other').digest();
  const flip = value => { const bytes = Buffer.from(value, 'base64'); bytes[0] ^= 1; return bytes.toString('base64'); };
  const refused = [
    [generateBootstrapToken(), salt, registrationId, activationIdHash, envelope],
    [token, otherSalt, registrationId, activationIdHash, envelope],
    [token, salt, 'registration_other', activationIdHash, envelope],
    [token, salt, registrationId, hashToken('activation-other-1'), envelope],
    [token, salt, registrationId, activationIdHash, { ...envelope, tag: flip(envelope.tag) }],
    [token, salt, registrationId, activationIdHash, { ...envelope, tag: Buffer.from(envelope.tag, 'base64').subarray(0, 12).toString('base64') }],
    [token, salt, registrationId, activationIdHash, { ...envelope, ciphertext: flip(envelope.ciphertext) }],
    [token, salt, registrationId, activationIdHash, { ...envelope, iv: flip(envelope.iv) }],
    [token, salt, registrationId, activationIdHash, null],
    [token, salt, registrationId, activationIdHash, {}],
    [token, salt, registrationId, activationIdHash, 'not an envelope']
  ];
  for (const args of refused) assert.equal(decryptActivation(...args), null);
  // A fresh IV each time.
  assert.notEqual(encryptActivation(token, salt, registrationId, activationIdHash, body).iv, envelope.iv);
});
