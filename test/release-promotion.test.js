import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_SECRET_NAMES, RELEASE_ACCOUNT_ID, promotionPlan, requireSecretNames } from '../scripts/promote-release.mjs';
const main = 'a'.repeat(40);
const candidate = 'b'.repeat(40);
const defaults = { target: 'staging', sha: main, headSha: main, mainSha: main, clean: true, descendedFromMain: true };

test('promotion defaults to a dry-run on the explicit target and records the runtime SHA', () => {
  const plan = promotionPlan(defaults);
  assert.equal(plan.accountId, RELEASE_ACCOUNT_ID);
  assert.deepEqual(plan.args, ['deploy', '--env', 'staging', '--var', `SINALOA_RELEASE_SHA:${main}`, '--dry-run', '--containers-rollout=none']);
});
test('premerge candidate can be dry-run but cannot be published', () => {
  const input = { ...defaults, sha: candidate, headSha: candidate };
  assert.doesNotThrow(() => promotionPlan(input));
  assert.throws(() => promotionPlan({ ...input, deploy: true }), /merge and fetch/);
});
test('accepted main can publish only the explicit beta target', () => {
  assert.deepEqual(promotionPlan({ ...defaults, target: 'beta', deploy: true }).args,
    ['deploy', '--env', 'beta', '--var', `SINALOA_RELEASE_SHA:${main}`]);
});
for (const [name, overrides, message] of [
  ['old production target', { target: 'production' }, /explicit staging or beta/],
  ['unqualified target', { target: undefined }, /explicit staging or beta/],
  ['dirty tracked or untracked work', { clean: false }, /must be clean/],
  ['short SHA', { sha: 'aabbcc' }, /40-hex/],
  ['SHA mismatching source', { sha: candidate }, /exactly match/],
  ['candidate from old branch', { descendedFromMain: false }, /descend/]
]) test(`promotion refuses ${name}`, () => assert.throws(() => promotionPlan({ ...defaults, ...overrides }), message));

test('secret-name gate accepts encrypted names without reading values', () => {
  assert.doesNotThrow(() => requireSecretNames(APP_SECRET_NAMES.map(name => ({ name, type: 'secret_text' }))));
});
test('secret-name gate reports only missing names and rejects plaintext vars', () => {
  assert.throws(() => requireSecretNames([{ name: 'DATABASE_URL', type: 'plain_text' }], ['DATABASE_URL']),
    /Missing encrypted runtime secrets: DATABASE_URL/);
});
test('secret-name gate allows a policy keyring and requires a separate scanner credential', () => {
  const names = APP_SECRET_NAMES.map(name => ({ name: name === 'SINALOA_POLICY_SIGNING_KEY' ? 'SINALOA_POLICY_SIGNING_KEYS' : name, type: 'secret_text' }));
  assert.doesNotThrow(() => requireSecretNames(names));
  assert.throws(() => requireSecretNames(names, ['SINALOA_SCANNER_TOKEN']), /SINALOA_SCANNER_TOKEN/);
});