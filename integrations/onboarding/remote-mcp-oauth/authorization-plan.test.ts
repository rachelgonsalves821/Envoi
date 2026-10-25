import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Keep the standalone Node suite runnable and include its canonical planner cases in CI's Vitest runner.
it('runs the full standalone OAuth/CIMD planner regression suite', () => {
  const output = execFileSync(process.execPath, ['--test', fileURLToPath(new URL('./authorization-plan.test.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8', windowsHide: true, timeout: 25_000
  });
  expect(output).toMatch(/# fail 0\b/);
  expect(output).toContain('approved CIMD client planner: modern-chatgpt-preference');
});
