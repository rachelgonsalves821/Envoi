// PowerShell: npx vite build --config vite.ga3-worker.config.ts; node integrations/gates/ga3-a2-local.mjs
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { owner, api, send, pauseAgent, resumeAgent, revokeAgent, eventually, sleep, ownerMessages,
  installOutboxGate, readData, outboxParts, waitForMessageStatus, ownerEvents } from '../../test/a3-harness.js';
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = '14ce3c45c0089dfb4314dcc632afebb3588b5104';
await exec('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: root });
assert.equal((await exec('git', ['diff', sha, '--', '.', ':(exclude)integrations/gates', ':(exclude)sdk/typescript/reviews',
  ':(exclude)vitest.a4-review.config.ts', ':(exclude)vitest.names-review.config.ts', ':(exclude)vite.ga3-worker.config.ts'], { cwd: root })).stdout, '', 'Production sources, fixtures and generated artifacts must match the requested integration SHA');
const artifact = await readFile(path.join(root, 'web/downloads/envoi-connector.mjs'));
const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
assert.equal(artifactSha256, JSON.parse(await readFile(path.join(root, 'web/downloads/release.json'))).artifacts['envoi-connector.mjs'].sha256);
const scratch = await mkdtemp(path.join(tmpdir(), 'envoi-ga3-private-'));
const output = path.join(root, 'integrations/gates/evidence/ga3-14ce3c4');
const stateDir = path.join(scratch, 'connector'); await mkdir(stateDir);
const privateTokens = [];
const redactFields = value => {
  if (Array.isArray(value)) return value.map(redactFields);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(leaseToken|agentApiToken|agentRefreshToken|mcpAccessToken|enrollmentToken|authorization|cookie|set-cookie)$/i.test(key) ? '<redacted>' : redactFields(item)]));
  if (typeof value === 'string' && /^[\[{]/.test(value)) {
    try { return JSON.stringify(redactFields(JSON.parse(value))); } catch { /* not embedded JSON */ }
  }
  return value;
};
const sanitize = value => {
  let text = String(value).replaceAll(scratch, '<private-gate-dir>').replaceAll(JSON.stringify(scratch).slice(1, -1), '<private-gate-dir>');
  try { text = JSON.stringify(redactFields(JSON.parse(text)), null, 2); } catch { /* plain log */ }
  for (const token of privateTokens) text = text.replaceAll(token, '<redacted>');
  return text.replace(/(?:sinaloa|envoi)_(?:agent_(?:access|refresh)|mcp_read|enroll)_[A-Za-z0-9_-]+/g, '<redacted>');
};
const env = { ...process.env, DATABASE_URL: '' };
for (const key of Object.keys(env)) if (/^(ENVOI|SINALOA)_/.test(key)) delete env[key];
const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
for (const [key, value] of Object.entries({ PORT: String(port), AUTH_MODE: 'development', DATA_DIR: path.join(scratch, 'data'), RELEASE_SHA: sha })) env[`ENVOI_${key}`] = value;
const baseUrl = `http://127.0.0.1:${port}`;
const server = { baseUrl, dataDir: env.ENVOI_DATA_DIR };
const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
let service, worker, serverLog = '', workerLog = '', actor, peer, initialIdentity;
let entries = [];
const allEntries = [], scenarios = [];
async function kill(child) {
  if (!child || child.exitCode !== null) return;
  await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  await Promise.race([new Promise(resolve => child.once('close', resolve)), sleep(2000)]);
}
async function startService() {
  service = spawn(process.execPath, [npmCli, 'start'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', chunk => { serverLog += chunk; });
  await eventually(async () => {
    assert.equal(service.exitCode, null, serverLog);
    try { const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) }); const health = await response.json(); return response.status === 200 && health.releaseSha === sha && health.service === 'envoi'; } catch { return false; }
  }, { timeoutMs: 20000, message: 'npm start health at exact SHA' });
}
function startWorker() {
  entries = [];
  worker = spawn(process.execPath, [path.join(root, 'integrations/gates/.runtime/worker.mjs'), stateDir], {
    cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', chunk => { workerLog += chunk; });
  worker.on('message', entry => { entries.push(entry); allEntries.push(entry); });
}
const waitEntry = (predicate, message) => eventually(() => {
  const found = entries.find(predicate); if (found) return found;
  const ended = entries.find(entry => entry.type === 'ended');
  if (ended) throw new Error(`Connector ended before ${message}: ${JSON.stringify(ended)}`);
  return false;
}, { timeoutMs: 20000, message });
const session = async () => JSON.parse(await readFile(path.join(stateDir, 'session.json'), 'utf8'));
const lifecycle = async state => eventually(async () => (await session()).lifecycle?.state === state, { timeoutMs: 20000, message: state });
async function command(name) {
  const start = entries.length; worker.send({ command: name });
  return eventually(() => entries.slice(start).find(entry => entry.type === 'command' && entry.command === name), { timeoutMs: 10000, message: name });
}
async function stopWorker() {
  if (!worker) return;
  const start = entries.length; worker.send({ command: 'stop' });
  await eventually(() => entries.slice(start).some(entry => entry.type === 'ended'), { timeoutMs: 10000, message: 'connector stop' }).catch(() => {});
  await kill(worker); worker = undefined;
}
async function scenario(id, fn) {
  const first = allEntries.length;
  try { const evidence = await fn(); scenarios.push({ id, result: 'PASS', evidence }); console.log(`PASS ${id}`); }
  catch (error) { scenarios.push({ id, result: 'FAIL', expected: error.expected, observed: error.actual, error: error.message, stack: error.stack }); console.log(`FAIL ${id}: ${error.message}`); }
  scenarios.at(-1).connectorExchanges = allEntries.slice(first);
}
const sendPeer = async (text, caseId) => {
  const result = await send(baseUrl, peer, actor, { text, caseId }); assert.equal(result.status, 202, result.text);
  return result.payload.id;
};
const processed = id => eventually(async () => (await ownerMessages(baseUrl, actor)).find(message => message.id === id && message.status === 'processed'), { timeoutMs: 12000, message: `processed ${id}` });
try {
  console.log('Starting npm FileStore server and disposable local actors');
  await startService(); actor = await owner(baseUrl, '9401'); peer = await owner(baseUrl, '9402');
  // The shared test owner defaults to OpenClaw. Explicitly bind the disposable
  // installation to Hermes before testing core setup reports; retain its identity.
  const bind = await api(baseUrl, `/api/inboxes/${actor.inbox.id}/agents/${actor.agent.id}/credentials/reconnect-token`, { session: actor.session, body: { runtime: 'hermes' } });
  assert.equal(bind.status, 201, bind.text);
  const bound = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: bind.payload.enrollmentToken, runtime: 'hermes' } });
  assert.equal(bound.status, 200, bound.text); Object.assign(actor, bound.payload);
  const credentials = { agentId: actor.agent.id, inboxId: actor.inbox.id, address: actor.agent.address,
    agentApiToken: actor.agentApiToken, agentRefreshToken: actor.agentRefreshToken,
    agentTokenExpiresAt: actor.agentTokenExpiresAt, agentRefreshTokenExpiresAt: actor.agentRefreshTokenExpiresAt, cursor: null };
  privateTokens.push(actor.agentApiToken, actor.agentRefreshToken, peer.agentApiToken, peer.agentRefreshToken);
  initialIdentity = { agentId: credentials.agentId, inboxId: credentials.inboxId, address: credentials.address };
  await writeFile(path.join(stateDir, 'session.json'), JSON.stringify(credentials), { mode: 0o600 });
  await writeFile(path.join(stateDir, 'connection.json'), JSON.stringify({ version: 1, runtime: 'hermes', apiUrl: baseUrl, address: credentials.address,
    agentName: 'GA3 disposable controlled handler', configuration: { controlledGateHandler: true } }), { mode: 0o600 });
  startWorker(); await waitEntry(entry => entry.type === 'ready', 'connector accepts Envoi and starts'); await lifecycle('RUNNING');
  await scenario('restart', async () => {
    const first = await sendPeer('before connector process restart'); await processed(first);
    await stopWorker(); const saved = await session(); assert.equal(saved.lifecycle.state, 'STOPPED');
    const offline = await sendPeer('arrived while connector process stopped'); await waitForMessageStatus(baseUrl, actor, offline, 'delivered');
    startWorker(); await waitEntry(entry => entry.type === 'ready', 'restarted connector'); await processed(offline);
    const next = await session(); assert.equal(next.agentRefreshToken, saved.agentRefreshToken);
    assert.deepEqual({ agentId: next.agentId, inboxId: next.inboxId, address: next.address }, initialIdentity);
    const log = (await readFile(path.join(stateDir, 'processed.log'), 'utf8')).trim().split('\n');
    assert.equal(log.filter(id => id === first).length, 1); assert.equal(log.filter(id => id === offline).length, 1);
    return { first, offline, state: next.lifecycle, identityPreserved: true, duplicateProcessing: false };
  });
  await scenario('outage', async () => {
    const before = await session(); await kill(service); service = undefined; await lifecycle('DEGRADED');
    const degraded = await session(); assert.equal(degraded.lifecycle.code, 'NETWORK_ERROR');
    assert.ok(Date.parse(degraded.lifecycle.retryAt) > Date.parse(degraded.lifecycle.changedAt));
    await kill(worker); worker = undefined; startWorker(); await waitEntry(entry => entry.type === 'waiting', 'startup outage remains manageable');
    assert.equal((await session()).agentRefreshToken, before.agentRefreshToken);
    await startService(); await waitEntry(entry => entry.type === 'ready', 'automatic outage recovery'); await lifecycle('RUNNING');
    const id = await sendPeer('after real npm server outage'); await processed(id);
    return { durableDegraded: degraded.lifecycle, credentialPreserved: true, automaticRecovery: true, processed: id };
  });
  await scenario('pause', async () => {
    await pauseAgent(baseUrl, actor); await lifecycle('PAUSED');
    const count = entries.filter(entry => entry.type === 'http' && entry.request.path === '/api/agent/work/claim').length;
    const id = await sendPeer('inbound delivered while receiver paused'); await waitForMessageStatus(baseUrl, actor, id, 'delivered');
    await sleep(1200);
    assert.equal(entries.filter(entry => entry.type === 'http' && entry.request.path === '/api/agent/work/claim').length, count);
    assert.equal((await ownerMessages(baseUrl, actor)).find(message => message.id === id).status, 'delivered');
    return { state: (await session()).lifecycle, inbound: id, claimsWhileKnownPaused: 0 };
  });
  await scenario('refresh across pause', async () => {
    await stopWorker(); const before = await session(); assert.equal(before.lifecycle.paused, true);
    await writeFile(path.join(stateDir, 'session.json'), JSON.stringify({ ...before, agentTokenExpiresAt: '2000-01-01T00:00:00.000Z' }));
    startWorker(); await waitEntry(entry => entry.type === 'ready', 'paused restart and refresh'); await lifecycle('PAUSED');
    const after = await session(); assert.notEqual(after.agentRefreshToken, before.agentRefreshToken); assert.equal(after.lifecycle.paused, true);
    assert.equal(after.pendingRotation, undefined); assert.equal(after.agentId, before.agentId);
    assert.ok(entries.some(entry => entry.type === 'http' && entry.request.path === '/api/agent-token' && entry.response.status === 200));
    assert.equal(entries.filter(entry => entry.type === 'http' && entry.request.path === '/api/agent/work/claim').length, 0);
    return { state: after.lifecycle, rotatedAtomically: true, identityPreserved: true, pausedClaims: 0 };
  });
  let held, reply, caseId;
  await scenario('held work', async () => {
    await resumeAgent(baseUrl, actor); await lifecycle('RUNNING');
    caseId = 'case_ga3_d1'; const gate = await installOutboxGate(server, caseId);
    const current = await session(); actor.agentApiToken = current.agentApiToken;
    const sent = await send(baseUrl, actor, peer, { caseId, text: 'outbound held after sender pause' }); assert.equal(sent.status, 202, sent.text); held = sent.payload.id;
    const before = await readData(server, ...outboxParts(held)); assert.equal(before.status, 'queued');
    await pauseAgent(baseUrl, actor); await lifecycle('PAUSED'); await gate.remove();
    await eventually(async () => (await readData(server, ...outboxParts(held)))?.status === 'held', { message: 'held outbound' });
    reply = await sendPeer('counterparty reply waits behind held outbound', caseId); await sleep(1200);
    const record = await readData(server, ...outboxParts(held));
    assert.equal(record.attempts, before.attempts); assert.equal(record.availableAt, before.availableAt);
    assert.equal((await ownerMessages(baseUrl, peer)).some(message => message.id === held), false);
    assert.equal((await readData(server, ...outboxParts(reply))).status, 'queued');
    return { held, reply, heldOutbox: record, attemptsUnchanged: true, backoffUnchanged: true, d1ReplyQueued: true };
  });
  await scenario('resume', async () => {
    await resumeAgent(baseUrl, actor); await lifecycle('RUNNING');
    await waitForMessageStatus(baseUrl, peer, held, 'delivered'); await processed(reply);
    const events = (await ownerEvents(baseUrl, peer)).filter(event => event.type === 'message.delivered');
    const one = events.find(event => event.messageId === held), two = events.find(event => event.messageId === reply);
    assert.ok(one && two); assert.ok(Number(one.sequence) < Number(two.sequence));
    const inbound = await sendPeer('after explicit resume'); await processed(inbound);
    return { heldDelivered: held, replyProcessed: reply, deliveredOrder: [one.sequence, two.sequence], state: (await session()).lifecycle };
  });
  await scenario('revoke', async () => {
    worker.send({ command: 'hold' }); await waitEntry(entry => entry.type === 'held-handler-enabled', 'hold next handler');
    const id = await sendPeer('revoke while handler in flight'); await waitEntry(entry => entry.type === 'processing' && entry.id === id, 'in-flight handler');
    const revoked = await revokeAgent(baseUrl, actor);
    const response = await command('mcp'); assert.equal(response.ok, false); assert.equal(response.code, 'CREDENTIAL_REVOKED'); await lifecycle('REVOKED');
    await waitEntry(entry => entry.type === 'late-handler' && entry.id === id && entry.aborted, 'late handler fenced');
    await sleep(300); const first = entries.length;
    for (const operation of ['refresh', 'claim', 'mcp']) { const result = await command(operation); assert.equal(result.code, 'CREDENTIAL_REVOKED'); }
    assert.equal(entries.slice(first).filter(entry => ['http', 'network'].includes(entry.type)).length, 0);
    assert.equal(entries.some(entry => entry.type === 'http' && entry.request.path === `/api/agent/work/${id}/complete`), false);
    const saved = await session(); await kill(worker); worker = undefined; startWorker();
    await waitEntry(entry => entry.type === 'ended' && entry.code === 'CREDENTIAL_REVOKED', 'revoked restart fenced');
    assert.equal(entries.filter(entry => ['http', 'network'].includes(entry.type)).length, 0);
    assert.equal((await session()).agentRefreshToken, saved.agentRefreshToken);
    return { id, ownerRevoke: revoked, terminal: saved.lifecycle, postRevokeNetworkRequests: 0, lateCompletionRequests: 0, restartFenced: true };
  });
} catch (error) { scenarios.push({ id: 'prerequisite', result: 'FAIL', error: error.message, stack: error.stack }); }
finally {
  await kill(worker); await kill(service); await mkdir(output, { recursive: true });
  const result = { testedIntegrationSha: sha, artifactSha256, node: process.version, recordedAt: new Date().toISOString(), serverCommand: 'npm start', storage: 'FileStore', authMode: 'development',
    connector: 'production startConnection + SinaloaConnector, separate child process', handler: 'controlled local durable handler; no real runtime host',
    overrides: '100ms event/work polling for bounded local test; default production retry policy retained; only local saved access-expiry changed to trigger real refresh',
    responseSemantics: 'real fetch, observation via response.clone(); no mocks or response mutation', result: scenarios.length === 7 && scenarios.every(item => item.result === 'PASS') ? 'PASS' : 'FAIL', scenarios, allConnectorExchanges: allEntries };
  await writeFile(path.join(output, 'result.json'), sanitize(JSON.stringify(result, null, 2)) + '\n');
  await writeFile(path.join(output, 'connector.log'), sanitize(workerLog)); await writeFile(path.join(output, 'server.log'), sanitize(serverLog));
  const summary = Object.fromEntries(['testedIntegrationSha', 'artifactSha256', 'node', 'recordedAt', 'serverCommand', 'storage', 'authMode',
    'connector', 'handler', 'overrides', 'responseSemantics', 'result'].map(key => [key, result[key]]));
  summary.scenarios = scenarios.map(({ id, result }) => ({ id, result }));
  if (result.result === 'PASS') summary.verification = {
    processRestartPreservesIdentityAndCredentials: true, offlineWorkProcessedOnce: true,
    outagePersistsDegradedStateAndRetryDeadline: true, outageRecoversAutomatically: true,
    knownPausedClaims: 0, pausedRefreshRotatesAndPersistsSuccessor: true, refreshPreservesPauseAndIdentity: true,
    heldDeliveryAttemptsAndBackoffUnchanged: true, d1ReplyStaysQueued: true, resumeDeliversHeldBeforeReply: true,
    inFlightRevokeAbortsHandler: true, lateCompletionRequests: 0, postRevokeRefreshClaimMcpRequests: 0, revokedRestartNetworkRequests: 0
  };
  summary.detailedEvidence = 'Generated result.json and logs remain local; public summary contains no HTTP payloads, credentials, agent/account identifiers or configuration.';
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(tmpdir())); assert.ok(path.basename(scratch).startsWith('envoi-ga3-private-'));
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(`${result.result} GA3/A2 ${sha}; evidence: ${output}`); if (result.result !== 'PASS') process.exitCode = 1;
}
