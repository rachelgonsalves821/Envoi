// scripts/ci-start-postgres.sh with a fake `docker` on PATH: the mirror path, the Docker Hub
// fallback, the exhausted-retry failure and the readiness deadline. Needs bash (CI has it; on
// Windows, Git Bash). Skipped where bash is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ci-start-postgres.sh');
const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
const skip = bash.status !== 0 ? 'bash is not available' : false;

// The fake records each call and fails a pull when its image is listed in FAKE_FAIL_PULLS.
const fakeDocker = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$1" in
  pull) case " $FAKE_FAIL_PULLS " in *" $2 "*) echo "toomanyrequests: Data limit exceeded" >&2; exit 1;; esac ;;
  exec) [ "$FAKE_READY" = yes ] || exit 1 ;;
esac
exit 0
`;

// Git Bash on Windows needs /d/... paths: a drive colon would split PATH.
const bashPath = value => (/^[A-Za-z]:/.test(value) ? `/${value[0].toLowerCase()}${value.slice(2)}` : value).split(path.sep).join('/');

async function run(t, env) {
  const dir = await mkdtemp(path.join(tmpdir(), 'envoi-ci-pg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'docker'), fakeDocker);
  await chmod(path.join(dir, 'docker'), 0o755);
  const log = path.join(dir, 'calls.log');
  await writeFile(log, '');
  const result = spawnSync('bash', ['-c', `PATH="${bashPath(dir)}:$PATH" bash "${bashPath(script)}"`], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_LOG: bashPath(log), ENVOI_CI_PULL_BACKOFF_SECONDS: '0', ENVOI_CI_POSTGRES_READY_SECONDS: '2', FAKE_READY: 'yes', FAKE_FAIL_PULLS: '', ...env }
  });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

test('the mirror is tried first and tagged as the official image', { skip }, async t => {
  const result = await run(t, {});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pulled from the mirror/);
  assert.deepEqual(result.calls.slice(0, 2), ['pull public.ecr.aws/docker/library/postgres:16-alpine', 'tag public.ecr.aws/docker/library/postgres:16-alpine postgres:16-alpine']);
  assert.ok(result.calls.some(call => call.startsWith('run -d --name envoi-ci-postgres -e POSTGRES_USER=sinaloa -e POSTGRES_PASSWORD=sinaloa_test -e POSTGRES_DB=sinaloa_test -p 5432:5432 postgres:16-alpine')));
  assert.ok(result.calls.some(call => call.startsWith('exec envoi-ci-postgres pg_isready -h 127.0.0.1')));
});

test('Docker Hub is the fallback when the mirror is throttled', { skip }, async t => {
  const result = await run(t, { FAKE_FAIL_PULLS: 'public.ecr.aws/docker/library/postgres:16-alpine' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pulled from the hub/);
  assert.deepEqual(result.calls.slice(0, 2), ['pull public.ecr.aws/docker/library/postgres:16-alpine', 'pull postgres:16-alpine']);
});

test('both registries throttled: a bounded number of attempts, then a visible failure', { skip }, async t => {
  const result = await run(t, { FAKE_FAIL_PULLS: 'public.ecr.aws/docker/library/postgres:16-alpine postgres:16-alpine', ENVOI_CI_PULL_ATTEMPTS: '3' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unavailable from both the mirror and Docker Hub after 3 attempts/);
  assert.equal(result.calls.filter(call => call.startsWith('pull ')).length, 6);
  assert.ok(!result.calls.some(call => call.startsWith('run ')), 'no container starts without an image');
});

test('a server that never becomes ready fails within the deadline', { skip }, async t => {
  const result = await run(t, { FAKE_READY: 'no' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not become ready within 2s/);
  assert.ok(result.calls.includes('logs envoi-ci-postgres'));
});
