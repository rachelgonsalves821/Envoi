import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { draftConnect } from '../envoi-link.mjs';

const command = fileURLToPath(new URL('../envoi-link.mjs', import.meta.url));
const origin = 'https://www.envoi-agents.com';

test('draft connect has a fixed safe result and grants no access', () => {
  assert.deepEqual(draftConnect(['connect', origin]), {
    schemaVersion: 'draft-1', state: 'contract_blocked', liveEnrollmentAllowed: false,
    nextAction: 'Wait for an approved Phase B registration and installation contract. No Envoi access was granted.',
  });
  const result = spawnSync(process.execPath, [command, 'connect', origin], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), draftConnect(['connect', origin]));
});

test('draft connect rejects token-bearing or noncanonical arguments without echoing them', () => {
  for (const args of [
    ['connect', `${origin}/connect`], ['connect', 'https://evil.example'],
    ['connect', `${origin}?token=secret-never-output`],
    ['connect', origin, '--token', 'secret-never-output'],
    ['status', origin],
  ]) {
    assert.throws(() => draftConnect(args), /unpublished Envoi connect draft/);
    const result = spawnSync(process.execPath, [command, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /secret-never-output|evil\.example/);
  }
});
