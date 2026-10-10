// PowerShell instructions and interpretation: GA4.md.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.ENVOI_GA4_TARGET_ROOT || '');
const sha = process.env.ENVOI_GA4_SHA;
assert.match(sha || '', /^[a-f0-9]{40}$/, 'Set ENVOI_GA4_SHA to the complete exact target SHA');
assert.ok(process.env.ENVOI_GA4_TARGET_ROOT && path.isAbsolute(process.env.ENVOI_GA4_TARGET_ROOT), 'An explicit absolute target worktree is required');
assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(), sha);
assert.equal((await exec('git', ['diff', sha, '--', '.', ':(exclude)integrations/gates'], { cwd: root })).stdout, '', 'Target production sources, fixtures and generated artifacts must be clean');
const compiled = JSON.parse(await readFile(path.join(here, '.runtime/ga4-source.json')));
assert.equal(compiled.target, root); assert.equal(compiled.sha, sha, 'Recompile the worker for this SHA');
assert.equal(compiled.bundleHash, createHash('sha256').update(await readFile(path.join(here, '.runtime/ga4-worker.mjs'))).digest('hex'));
const artifactSha256 = createHash('sha256').update(await readFile(path.join(root, 'web/downloads/envoi-connector.mjs'))).digest('hex');
assert.equal(artifactSha256, JSON.parse(await readFile(path.join(root, 'web/downloads/release.json'))).artifacts['envoi-connector.mjs'].sha256);
const { owner, api, send, eventually, sleep, ownerMessages, ownerEvents, readData, workClaimParts, waitForMessageStatus } =
  await import(pathToFileURL(path.join(root, 'test/a3-harness.js')).href);

const scratch = await mkdtemp(path.join(tmpdir(), 'envoi-ga4-private-'));
const stateDir = path.join(scratch, 'connector'); await mkdir(stateDir);
const env = { ...process.env, DATABASE_URL: '' };
for (const key of Object.keys(env)) if (/^(ENVOI|SINALOA)_/.test(key)) delete env[key];
Object.assign(env, { ENVOI_PORT: '0', ENVOI_AUTH_MODE: 'development', ENVOI_DATA_DIR: path.join(scratch, 'data'),
  ENVOI_RELEASE_SHA: sha, ENVOI_AGENT_WORK_RETRY_BASE_MS: '20000' });
const entries = [], children = new Set(), streams = new Set();
let service, worker, baseUrl, proxy, blocked = false, droppedStreams = 0, blockedReconnects = 0, forwardedAfterCut = 0;
const summary = { testedSha: sha, artifactSha256, storage: 'FileStore', serverCommand: 'npm start',
  node: process.version, recordedAt: new Date().toISOString(), result: 'FAIL',
  connector: 'production startConnection + EnvoiConnector + FileBridgeStore, separate child process',
  handler: 'controlled local durable handler; no provider or real host',
  timerOverrides: 'none on client; server retry base 20 s to ensure work remains delayed through process restart',
  networkFault: 'HTTP proxy closes active SSE sockets and rejects SSE reconnects; REST remains real and available',
  scenarios: [] };
const spawnChild = args => {
  const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.add(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', () => {}); // Drain without exporting credentials or payloads.
  return child;
};
async function kill(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  else child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('close', resolve)), sleep(2000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
async function startWorker() {
  const first = entries.length;
  worker = spawnChild([path.join(here, '.runtime/ga4-worker.mjs'), stateDir]);
  worker.on('message', entry => entries.push(entry));
  await wait(() => entries.slice(first).some(entry => entry.type === 'ready'), 'connector ready');
}
async function stopWorker() {
  if (!worker) return;
  const first = entries.length; worker.send({ command: 'stop' });
  await wait(() => entries.slice(first).some(entry => entry.type === 'ended'), 'graceful connector stop');
  await kill(worker); worker = undefined;
}
const wait = (check, message, timeoutMs = 60000) => eventually(async () => {
  const result = await check(); if (result) return result;
  if (worker && worker.exitCode !== null) throw new Error(`Connector exited before ${message}`);
  return false;
}, { timeoutMs, message });
const session = async () => JSON.parse(await readFile(path.join(stateDir, 'session.json'), 'utf8'));
const log = async () => (await readFile(path.join(stateDir, 'attempts.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const wakeIds = async actor => (await ownerEvents(baseUrl, actor)).filter(event => ['work.available', 'message.delivered', 'human.instruction_created', 'agent.resumed'].includes(event.type)).map(event => event.id);
try {
  // npm start launches the actual server; ephemeral port is announced by its stdout.
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  service = spawnChild([npmCli, 'start']);
  baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('FileStore server startup timeout')), 20000);
    service.once('exit', () => { clearTimeout(timer); reject(new Error('FileStore server exited')); });
    service.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
  });
  const health = await (await fetch(`${baseUrl}/health`)).json(); assert.equal(health.releaseSha, sha); assert.equal(health.service, 'envoi');
  const server = { baseUrl, dataDir: env.ENVOI_DATA_DIR };
  proxy = createServer((incoming, outgoing) => {
    const isSse = /^\/api\/inboxes\/[^/]+\/events(?:\?|$)/.test(incoming.url);
    if (isSse && blocked) { blockedReconnects += 1; incoming.socket.destroy(); return; }
    const upstream = httpRequest(new URL(incoming.url, baseUrl), { method: incoming.method, headers: { ...incoming.headers, host: new URL(baseUrl).host } }, response => {
      outgoing.writeHead(response.statusCode, response.headers);
      if (isSse) {
        const stream = { incoming, outgoing, upstream, response }; streams.add(stream);
        response.on('data', chunk => { if (blocked) forwardedAfterCut += chunk.length; });
        response.once('close', () => streams.delete(stream));
      }
      response.pipe(outgoing);
    });
    upstream.on('error', () => outgoing.destroy());
    outgoing.on('close', () => upstream.destroy()); incoming.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const actor = await owner(baseUrl, '9501'), peer = await owner(baseUrl, '9502');
  const bind = await api(baseUrl, `/api/inboxes/${actor.inbox.id}/agents/${actor.agent.id}/credentials/reconnect-token`, { session: actor.session, body: { runtime: 'hermes' } }); assert.equal(bind.status, 201);
  const bound = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: bind.payload.enrollmentToken, runtime: 'hermes' } }); assert.equal(bound.status, 200); Object.assign(actor, bound.payload);
  const credentials = { agentId: actor.agent.id, inboxId: actor.inbox.id, address: actor.agent.address,
    agentApiToken: actor.agentApiToken, agentRefreshToken: actor.agentRefreshToken,
    agentTokenExpiresAt: actor.agentTokenExpiresAt, agentRefreshTokenExpiresAt: actor.agentRefreshTokenExpiresAt, cursor: null };
  await writeFile(path.join(stateDir, 'session.json'), JSON.stringify(credentials), { mode: 0o600 });
  await writeFile(path.join(stateDir, 'connection.json'), JSON.stringify({ version: 1, runtime: 'hermes', apiUrl: proxyUrl, address: credentials.address,
    agentName: 'GA4 disposable controlled handler', configuration: { controlledGateHandler: true } }), { mode: 0o600 });
  await startWorker(); await wait(() => streams.size > 0, 'real SSE stream connected');
  worker.send({ command: 'fail-next' }); await wait(() => entries.some(entry => entry.type === 'fail-next-ready'), 'arm controlled retry');
  const sent = await send(baseUrl, peer, actor, { text: 'GA4 delayed retry without a new wake', caseId: 'case_ga4_retry' }); assert.equal(sent.status, 202);
  const retryId = sent.payload.id;
  const delayed = await wait(async () => { const record = await readData(server, ...workClaimParts(actor.inbox.id, retryId)); return record?.status === 'retryable' && record; }, 'durable retry-delayed work');
  assert.ok(Date.parse(delayed.retryAt) > Date.now()); assert.equal((await log()).filter(entry => entry.id === retryId && entry.outcome === 'processing').length, 0);
  blocked = true;
  for (const stream of [...streams]) { droppedStreams += 1; stream.outgoing.destroy(); stream.response.destroy(); stream.upstream.destroy(); stream.incoming.socket.destroy(); }
  assert.ok(droppedStreams > 0); await stopWorker(); const before = await session();
  const offline = await send(baseUrl, peer, actor, { text: 'GA4 arrived offline without a new wake', caseId: 'case_ga4_offline' }); assert.equal(offline.status, 202);
  const offlineId = offline.payload.id; await waitForMessageStatus(baseUrl, actor, offlineId, 'delivered');
  const wakesBefore = await wakeIds(actor);
  assert.ok(Date.parse(delayed.retryAt) > Date.now(), 'Retry must still be delayed when restarting');
  // stopWorker's ended handshake drains pre-cut IPC observations. Only the new
  // process can observe recovery events; proxy bytes are measured at the cut.
  const recoveryStart = entries.length;
  await startWorker();
  await wait(() => entries.slice(recoveryStart).some(entry => entry.type === 'http' && entry.route === '/api/agent/work/claim' && entry.state === 'idle' && entry.hint > 0), 'real idle claim contains relative retry hint');
  for (const [id, label] of [[offlineId, 'offline-arrival'], [retryId, 'retry-delayed']]) {
    await wait(async () => (await ownerMessages(baseUrl, actor)).some(message => message.id === id && message.status === 'processed'), `${label} processed`);
    const record = await readData(server, ...workClaimParts(actor.inbox.id, id)); assert.equal(record.status, 'completed');
    assert.equal(entries.filter(entry => entry.type === 'http' && entry.route === `/api/agent/work/${id}/complete` && entry.receiptState === 'processed').length, 1);
    assert.equal((await log()).filter(entry => entry.id === id && entry.outcome === 'processing').length, 1);
    summary.scenarios.push({ id: label, result: 'PASS', successfulProcessing: 1, successfulCompletionReceipts: 1 }); console.log(`PASS ${label}`);
  }
  const completedAt = Date.now();
  await wait(() => entries.filter(entry => entry.at > completedAt && entry.type === 'http' && entry.route === '/api/agent/work/claim' && entry.state === 'idle').length >= 2, 'two production safety claims after completion');
  await stopWorker(); await startWorker();
  const restartAt = Date.now();
  await wait(() => entries.some(entry => entry.at > restartAt + 12000 && entry.type === 'http' && entry.route === '/api/agent/work/claim' && entry.state === 'idle'), 'safety claim after second restart');
  const after = await session();
  for (const key of ['agentId', 'inboxId', 'address', 'agentApiToken', 'agentRefreshToken']) assert.equal(after[key], before[key], `${key} survives restarts`);
  assert.deepEqual(after.cursors, before.cursors, 'No delivered event advances stored inbox cursors');
  assert.deepEqual(await wakeIds(actor), wakesBefore, 'No new durable wake event was needed after offline work delivery');
  for (const id of [retryId, offlineId]) {
    assert.equal((await log()).filter(entry => entry.id === id && entry.outcome === 'processing').length, 1);
    assert.equal(entries.filter(entry => entry.type === 'http' && entry.route === `/api/agent/work/${id}/complete`).length, 1);
  }
  assert.equal((await log()).filter(entry => entry.id === retryId && entry.outcome === 'failed-before-effect').length, 1);
  assert.equal(entries.slice(recoveryStart).filter(entry => entry.type === 'event' || entry.type === 'sse-open').length, 0, 'Recovery must receive no stored events or open SSE stream');
  assert.equal(entries.filter(entry => entry.type === 'http' && entry.route.endsWith('/events/delta')).length, 0, 'No delta recovery or poll was requested');
  assert.equal(forwardedAfterCut, 0, 'No SSE bytes forwarded after network cut'); assert.ok(blockedReconnects > 0);
  summary.result = 'PASS'; summary.verification = { sseStreamsDropped: droppedStreams, blockedSseReconnects: blockedReconnects,
    sseBytesAfterCut: 0, storedEventsDeliveredDuringRecovery: 0, deltaRequests: 0, newWakeEventsAfterOfflineDelivery: 0,
    relativeRetryHintObserved: true, identityAndCredentialsPreserved: true, cursorPreserved: true,
    laterSafetyClaimsAndSecondRestartProduceDuplicates: false, controlledFailureBeforeEffect: 1 };
} catch (error) {
  // Detailed HTTP payloads and private state are never exported to public evidence.
  summary.failure = { message: error.message }; console.error(`FAIL GA4: ${error.message}`); process.exitCode = 1;
} finally {
  for (const stream of streams) { stream.outgoing.destroy(); stream.response.destroy(); stream.upstream.destroy(); }
  await Promise.all([...children].map(kill));
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  const output = path.join(here, 'evidence', `ga4-${sha.slice(0, 7)}`); await mkdir(output, { recursive: true });
  // Failed details stay local; only successful, identifier-free evidence is publishable.
  await writeFile(path.join(output, summary.result === 'PASS' ? 'summary.json' : 'result.json'), JSON.stringify(summary, null, 2) + '\n');
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(tmpdir())); assert.ok(path.basename(scratch).startsWith('envoi-ga4-private-'));
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(`${summary.result} GA4 FileStore @${sha}; evidence: ${output}`);
}
