import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, readFile, lstat, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrivateStore, secureDirectory, windowsExecutable } from '../helper/store.mjs';
const fixtureDirectory = async fn => {
  const directory = await mkdtemp(path.join(tmpdir(), 'envoi-helper-test-'));
  try { return await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};
const localSecurity = directory => secureDirectory(directory, { platform: 'posix' });

test('private store writes a whole synced record and leaves no partial temporary file', async () => fixtureDirectory(async directory => {
  const events = [];
  const store = await new PrivateStore(directory, { secureDirectory: localSecurity, fault: async (stage, name) => events.push(`${stage}:${name}`) }).init();
  await store.write('helper-state.json', { version: 1, bootstrapToken: 'private' });
  assert.deepEqual(await store.read('helper-state.json'), { version: 1, bootstrapToken: 'private' });
  assert.deepEqual(events, ['after_file_sync:helper-state.json', 'after_rename:helper-state.json']);
  assert.deepEqual(await readdir(directory), ['helper-state.json']);
  if (process.platform !== 'win32') { assert.equal((await lstat(directory)).mode & 0o777, 0o700); assert.equal((await lstat(path.join(directory, 'helper-state.json'))).mode & 0o777, 0o600); }
}));

test('rename boundary failure preserves committed record and readable recovery state', async () => fixtureDirectory(async directory => {
  const store = await new PrivateStore(directory, { secureDirectory: localSecurity }).init();
  await store.write('session.json', { version: 1 });
  store.options.fault = async stage => { if (stage === 'after_file_sync') throw new Error('crash'); };
  await assert.rejects(store.write('session.json', { version: 2 }));
  assert.deepEqual(await store.read('session.json'), { version: 1 });
}));

test('malformed, null and oversized state fail closed without overwrite', async () => fixtureDirectory(async directory => {
  const store = await new PrivateStore(directory, { secureDirectory: localSecurity }).init();
  for (const value of ['{broken', 'null', '[]', 'x'.repeat(128_001)]) {
    await writeFile(path.join(directory, 'helper-state.json'), value);
    await assert.rejects(store.read('helper-state.json'));
    assert.equal(await readFile(path.join(directory, 'helper-state.json'), 'utf8'), value);
  }
  assert.throws(() => store.filename('../session.json'));
}));

test('only one helper may use the state directory and release preserves lock ownership', async () => fixtureDirectory(async directory => {
  const first = await new PrivateStore(directory, { secureDirectory: localSecurity }).init();
  const second = new PrivateStore(directory, { secureDirectory: localSecurity });
  await first.lock(async () => {
    await assert.rejects(second.lock(async () => assert.fail('must not acquire live lock')), /STATE_BUSY/);
    assert.equal((await first.read('helper.lock')).pid, process.pid);
  });
  await second.lock(async () => {});
  assert.equal(await second.read('helper.lock'), null);
}));

test('dead helper lock recovers once; incomplete lock is preserved for inspection', async () => fixtureDirectory(async directory => {
  const store = await new PrivateStore(directory, { secureDirectory: localSecurity }).init();
  await writeFile(path.join(directory, 'helper.lock'), JSON.stringify({ pid: 2147483647, nonce: 'dead-owner' }));
  await store.lock(async () => assert.equal((await store.read('helper.lock')).pid, process.pid));
  await writeFile(path.join(directory, 'helper.lock'), '');
  await assert.rejects(store.lock(async () => {}));
  assert.equal(await readFile(path.join(directory, 'helper.lock'), 'utf8'), '');
}));

test('existing connector lock prevents a second credential writer', async () => fixtureDirectory(async directory => {
  const store = await new PrivateStore(directory, { secureDirectory: localSecurity }).init();
  await writeFile(path.join(directory, 'connector.lock'), JSON.stringify({ pid: process.pid, nonce: 'runtime' }));
  await assert.rejects(store.lock(async () => assert.fail('must not run')), /STATE_BUSY/);
  assert.equal(await store.read('helper.lock'), null);
}));

test('symbolic link files cannot redirect state reads or writes', async () => fixtureDirectory(async directory => {
  const store = await new PrivateStore(directory, { secureDirectory: localSecurity }).init();
  await writeFile(path.join(directory, 'target.json'), '{"private":true}');
  try { await symlink(path.join(directory, 'target.json'), path.join(directory, 'helper-state.json')); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(store.read('helper-state.json'), /STATE_INVALID/);
  await assert.rejects(store.write('helper-state.json', { overwritten: true }), /STATE_INVALID/);
  assert.equal(await readFile(path.join(directory, 'target.json'), 'utf8'), '{"private":true}');
}));

test('Windows privacy uses absolute system helpers, account SID and terminating ACL errors', async () => fixtureDirectory(async directory => {
  await writeFile(path.join(directory, 'existing.json'), '{}');
  const calls = [];
  const run = async (command, args, options) => { calls.push({ command, args, options }); return { stdout: command.endsWith('whoami.exe') ? '"user","S-1-5-21-123"' : '' }; };
  await secureDirectory(directory, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run });
  assert.equal(calls.length, 3); assert.equal(calls[0].command, 'C:\\Windows\\System32\\whoami.exe');
  assert.match(calls[1].args.at(-1), /SetAccessRuleProtection\(\$true,\$false\)/);
  assert.match(calls[1].args.at(-1), /SetOwner/); assert.match(calls[1].args.at(-1), /S-1-5-21-123/);
  assert.equal(calls[2].command, 'C:\\Windows\\System32\\icacls.exe'); assert.ok(calls.every(call => call.options.windowsHide));
  await assert.rejects(secureDirectory(directory, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run: async command => {
    if (command.endsWith('whoami.exe')) return { stdout: '"user","S-1-5-21-123"' }; throw new Error('ACL denied');
  } }), /ACL denied/);
  assert.throws(() => windowsExecutable('whoami.exe', { SystemRoot: 'unsafe-root' }));
}));
