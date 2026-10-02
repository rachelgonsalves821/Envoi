import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

test('local server starts with a relative SINALOA_DATA_DIR', { timeout: 20_000 }, async t => {
  const fixtureRoot = path.join(process.cwd(), 'data');
  await mkdir(fixtureRoot, { recursive: true });
  const directory = await mkdtemp(path.join(fixtureRoot, 'startup-relative-'));
  assert.ok(path.resolve(directory).startsWith(path.resolve(fixtureRoot) + path.sep));
  const relative = path.relative(process.cwd(), directory);
  assert.equal(path.isAbsolute(relative), false);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: '', SINALOA_HOST: '127.0.0.1', SINALOA_PORT: '0',
      SINALOA_DATA_DIR: relative, SINALOA_AUTH_MODE: 'development', SINALOA_HUMAN_AUTH_PROVIDER: 'local',
      SINALOA_OBJECT_STORAGE_PROVIDER: 'local', SINALOA_PUBLIC_URL: '', SINALOA_ENABLE_EXTERNAL_EMAIL: 'false',
      SINALOA_ENABLE_CALENDAR_WRITES: 'false', SINALOA_COOKIE_SECURE: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
    }
    // Remove only the disposable fixture created under this workspace's data directory.
    await rm(directory, { recursive: true, force: true });
  });
  let stderr = '', stdout = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Local server did not start: ${stderr}`)), 10_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Local server exited with ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk).slice(-4000);
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const config = await fetch(`${baseUrl}/api/auth/config`, { signal: AbortSignal.timeout(5000) });
  assert.equal(config.status, 200);
  assert.equal((await config.json()).provider, 'local');
});
