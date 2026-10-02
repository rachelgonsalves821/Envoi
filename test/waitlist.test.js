import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileStore } from '../src/storage.js';
import { joinWaitlist, normalizeWaitlistEmail } from '../src/waitlist.js';

test('waitlist validates, normalizes, and de-duplicates without leaking the email in the key', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sinaloa-waitlist-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root);
  await store.init();
  assert.equal(normalizeWaitlistEmail(' RACHEL@Example.com '), 'rachel@example.com');
  assert.equal(normalizeWaitlistEmail('not-an-email'), null);
  assert.deepEqual(await joinWaitlist(store, { email: 'bad' }), { error: 'Enter a valid email address' });
  assert.deepEqual(await joinWaitlist(store, { email: 'rachel@example.com', company: 'bot' }), { accepted: true });
  assert.equal((await readdir(path.join(root, 'waitlist')).catch(() => [])).length, 0);
  assert.equal((await joinWaitlist(store, { email: ' RACHEL@Example.com ' })).created, true);
  assert.equal((await joinWaitlist(store, { email: 'rachel@example.com' })).created, false);
  const files = await readdir(path.join(root, 'waitlist'));
  assert.equal(files.length, 1);
  assert.doesNotMatch(files[0], /rachel|example/);
  const entry = JSON.parse(await readFile(path.join(root, 'waitlist', files[0]), 'utf8'));
  assert.equal(entry.email, 'rachel@example.com');
  assert.equal(entry.source, 'landing');
});

test('public waitlist endpoint accepts only bounded JSON and never exposes entries', { timeout: 30000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sinaloa-waitlist-http-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, DATABASE_URL: '', SINALOA_HOST: '127.0.0.1', SINALOA_PORT: '0', SINALOA_DATA_DIR: dataDir,
      SINALOA_AUTH_MODE: 'development', SINALOA_HUMAN_AUTH_PROVIDER: 'local', SINALOA_OBJECT_STORAGE_PROVIDER: 'local',
      SINALOA_ENABLE_EXTERNAL_EMAIL: 'false', SINALOA_ENABLE_CALENDAR_WRITES: 'false', SINALOA_ENABLE_CONSEQUENTIAL_ACTIONS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await stopped;
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  const baseUrl = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Waitlist test server did not start')), 10000);
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Waitlist test server exited early')));
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  const post = (payload, headers = { 'content-type': 'application/json' }) => fetch(`${baseUrl}/api/waitlist`, { method: 'POST', headers, body: payload });
  assert.equal((await post(JSON.stringify({ email: 'hello@example.com' }))).status, 200);
  assert.equal((await post(JSON.stringify({ email: 'HELLO@example.com' }))).status, 200);
  assert.equal((await post(JSON.stringify({ email: 'invalid' }))).status, 400);
  assert.equal((await post(JSON.stringify({ email: 'bot@example.com', company: 'spam' }))).status, 200);
  assert.equal((await post('a'.repeat(2100))).status, 413);
  assert.equal((await post('hello@example.com', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await fetch(`${baseUrl}/api/waitlist`)).status, 404);
  assert.equal((await readdir(path.join(dataDir, 'waitlist'))).length, 1);
});
