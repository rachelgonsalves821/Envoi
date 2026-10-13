import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('the onboarding manifest consumer and safety/conformance suite pass under the integration runner', () => {
  const tests = ['skill-contract.test.mjs', 'host-plan.test.mjs']
    .map((name) => fileURLToPath(new URL(name, import.meta.url)));
  const result = spawnSync(process.execPath, ['--test', ...tests], { encoding: 'utf8' });
  expect(result.status, result.stderr + result.stdout).toBe(0);
});
