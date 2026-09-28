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

async function request(baseUrl, pathname, { token, body, headers = {}, method = body ? 'POST' : 'GET' } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, payload: await response.json() };
}

async function startScanner() {
  const scans = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    scans.push({ body: Buffer.concat(chunks), headers: req.headers });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'clean', engine: 'test-scanner' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { scans, url: `http://127.0.0.1:${server.address().port}/scan`, stop: () => new Promise(resolve => server.close(resolve)) };
}

async function startServer(scannerUrl) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sinaloa-asset-integration-'));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0', SINALOA_AUTH_MODE: 'development', SINALOA_DATA_DIR: dataDir, SINALOA_MALWARE_SCANNER_URL: scannerUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server start timed out')), 10_000);
    child.once('exit', code => reject(new Error(`Server exited with ${code}`)));
    child.stdout.on('data', chunk => { const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  return { baseUrl, stop: () => new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }) };
}

async function authenticatedOwner(baseUrl) {
  const start = await request(baseUrl, '/api/auth/phone/start', { body: { phoneNumber: '+14165550888', displayName: 'Asset Owner' } });
  const verified = await request(baseUrl, '/api/auth/phone/verify', { body: { challengeId: start.payload.challengeId, code: start.payload.developmentCode } });
  const setup = await request(baseUrl, '/api/auth/totp/setup', { token: verified.payload.sessionToken, body: {} });
  const mfa = await request(baseUrl, '/api/auth/totp/verify', { token: verified.payload.sessionToken, body: { code: generateSync({ secret: setup.payload.secret }) } });
  assert.equal(mfa.status, 200);
  return verified.payload.sessionToken;
}

test('agent asset upload is quota-reserved, checksum-verified, scanned, and signed for supervised download', async t => {
  const scanner = await startScanner();
  const app = await startServer(scanner.url);
  t.after(async () => { await app.stop(); await scanner.stop(); });
  const humanToken = await authenticatedOwner(app.baseUrl);
  const workspace = await request(app.baseUrl, '/api/inboxes', { token: humanToken, body: { name: 'Asset workspace' } });
  const enrollment = await request(app.baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { token: humanToken, body: { permissions: ['receive_agent_messages', 'create_assets'], agentProfile: { name: 'Artifact Agent' } } });
  const enrolled = await request(app.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: enrollment.payload.enrollmentToken } });
  const content = Buffer.from('signed agent artifact');
  const checksumSha256 = crypto.createHash('sha256').update(content).digest('base64');
  const started = await request(app.baseUrl, `/api/inboxes/${enrolled.payload.inbox.id}/asset-uploads`, { token: enrolled.payload.agentApiToken, body: { filename: 'agreement.txt', mimeType: 'text/plain', size: content.length, checksumSha256 } });
  assert.equal(started.status, 201);
  assert.equal(started.payload.object.state, 'quarantine');
  const uploaded = await fetch(started.payload.upload.url, { method: 'PUT', headers: started.payload.upload.headers, body: content });
  assert.equal(uploaded.status, 204);
  const completed = await request(app.baseUrl, `/api/inboxes/${enrolled.payload.inbox.id}/assets/${started.payload.object.id}/complete`, { token: enrolled.payload.agentApiToken, body: {} });
  assert.equal(completed.status, 200);
  assert.equal(completed.payload.state, 'clean');
  assert.equal(completed.payload.scan.engine, 'test-scanner');
  assert.equal(scanner.scans.length, 1);
  assert.equal(scanner.scans[0].body.toString(), content.toString());
  const signed = await request(app.baseUrl, `/api/inboxes/${enrolled.payload.inbox.id}/assets/${started.payload.object.id}/download`, { token: humanToken });
  assert.equal(signed.status, 200);
  const downloaded = await fetch(signed.payload.download.url);
  assert.equal(downloaded.status, 200);
  assert.equal(Buffer.from(await downloaded.arrayBuffer()).toString(), content.toString());
  const quota = await request(app.baseUrl, `/api/inboxes/${enrolled.payload.inbox.id}/assets/quota`, { token: humanToken });
  assert.equal(quota.status, 200);
  assert.equal(quota.payload.used, content.length);
  assert.equal(quota.payload.reserved, 0);
});
