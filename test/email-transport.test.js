import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { createEmailTransport } from '../src/email-transport.js';

async function fakeProvider(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

const rawBody = async req => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

test('email transport remains fail-closed until provider, public domain, webhook, and DNS verification are configured', () => {
  const disabled = createEmailTransport({ provider: 'disabled' });
  assert.equal(disabled.ready, false);
  assert.match(disabled.status().reason, /provider/i);

  const reservedDomain = createEmailTransport({
    provider: 'resend',
    apiKey: 're_test',
    webhookSecret: `whsec_${Buffer.alloc(32, 1).toString('base64')}`,
    publicDomain: 'sinaloa.mail',
    domainVerified: true
  });
  assert.equal(reservedDomain.ready, false);
  assert.match(reservedDomain.status().reason, /not a delegated public/i);
  assert.throws(() => reservedDomain.assertReady(), /not ready/i);
});

test('email transport sends one-recipient messages with provider idempotency and retrieves inbound content', async t => {
  const requests = [];
  const provider = await fakeProvider(async (req, res) => {
    const body = await rawBody(req);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/emails') return res.end(JSON.stringify({ id: 'provider_email_1' }));
    if (req.method === 'GET' && req.url === '/emails/receiving/inbound_1?html_format=cid') return res.end(JSON.stringify({
      object: 'email', id: 'inbound_1', to: ['worker@agents.example.com'], from: 'Human <human@example.net>', created_at: new Date().toISOString(), subject: 'Reply', bcc: null, cc: null, reply_to: null, received_for: ['worker@agents.example.com'], html: '<p>Hello</p>', text: 'Hello', headers: {}, message_id: '<reply@example.net>', attachments: []
    }));
    res.statusCode = 404;
    return res.end(JSON.stringify({ name: 'not_found', message: 'Missing', statusCode: 404 }));
  });
  t.after(provider.close);
  const transport = createEmailTransport({
    provider: 'resend',
    apiKey: 're_test',
    webhookSecret: `whsec_${Buffer.alloc(32, 2).toString('base64')}`,
    publicDomain: 'agents.example.com',
    domainVerified: true,
    baseUrl: provider.baseUrl
  });
  assert.equal(transport.ready, true);
  assert.equal(transport.addressForSlug('worker'), 'worker@agents.example.com');
  const sent = await transport.send({
    from: 'Worker <worker@agents.example.com>',
    to: 'human@example.net',
    subject: 'Status',
    text: 'The agents reached agreement.',
    replyTo: 'reply+abc@agents.example.com',
    idempotencyKey: 'external-email/msg_1'
  });
  assert.deepEqual(sent, { provider: 'resend', providerMessageId: 'provider_email_1' });
  const outbound = requests[0];
  assert.equal(outbound.headers['idempotency-key'], 'external-email/msg_1');
  assert.equal(outbound.headers.authorization, 'Bearer re_test');
  assert.deepEqual(JSON.parse(outbound.body), {
    from: 'Worker <worker@agents.example.com>',
    to: ['human@example.net'],
    subject: 'Status',
    text: 'The agents reached agreement.',
    reply_to: 'reply+abc@agents.example.com'
  });
  const inbound = await transport.retrieveInbound('inbound_1');
  assert.equal(inbound.text, 'Hello');
  assert.equal(requests[1].url, '/emails/receiving/inbound_1?html_format=cid');
});

test('email transport verifies the exact raw webhook body and rejects tampering', () => {
  const key = Buffer.alloc(32, 3);
  const secret = `whsec_${key.toString('base64')}`;
  const transport = createEmailTransport({
    provider: 'resend',
    apiKey: 're_test',
    webhookSecret: secret,
    publicDomain: 'agents.example.com',
    domainVerified: true
  });
  const payload = JSON.stringify({ type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: 'provider_email_1' } });
  const id = 'evt_webhook_1';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64');
  const headers = { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
  assert.equal(transport.verifyWebhook(payload, headers).type, 'email.delivered');
  assert.throws(() => transport.verifyWebhook(`${payload} `, headers), /Invalid email webhook signature/);
});
