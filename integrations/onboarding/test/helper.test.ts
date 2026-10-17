import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('private helper consumes canonical fixtures and passes recovery, privacy and CLI checks', () => {
  const files = ['helper-state.test.mjs', 'helper-store.test.mjs', 'helper-transport.test.mjs', 'envoi-link.test.mjs']
    .map(name => fileURLToPath(new URL(name, import.meta.url)));
  const result = spawnSync(process.execPath, ['--test', ...files], { encoding: 'utf8', timeout: 60_000 });
  expect(result.status, result.stderr + result.stdout).toBe(0);
});
