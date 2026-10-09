// GA3/A2 prerequisite probe. No runtime host is started and no service is mocked.
// Run from PowerShell after npm run build. Exit 1 means a gate prerequisite failed.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { owner } from '../../test/a3-harness.js';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = '478c2d758f0360704fb96d5940a287b85453f44a';
const output = path.resolve(process.argv[2] || path.join(root, 'integrations/gates/evidence/ga3-478c2d7'));
const artifact = path.join(root, 'web/downloads/envoi-connector.mjs');
const protectedPaths = ['.', ':(exclude)integrations/gates'];
const diff = await exec('git', ['diff', sha, '--', ...protectedPaths], { cwd: root, windowsHide: true });
assert.equal(diff.stdout, '', 'Gate server/connector/harness sources must match the exact integration SHA');
const release = JSON.parse(await readFile(path.join(root, 'web/downloads/release.json'), 'utf8'));
const artifactHash = createHash('sha256').update(await readFile(artifact)).digest('hex');
assert.equal(artifactHash, release.artifacts['envoi-connector.mjs'].sha256);
const scratch = await mkdtemp(path.join(tmpdir(), 'envoi-ga3-'));
const stateDir = path.join(scratch, 'connector');
const captureFile = path.join(scratch, 'connector-health.json');
const recorder = path.join(scratch, 'health-recorder.mjs');
await mkdir(stateDir);
const secrets = [];
const sanitize = value => {
  let text = String(value).replaceAll(scratch, '<private-gate-dir>').replaceAll(JSON.stringify(scratch).slice(1, -1), '<private-gate-dir>');
  for (const secret of secrets) text = text.replaceAll(secret, '<redacted>');
  return text.replace(/sinaloa_(?:agent_(?:access|refresh)|mcp_read|enroll)_[A-Za-z0-9_-]+/g, '<redacted>');
};
const env = { ...process.env, DATABASE_URL: '' };
for (const key of Object.keys(env)) if (/^(ENVOI|SINALOA)_/.test(key)) delete env[key];
for (const [key, value] of Object.entries({ PORT: '0', AUTH_MODE: 'development', DATA_DIR: path.join(scratch, 'data'), RELEASE_SHA: sha })) {
  env[`ENVOI_${key}`] = value;
  env[`SINALOA_${key}`] = value;
}
const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
let server;
let connector;
let serverLog = '';
let connectorLog = '';
let mismatch;
let infrastructureError;
const snapshots = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
async function killOwned(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  else child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('close', resolve)), sleep(2000)]);
}
try {
  server = spawn(process.execPath, [npmCli, 'start'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { serverLog += `[stdout] ${chunk}`; });
  server.stderr.on('data', chunk => { serverLog += `[stderr] ${chunk}`; });
  server.on('error', error => { serverLog += `[spawn error] ${error.message}\n`; });
  const baseUrl = await waitFor(() => {
    assert.equal(server.exitCode, null, `npm start exited: ${serverLog}`);
    return serverLog.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  }, 'npm start FileStore listening');
  const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10000) });
  const responseBody = await response.text();
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(responseBody).releaseSha, sha);
  assert.equal(JSON.parse(responseBody).service, 'envoi');
  // Observe the built CLI's actual health exchange without changing the response.
  await writeFile(recorder, `import { writeFile } from 'node:fs/promises';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  const url = String(args[0] instanceof Request ? args[0].url : args[0]);
  if (new URL(url).pathname === '/health') {
    await writeFile(${JSON.stringify(captureFile)}, JSON.stringify({ request: { method: args[1]?.method || 'GET', url, body: args[1]?.body ?? null }, response: { status: response.status, headers: Object.fromEntries(response.headers), body: await response.clone().text() } }));
  }
  return response;
};
`);
  const actor = await owner(baseUrl, '9301');
  const session = { agentId: actor.agent.id, inboxId: actor.inbox.id, address: actor.agent.address,
    agentApiToken: actor.agentApiToken, agentRefreshToken: actor.agentRefreshToken,
    agentTokenExpiresAt: actor.agentTokenExpiresAt, agentRefreshTokenExpiresAt: actor.agentRefreshTokenExpiresAt, cursor: null };
  secrets.push(session.agentApiToken, session.agentRefreshToken);
  assert.ok(secrets.every(value => typeof value === 'string' && value.length > 0));
  await writeFile(path.join(stateDir, 'session.json'), JSON.stringify(session), { mode: 0o600 });
  // Adapter setup is deliberately deferred: the real CLI checks health first.
  // If it reaches the adapter, this probe ends; it cannot certify a runtime host.
  await writeFile(path.join(stateDir, 'connection.json'), JSON.stringify({ version: 1, runtime: 'hermes', apiUrl: baseUrl,
    address: session.address, agentName: 'GA3 disposable startup probe', configuration: { gateProbe: true } }), { mode: 0o600 });
  connector = spawn(process.execPath, ['--import', pathToFileURL(recorder).href, artifact, 'start', '--state-dir', stateDir], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  connector.stdout.on('data', chunk => { connectorLog += `[stdout] ${chunk}`; });
  connector.stderr.on('data', chunk => { connectorLog += `[stderr] ${chunk}`; });
  connector.on('error', error => { connectorLog += `[spawn error] ${error.message}\n`; });
  await waitFor(() => {
    assert.equal(connector.exitCode, null, `connector exited: ${connectorLog}`);
    return connectorLog.includes('ENVOI_UNREACHABLE');
  }, 'real CLI health rejection');
  const status = await exec(process.execPath, [artifact, 'status', '--state-dir', stateDir], { cwd: root, env, windowsHide: true });
  snapshots.push({ command: 'status', output: JSON.parse(status.stdout) });
  const doctor = await exec(process.execPath, [artifact, 'doctor', '--state-dir', stateDir], { cwd: root, env, windowsHide: true });
  snapshots.push({ command: 'doctor', output: JSON.parse(doctor.stdout) });
  assert.equal(snapshots[0].output.status, 'waiting');
  assert.equal(snapshots[0].output.lifecycle.state, 'DEGRADED');
  assert.equal(snapshots[1].output.errorCode, 'ENVOI_UNREACHABLE');
  const durable = JSON.parse(await readFile(path.join(stateDir, 'session.json'), 'utf8'));
  assert.equal(durable.agentId, session.agentId, 'startup did not re-enroll');
  assert.equal(durable.agentRefreshToken, session.agentRefreshToken, 'startup did not rotate');
  const actualHealth = JSON.parse(await readFile(captureFile, 'utf8'));
  assert.equal(actualHealth.response.status, 200);
  assert.equal(JSON.parse(actualHealth.response.body).service, 'envoi');
  mismatch = { id: 'a3-pause-auth v1 GA3/A2 connector-health', ...actualHealth,
    expected: 'HTTP 200 Envoi health is accepted; installed connector proceeds to adapter preflight and lifecycle scenarios.',
    observed: 'Built connector rejects service=envoi as ENVOI_UNREACHABLE; status=waiting, lifecycle=DEGRADED/NETWORK_ERROR; retries before adapter preflight.',
    source: 'integrations/connector/core.ts:98 requires service=sinaloa; src/server.js:1973 returns service=envoi',
    gateResult: 'FAIL at startup prerequisite',
    notRun: ['restart', 'outage', 'pause', 'held work', 'resume', 'refresh across pause', 'revoke'],
    snapshots };
  const stopped = await exec(process.execPath, [artifact, 'stop', '--state-dir', stateDir], { cwd: root, env, windowsHide: true });
  connectorLog += `[control stop] ${stopped.stdout}`;
} catch (error) {
  infrastructureError = { message: error.message, stack: error.stack };
} finally {
  await killOwned(connector);
  await killOwned(server);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'connector.log'), sanitize(connectorLog).replace(/[ \t]+$/gm, ''));
  await writeFile(path.join(output, 'server.log'), sanitize(serverLog).replace(/[ \t]+$/gm, ''));
  const result = { testedIntegrationSha: sha, artifactSha256: artifactHash, node: process.version,
    instrumentation: 'Node --import records only the built CLI health request and a cloned response; no request/response mutation', serverCommand: 'npm start', storage: 'FileStore', authMode: 'development', recordedAt: new Date().toISOString(), mismatch, infrastructureError };
  await writeFile(path.join(output, 'result.json'), sanitize(JSON.stringify(result, null, 2)) + '\n');
  // Only delete the private directory created by this invocation, within tmpdir.
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(tmpdir()));
  assert.ok(path.basename(scratch).startsWith('envoi-ga3-'));
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(`${mismatch ? 'MISMATCH: installed connector rejects real Envoi health' : 'Probe infrastructure failed'}; evidence: ${output}`);
process.exitCode = 1;
