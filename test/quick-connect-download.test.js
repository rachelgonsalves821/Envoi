import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, copyFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const bundle = new URL('../web/downloads/envoi-openclaw.mjs', import.meta.url);
const releaseFile = new URL('../web/downloads/release.json', import.meta.url);

async function listen(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const close = server => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
const json = (response, value, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
};
async function body(request) { let value = ''; for await (const chunk of request) value += chunk; return value; }

function run(executable, args, cwd, input = '') {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(OPENCLAW_|SINALOA_)/.test(key)) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...args], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Standalone setup timed out')); }, 30_000);
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

for (const artifact of ['envoi-openclaw.mjs', 'envoi-connector.mjs']) {
test(`distributed ${artifact} runs without repository dependencies and protects saved credentials`, { timeout: 60_000 }, async t => {
  const bundle = new URL(`../web/downloads/${artifact}`, import.meta.url);
  const unified = artifact === 'envoi-connector.mjs';
  const directory = await mkdtemp(path.join(tmpdir(), 'sinaloa-download-'));
  // Only remove the fixture directory created by this test, never an arbitrary configured path.
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const download = path.join(directory, 'download.mjs');
  const stateDir = path.join(directory, 'private state');
  const configPath = path.join(directory, 'openclaw.json');
  const bytes = await readFile(bundle);
  const release = JSON.parse(await readFile(releaseFile, 'utf8'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), release.artifacts[artifact].sha256);
  assert.equal(bytes.length, release.artifacts[artifact].size);
  if (unified) assert.deepEqual(release.runtimes, ['openclaw', 'hermes', 'grok']);
  await copyFile(bundle, download);

  let gatewayToken = 'download-fixture-gateway-secret';
  const enrollmentToken = 'download-fixture-enrollment-secret';
  const accessToken = 'download-fixture-access-secret';
  const refreshToken = 'download-fixture-refresh-secret';
  let gatewayCalls = 0, enrollments = 0, readyReports = 0;
  let wrongGatewayAuth = false, leakedGatewayCredential = false;
  const order = [];
  const gateway = await listen(async (request, response) => {
    if (request.url !== '/v1/chat/completions') return json(response, { error: 'not found' }, 404);
    gatewayCalls++; order.push('gateway');
    wrongGatewayAuth ||= request.headers.authorization !== `Bearer ${gatewayToken}`;
    const input = JSON.parse(await body(request));
    if (input.model !== 'openclaw/main') return json(response, { error: 'wrong agent' }, 400);
    json(response, { choices: [{ finish_reason: 'stop', message: { content: 'Setup check completed' } }] });
  });
  t.after(() => close(gateway.server));
  const api = await listen(async (request, response) => {
    const source = await body(request);
    leakedGatewayCredential ||= source.includes(gatewayToken) || JSON.stringify(request.headers).includes(gatewayToken);
    if (request.url === '/health') return json(response, { service: 'sinaloa' });
    if (request.url === '/api/agent-enroll') {
      enrollments++; order.push('enroll');
      if (JSON.parse(source).enrollmentToken !== enrollmentToken) return json(response, { error: 'wrong token' }, 401);
      return json(response, { agent: { id: 'agent_download', address: 'download@agents.sinaloa.example' }, inbox: { id: 'inbox_download' },
        agentApiToken: accessToken, agentRefreshToken: refreshToken,
        agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() }, 201);
    }
    if (request.headers.authorization !== `Bearer ${accessToken}`) return json(response, { error: 'not authorized' }, 401);
    if (request.url.startsWith('/api/inboxes/inbox_download/events/delta')) return json(response, { events: [], nextCursor: null, hasMore: false });
    if (request.url === '/api/agent/connection-status') {
      const report = JSON.parse(source);
      if (report.phase === 'ready' && (report.gatewayTest === 'passed' || report.runtimeTest === 'passed')) readyReports++;
      return json(response, { checkedAt: new Date().toISOString() });
    }
    json(response, { error: 'unexpected route' }, 404);
  });
  t.after(() => close(api.server));
  const handoff = { version: 1, runtime: 'openclaw', apiUrl: api.url, enrollmentToken,
    expiresAt: new Date(Date.now() + 900_000).toISOString(), agentName: 'Download', address: 'download@agents.sinaloa.example' };
  await writeFile(configPath, JSON.stringify({ gateway: { port: gateway.server.address().port, auth: { token: gatewayToken },
    http: { endpoints: { chatCompletions: { enabled: true } } } }, agents: { list: [{ id: 'main' }] } }), { mode: 0o600 });

  const args = ['setup', '--handoff-stdin', '--config', configPath, '--state-dir', stateDir];
  const setup = await run(download, args, directory, JSON.stringify(handoff));
  assert.equal(setup.code, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).checks, 'passed');
  assert.deepEqual(order, ['gateway', 'enroll']);
  assert.equal(readyReports, 1);
  assert.equal(wrongGatewayAuth, false);
  assert.equal(leakedGatewayCredential, false);
  const installed = path.join(stateDir, 'connector.mjs');
  assert.equal(createHash('sha256').update(await readFile(installed)).digest('hex'), release.artifacts[artifact].sha256);
  const saved = await readFile(path.join(stateDir, 'connection.json'), 'utf8');
  const session = await readFile(path.join(stateDir, 'session.json'), 'utf8');
  assert.ok(saved.includes(gatewayToken)); assert.ok(session.includes(refreshToken));
  assert.ok(!(saved + session).includes(enrollmentToken));
  assert.ok(!(await readdir(stateDir)).includes('connector.lock'));
  for (const secret of [gatewayToken, enrollmentToken, accessToken, refreshToken]) assert.ok(!(setup.stdout + setup.stderr).includes(secret));

  const status = await run(installed, ['status', '--state-dir', stateDir], directory);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).address, handoff.address);
  for (const secret of [gatewayToken, enrollmentToken, accessToken, refreshToken]) assert.ok(!(status.stdout + status.stderr).includes(secret));
  // Real downloaded code must pick up config rotation instead of using its saved token.
  gatewayToken = 'download-fixture-rotated-gateway-secret';
  const rotatedConfig = JSON.parse(await readFile(configPath, 'utf8'));
  rotatedConfig.gateway.auth.token = gatewayToken;
  await writeFile(configPath, JSON.stringify(rotatedConfig), { mode: 0o600 });
  const resume = await run(installed, args, directory, JSON.stringify({ ...handoff, expiresAt: '2000-01-01T00:00:00Z' }));
  assert.equal(resume.code, 0, resume.stderr);
  assert.equal(enrollments, 1); assert.equal(gatewayCalls, 2); assert.equal(readyReports, 2);
  assert.equal(wrongGatewayAuth, false);
  assert.equal(leakedGatewayCredential, false);
  // Losing the config file must still permit a restart using the saved, updated settings.
  await rm(configPath);
  const missingConfig = await run(installed, args, directory, JSON.stringify({ ...handoff, expiresAt: '2000-01-01T00:00:00Z' }));
  assert.equal(missingConfig.code, 0, missingConfig.stderr);
  assert.equal(enrollments, 1); assert.equal(gatewayCalls, 3); assert.equal(readyReports, 3);
  if (process.platform === 'win32') {
    const targets = [stateDir, path.join(stateDir, 'session.json')].map(value => `'${value.replaceAll("'", "''")}'`).join(',');
    const script = `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; foreach($p in @(${targets})){ if([System.IO.Directory]::Exists($p)){$acl=[System.IO.Directory]::GetAccessControl($p)}else{$acl=[System.IO.File]::GetAccessControl($p)}; $rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); if($rules.Count -lt 1){throw 'No credential access rule'}; foreach($r in $rules){if($r.IdentityReference.Value -ne $sid){throw 'Credential storage grants another account access'}} }; Write-Output 'protected'`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    assert.match(stdout, /protected/);
  } else {
    assert.equal((await stat(stateDir)).mode & 0o077, 0);
    assert.equal((await stat(path.join(stateDir, 'session.json'))).mode & 0o077, 0);
  }
  const expired = await run(download, ['setup', '--handoff-stdin', '--config', configPath, '--state-dir', path.join(directory, 'new state')], directory,
    JSON.stringify({ ...handoff, expiresAt: '2000-01-01T00:00:00Z' }));
  assert.equal(expired.code, 1); assert.match(expired.stderr, /expired/); assert.equal(enrollments, 1);
});
}

test('distributed connector pairs a password-mode Gateway and stops before enrollment when Gateway auth is disabled', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sinaloa-download-'));
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const download = path.join(directory, 'download.mjs');
  await copyFile(new URL('../web/downloads/envoi-connector.mjs', import.meta.url), download);
  const password = 'download-fixture-gateway-password';
  const enrollmentToken = 'download-fixture-enrollment-secret';
  const accessToken = 'download-fixture-access-secret';
  let enrollments = 0, wrongGatewayAuth = false, leakedGatewayCredential = false;
  const gateway = await listen(async (request, response) => {
    if (request.url !== '/v1/chat/completions') return json(response, { error: 'not found' }, 404);
    // OpenClaw password mode accepts the password as a Bearer value.
    if (request.headers.authorization !== `Bearer ${password}`) { wrongGatewayAuth = true; return json(response, { error: 'unauthorized' }, 401); }
    await body(request);
    json(response, { choices: [{ finish_reason: 'stop', message: { content: 'Setup check completed' } }] });
  });
  t.after(() => close(gateway.server));
  const api = await listen(async (request, response) => {
    const source = await body(request);
    leakedGatewayCredential ||= source.includes(password) || JSON.stringify(request.headers).includes(password);
    if (request.url === '/health') return json(response, { service: 'sinaloa' });
    if (request.url === '/api/agent-enroll') {
      enrollments++;
      return json(response, { agent: { id: 'agent_download', address: 'download@agents.sinaloa.example' }, inbox: { id: 'inbox_download' },
        agentApiToken: accessToken, agentRefreshToken: 'download-fixture-refresh-secret',
        agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() }, 201);
    }
    if (request.headers.authorization !== `Bearer ${accessToken}`) return json(response, { error: 'not authorized' }, 401);
    if (request.url.startsWith('/api/inboxes/inbox_download/events/delta')) return json(response, { events: [], nextCursor: null, hasMore: false });
    if (request.url === '/api/agent/connection-status') return json(response, { checkedAt: new Date().toISOString() });
    json(response, { error: 'unexpected route' }, 404);
  });
  t.after(() => close(api.server));
  const handoff = { version: 1, runtime: 'openclaw', apiUrl: api.url, enrollmentToken,
    expiresAt: new Date(Date.now() + 900_000).toISOString(), agentName: 'Download', address: 'download@agents.sinaloa.example' };
  const setup = async (name, auth) => {
    const configPath = path.join(directory, `${name}.json`);
    await writeFile(configPath, JSON.stringify({ gateway: { port: gateway.server.address().port, auth,
      http: { endpoints: { chatCompletions: { enabled: true } } } }, agents: { list: [{ id: 'main' }] } }), { mode: 0o600 });
    return run(download, ['setup', '--handoff-stdin', '--config', configPath, '--state-dir', path.join(directory, `${name} state`)], directory, JSON.stringify(handoff));
  };

  const disabled = await setup('none', { mode: 'none' });
  assert.equal(disabled.code, 1);
  assert.match(disabled.stderr, /gateway\.auth\.mode is "none"/);
  assert.match(disabled.stderr, /did not redeem an enrollment token/);
  assert.equal(enrollments, 0);

  const paired = await setup('password', { mode: 'password', password });
  assert.equal(paired.code, 0, paired.stderr);
  assert.equal(JSON.parse(paired.stdout).checks, 'passed');
  assert.equal(enrollments, 1);
  assert.equal(wrongGatewayAuth, false);
  assert.equal(leakedGatewayCredential, false);
  for (const secret of [password, enrollmentToken, accessToken]) assert.ok(!(paired.stdout + paired.stderr).includes(secret));
});
