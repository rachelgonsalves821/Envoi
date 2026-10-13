import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { originOf, releaseMatches, manifestMatches, sha256, disposableHermesCommand, versionMatches, hermesVersion, separateApiPort, inspectDisposableProfile } from './phase-a-hosted-preflight.mjs';

test('uses the CLI inside the disposable profile instead of a machine-wide Hermes command', () => {
  const home = 'C:\\disposable\\hermes';
  assert.equal(disposableHermesCommand(home, 'win32'), 'C:\\disposable\\hermes\\bin\\hermes.exe');
  assert.equal(disposableHermesCommand('/tmp/hermes', 'linux'), '/tmp/hermes/bin/hermes');
});

test('requires a bare HTTPS origin', () => {
  assert.equal(originOf('https://staging.example.test'), 'https://staging.example.test');
  for (const value of ['http://staging.example.test', 'https://staging.example.test/other',
    'https://user:pass@staging.example.test/', 'https://staging.example.test/?token=x']) {
    assert.throws(() => originOf(value));
  }
});

test('requires one exact healthy release including critical providers', () => {
  const sha = 'a'.repeat(40);
  const health = { ok: true, releaseSha: sha, configurationValidated: true };
  const ready = { ready: true, releaseSha: sha, checks: { database: { ready: true }, objectStorageReadAccess: { ready: true }, malwareScanner: { ready: true } } };
  assert.equal(releaseMatches(health, ready, sha), true);
  assert.equal(releaseMatches(health, { ...ready, releaseSha: 'b'.repeat(40) }, sha), false);
  assert.equal(releaseMatches(health, { ...ready, checks: { ...ready.checks, malwareScanner: { ready: false } } }, sha), false);
  assert.equal(releaseMatches({ ...health, configurationValidated: false }, ready, sha), false);
  const { configurationValidated, ...oldHealth } = health;
  assert.equal(releaseMatches(oldHealth, ready, sha), false);
});

test('records only the CLI version and requires the exact expected version', () => {
  const version = 'v0.21.6+774.g835c3dd';
  assert.equal(hermesVersion(`Hermes ${version}\n`), '0.21.6+774.g835c3dd');
  assert.equal(versionMatches(`Hermes ${version}`, version), true);
  assert.equal(versionMatches('Hermes v0.21.7', version), false);
  assert.equal(versionMatches('', version), false);
  assert.equal(hermesVersion('private config or token'), null);
});

test('requires an explicit disposable API port different from the regular port', () => {
  assert.equal(separateApiPort('API_SERVER_KEY=private\nAPI_SERVER_PORT=9864\n'), 9864);
  assert.equal(separateApiPort('API_SERVER_PORT="9864" # disposable\n', 9864), null);
  for (const text of ['', 'API_SERVER_PORT=8642', 'API_SERVER_PORT=0', 'API_SERVER_PORT=65536', 'API_SERVER_PORT=not-a-port',
    'API_SERVER_PORT="9864\'', 'API_SERVER_PORT=9864\nAPI_SERVER_PORT=invalid']) {
    assert.equal(separateApiPort(text), null);
  }
});

test('checks the actual disposable directory and private port setting without returning secrets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'envoi-preflight-'));
  try {
    const profile = path.join(root, 'home'); await mkdir(profile);
    assert.equal(await inspectDisposableProfile(profile), null);
    await writeFile(path.join(profile, '.env'), 'API_SERVER_PORT=8642\nAPI_SERVER_KEY=private\n');
    assert.equal(await inspectDisposableProfile(profile), null);
    await writeFile(path.join(profile, '.env'), 'API_SERVER_PORT=9864\nAPI_SERVER_KEY=private\n');
    assert.equal(await inspectDisposableProfile(profile), 9864);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('requires matching release metadata and both exact bundle bytes', () => {
  const bytes = Buffer.from('fixture bundle');
  const manifest = { runtimes: ['hermes'], artifacts: { 'envoi-connector.mjs': { sha256: sha256(bytes), size: bytes.length } } };
  assert.equal(manifestMatches(manifest, manifest, bytes, bytes), true);
  assert.equal(manifestMatches(manifest, manifest, bytes, Buffer.from('changed')), false);
  assert.equal(manifestMatches({ ...manifest, runtimes: ['openclaw'] }, manifest, bytes, bytes), false);
});
