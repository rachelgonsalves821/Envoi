import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { BrowserSession } from './browser-session.js';

// An agent /mcp tool call reaches REST through a loopback request. These checks pin that it is rate-limited once, as the
// agent, by what the tool does: no double charge, no read counted as a write, and no bucket shared through 127.0.0.1.
async function startServer(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'envoi-mcp-rate-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: '', ENVOI_PORT: '0', ENVOI_AUTH_MODE: 'development', ENVOI_DATA_DIR: dataDir, ENVOI_TRUSTED_PROXY: 'cloudflare' },
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

const client = baseUrl => {
  const api = async (pathname, { ip, token, session, body, headers = {}, method = body ? 'POST' : 'GET' } = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { 'x-forwarded-for': ip, ...headers, ...(body ? { 'content-type': 'application/json' } : {}), ...(session ? session.headers(baseUrl, method) : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    session?.capture(response);
    return { status: response.status, payload: await response.json().catch(() => null) };
  };
  const agent = async (suffix, ip) => {
    const session = new BrowserSession();
    const started = await api('/api/auth/phone/start', { ip, session, body: { phoneNumber: `+14165550${suffix}`, displayName: `Owner ${suffix}` } });
    assert.equal((await api('/api/auth/phone/verify', { ip, session, body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } })).status, 200);
    const setup = await api('/api/auth/totp/setup', { ip, session, body: {} });
    assert.equal((await api('/api/auth/totp/verify', { ip, session, body: { code: generateSync({ secret: setup.payload.secret }) } })).status, 200);
    const workspace = await api('/api/inboxes', { ip, session, body: { name: `Workspace ${suffix}` } });
    const enrollment = await api(`/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { ip, session, body: { permissions: ['send_agent_messages', 'receive_agent_messages'] } });
    const enrolled = await api('/api/agent-enroll', { ip, body: { enrollmentToken: enrollment.payload.enrollmentToken, name: `Agent ${suffix}`, slug: `agent-${suffix}` } });
    assert.equal(enrolled.status, 201, JSON.stringify(enrolled.payload));
    return { token: enrolled.payload.agentApiToken, ip };
  };
  const tool = async ({ token, ip }, name, args = {}) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'x-forwarded-for': ip, authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    });
    const text = await response.text();
    return { http: response.status, limited: response.status === 429 || /RATE_LIMITED/.test(text) };
  };
  const repeat = async (count, call) => {
    const limited = [];
    for (let index = 1; index <= count; index += 1) if ((await call()).limited) limited.push(index);
    return limited;
  };
  return { api, agent, tool, repeat };
};

test('an MCP tool call is charged once, as its own agent, by what the tool does', async t => {
  const { api, agent, tool, repeat } = client(await startServer(t));
  const alice = await agent('501', '203.0.113.10');
  const bob = await agent('502', '198.51.100.20');
  const carol = await agent('503', '192.0.2.30');
  const dana = await agent('504', '192.0.2.40');

  // A write tool costs one of the agent's 180 writes a minute, not two.
  assert.deepEqual(await repeat(150, () => tool(alice, 'envoi_claim_work')), [], 'Alice keeps 150 MCP writes inside her own budget');
  // Another customer's agent has its own full budget: nothing is shared through the loopback address.
  assert.deepEqual(await repeat(150, () => tool(bob, 'envoi_claim_work')), [], 'Bob is unaffected by Alice');
  assert.deepEqual(await repeat(5, () => tool(carol, 'envoi_claim_work')), [], 'a fresh agent is unaffected by both');
  // The agent's own write limit still holds at exactly the REST number.
  assert.deepEqual(await repeat(31, () => tool(alice, 'envoi_claim_work')), [31], 'Alice is limited at her 181st write, as on REST');
  assert.equal((await api('/api/agent/work/claim', { ip: alice.ip, token: alice.token, body: {} })).status, 429, 'MCP and REST writes draw on one budget');
  // A read tool costs a read, not a write, even though every MCP request is a POST.
  assert.deepEqual(await repeat(250, () => tool(dana, 'envoi_list_messages')), [], 'Dana reads past 180 a minute');
});

test('the loopback rate-limit exemption cannot be claimed from outside', async t => {
  const { api } = client(await startServer(t));
  // Rotating unknown credentials with a made-up marker from one address: only the address limit can stop this, and it must.
  const statuses = [];
  for (let index = 0; index < 181; index += 1) {
    statuses.push((await api('/api/agent/work/claim', { ip: '198.51.100.99', token: `envoi_at_forged${index}`, headers: { 'x-envoi-mcp-dispatch': `forged-${index}` }, body: {} })).status);
  }
  assert.ok(statuses.slice(0, 180).every(status => status !== 429), 'the first 180 are judged on their credentials');
  assert.equal(statuses[180], 429, 'the 181st write from one address is limited despite the forged marker');
});

test('invalid credentials at /mcp stay at the strict per-address rate while valid agents get the read rate', async t => {
  const baseUrl = await startServer(t);
  const envelope = token => fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'x-forwarded-for': '198.51.100.77', authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  }).then(async response => { await response.body?.cancel(); return response.status; });
  const statuses = [];
  for (let index = 0; index < 181; index += 1) statuses.push(await envelope(`rotating-invalid-${index}`));
  assert.ok(statuses.slice(0, 180).every(status => status === 401), 'the first 180 attempts are refused on their credentials');
  assert.equal(statuses[180], 429, 'the 181st invalid attempt from one address is rate limited');
});
