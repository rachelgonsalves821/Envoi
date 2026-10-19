// case-tools v1: a case session sees exactly its own inbox's assets in its case, plus assets
// granted to it in that case. Loading them reads only the inbox's own asset records and the case's
// grants; assets in other cases, without a case, or in the other inbox of a shared case stay hidden.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { api, claim, eventually, launch, owner, send, waitForMessageStatus } from './a3-harness.js';

const backends = [{ name: 'FileStore', env: {}, prefix: '87' }, ...(process.env.DATABASE_URL
  ? [{ name: 'PostgreSQL', env: { DATABASE_URL: process.env.DATABASE_URL }, prefix: '88' }] : [])];
const flags = { ENVOI_INSTALLATIONS_V2: 'true', ENVOI_CASE_SESSIONS_V1: 'true' };

async function tool(baseUrl, session, name, args = {}) {
  const response = await api(baseUrl, '/mcp', { token: session.token,
    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  assert.equal(response.status, 200, response.text);
  const body = JSON.parse(response.payload.result.content[0].text);
  assert.equal(body.ok, true, JSON.stringify(body));
  return body.result;
}
async function deliver(baseUrl, from, to, caseId) {
  const sent = await send(baseUrl, from, to, { caseId, text: `Open ${caseId}` });
  assert.equal(sent.status, 202, sent.text);
  await waitForMessageStatus(baseUrl, to, sent.payload.id, 'delivered');
}
async function reserve(baseUrl, who, caseId, filename) {
  const content = Buffer.from(`Asset ${filename}`);
  const response = await api(baseUrl, `/api/inboxes/${who.inbox.id}/asset-uploads`, { token: who.agentApiToken, key: `reserve-${filename}`, body: {
    ...(caseId ? { caseId } : {}), filename, mimeType: 'text/plain', size: content.length,
    checksumSha256: crypto.createHash('sha256').update(content).digest('base64') } });
  assert.equal(response.status, 201, response.text);
  return response.payload.object.id;
}

for (const backend of backends) {
  test(`[${backend.name}] case tools list only this inbox's assets in this case`, { timeout: 90000 }, async t => {
    const server = await launch({ ...backend.env, ...flags });
    t.after(() => server.stop());
    const { baseUrl } = server;
    const [alice, bob, carol, dave] = await Promise.all(['10', '11', '12', '13'].map(suffix => owner(baseUrl, `${backend.prefix}${suffix}`)));
    const tag = crypto.randomBytes(6).toString('hex');
    const caseA = `case_scope_a_${tag}`, caseB = `case_scope_b_${tag}`, caseC = `case_scope_c_${tag}`;
    await deliver(baseUrl, alice, bob, caseA);
    await deliver(baseUrl, alice, bob, caseB);
    await deliver(baseUrl, carol, dave, caseC);

    const visible = await reserve(baseUrl, bob, caseA, 'bob-case-a.txt');
    await reserve(baseUrl, bob, caseB, 'bob-other-case.txt');
    await reserve(baseUrl, bob, null, 'bob-no-case.txt');
    await reserve(baseUrl, alice, caseA, 'alice-same-case.txt');
    await reserve(baseUrl, dave, caseC, 'dave-other-inbox.txt');

    const work = await eventually(async () => {
      const response = await claim(baseUrl, bob.agentApiToken);
      assert.equal(response.status, 200, response.text);
      return response.payload.work?.message.caseId === caseA ? response.payload.work : null;
    }, { message: `claim work in ${caseA}` });
    const minted = await api(baseUrl, `/api/agent/work/${work.workId}/session`, { token: bob.agentApiToken, body: { leaseToken: work.leaseToken } });
    assert.equal(minted.status, 201, minted.text);
    const session = minted.payload.session;

    const shown = await tool(baseUrl, session, 'envoi_case_snapshot');
    assert.deepEqual(shown.assets.map(asset => asset.filename), ['bob-case-a.txt']);
    const listed = await tool(baseUrl, session, 'envoi_case_list_assets');
    assert.deepEqual(listed.assets.map(asset => asset.filename), ['bob-case-a.txt']);
    const one = await tool(baseUrl, session, 'envoi_case_list_assets', { assetRef: listed.assets[0].ref });
    assert.equal(one.asset.filename, 'bob-case-a.txt');
    assert.ok(visible);
  });
}
