// agent-registration v1 revision 5 §14.7: the owner revoke on OAuth stored state, through the real route, in both
// rollback contexts of the fixtures stored-oauth-flags-off and stored-oauth-source-rollback.
// The fixture's stored records are seeded onto a real enrolled agent (ids remapped), then the existing revoke route
// runs. Before the revoke, OAuth tokens are refused everywhere; after it, the installation is ended/revoked at the
// family's revokedAt, and the family keeps its audience and client.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessCredentialParts, api, editData, familyPartsForToken, launch, owner, readData, refreshCredentialParts, writeData } from './a3-harness.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures', 'agent-registration');
const load = async name => JSON.parse(await readFile(path.join(fixtureDir, `${name}.json`), 'utf8'));
const future = days => new Date(Date.now() + days * 86_400_000).toISOString();

for (const [name, suffix] of [['stored-oauth-flags-off', '81'], ['stored-oauth-source-rollback', '82']]) {
  test(`${name}: the real owner revoke ends the OAuth installation, and OAuth tokens stay refused`, async t => {
    const fixture = await load(name);
    const env = Object.fromEntries(Object.entries(fixture.flags).map(([flag, on]) => [flag, String(on)]));
    const server = await launch(env); t.after(() => server.stop());
    const { baseUrl } = server;
    const who = await owner(baseUrl, `${suffix}00`);

    // Seed the fixture's OAuth family and installation on this agent. Its enrollment family is replaced, as the
    // OAuth exchange (existing_agent) would have done.
    const legacyParts = await familyPartsForToken(server, who.agentApiToken);
    const legacy = await readData(server, ...legacyParts);
    const replacedAt = new Date(Date.now() - 60_000).toISOString();
    await editData(server, legacyParts, value => ({ ...value, revokedAt: replacedAt, revokedReason: 'replaced' }));
    const [seedFamily] = fixture.stored.credentialFamilies;
    const [seedInstallation] = fixture.stored.installations;
    const family = { ...seedFamily, agentId: who.agent.id, inboxId: legacy.inboxId, createdAt: new Date(Date.now() - 30_000).toISOString(), refreshExpiresAt: future(30) };
    const installation = { ...seedInstallation, agentId: who.agent.id, createdAt: family.createdAt, activatedAt: family.createdAt };
    await writeData(server, ['auth', 'agent-credential-families', family.inboxId, family.agentId, `${family.id}.json`], family);
    await writeData(server, ['auth', 'agent-installations', family.inboxId, family.agentId, `${installation.id}.json`], installation);
    const raw = { access: `envoi_agent_access_${crypto.randomBytes(32).toString('base64url')}`, refresh: `envoi_agent_refresh_${crypto.randomBytes(48).toString('base64url')}` };
    const tokenRecord = (tokenType, expiresAt) => ({ tokenType, agentId: family.agentId, inboxId: family.inboxId, familyId: family.id, issuedAt: family.createdAt, expiresAt, usedAt: null, revokedAt: null });
    await writeData(server, accessCredentialParts(raw.access), tokenRecord('oauth_access', future(1 / 96)));
    await writeData(server, refreshCredentialParts(raw.refresh), tokenRecord('oauth_refresh', family.refreshExpiresAt));

    // Before the revoke: refused on REST, at /mcp and at the A1 refresh route, and nothing is revoked by trying.
    const status = await api(baseUrl, '/api/agent/status', { token: raw.access });
    assert.equal(status.status, 401, status.text); assert.equal(status.payload.code, 'AUTHENTICATION_REQUIRED');
    const mcp = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${raw.access}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(mcp.status, 401, 'refused at /mcp by this server');
    const refreshed = await api(baseUrl, '/api/agent-token', { body: { refreshToken: raw.refresh, rotationId: `rotation_${crypto.randomBytes(8).toString('hex')}` } });
    assert.equal(refreshed.status, 401, refreshed.text); assert.equal(refreshed.payload.code, 'REFRESH_TOKEN_INVALID');
    assert.deepEqual(await readData(server, 'auth', 'agent-credential-families', family.inboxId, family.agentId, `${family.id}.json`), family, 'trying the OAuth tokens revoked and changed nothing');

    // The listing matches the fixture's listing before the revoke, with ids remapped.
    const listPath = `/api/inboxes/${who.inbox.id}/agents/${who.agent.id}/installations`;
    const fixtureList = fixture.steps.filter(step => step.response.schema === 'ownerInstallationList');
    const before = await api(baseUrl, listPath, { session: who.session });
    assert.equal(before.status, 200, before.text);
    const oauthBefore = before.payload.installations.find(entry => entry.id === installation.id);
    assert.deepEqual({ ...oauthBefore, agentId: 'agent_example', createdAt: seedInstallation.createdAt, activatedAt: seedInstallation.activatedAt }, fixtureList[0].response.body.installations[0], 'the OAuth installation is listed as the fixture says');

    // The real revoke mutation.
    const revoked = await api(baseUrl, `${listPath}/${installation.id}/revoke`, { session: who.session, body: {} });
    assert.equal(revoked.status, 200, revoked.text);
    const after = await readData(server, 'auth', 'agent-credential-families', family.inboxId, family.agentId, `${family.id}.json`);
    assert.deepEqual([revoked.payload.installation.status, revoked.payload.installation.endedReason, revoked.payload.installation.endedAt], ['ended', 'revoked', after.revokedAt], 'ended/revoked at the family revokedAt');
    const changed = Object.keys({ ...family, ...after }).filter(key => JSON.stringify(family[key]) !== JSON.stringify(after[key])).sort();
    assert.deepEqual(changed.filter(key => key !== 'updatedAt'), ['revokedAt', 'revokedByHumanId', 'revokedReason'], 'the revoke changes only revokedAt, revokedByHumanId and revokedReason (as the fixture storedAfter)');
    assert.equal(after.revokedByHumanId, who.human.id, 'the revoking owner is recorded');
    const fixtureAfter = fixture.steps.find(step => step.storedAfter).storedAfter.credentialFamilies[0];
    assert.deepEqual(Object.keys(fixtureAfter).filter(key => JSON.stringify(fixtureAfter[key]) !== JSON.stringify(seedFamily[key])).sort(), ['revokedAt', 'revokedByHumanId', 'revokedReason'], 'the fixture records the same changed fields');
    assert.equal(after.revokedReason, 'revoked');
    assert.deepEqual([after.audience, after.oauthClientId], [seedFamily.audience, seedFamily.oauthClientId], 'audience and client stay on the revoked family');
    const fixtureRevoke = fixture.steps.find(step => step.response.schema === 'installationRevoked');
    assert.deepEqual(Object.keys(revoked.payload.installation).sort(), Object.keys(fixtureRevoke.response.body.installation).sort(), 'the response has the fixture shape');
    const listedAfter = await api(baseUrl, listPath, { session: who.session });
    const oauthAfter = listedAfter.payload.installations.find(entry => entry.id === installation.id);
    assert.deepEqual([oauthAfter.status, oauthAfter.endedReason, oauthAfter.endedAt], ['ended', 'revoked', after.revokedAt], 'listed ended/revoked after the revoke');
    assert.equal((await api(baseUrl, '/api/agent/status', { token: raw.access })).status, 401, 'still refused after the revoke');
    for (const secret of [raw.access, raw.refresh]) assert.ok(!(server.stdout + server.stderr).includes(secret), 'no token in the logs');
  });
}
