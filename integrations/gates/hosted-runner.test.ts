import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Keep the Node-only operator tooling in the existing integration CI suite.
it('passes the hosted fault proxy, preflight and disposable helper tests', () => {
  const files = ['phase-a-fault-proxy.test.mjs', 'phase-a-hosted-preflight.test.mjs', 'prepare-disposable-hermes.test.mjs']
    .map(file => fileURLToPath(new URL(file, import.meta.url)));
  const output = execFileSync(process.execPath, ['--test', ...files], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true
  });
  expect(output).toMatch(/# fail 0\b/);
  expect(output).toMatch(/# skipped 0\b/);
});
