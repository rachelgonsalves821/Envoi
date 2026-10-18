import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const bundle = new URL('../web/downloads/envoi-connector.mjs', import.meta.url);

async function temporaryDownload(context) {
  const directory = await mkdtemp(path.join(tmpdir(), 'envoi wake download-'));
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const download = path.join(directory, 'renamed-download.mjs');
  await copyFile(bundle, download);
  return { directory, download };
}

function run(directory, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(ENVOI_|OPENCLAW_|HERMES_|NODE_OPTIONS$)/.test(key)) delete env[key];
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) env[key] = directory;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: directory, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Standalone wake download test timed out')); }, 30_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end('{"enrollmentToken":"must-not-enroll"}\n');
  });
}

function assertSuccess(result) {
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
}

const networkGuard = String.raw`
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
const forbidden = [];
function deny(name) {
  return () => { forbidden.push(name); throw new Error('Forbidden effect: ' + name); };
}
globalThis.fetch = deny('fetch');
for (const transport of [http, https]) for (const name of ['request', 'get']) transport[name] = deny(name);
net.Server.prototype.listen = deny('listen');
net.Socket.prototype.connect = deny('socket.connect');
net.connect = deny('connect');
net.createConnection = deny('createConnection');
tls.connect = deny('tls.connect');
syncBuiltinESMExports();
`;

const sideEffectGuard = networkGuard + String.raw`
import filesystem from 'node:fs';
import promises from 'node:fs/promises';
import subprocess from 'node:child_process';
for (const name of ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rename', 'unlink', 'rm', 'rmdir', 'chmod', 'chown', 'truncate', 'copyFile', 'cp', 'symlink', 'link']) {
  if (typeof filesystem[name] === 'function') filesystem[name] = deny(name);
  if (typeof filesystem[name + 'Sync'] === 'function') filesystem[name + 'Sync'] = deny(name + 'Sync');
  if (typeof promises[name] === 'function') promises[name] = deny(name);
}
filesystem.createWriteStream = deny('createWriteStream');
for (const name of ['open', 'openSync']) {
  const original = filesystem[name];
  filesystem[name] = function(filename, flags, ...rest) {
    if (flags !== 'r' && flags !== 0) return deny(name)();
    return original.call(this, filename, flags, ...rest);
  };
}
const originalOpen = promises.open;
promises.open = function(filename, flags, ...rest) {
  if (flags !== 'r' && flags !== 0) return deny('promises.open')();
  return originalOpen.call(this, filename, flags, ...rest);
};
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) subprocess[name] = deny(name);
syncBuiltinESMExports();
process.on('exit', () => { if (forbidden.length) { process.stderr.write(JSON.stringify(forbidden)); process.exitCode = 1; } });
`;

test('wake download matches the published manifest', async () => {
  const bytes = await readFile(bundle);
  const release = JSON.parse(await readFile(new URL('../web/downloads/release.json', import.meta.url), 'utf8'));
  assert.equal(bytes.length, release.artifacts['envoi-connector.mjs'].size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), release.artifacts['envoi-connector.mjs'].sha256);
});

test('standalone import exports the six public functions without setup or host effects', async context => {
  const { directory, download } = await temporaryDownload(context);
  const runner = path.join(directory, 'import-only.mjs');
  await writeFile(runner, sideEffectGuard + String.raw`
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const download = process.argv[2];
process.argv.splice(2, 1);
const exported = await import(pathToFileURL(download).href);
assert.deepEqual(Object.keys(exported).sort(), ['EnvoiConnector', 'EnvoiError', 'FileWakeStore', 'HttpWakeReceiver', 'createScopedWakeHost', 'createWakeHttpHandler']);
for (const value of Object.values(exported)) assert.equal(typeof value, 'function');
assert.ok(new exported.EnvoiError('test') instanceof Error);
const originalEntry = process.argv[1];
delete process.argv[1];
const withoutEntry = await import(pathToFileURL(download).href + '?without-entry');
assert.deepEqual(Object.keys(withoutEntry).sort(), Object.keys(exported).sort());
process.argv[1] = originalEntry;
assert.deepEqual(forbidden, []);
assert.equal(process.exitCode, undefined);
process.stdout.write('import-only-ok');
`);
  const before = (await readdir(directory)).sort();
  const result = await run(directory, [runner, download, 'setup', '--handoff-stdin', '--install-service', '--prepare-runtime', '--state-dir', path.join(directory, 'private-state')]);
  assertSuccess(result);
  assert.equal(result.stdout, 'import-only-ok');
  assert.deepEqual((await readdir(directory)).sort(), before);
});

test('standalone wake classes persist signed acceptance and compose with the actual scoped connector', { timeout: 60_000 }, async context => {
  const { directory, download } = await temporaryDownload(context);
  const statusFixture = JSON.parse(await readFile(new URL('./contract-fixtures/case-session/agent-status-case-sessions.json', import.meta.url), 'utf8'));
  const idleFixture = JSON.parse(await readFile(new URL('./contract-fixtures/a4-wake/claim-idle-next-available.json', import.meta.url), 'utf8'));
  await writeFile(path.join(directory, 'fixtures.json'), JSON.stringify({ status: statusFixture.response.body, idle: idleFixture.response.body }));
  const runner = path.join(directory, 'wake-roundtrip.mjs');
  await writeFile(runner, networkGuard + String.raw`
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const { EnvoiConnector, EnvoiError, HttpWakeReceiver, FileWakeStore, createScopedWakeHost, createWakeHttpHandler } = await import(pathToFileURL(process.argv[2]).href);
const origin = 'https://envoi.example';
const registeredUrl = 'https://hooks.example.com/envoi/wake';
const identity = { agentId: 'agent_example', installationId: 'installation_example', inboxId: 'inbox_example' };
const clock = Date.now();
const notification = { version: 1, type: 'wake.work_available', id: 'wake_evt_abcdefghijklmnop', subscriptionId: 'wake_sub_example', sequence: 2, reason: 'message_delivered', createdAt: new Date(clock).toISOString() };
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const kid = 'test-key';
const timestamp = String(Math.floor(clock / 1000));
const body = Buffer.from(JSON.stringify(notification));
const prefix = 'envoi-wake/1\n' + kid + '\n' + timestamp + '\n' + notification.id + '\n' + registeredUrl + '\n';
const signature = 'v1=' + sign(null, Buffer.concat([Buffer.from(prefix), body]), privateKey).toString('base64url');
const request = { method: 'POST', body, headers: { 'content-type': 'application/json', 'envoi-wake-id': notification.id, 'envoi-wake-timestamp': timestamp, 'envoi-wake-key-id': kid, 'envoi-wake-signature': signature } };
let keyRequests = 0;
const fetchKeys = async (input, options) => {
  assert.equal(String(input), origin + '/.well-known/envoi-wake-keys.json');
  assert.equal(new Headers(options?.headers).has('authorization'), false);
  keyRequests++;
  return Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig', status: 'active' }] }, { headers: { 'cache-control': 'max-age=300' } });
};
const storePath = path.join(process.cwd(), 'private-wake');
let store = await FileWakeStore.open(storePath);
try {
  await store.update(state => { state.subscriptions[notification.subscriptionId] = { url: registeredUrl, status: 'active', installationId: identity.installationId }; });
  const receiver = new HttpWakeReceiver({ origin, registeredUrl, store, fetch: fetchKeys, now: () => clock });
  const accepted = await receiver.receive(request);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.acceptedId, notification.id);
  assert.deepEqual(accepted.notification, notification);
  const saved = (await store.read()).accepted[notification.id];
  assert.equal(saved.pending, true);
  assert.equal(saved.acknowledged, false);
} finally { await store.close(); }
store = await FileWakeStore.open(storePath);
try {
  const receiver = new HttpWakeReceiver({ origin, registeredUrl, store, fetch: fetchKeys, now: () => clock });
  const before = await store.read();
  const duplicate = await receiver.receive(request);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.acceptedId, notification.id);
  assert.equal(duplicate.notification, undefined);
  assert.deepEqual(await store.read(), before);
  assert.equal(keyRequests, 2);
  const fixtures = JSON.parse(await readFile('fixtures.json', 'utf8'));
  fixtures.status.httpWake = { available: false, version: 1, subscription: null };
  const requests = [];
  let handlerCalls = 0;
  let session = { ...identity, address: 'example@envoi.mail', cursor: null, agentApiToken: 'private-access-test', agentRefreshToken: 'private-refresh-test', agentTokenExpiresAt: new Date(clock + 3600000).toISOString(), agentRefreshTokenExpiresAt: new Date(clock + 86400000).toISOString() };
  const credentials = {
    load: async () => structuredClone(session),
    save: async saved => {
      assert.equal(saved.agentApiToken, 'private-access-test');
      assert.equal(saved.agentRefreshToken, 'private-refresh-test');
      session = structuredClone(saved);
    }
  };
  const fetcher = async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, origin);
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer private-access-test');
    requests.push(url.pathname);
    if (url.pathname === '/api/agent/status') {
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      return Response.json(fixtures.status);
    }
    assert.equal(url.pathname, '/api/agent/work/claim');
    assert.equal(options.method, 'POST');
    return Response.json(fixtures.idle);
  };
  const handler = { admit: async () => { handlerCalls++; }, process: async () => { handlerCalls++; } };
  for (const options of [{}, { handler }]) {
    const unscoped = new EnvoiConnector(origin, credentials, { fetch: fetcher, ...options });
    assert.throws(() => createScopedWakeHost({ connector: unscoped, origin, registeredUrl, identity, store }), error => error instanceof EnvoiError && error.code === 'SCOPED_HANDLER_REQUIRED');
  }
  assert.deepEqual(requests, []);
  const connector = new EnvoiConnector(origin, credentials, { fetch: fetcher, caseSessionHandler: handler });
  assert.ok(connector instanceof EnvoiConnector);
  const driver = connector.scopedWakeWorkDriver();
  assert.equal(Object.isFrozen(driver), true);
  const host = createScopedWakeHost({ connector, origin, registeredUrl, identity, store });
  const controller = new AbortController();
  assert.equal(typeof createWakeHttpHandler({ path: '/envoi/wake', receiver, host, signal: controller.signal }), 'function');
  await host.poll(controller.signal);
  assert.deepEqual(requests, ['/api/agent/status', '/api/agent/status', '/api/agent/work/claim']);
  assert.equal(handlerCalls, 0);
  assert.ok(driver.nextAvailableInMs() > 0 && driver.nextAvailableInMs() <= fixtures.idle.nextAvailableInMs);
  assert.doesNotMatch(JSON.stringify(await store.read()), /private-access-test|private-refresh-test/);
  assert.deepEqual(forbidden, []);
  process.stdout.write('wake-roundtrip-ok');
} finally { await store.close(); }
`);
  const result = await run(directory, [runner, download]);
  assertSuccess(result);
  assert.equal(result.stdout, 'wake-roundtrip-ok');
});

test('renamed standalone CLI runs help without external effects', async context => {
  const { directory, download } = await temporaryDownload(context);
  const guard = path.join(directory, 'guard.mjs');
  await writeFile(guard, sideEffectGuard);
  const before = (await readdir(directory)).sort();
  const result = await run(directory, ['--import', pathToFileURL(guard).href, download, '--help']);
  assertSuccess(result);
  assert.match(result.stdout, /Envoi connector/);
  assert.match(result.stdout, /setup --handoff/);
  if (process.platform === 'win32') {
    const alternateCase = await run(directory, ['--import', pathToFileURL(guard).href, path.join(path.dirname(download).toUpperCase(), path.basename(download)), '--help']);
    assertSuccess(alternateCase);
    assert.match(alternateCase.stdout, /Envoi connector/);
  }
  assert.deepEqual((await readdir(directory)).sort(), before);
});

test('standalone CLI recognizes a symlinked entry or Windows junction parent', async context => {
  const { directory, download } = await temporaryDownload(context);
  const guard = path.join(directory, 'guard.mjs');
  await writeFile(guard, sideEffectGuard);
  let linkedEntry = path.join(directory, 'linked-download.mjs');
  try { await symlink(download, linkedEntry, 'file'); }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    const actualDirectory = path.join(directory, 'actual');
    const linkedDirectory = path.join(directory, 'linked');
    await mkdir(actualDirectory);
    await copyFile(download, path.join(actualDirectory, 'connector.mjs'));
    await symlink(actualDirectory, linkedDirectory, 'junction');
    linkedEntry = path.join(linkedDirectory, 'connector.mjs');
  }
  const result = await run(directory, ['--import', pathToFileURL(guard).href, linkedEntry, '--help']);
  assertSuccess(result);
  assert.match(result.stdout, /Envoi connector/);
  assert.match(result.stdout, /setup --handoff/);
});
