import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';

const webhookKey = Buffer.alloc(32, 7);
const webhookSecret = `whsec_${webhookKey.toString('base64')}`;

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function startProvider() {
  const state = { outbound: [], inbound: new Map() };
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/emails') {
      state.outbound.push({ body: JSON.parse(raw), headers: req.headers });
      return res.end(JSON.stringify({ id: 'provider_outbound_1' }));
    }
    const inboundMatch = req.url.match(/^\/emails\/receiving\/([^?]+)\?html_format=cid$/);
    if (req.method === 'GET' && inboundMatch && state.inbound.has(inboundMatch[1])) return res.end(JSON.stringify(state.inbound.get(inboundMatch[1])));
    res.statusCode = 404;
    return res.end(JSON.stringify({ name: 'not_found', message: 'Not found', statusCode: 404 }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { state, baseUrl: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise(resolve => server.close(resolve)) };
}

async function startSinaloa(providerUrl) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sinaloa-email-integration-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: '',
      SINALOA_PORT: '0',
      SINALOA_AUTH_MODE: 'development',
      SINALOA_DATA_DIR: dataDir,
      SINALOA_EMAIL_PROVIDER: 'resend',
      SINALOA_ENABLE_EXTERNAL_EMAIL: 'true',
      SINALOA_PUBLIC_EMAIL_DOMAIN: 'agents.example.com',
      SINALOA_EMAIL_DOMAIN_VERIFIED: 'true',
      RESEND_API_KEY: 're_test',
      RESEND_WEBHOOK_SECRET: webhookSecret,
      RESEND_API_BASE_URL: providerUrl
    },
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
  return { baseUrl, stop: () => new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }) };
}

async function request(baseUrl, pathname, { token, body, headers = {}, method = body ? 'POST' : 'GET' } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, payload: await response.json() };
}

async function signedWebhook(baseUrl, id, event) {
  const payload = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', webhookKey).update(`${id}.${timestamp}.${payload}`).digest('base64');
  const response = await fetch(`${baseUrl}/api/email-webhooks/resend`, { method: 'POST', headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` }, body: payload });
  return { status: response.status, payload: await response.json() };
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Timed out waiting for email delivery');
}

async function ownerSession(baseUrl) {
  const started = await request(baseUrl, '/api/auth/phone/start', { body: { phoneNumber: '+14165550999', displayName: 'Email Owner' } });
  const verified = await request(baseUrl, '/api/auth/phone/verify', { body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  const setup = await request(baseUrl, '/api/auth/totp/setup', { token: verified.payload.sessionToken, body: {} });
  const mfa = await request(baseUrl, '/api/auth/totp/verify', { token: verified.payload.sessionToken, body: { code: generateSync({ secret: setup.payload.secret }) } });
  assert.equal(mfa.status, 200);
  return verified.payload.sessionToken;
}

test('approved agent email reaches a human and a signed reply returns to the same supervised case', async t => {
  const provider = await startProvider();
  const app = await startSinaloa(provider.baseUrl);
  t.after(async () => { await app.stop(); await provider.stop(); });

  const humanToken = await ownerSession(app.baseUrl);
  const workspace = await request(app.baseUrl, '/api/inboxes', { token: humanToken, body: { name: 'External email workspace' } });
  const enrollment = await request(app.baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { token: humanToken, body: { permissions: ['send_agent_messages', 'receive_agent_messages', 'use_email_transport'], agentProfile: { name: 'Negotiator', slug: 'negotiator' } } });
  const enrolled = await request(app.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: enrollment.payload.enrollmentToken } });
  assert.equal(enrolled.payload.agent.identity.externalAddress, 'negotiator@agents.example.com');
  const inboxId = enrolled.payload.inbox.id;
  const approved = await request(app.baseUrl, `/api/inboxes/${inboxId}/external-contacts`, { token: humanToken, body: { email: 'friend@example.net', displayName: 'Friend', direction: 'both' } });
  assert.equal(approved.status, 201);

  const queued = await request(app.baseUrl, `/api/inboxes/${inboxId}/external-emails`, {
    token: enrolled.payload.agentApiToken,
    headers: { 'Idempotency-Key': 'friend-update-1' },
    body: { senderAgentId: enrolled.payload.agent.id, recipientEmail: 'friend@example.net', subject: 'Negotiation update', text: 'We have a proposed agreement.' }
  });
  assert.equal(queued.status, 202);
  const accepted = await waitFor(async () => {
    const messages = await request(app.baseUrl, `/api/inboxes/${inboxId}/messages`, { token: humanToken });
    return messages.payload.find(message => message.id === queued.payload.id && message.status === 'accepted');
  });
  assert.equal(provider.state.outbound.length, 1);
  assert.equal(provider.state.outbound[0].body.from, 'Negotiator <negotiator@agents.example.com>');
  assert.equal(provider.state.outbound[0].body.to[0], 'friend@example.net');
  assert.equal(provider.state.outbound[0].headers['idempotency-key'], `external-email/${queued.payload.id}`);

  const deliveredWebhook = await signedWebhook(app.baseUrl, 'webhook-delivered-1', { type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: 'provider_outbound_1' } });
  assert.equal(deliveredWebhook.status, 202);
  await waitFor(async () => {
    const messages = await request(app.baseUrl, `/api/inboxes/${inboxId}/messages`, { token: humanToken });
    return messages.payload.find(message => message.id === queued.payload.id && message.status === 'delivered');
  });

  provider.state.inbound.set('provider_inbound_1', {
    object: 'email', id: 'provider_inbound_1', to: [accepted.replyAddress], received_for: [accepted.replyAddress], from: 'Friend <friend@example.net>', created_at: new Date().toISOString(), subject: 'Re: Negotiation update', bcc: null, cc: null, reply_to: null, html: '<p>Approved.</p>', text: 'Approved.', headers: { 'in-reply-to': '<provider_outbound_1>' }, message_id: '<provider_inbound_1@example.net>', attachments: []
  });
  const receivedWebhook = await signedWebhook(app.baseUrl, 'webhook-received-1', { type: 'email.received', created_at: new Date().toISOString(), data: { email_id: 'provider_inbound_1' } });
  assert.equal(receivedWebhook.status, 202);
  const reply = await waitFor(async () => {
    const messages = await request(app.baseUrl, `/api/inboxes/${inboxId}/messages`, { token: humanToken });
    return messages.payload.find(message => message.direction === 'inbound' && message.payload?.providerMessageId === 'provider_inbound_1');
  });
  assert.equal(reply.caseId, queued.payload.caseId);
  assert.equal(reply.senderEmail, 'friend@example.net');
  assert.equal(reply.recipientAgentId, enrolled.payload.agent.id);
  assert.equal(reply.text, 'Approved.');
  const humanView = await request(app.baseUrl, `/api/inboxes/${inboxId}/human-view`, { token: humanToken });
  const externalHuman = Object.values(humanView.payload.participantDirectory).find(participant => participant.address === 'friend@example.net');
  assert.deepEqual(externalHuman, { id: externalHuman.id, type: 'human', displayName: 'Friend', address: 'friend@example.net', organizationId: null, inboxId, accessState: 'active' });
});
