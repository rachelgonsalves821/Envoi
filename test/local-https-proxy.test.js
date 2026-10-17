// scripts/local-https-proxy.mjs: loopback-only HTTPS in front of a local server, bodies and SSE
// streamed, a down target answered with 502. A throwaway certificate is generated with openssl
// (Git for Windows ships one); the test skips where openssl is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalHttpsProxy, parseTarget } from '../scripts/local-https-proxy.mjs';

const openssl = [process.env.OPENSSL, 'openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe']
  .filter(Boolean).find(candidate => (candidate === 'openssl' || existsSync(candidate)) && spawnSync(candidate, ['version']).status === 0);
const skip = openssl ? false : 'openssl is not available';

async function certificate(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'envoi-local-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cert = path.join(dir, 'localhost.pem');
  const key = path.join(dir, 'localhost-key.pem');
  const made = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  assert.equal(made.status, 0, made.stderr);
  return { cert: await readFile(cert), key: await readFile(key) };
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));

function request(port, ca, { method = 'GET', path: target = '/', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: 'localhost', port, method, path: target, ca, headers: body ? { 'content-type': 'application/json' } : {} }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('only loopback http targets are accepted', () => {
  assert.equal(parseTarget('http://127.0.0.1:8787').port, '8787');
  for (const bad of ['https://127.0.0.1:8787', 'http://10.0.0.5:8787', 'http://example.com', 'http://127.0.0.1:8787/api', 'http://user:pass@127.0.0.1:8787']) {
    assert.throws(() => parseTarget(bad), /loopback http origin/, bad);
  }
});

test('requests, bodies, the Host header and SSE frames pass through over TLS', { skip }, async t => {
  const tls = await certificate(t);
  const target = http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: ready\ndata: {}\n\n');
      setTimeout(() => { res.write('event: work.available\ndata: {}\n\n'); res.end(); }, 50);
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { res.writeHead(201, { 'content-type': 'application/json', 'x-seen-host': req.headers.host }); res.end(JSON.stringify({ method: req.method, path: req.url, body })); });
  });
  const targetPort = await listen(target);
  const proxy = createLocalHttpsProxy({ ...tls, target: `http://127.0.0.1:${targetPort}` });
  const port = await listen(proxy);
  t.after(async () => { await close(proxy); await close(target); });

  const posted = await request(port, tls.cert, { method: 'POST', path: '/api/agent-registrations?x=1', body: '{"a":1}' });
  assert.equal(posted.status, 201);
  assert.deepEqual(JSON.parse(posted.text), { method: 'POST', path: '/api/agent-registrations?x=1', body: '{"a":1}' });
  assert.equal(posted.headers['x-seen-host'], `localhost:${port}`, 'the server sees the public origin\'s host');

  const stream = await request(port, tls.cert, { path: '/events' });
  assert.match(stream.headers['content-type'], /text\/event-stream/);
  assert.match(stream.text, /event: ready[\s\S]*event: work\.available/);
});

test('a stopped local server is a 502, and an untrusted certificate is refused by clients', { skip }, async t => {
  const tls = await certificate(t);
  const idle = http.createServer();
  const deadPort = await listen(idle);
  await close(idle);
  const proxy = createLocalHttpsProxy({ ...tls, target: `http://127.0.0.1:${deadPort}` });
  const port = await listen(proxy);
  t.after(() => close(proxy));
  assert.equal((await request(port, tls.cert)).status, 502);
  await assert.rejects(request(port, undefined), /self.signed|unable to verify|certificate/i, 'without NODE_EXTRA_CA_CERTS the certificate is not trusted');
});
