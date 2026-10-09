import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_SECRET_NAMES, RELEASE_ACCOUNT_ID, promotionPlan, requireSecretNames } from '../scripts/promote-release.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { betaBuildDeployArgs } from '../scripts/deploy-beta-build.mjs';
import { deployStaging, stagingDeployArgs } from '../scripts/deploy-staging.mjs';
const main = 'a'.repeat(40);
const candidate = 'b'.repeat(40);
const defaults = { target: 'staging', sha: main, headSha: main, mainSha: main, clean: true, descendedFromMain: true };

test('promotion defaults to a dry-run on the explicit target and records the runtime SHA', () => {
  const plan = promotionPlan(defaults);
  assert.equal(plan.accountId, RELEASE_ACCOUNT_ID);
  assert.deepEqual(plan.args, ['deploy', '--env', 'staging', '--var', `ENVOI_RELEASE_SHA:${main}`, '--var', `SINALOA_RELEASE_SHA:${main}`, '--dry-run', '--containers-rollout=none']);
});
test('premerge candidate can be dry-run but cannot be published', () => {
  const input = { ...defaults, sha: candidate, headSha: candidate };
  assert.doesNotThrow(() => promotionPlan(input));
  assert.throws(() => promotionPlan({ ...input, deploy: true }), /merge and fetch/);
});
test('accepted main can publish only the explicit beta target', () => {
  assert.deepEqual(promotionPlan({ ...defaults, target: 'beta', deploy: true }).args,
    ['deploy', '--env', 'beta', '--var', `ENVOI_RELEASE_SHA:${main}`, '--var', `SINALOA_RELEASE_SHA:${main}`]);
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
  assert.doesNotThrow(() => requireSecretNames(APP_SECRET_NAMES.map(name => ({ name: name.replace('ENVOI_', 'SINALOA_'), type: 'secret_text' }))));
});
test('secret-name gate reports only missing names and rejects plaintext vars', () => {
  assert.throws(() => requireSecretNames([{ name: 'DATABASE_URL', type: 'plain_text' }], ['DATABASE_URL']),
    /Missing encrypted runtime secrets: DATABASE_URL/);
});
test('secret-name gate allows a policy keyring and requires a separate scanner credential', () => {
  const names = APP_SECRET_NAMES.map(name => ({ name: name === 'ENVOI_POLICY_SIGNING_KEY' ? 'ENVOI_POLICY_SIGNING_KEYS' : name, type: 'secret_text' }));
  assert.doesNotThrow(() => requireSecretNames(names));
  assert.throws(() => requireSecretNames(names, ['ENVOI_SCANNER_TOKEN']), /ENVOI_SCANNER_TOKEN/);
});
test('automatic beta Builds pins the exact Git SHA and never selects the old production Worker', () => {
  assert.deepEqual(betaBuildDeployArgs(main), ['deploy', '--env', 'beta', '--var', `ENVOI_RELEASE_SHA:${main}`, '--var', `SINALOA_RELEASE_SHA:${main}`]);
  assert.throws(() => betaBuildDeployArgs('short-sha'), /full Git commit SHA/);
});
test('staging deploy stamps the checked-out SHA on the explicit staging target', () => {
  assert.deepEqual(stagingDeployArgs({ sha: main, clean: true }), ['deploy', '--env', 'staging', '--var', `ENVOI_RELEASE_SHA:${main}`, '--var', `SINALOA_RELEASE_SHA:${main}`]);
});
for (const [name, input, message] of [
  ['dirty tracked or untracked work', { sha: main, clean: false }, /clean worktree/],
  ['short SHA', { sha: 'aabbcc', clean: true }, /40-hex/],
  ['uppercase SHA', { sha: 'A'.repeat(40), clean: true }, /40-hex/],
  ['missing SHA', { sha: '', clean: true }, /40-hex/]
]) test(`staging deploy refuses ${name}`, () => assert.throws(() => stagingDeployArgs(input), message));
test('staging deploy refuses an untracked file before invoking Wrangler', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'envoi-staging-deploy-'));
  try {
    const git = (...argv) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...argv], { cwd, stdio: 'ignore' });
    git('init', '-q');
    // A local config that hides untracked files must not hide them from the deploy check.
    git('config', 'status.showUntrackedFiles', 'no');
    git('commit', '-q', '--allow-empty', '-m', 'base');
    await writeFile(join(cwd, 'stray.txt'), 'uncommitted');
    await assert.rejects(deployStaging({ cwd, env: {} }), /clean worktree/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
