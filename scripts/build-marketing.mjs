import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const prefix = 'frontend/marketing-preview';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (program, args, shell = false) => {
  const result = spawnSync(program, args, { stdio: 'inherit', shell, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};

if (process.env.CI || !existsSync(`${prefix}/node_modules/astro/package.json`)) run(npm, ['--prefix', prefix, 'ci', '--ignore-scripts'], process.platform === 'win32');
run(npm, ['--prefix', prefix, 'run', 'build'], process.platform === 'win32');
run(process.execPath, ['scripts/package-marketing.mjs']);
