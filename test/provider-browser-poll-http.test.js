import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { BrowserSession } from './browser-session.js';
import { api, owner, send } from './a3-harness.js';
import { backends, launchRegistration, lookup, approveRequest, approveBody, newAgentTarget, documents } from './agent-registration-harness.js';
const schemas = JSON.parse(await readFile(new URL('./contract-fixtures/provider-browser-poll/schemas.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict:false, allErrors:true }); addFormats(ajv); ajv.addSchema(schemas);
const matches = (name,value) => { const check=ajv.getSchema(`${schemas.$id}#/definitions/${name}`); assert.ok(check(value),ajv.errorsText(check.errors)); };

for (const backend of backends) {
  test(`[${backend.name}] real owner claim -> gateway confirmation -> scoped cookie; notification does not settle; pause and revoke deny`, { timeout: 90000 }, async t => {
    const server = await launchRegistration(backend, { ENVOI_AUTHENTICATED_REST_ROUTE: 'true', ENVOI_PROVIDER_BROWSER_POLL: 'true' });
    t.after(() => server.stop());
    const { baseUrl } = server, jar = new BrowserSession();
    async function request(route, payload, csrf, extra = {}) {
      const headers = { cookie: [...jar.cookies].map(([k,v]) => `${k}=${v}`).join('; '), ...extra };
      if (payload !== undefined) { headers['content-type'] = 'application/json'; headers.origin ||= baseUrl; if (csrf) headers['x-envoi-gateway-csrf'] = csrf; }
      const r = await fetch(baseUrl + route, { method: payload === undefined ? 'GET' : 'POST', headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
      jar.capture(r); const text = await r.text(); let value; try { value = JSON.parse(text); } catch { value = null; }
      return { status: r.status, headers: r.headers, text, payload: value };
    }
    const who = await owner(baseUrl, backend.name === 'FileStore' ? '9701' : '9702');
    const discovery = await request('/api/onboarding/routes?contract=provider-browser-poll-v1'); assert.equal(discovery.payload.gatewayAvailable, true);
    matches('capabilities',discovery.payload);
    const legacy = await request('/api/onboarding/routes'); assert.equal(legacy.payload.deliveryModes.find(x=>x.deliveryMode==='poll').available, false);
    const shell = await request('/agent-gateway/connect'); assert.equal(shell.status, 200, shell.text);
    assert.match(shell.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Strict/);
    const csrf = shell.text.match(/name="csrf" content="([^"]+)"/)[1];
    const attempt = await request('/api/agent-gateway/pairings', { requestedName: 'Browser agent', requestedPermissions: ['receive_agent_messages'], runtime: { type: 'muse', version: null } }, csrf);
    assert.equal(attempt.status, 200, attempt.text); assert.doesNotMatch(attempt.text, /envoi_reg_|agentRefreshToken|agentApiToken/);
    const found = await lookup(baseUrl, who, attempt.payload.verificationCode); assert.equal(found.status, 200, found.text);
    const registrationId = found.payload.registrationId;
    const approved = await approveRequest(baseUrl, who, registrationId, approveBody(attempt.payload.verificationCode, newAgentTarget(who, `gw-${Date.now().toString(36)}`), ['receive_agent_messages']));
    assert.equal(approved.status, 200, approved.text);
    const premature = await request('/api/agent-gateway/pairing/activate', { operationId: attempt.payload.operationId }, csrf); assert.equal(premature.status, 409);
    const confirmed = await api(baseUrl, '/api/agent-gateway/owner-confirm', { session: who.session, headers: { 'x-envoi-gateway-csrf': decodeURIComponent(who.session.cookies.get('envoi_csrf')) }, body: { verificationCode: attempt.payload.verificationCode, comparisonPhrase: attempt.payload.comparisonPhrase } });
    assert.equal(confirmed.status, 200, confirmed.text);
    const connected = await request('/api/agent-gateway/pairing/activate', { operationId: attempt.payload.operationId }, csrf); assert.equal(connected.status, 200, connected.text);
    assert.ok(jar.cookies.has('__Host-envoi_agent_gateway')); assert.ok(!jar.cookies.has('__Host-envoi_agent_pair'));
    const session = connected.payload, newCsrf = session.csrf;
    const docs = documents(t, backend, server), registration = await docs.get(['auth','agent-registrations',`${registrationId}.json`]);
    const agentParts = ['inboxes',registration.agentInboxId,'agents',`${registration.agentId}.json`];
    const sent = await send(baseUrl, who, { agent: { address: session.agentAddress } }, { text: 'A real canonical pending item' });
    assert.equal(sent.status, 202, sent.text);
    const messageParts = ['inboxes',registration.agentInboxId,'messages',`${sent.payload.id}.json`];
    for (let i = 0; i < 80 && (await docs.get(messageParts))?.status !== 'delivered'; i++) await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal((await docs.get(messageParts))?.status,'delivered');
    const noToken = await request('/api/agent/status'); assert.equal(noToken.status, 401, 'delegated cookie cannot authenticate raw agent API');
    assert.equal((await request('/api/agent-gateway/check', { runId:'run1' })).status, 403);
    assert.equal((await request('/api/agent-gateway/check', { runId:'run1' }, newCsrf, { origin:'https://attacker.invalid' })).status, 403);
    assert.equal((await request('/api/agent-gateway/send', {}, newCsrf)).status, 403);
    const checked = await request('/api/agent-gateway/check', { runId:'run1' }, newCsrf); assert.equal(checked.status, 200, checked.text); assert.equal(checked.payload.items.length, 1, checked.text);
    matches('checkResult',checked.payload);
    assert.equal(checked.payload.items[0].summary, 'A real canonical pending item');
    const ack = await request('/api/agent-gateway/notifications/ack', { runId:'run1', notificationRefs:[checked.payload.items[0].notificationRef] }, newCsrf);
    assert.equal(ack.status,200,ack.text);
    assert.equal((await docs.get(messageParts)).status,'delivered','notification ack does not acknowledge/process canonical message');
    assert.equal(checked.headers.get('cache-control'), 'private, no-store'); assert.equal(checked.headers.get('access-control-allow-origin'), null);
    await docs.edit(agentParts, a => ({ ...a, status:'paused' }));
    assert.equal((await request('/api/agent-gateway/check', { runId:'run1' }, newCsrf)).payload.code, 'AGENT_PAUSED');
    await docs.edit(agentParts, a => ({ ...a, status:'active' }));
    await docs.edit(['auth','agent-credential-families',registration.agentInboxId,registration.agentId,`${registration.credentialFamilyId}.json`], f => ({ ...f, revokedAt:new Date().toISOString() }));
    assert.equal((await request('/api/agent-gateway/session')).payload.code, 'CREDENTIAL_REVOKED');
  });
}
