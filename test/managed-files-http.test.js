import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { api, launch, owner, pauseAgent, resumeAgent } from './a3-harness.js';

test('owner-selected files enforce exact read and edit grants with both Phase D flags off', { timeout: 90000 }, async t => {
  const scanner = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const infected = Buffer.concat(chunks).toString() === 'blocked by test scanner';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: infected ? 'infected' : 'clean', engine: 'test' }));
  }).listen(0, '127.0.0.1');
  await once(scanner, 'listening');
  t.after(() => new Promise(resolve => scanner.close(resolve)));
  const server = await launch({ ENVOI_RELATIONSHIPS_V2: 'false', ENVOI_A2A_GATEWAY: 'false',
    ENVOI_MALWARE_SCANNER_URL: `http://127.0.0.1:${scanner.address().port}/scan` });
  t.after(() => server.stop());
  const { baseUrl } = server;
  const [alice, bob] = await Promise.all([owner(baseUrl, '8401'), owner(baseUrl, '8402')]);
  const inbox = `/api/inboxes/${alice.inbox.id}`;
  const files = `${inbox}/managed-files`;
  const request = (route, options) => api(baseUrl, route, options);
  const token = alice.agentApiToken;
  const session = alice.session;
  const data = content => Buffer.from(content).toString('base64');
  async function add(filename, access) {
    const response = await request(files, { session, body: { filename, access, mimeType: 'text/plain', contentBase64: data(filename) } });
    assert.equal(response.status, 201, response.text);
    assert.equal('objectId' in response.payload, false);
    return response.payload;
  }
  const hidden = await add('hidden.txt', 'none');
  const read = await add('read.txt', 'read');
  const edit = await add('edit.txt', 'edit');
  const content = file => `${files}/${file.id}/content`;
  const access = file => `${files}/${file.id}/access`;
  const update = (file, text, revision = file.revision) => request(content(file), {
    method: 'PUT', token, body: { revision, contentBase64: data(text) }
  });
  assert.deepEqual((await request(files, { token })).payload.map(file => file.id).sort(), [read.id, edit.id].sort());
  assert.equal((await request(content(hidden), { token })).status, 404);
  assert.equal((await update(hidden, 'unauthorized')).status, 404);
  assert.equal((await request(content(read), { token: bob.agentApiToken })).status, 401);
  assert.equal((await request(content(read), { token })).text, 'read.txt');
  assert.equal((await update(read, 'unauthorized')).status, 403);
  assert.equal((await request(access(hidden), { method: 'PUT', token, body: { access: 'edit', revision: 1 } })).status, 404);
  assert.equal((await update(edit, 'blocked by test scanner')).status, 422);
  assert.equal((await request(content(edit), { token })).text, 'edit.txt');
  assert.equal((await update(edit, 'updated')).status, 200);
  assert.equal((await update(edit, 'stale')).status, 409);
  assert.equal((await request(content(edit), { token })).text, 'updated');
  assert.deepEqual((await request(`${inbox}/assets`, { token })).payload, []);
  const events = (await request(`${inbox}/events/delta`, { token })).payload.events;
  assert.ok(!events.some(event => event.type.startsWith('managed_file.')));
  await pauseAgent(baseUrl, alice);
  assert.equal((await request(content(edit), { token })).status, 404);
  await resumeAgent(baseUrl, alice);
  assert.equal((await request(access(edit), { method: 'PUT', session, body: { access: 'none', revision: 2 } })).status, 200);
  assert.equal((await request(content(edit), { token })).status, 404);
  assert.equal((await request(content(edit), { session })).text, 'updated');
});
