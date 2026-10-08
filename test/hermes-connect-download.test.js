import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function listen(handler) {
  const server = createServer((request, response) => { void handler(request, response).catch(() => { response.writeHead(500); response.end(); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
function close(server) {
  return new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
}
async function body(request) { let value = ''; for await (const chunk of request) value += chunk; return value; }
function json(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
}
function runProgram(executable, args, cwd, env, input = '') {
  const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Fixture command timed out: ${stdout}\n${stderr}`)); }, args.includes('start') ? 300_000 : 90_000);
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  // The foreground connector's result is awaited after client lifecycle checks.
  // Keep its timeout observed while another child is still running.
  void result.catch(() => {});
  child.stdin.end(input);
  return { child, result };
}
function run(executable, args, cwd, env, input = '') { return runProgram(process.execPath, [executable, ...args], cwd, env, input); }

for (const [managed, pending] of process.platform === 'win32' && process.env.ENVOI_TEST_MANAGED_SERVICE === '1' ? [[false, false], [true, false], [true, true]] : [[false, false]]) {
test(`downloaded Hermes connector survives discovery, chat closure and restarts (${pending ? 'pending MCP reload' : managed ? 'managed startup' : 'existing supervisor'})`, { timeout: process.env.ENVOI_TEST_HERMES_PYTHON ? 180_000 : 150_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'envoi-hermes-download-'));
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
  const stateDir = path.join(directory, 'private state');
  const profile = path.join(directory, 'Hermes profile');
  assert.equal(path.dirname(path.resolve(profile)), path.resolve(directory));
  let api, gateway, started;
  const installed = path.join(stateDir, 'connector.mjs');
  async function controlRequest(action = 'status') {
    const control = JSON.parse(await readFile(path.join(stateDir, 'control.json'), 'utf8'));
    return fetch(`http://127.0.0.1:${control.port}/${action}`, { method: action === 'stop' ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${control.secret}` }, signal: AbortSignal.timeout(3000) });
  }
  async function waitStatus(predicate, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const status = await controlRequest().then(response => response.json()).catch(() => null);
      if (predicate(status)) return status;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('Saved background connector did not reach the expected state');
  }
  t.after(async () => {
    const owner = await controlRequest().then(response => response.json()).catch(() => null);
    if (managed) await run(download, ['uninstall', '--state-dir', stateDir], directory, env).result.catch(() => null);
    await controlRequest('stop').catch(() => null);
    if (started?.child.exitCode === null) await started.result.catch(() => { started.child.kill(); });
    await waitStatus(value => value === null, 5000).catch(() => null);
    // The private listener closes before Node releases its Windows working
    // directory. Wait for the authenticated fixture owner to finish exiting.
    if (owner?.address === 'hermes@agents.example' && owner.pid !== process.pid) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try { process.kill(owner.pid, 0); } catch { break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    if (api) await close(api.server);
    if (gateway) await close(gateway.server);
    await rm(directory, { force: true, recursive: true, maxRetries: 20, retryDelay: 100 });
  });
  await mkdir(profile, { recursive: true });
  const configPath = path.join(profile, 'config.yaml');
  await writeFile(configPath, 'model:\n  default: existing-provider-model\nmcp_servers:\n  unrelated:\n    command: existing-tool\n');
  const localKey = 'download-local-api-key', providerKey = 'download-existing-provider-key';
  await writeFile(path.join(profile, '.env'), `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${localKey}\nANTHROPIC_API_KEY=${providerKey}\n`, { mode: 0o600 });
  const download = path.join(directory, 'envoi-connector.mjs');
  await copyFile(new URL('../web/downloads/envoi-connector.mjs', import.meta.url), download);
  const release = JSON.parse(await readFile(new URL('../web/downloads/release.json', import.meta.url), 'utf8'));
  assert.equal(createHash('sha256').update(await readFile(download)).digest('hex'), release.artifacts['envoi-connector.mjs'].sha256);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(HERMES_|API_SERVER_|SINALOA_|TERMINAL_)/.test(key)) delete env[key];
  if (process.platform === 'win32') {
    const shadow = path.join(directory, 'Git-style PATH shadows'); await mkdir(shadow);
    for (const name of ['whoami.exe', 'powershell.exe', 'icacls.exe', 'schtasks.exe']) await writeFile(path.join(shadow, name), 'Invalid executable: native helper lookup must bypass PATH.');
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = `${shadow};${env[pathKey] ?? ''}`;
  }
  const token = 'download-hermes-enrollment-token', access = 'download-access-token', refresh = 'download-refresh-token';
  let enrollments = 0, readyReports = 0, verificationRuns = 0, successfulCalls = 0, capabilityOutages = 0, missingTools = pending;
  let relay;
  async function mcp(method) {
    relay ??= JSON.parse(await readFile(path.join(stateDir, 'hermes-relay.json'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:${relay.port}/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${relay.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'probe', method, ...(method === 'tools/call' ? { params: { name: 'sinaloa_agent_info', arguments: {} } } : {}) }) });
    assert.equal(response.status, 200);
    const payload = await response.json(); assert.equal(payload.error, undefined);
  }
  api = await listen(async (request, response) => {
    const source = await body(request);
    assert.ok(!(source + JSON.stringify(request.headers)).includes(providerKey));
    assert.ok(!(source + JSON.stringify(request.headers)).includes(localKey));
    if (request.url === '/health') return json(response, { service: 'sinaloa' });
    if (request.url === '/api/agent-enroll') {
      enrollments++; assert.equal(JSON.parse(source).enrollmentToken, token);
      return json(response, { agent: { id: 'hermes_download', address: 'hermes@agents.example' }, inbox: { id: 'inbox_download' },
        agentApiToken: access, agentRefreshToken: refresh, agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() }, 201);
    }
    assert.equal(request.headers.authorization, `Bearer ${access}`);
    if (request.url.startsWith('/api/inboxes/inbox_download/events/delta')) return json(response, { events: [], nextCursor: null, hasMore: false });
    if (request.url === '/api/agent/work/claim') return json(response, { work: null });
    if (request.url === '/api/agent/connection-status') {
      if (JSON.parse(source).phase === 'ready') { readyReports++; assert.ok(successfulCalls > 0); }
      return json(response, {});
    }
    if (request.url === '/mcp') {
      const input = JSON.parse(source);
      if (input.method === 'initialize') return json(response, { jsonrpc: '2.0', id: input.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'Envoi fixture', version: '1' } } });
      if (input.method === 'notifications/initialized') { response.writeHead(202); return response.end(); }
      if (input.method === 'tools/list') return json(response, { jsonrpc: '2.0', id: input.id, result: { tools: [{ name: 'sinaloa_agent_info', inputSchema: { type: 'object' } }] } });
      if (input.method === 'tools/call') { successfulCalls++; return json(response, { jsonrpc: '2.0', id: input.id, result: { content: [{ type: 'text', text: '{"agentId":"hermes_download"}' }] } }); }
    }
    json(response, { error: 'Unexpected request' }, 404);
  });
  gateway = await listen(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${localKey}`);
    if (request.url === '/v1/capabilities') {
      if (capabilityOutages > 0) {
        capabilityOutages--;
        await mcp('tools/list'); // Relay must stay live even while the Gateway API is starting.
        return json(response, { error: 'Starting Gateway' }, 503);
      }
      return json(response, { features: { run_submission: true, run_status: true, run_stop: true } });
    }
    if (request.url === '/v1/runs' && request.method === 'POST') {
      const input = JSON.parse(await body(request));
      assert.equal(input.provider, undefined); assert.equal(input.api_key, undefined);
      if (input.input.startsWith('Envoi setup verification.')) {
        verificationRuns++;
        if (verificationRuns === 1 || missingTools) {
          assert.equal(readyReports, 0);
          await mcp('tools/list'); // Discovery alone plus a model success claim cannot pass.
        } else await mcp('tools/call');
      }
      return json(response, { run_id: 'download_run' }, 202);
    }
    if (request.url === '/v1/runs/download_run') return json(response, { run_id: 'download_run', status: 'completed', output: 'I called the tool' });
    json(response, { error: 'Unexpected Gateway request' }, 404);
  });
  const handoff = { version: 1, runtime: 'hermes', apiUrl: api.url, enrollmentToken: token, expiresAt: new Date(Date.now() + 900_000).toISOString(), agentName: 'Hermes', address: 'hermes@agents.example' };
  const args = ['setup', '--handoff-stdin', ...managed ? [] : ['--no-service'], '--config', configPath, '--gateway-url', gateway.url, '--state-dir', stateDir];
  const setup = await run(download, args, directory, env, JSON.stringify(handoff)).result;
  assert.equal(setup.code, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).checks, pending ? 'pending' : 'passed');
  assert.match(setup.stderr, /relay is online/);
  if (managed && !pending) assert.equal(JSON.parse(setup.stdout).backgroundChecks, 'passed');
  if (!managed) assert.match(setup.stderr, /Keep this command running/);
  if (pending) {
    assert.equal(readyReports, 0, 'A running but unverified service must not report setup ready');
    assert.ok(verificationRuns >= 2);
    assert.match(setup.stderr, /No separate connector terminal or new token/);
    missingTools = false; // The owner approved the selected Gateway's tool reload.
    await mcp('tools/list');
    await waitStatus(value => value?.status === 'running', 45_000);
  } else assert.equal(verificationRuns, managed ? 3 : 2);
  assert.equal(enrollments, 1); assert.equal(readyReports, 1);
  const config = await readFile(configPath, 'utf8');
  assert.match(config, /existing-provider-model/); assert.match(config, /unrelated:\n    command: existing-tool/);
  assert.ok((await readFile(path.join(profile, '.env'), 'utf8')).includes(`ANTHROPIC_API_KEY=${providerKey}`));
  for (const secret of [token, access, refresh, localKey, providerKey, relay.token]) assert.ok(!(setup.stdout + setup.stderr).includes(secret));
  assert.equal(createHash('sha256').update(await readFile(installed)).digest('hex'), release.artifacts['envoi-connector.mjs'].sha256);
  const resumed = await run(installed, args, directory, env, JSON.stringify({ ...handoff, expiresAt: '2000-01-01T00:00:00Z' })).result;
  assert.equal(resumed.code, 0, resumed.stderr); assert.equal(enrollments, 1);

  capabilityOutages = managed ? 0 : 2;
  if (!managed) started = run(installed, ['start', '--state-dir', stateDir], directory, env);
  const deadline = Date.now() + 20_000;
  let control;
  while (Date.now() < deadline) {
    if (started && started.child.exitCode !== null) {
      const failure = await started.result;
      assert.fail(`Saved connector exited before becoming ready: ${failure.stderr}`);
    }
    try {
      control = JSON.parse(await readFile(path.join(stateDir, 'control.json'), 'utf8'));
      const response = await fetch(`http://127.0.0.1:${control.port}/status`, { headers: { authorization: `Bearer ${control.secret}` } });
      if ((await response.json()).status === 'running') break;
    } catch { /* Child is still bringing its private relay and control listener online. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(capabilityOutages, 0);
  const status = await fetch(`http://127.0.0.1:${control.port}/status`, { headers: { authorization: `Bearer ${control.secret}` } }).then(response => response.json());
  assert.equal(status.status, 'running'); assert.equal(status.runtimeChecks, 'passed');
  async function client() {
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Hermes fixture', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sinaloa_agent_info', arguments: {} } }
    ];
    const result = await run(installed, ['mcp', '--state-dir', stateDir], directory, env, requests.map(value => JSON.stringify(value)).join('\n') + '\n').result;
    assert.equal(result.code, 0, result.stderr);
    const responses = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(responses.map(value => value.id), [1, 2, 3]);
    for (const response of responses) assert.equal(response.error, undefined, result.stdout);
    assert.equal(responses[1].result.tools[0].name, 'sinaloa_agent_info');
    for (const secret of [token, access, refresh, localKey, providerKey, relay.token]) assert.ok(!(result.stdout + result.stderr).includes(secret));
  }
  async function nativeClient() {
    t.diagnostic('Checking installed Hermes MCP client against fixture profile');
    const result = await runProgram(process.env.ENVOI_TEST_HERMES_PYTHON, ['-m', 'hermes_cli.main', 'mcp', 'test', relay.serverName], directory,
      { ...env, HERMES_HOME: profile, HERMES_DISABLE_LAZY_INSTALLS: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }).result;
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Tools discovered: 1/);
    assert.match(result.stdout, /sinaloa_agent_info/);
    t.diagnostic('Installed Hermes discovered the fixture Envoi identity tool');
  }
  if (process.env.ENVOI_TEST_HERMES_PYTHON) await nativeClient();
  await client();
  assert.equal((await controlRequest().then(response => response.json())).pid, status.pid, 'Closing a Hermes chat must leave the receiving connector alive');
  const stopped = await controlRequest('stop');
  assert.equal(stopped.status, 202);
  if (started) {
    const completed = await started.result;
    assert.equal(completed.code, 0, completed.stderr);
    for (const secret of [token, access, refresh, localKey, providerKey, relay.token]) assert.ok(!(completed.stdout + completed.stderr).includes(secret));
  }
  await waitStatus(value => value === null);
  if (process.env.ENVOI_TEST_HERMES_PYTHON) await nativeClient();
  await Promise.all([client(), client()]);
  const recovered = await waitStatus(value => value?.status === 'running');
  assert.notEqual(recovered.pid, status.pid);
  assert.equal(enrollments, 1, 'Two clients must reuse the existing enrollment');
  // Only this test's authenticated fixture owner is terminated; saved locks and
  // credentials must recover after an abrupt process exit as well.
  assert.ok(recovered.pid !== process.pid && recovered.address === handoff.address);
  process.kill(recovered.pid);
  await waitStatus(value => value === null);
  await client();
  const restarted = await waitStatus(value => value?.status === 'running');
  assert.notEqual(restarted.pid, recovered.pid);
  assert.equal(enrollments, 1);
});
}
