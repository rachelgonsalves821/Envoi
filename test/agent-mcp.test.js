import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { BrowserSession } from './browser-session.js';
import { FileStore } from '../src/storage.js';

async function startServer(t, environment = {}, dataDirOverride = null) {
  const dataDir = dataDirOverride || await mkdtemp(path.join(tmpdir(), 'sinaloa-mcp-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0', SINALOA_AUTH_MODE: 'development', SINALOA_DATA_DIR: dataDir, ...environment },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server start timed out')), 10_000);
    child.once('exit', code => reject(new Error(`Server exited with ${code}`)));
    child.stdout.on('data', chunk => {
      const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  t.after(async () => {
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
    await rm(dataDir, { recursive: true, force: true });
  });
  return baseUrl;
}

async function startScanner(t) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const value = Buffer.concat(chunks).toString('utf8');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: value.includes('infected') ? 'infected' : 'clean', engine: 'mcp-test-scanner' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/scan`;
}

async function api(baseUrl, pathname, { token, session, body, method = body ? 'POST' : 'GET', headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(session ? session.headers(baseUrl, method) : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  session?.capture(response);
  return { status: response.status, payload: await response.json() };
}

async function owner(baseUrl, suffix, permissions = ['send_agent_messages', 'receive_agent_messages']) {
  const session = new BrowserSession();
  const started = await api(baseUrl, '/api/auth/phone/start', { session, body: { phoneNumber: `+14165550${suffix}`, displayName: `Owner ${suffix}` } });
  assert.equal(started.status, 201);
  const verified = await api(baseUrl, '/api/auth/phone/verify', { session, body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  assert.equal(verified.status, 200);
  const setup = await api(baseUrl, '/api/auth/totp/setup', { session, body: {} });
  assert.equal(setup.status, 201, JSON.stringify(setup.payload));
  const mfa = await api(baseUrl, '/api/auth/totp/verify', { session, body: { code: generateSync({ secret: setup.payload.secret }) } });
  assert.equal(mfa.status, 200);
  const workspace = await api(baseUrl, '/api/inboxes', { session, body: { name: `Workspace ${suffix}` } });
  assert.equal(workspace.status, 201);
  const enrollment = await api(baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { session, body: { permissions } });
  assert.equal(enrollment.status, 201);
  const agent = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: enrollment.payload.enrollmentToken, name: `Agent ${suffix}`, slug: `agent-${suffix}` } });
  assert.equal(agent.status, 201);
  return { session, ...agent.payload };
}

async function mcp(baseUrl, token, method, params, { id = 1, headers = {}, httpMethod = 'POST' } = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: httpMethod,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
      ...headers
    },
    body: httpMethod === 'POST' ? JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, ...(params === undefined ? {} : { params }) }) : undefined
  });
  return { status: response.status, payload: response.status === 202 || response.status === 405 ? null : await response.json() };
}

const tool = (baseUrl, token, name, args = {}, id = 1) => mcp(baseUrl, token, 'tools/call', { name, arguments: args }, { id });
const content = result => JSON.parse(result.payload.result.content[0].text);
async function eventually(check) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Expected delivered work did not become visible');
}

test('remote MCP transport authenticates every call, validates the handshake, and rejects browser-origin and schema abuse', async t => {
  const baseUrl = await startServer(t);
  const alice = await owner(baseUrl, '1101');
  const bob = await owner(baseUrl, '1102');
  const init = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1.0' } };
  assert.equal((await mcp(baseUrl, 'invalid', 'initialize', init)).status, 401);
  const accepted = await mcp(baseUrl, alice.agentApiToken, 'initialize', init);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.payload.result.protocolVersion, '2025-11-25');
  assert.deepEqual(accepted.payload.result.capabilities, { tools: { listChanged: false } });
  assert.equal((await mcp(baseUrl, alice.agentApiToken, 'notifications/initialized', undefined, { id: null })).status, 202);
  assert.equal((await mcp(baseUrl, alice.agentApiToken, 'ping')).payload.result.constructor, Object);
  assert.equal((await mcp(baseUrl, alice.agentApiToken, 'ping', undefined, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await mcp(baseUrl, alice.agentApiToken, 'ping', undefined, { headers: { origin: 'https://evil.example', host: 'evil.example' } })).status, 403);
  assert.equal((await mcp(baseUrl, alice.agentApiToken, 'ping', undefined, { headers: { accept: 'application/json' } })).status, 406);
  assert.equal((await mcp(baseUrl, alice.agentApiToken, 'ping', undefined, { headers: { 'mcp-protocol-version': 'unsupported' } })).status, 400);
  assert.equal((await mcp(baseUrl, alice.agentApiToken, 'ping', undefined, { httpMethod: 'GET' })).status, 405);
  const listed = await mcp(baseUrl, alice.agentApiToken, 'tools/list');
  assert.ok(listed.payload.result.tools.some(item => item.name === 'sinaloa_start_case'));
  assert.ok(listed.payload.result.tools.some(item => item.name === 'sinaloa_claim_work'));
  assert.ok(listed.payload.result.tools.every(item => item.inputSchema.additionalProperties === false));
  const forged = await tool(baseUrl, alice.agentApiToken, 'sinaloa_list_messages', { inboxId: bob.inbox.id });
  assert.equal(forged.payload.error.code, -32602);
  const spoofed = await tool(baseUrl, alice.agentApiToken, 'sinaloa_start_case', { senderAgentId: bob.agent.id, recipientAddress: bob.agent.address, text: 'hello', idempotencyKey: 'forged-sender' });
  assert.equal(spoofed.payload.error.code, -32602);
  const invalidAddress = await tool(baseUrl, alice.agentApiToken, 'sinaloa_start_case', { recipientAddress: '../api/inboxes', text: 'hello', idempotencyKey: 'invalid-address' });
  assert.equal(invalidAddress.payload.error.code, -32602);
  const restricted = await owner(baseUrl, '1103', ['receive_agent_messages']);
  const restrictedTools = (await mcp(baseUrl, restricted.agentApiToken, 'tools/list')).payload.result.tools.map(item => item.name);
  assert.ok(!restrictedTools.includes('sinaloa_send_message'));
  assert.ok(!restrictedTools.includes('sinaloa_send_completion'));
  assert.ok(!restrictedTools.includes('sinaloa_grant_asset'));
  assert.equal((await tool(baseUrl, restricted.agentApiToken, 'sinaloa_send_message', { recipientAddress: bob.agent.address, text: 'no', caseId: 'case_x', idempotencyKey: 'no' })).payload.error.code, -32602);
});

test('MCP tools start two distinct cases, preserve send idempotency, and settle claimed work under the REST fence', async t => {
  const baseUrl = await startServer(t);
  const alice = await owner(baseUrl, '1201');
  const bob = await owner(baseUrl, '1202');
  const outsider = await owner(baseUrl, '1203');
  const send = (key, message) => tool(baseUrl, alice.agentApiToken, 'sinaloa_start_case', { recipientAddress: bob.agent.address, text: message, idempotencyKey: key });
  const first = content(await send('first-case', 'First case opening'));
  assert.equal(first.status, 202);
  const replay = content(await send('first-case', 'First case opening'));
  assert.equal(replay.payload.id, first.payload.id);
  assert.equal(replay.payload.caseId, first.payload.caseId);
  const second = content(await send('second-case', 'Second case opening'));
  assert.notEqual(first.payload.caseId, second.payload.caseId);
  const followUp = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_send_message', { recipientAddress: bob.agent.address, caseId: first.payload.caseId, text: 'Follow-up in first case', idempotencyKey: 'first-follow-up', intent: 'clarify' }));
  assert.equal(followUp.status, 202);
  assert.equal(followUp.payload.caseId, first.payload.caseId);
  const proposalArgs = { recipientAddress: bob.agent.address, caseId: first.payload.caseId, text: 'Propose a shared answer', proposal: { answer: '42', source: 'agent-a' }, idempotencyKey: 'shared-proposal' };
  const proposal = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_send_proposal', proposalArgs));
  assert.equal(proposal.status, 202);
  assert.equal(proposal.payload.intent, 'offer');
  assert.deepEqual(proposal.payload.payload.proposal, proposalArgs.proposal);
  const proposalReplay = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_send_proposal', proposalArgs));
  assert.equal(proposalReplay.payload.id, proposal.payload.id);
  const proposalConflict = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_send_proposal', { ...proposalArgs, proposal: { answer: 'different' } }));
  assert.equal(proposalConflict.status, 409);
  const decision = content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_send_decision', { recipientAddress: alice.agent.address, caseId: first.payload.caseId, text: 'Accepted for this discussion', decision: 'accept', proposalMessageId: proposal.payload.id, details: { reason: 'supported' }, idempotencyKey: 'shared-decision' }));
  assert.equal(decision.status, 202);
  assert.equal(decision.payload.intent, 'accept');
  assert.equal(decision.payload.payload.decision.proposalMessageId, proposal.payload.id);
  const conflict = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_start_case', { recipientAddress: bob.agent.address, text: 'Different payload', idempotencyKey: 'first-case' }));
  assert.equal(conflict.status, 409);
  const cases = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_list_cases', {}));
  assert.equal(cases.status, 200);
  assert.ok(cases.payload.some(item => item.id === first.payload.caseId));
  const readCase = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_read_case', { caseId: first.payload.caseId }));
  assert.equal(readCase.payload.id, first.payload.caseId);
  const alienCase = content(await tool(baseUrl, outsider.agentApiToken, 'sinaloa_read_case', { caseId: first.payload.caseId }));
  assert.equal(alienCase.status, 404);
  const alienList = content(await tool(baseUrl, outsider.agentApiToken, 'sinaloa_list_messages', { caseId: first.payload.caseId }));
  assert.deepEqual(alienList.payload, []);
  const aliceMessages = await eventually(async () => {
    const result = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_list_messages', { caseId: first.payload.caseId }));
    return result.payload.filter(item => item.caseId === first.payload.caseId).length === 4 ? result : null;
  });
  assert.equal(aliceMessages.payload.filter(item => item.caseId === first.payload.caseId).length, 4);
  const bobMessages = await eventually(async () => {
    const result = content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_list_messages', { caseId: first.payload.caseId }));
    return result.payload.some(item => item.id === first.payload.id) ? result : null;
  });
  assert.ok(bobMessages.payload.some(item => item.id === first.payload.id));
  const claimed = content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_claim_work'));
  assert.equal(claimed.status, 200);
  assert.ok([first.payload.id, second.payload.id, followUp.payload.id, proposal.payload.id].includes(claimed.payload.work.workId));
  const work = claimed.payload.work;
  assert.equal(content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_renew_work', { workId: work.workId, leaseToken: work.leaseToken })).status, 200);
  const alienComplete = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_complete_work', { workId: work.workId, leaseToken: work.leaseToken, idempotencyKey: 'alien-complete' }));
  assert.equal(alienComplete.status, 404);
  const ack = content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_acknowledge_work', { workId: work.workId, leaseToken: work.leaseToken, idempotencyKey: 'bob-ack' }));
  assert.equal(ack.status, 201);
  const done = content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_complete_work', { workId: work.workId, leaseToken: work.leaseToken, idempotencyKey: 'bob-done' }));
  assert.equal(done.status, 201);
  assert.equal(done.payload.status, 'processed');
  const repeated = content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_complete_work', { workId: work.workId, leaseToken: work.leaseToken, idempotencyKey: 'bob-done' }));
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.payload, done.payload);
  const nextWork = content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_claim_work'));
  assert.equal(nextWork.status, 200);
  assert.ok(nextWork.payload.work);
  const failed = content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_fail_work', { workId: nextWork.payload.work.workId, leaseToken: nextWork.payload.work.leaseToken, retryable: true, reasonCode: 'connector-restart' }));
  assert.equal(failed.status, 200);
  assert.equal(failed.payload.status, 'retryable');
  const revoked = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/agents/${bob.agent.id}/credentials/revoke`, { session: bob.session, body: {} });
  assert.equal(revoked.status, 200);
  assert.equal((await mcp(baseUrl, bob.agentApiToken, 'tools/list')).status, 401);
});

test('MCP asset tools use signed binary URLs and enforce scanner state, permission and workspace boundaries', async t => {
  const scannerUrl = await startScanner(t);
  const baseUrl = await startServer(t, { SINALOA_MALWARE_SCANNER_URL: scannerUrl });
  const alice = await owner(baseUrl, '1301', ['send_agent_messages', 'receive_agent_messages', 'create_assets']);
  const outsider = await owner(baseUrl, '1302');
  const blob = Buffer.from('safe collaboration file');
  const checksumSha256 = crypto.createHash('sha256').update(blob).digest('base64');
  const uploadArgs = { filename: 'answer.txt', mimeType: 'text/plain', size: blob.length, checksumSha256, idempotencyKey: 'safe-file-once' };
  const begun = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_begin_asset_upload', uploadArgs));
  assert.equal(begun.status, 201);
  assert.equal(begun.payload.object.state, 'quarantine');
  assert.ok(begun.payload.upload.url);
  assert.ok(!JSON.stringify(begun).includes(blob.toString()));
  const assetId = begun.payload.object.id;
  const retry = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_begin_asset_upload', uploadArgs));
  assert.equal(retry.status, 200);
  assert.equal(retry.payload.object.id, assetId);
  const conflict = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_begin_asset_upload', { ...uploadArgs, filename: 'changed.txt' }));
  assert.equal(conflict.status, 409);
  const preScan = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_asset_download', { assetId }));
  assert.equal(preScan.status, 423);
  const alien = content(await tool(baseUrl, outsider.agentApiToken, 'sinaloa_asset_download', { assetId }));
  assert.equal(alien.status, 404);
  const noCreate = await tool(baseUrl, outsider.agentApiToken, 'sinaloa_begin_asset_upload', { filename: 'bad.txt', mimeType: 'text/plain', size: blob.length, checksumSha256, idempotencyKey: 'wrong-owner' });
  assert.equal(noCreate.payload.error.code, -32602);
  const uploaded = await fetch(begun.payload.upload.url, { method: 'PUT', headers: begun.payload.upload.headers, body: blob });
  assert.equal(uploaded.status, 204);
  const complete = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_complete_asset_upload', { assetId }));
  assert.equal(complete.status, 200);
  assert.equal(complete.payload.state, 'clean');
  const list = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_list_assets'));
  assert.ok(list.payload.some(item => item.id === assetId && item.state === 'clean'));
  const alienList = content(await tool(baseUrl, outsider.agentApiToken, 'sinaloa_list_assets'));
  assert.ok(!alienList.payload.some(item => item.id === assetId));
  const signed = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_asset_download', { assetId }));
  assert.equal(signed.status, 200);
  const downloaded = await fetch(signed.payload.download.url);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), blob);
  const infected = Buffer.from('infected test item');
  const infectedStarted = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_begin_asset_upload', { filename: 'infected.txt', mimeType: 'text/plain', size: infected.length, checksumSha256: crypto.createHash('sha256').update(infected).digest('base64'), idempotencyKey: 'infected-file-once' }));
  await fetch(infectedStarted.payload.upload.url, { method: 'PUT', headers: infectedStarted.payload.upload.headers, body: infected });
  const infectedScan = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_complete_asset_upload', { assetId: infectedStarted.payload.object.id }));
  assert.equal(infectedScan.payload.state, 'infected');
  const infectedDownload = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_asset_download', { assetId: infectedStarted.payload.object.id }));
  assert.equal(infectedDownload.status, 423);
});

test('MCP typed collaboration shares one result and grants one clean asset to the counterparty', async t => {
  const scannerUrl = await startScanner(t);
  const baseUrl = await startServer(t, { SINALOA_MALWARE_SCANNER_URL: scannerUrl });
  const [alice, bob, outsider] = await Promise.all([
    owner(baseUrl, '1401', ['send_agent_messages', 'receive_agent_messages', 'create_assets']),
    owner(baseUrl, '1402', ['send_agent_messages', 'receive_agent_messages', 'create_assets']),
    owner(baseUrl, '1403', ['send_agent_messages', 'receive_agent_messages', 'create_assets'])
  ]);
  const start = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_start_case', { recipientAddress: bob.agent.address, text: 'Find a shared answer', idempotencyKey: 'mcp-shared-first' }));
  assert.equal(start.status, 202);
  assert.equal(start.payload.type, 'request');
  const second = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_start_case', { recipientAddress: bob.agent.address, text: 'Separate case', idempotencyKey: 'mcp-shared-second' }));
  assert.notEqual(second.payload.caseId, start.payload.caseId);
  const caseId = start.payload.caseId;
  const injection = content(await tool(baseUrl, outsider.agentApiToken, 'sinaloa_send_message', { recipientAddress: bob.agent.address, caseId, text: 'Inject', idempotencyKey: 'mcp-third-inject' }));
  assert.equal(injection.status, 403);
  const proposal = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_send_proposal', { recipientAddress: bob.agent.address, caseId, text: 'Answer 42', proposal: { answer: '42' }, idempotencyKey: 'mcp-shared-proposal' }));
  assert.equal(proposal.status, 202);
  const counter = content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_send_decision', { recipientAddress: alice.agent.address, caseId, text: 'Try 43', decision: 'counteroffer', proposalMessageId: proposal.payload.id, details: { answer: '43' }, idempotencyKey: 'mcp-shared-counter' }));
  assert.equal(counter.status, 202, JSON.stringify(counter));
  assert.equal(counter.payload.type, 'counterproposal');
  const decision = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_send_decision', { recipientAddress: bob.agent.address, caseId, text: 'Accept 43', decision: 'accept', proposalMessageId: proposal.payload.id, idempotencyKey: 'mcp-shared-decision' }));
  assert.equal(decision.status, 202, JSON.stringify(decision));
  const approval = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/cases/${caseId}/actions`, { session: bob.session, headers: { 'idempotency-key': 'mcp-shared-approval' }, body: { actionKey: 'approveOnce', externalRefs: { requestedAction: 'case.complete', result: '43' } } });
  assert.equal(approval.status, 201, JSON.stringify(approval.payload));
  const forged = content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_send_completion', { recipientAddress: alice.agent.address, caseId, text: 'Forged completion', result: '43', authorityBasis: 'action_forged', idempotencyKey: 'mcp-forged-completion' }));
  assert.equal(forged.status, 409);
  const completionArgs = { recipientAddress: alice.agent.address, caseId, text: 'Joint answer 43', result: '43', authorityBasis: approval.payload.action.id, idempotencyKey: 'mcp-shared-completion' };
  const completion = content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_send_completion', completionArgs));
  assert.equal(completion.status, 202, JSON.stringify(completion));
  assert.equal(content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_send_completion', completionArgs)).payload.id, completion.payload.id);
  await eventually(async () => {
    const a = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_read_case', { caseId }));
    const b = content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_read_case', { caseId }));
    return a.payload?.state === 'completed' && b.payload?.state === 'completed' && a.payload.receipt?.id === b.payload.receipt?.id;
  });
  const firstCase = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_read_case', { caseId })).payload;
  assert.equal(firstCase.receipt.result, '43');
  assert.equal(firstCase.receipt.authorityBasis, approval.payload.action.id);
  assert.equal(content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_read_case', { caseId: second.payload.caseId })).payload.receipt, null);

  const blob = Buffer.from('shared MCP file');
  const begun = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_begin_asset_upload', { filename: 'shared.txt', mimeType: 'text/plain', size: blob.length, checksumSha256: crypto.createHash('sha256').update(blob).digest('base64'), caseId, idempotencyKey: 'mcp-shared-upload' }));
  assert.equal(begun.status, 201);
  const assetId = begun.payload.object.id;
  const grantArgs = { assetId, caseId, recipientAgentId: bob.agent.id, idempotencyKey: 'mcp-shared-grant' };
  const grant = content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_grant_asset', grantArgs));
  assert.equal(grant.status, 201, JSON.stringify(grant));
  assert.equal(content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_grant_asset', grantArgs)).payload.id, grant.payload.id);
  assert.equal(content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_grant_asset', { ...grantArgs, recipientAgentId: outsider.agent.id })).status, 409);
  assert.equal(content(await tool(baseUrl, outsider.agentApiToken, 'sinaloa_grant_asset', { ...grantArgs, idempotencyKey: 'outsider-grant' })).status, 404);
  assert.equal((await fetch(begun.payload.upload.url, { method: 'PUT', headers: begun.payload.upload.headers, body: blob })).status, 204);
  assert.equal(content(await tool(baseUrl, alice.agentApiToken, 'sinaloa_complete_asset_upload', { assetId })).payload.state, 'clean');
  assert.ok(content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_list_assets', { caseId })).payload.some(asset => asset.id === assetId));
  assert.equal(content(await tool(baseUrl, outsider.agentApiToken, 'sinaloa_asset_download', { assetId })).status, 404);
  assert.equal(content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_asset_download', { assetId })).status, 200);
  assert.equal((await api(baseUrl, `/api/inboxes/${bob.inbox.id}/contacts/${alice.agent.id}/block`, { session: bob.session, body: {} })).status, 200);
  assert.equal(content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_asset_download', { assetId })).status, 403);
  assert.equal((await api(baseUrl, `/api/inboxes/${bob.inbox.id}/contacts/${alice.agent.id}/unblock`, { session: bob.session, body: {} })).status, 200);
  assert.equal(content(await tool(baseUrl, bob.agentApiToken, 'sinaloa_asset_download', { assetId })).status, 200);
});

test('trusted relay renews an expired access token before a late MCP call and keeps credentials out of tool arguments', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sinaloa-mcp-expiry-'));
  const baseUrl = await startServer(t, {}, dataDir);
  const alice = await owner(baseUrl, '1501');
  const listed = (await mcp(baseUrl, alice.agentApiToken, 'tools/list')).payload.result.tools;
  assert.ok(listed.every(item => !JSON.stringify(item.inputSchema).includes('agentApiToken') && !JSON.stringify(item.inputSchema).includes('agentRefreshToken')));
  const credentialHash = crypto.createHash('sha256').update(alice.agentApiToken).digest('hex');
  const store = new FileStore(dataDir);
  const credentialPath = path.join('auth', 'agent-credentials', `${credentialHash}.json`);
  const credential = await store.getJson(credentialPath);
  await store.putJson(credentialPath, { ...credential, expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await mcp(baseUrl, alice.agentApiToken, 'tools/list')).status, 401);
  const renewed = await api(baseUrl, '/api/agent-token', { body: { grantType: 'refresh_token', agentRefreshToken: alice.agentRefreshToken } });
  assert.equal(renewed.status, 200);
  const lateCall = await tool(baseUrl, renewed.payload.agentApiToken, 'sinaloa_agent_info');
  assert.equal(lateCall.status, 200);
  assert.equal(content(lateCall).agentId, alice.agent.id);
  assert.equal(JSON.stringify(lateCall).includes(renewed.payload.agentApiToken), false);
  assert.equal((await api(baseUrl, '/api/agent-token', { body: { grantType: 'refresh_token', agentRefreshToken: alice.agentRefreshToken } })).status, 401);
  assert.equal((await api(baseUrl, `/api/inboxes/${alice.inbox.id}/agents/${alice.agent.id}/credentials/revoke`, { session: alice.session, body: {} })).status, 200);
  assert.equal((await mcp(baseUrl, renewed.payload.agentApiToken, 'tools/list')).status, 401);
  assert.equal((await api(baseUrl, '/api/agent-token', { body: { grantType: 'refresh_token', agentRefreshToken: renewed.payload.agentRefreshToken } })).status, 401);
});
