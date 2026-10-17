import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { draftConnect, runCli } from '../envoi-link.mjs';
const command = fileURLToPath(new URL('../envoi-link.mjs', import.meta.url));
const origin = 'https://www.envoi-agents.com';

test('source entry without trusted runtime returns safe unavailable output before any request', async () => {
  let fetched = false;
  const output = await runCli(['connect', origin], { fetch: async () => { fetched = true; throw new Error('must not call'); } });
  assert.equal(output.state, 'needs_help'); assert.equal(fetched, false);
  const result = spawnSync(process.execPath, [command, 'connect', origin], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stderr, ''); assert.deepEqual(JSON.parse(result.stdout), output);
  assert.doesNotMatch(result.stdout, /contract_blocked|liveEnrollmentAllowed|envoi_reg_/);
});

test('entry rejects token-bearing, malformed and unsupported arguments without echoing them', () => {
  for (const args of [
    ['connect', `${origin}/connect`], ['connect', `${origin}?token=secret-never-output`],
    ['connect', origin, '--token', 'secret-never-output'], ['connect', 'https://user:secret-never-output@example.com'],
    ['connect', origin, '--runtime', 'unsupported-secret-never-output'], ['send', origin],
  ]) {
    const result = spawnSync(process.execPath, [command, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(result.stderr, ''); assert.equal(JSON.parse(result.stdout).state, 'needs_help');
    assert.doesNotMatch(result.stdout, /secret-never-output|user:|unsupported-secret|example\.com/);
  }
});

test('legacy unpublished draft API still rejects foreign origins and tokens without granting access', () => {
  assert.equal(draftConnect(['connect', origin]).liveEnrollmentAllowed, false);
  for (const args of [['connect', 'https://evil.example'], ['connect', `${origin}?token=secret-never-output`], ['connect', origin, '--token', 'secret-never-output']]) {
    assert.throws(() => draftConnect(args), /unpublished Envoi connect draft/);
  }
});
