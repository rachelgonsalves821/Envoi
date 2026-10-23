// agent-registration v1 revision 5 §14.7 "Evidence before any rollout": the source rollback. A release that predates agent-remote-auth
// runs over the records this server wrote, on FileStore and (in CI) PostgreSQL: its credential check refuses the oauth_ tokens,
// its owner views list the installation and the approval, its owner revoke ends the installation, and its registration cleanup
// deletes the registrations and leaves the code index and consent decision behind, which this server then sweeps as orphans.
// The rollback SHA is the integration head that predates every remote-auth change; ENVOI_ROLLBACK_SHA overrides it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, unlink, symlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, assertTokenResponse, backends, connect, documents, exchange, familyParts, installationView, openStore, freshOwner, publicClient, refreshParams, registrationParts, remoteServer, stored, tokenPost } from './agent-remote-auth-token-harness.js';
import { createAgentSlots } from '../src/agent-approval.js';
import { createAgentRegistrations, sha256Hex } from '../src/agent-registration.js';
import { verificationCodeKey } from '../src/agent-registration-codes.js';
import { createPollLimiter, createRegistrationLimits } from '../src/agent-registration-limits.js';
import { createInstallationReader } from '../src/agent-installations.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
export const rollbackSha = process.env.ENVOI_ROLLBACK_SHA || '2312734c4e93c533d3e457929d0afc67b62fc130';
const git = (...args) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

// The rollback release, as a detached worktree whose dependencies are this checkout's own.
async function rollbackCheckout(t) {
  if (git('cat-file', '-e', `${rollbackSha}^{commit}`).status !== 0) {
    const fetched = git('fetch', '--depth', '1', 'origin', rollbackSha);
    assert.equal(fetched.status, 0, `the rollback SHA ${rollbackSha} must be available (git fetch origin ${rollbackSha}): ${fetched.stderr}`);
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'envoi-rollback-'));
  await rm(dir, { recursive: true, force: true });
  const added = git('worktree', 'add', '--detach', dir, rollbackSha);
  assert.equal(added.status, 0, `worktree add: ${added.stderr}`);
  const link = path.join(dir, 'node_modules');
  await symlink(path.join(repoRoot, 'node_modules'), link, 'junction');
  t.after(async () => {
    // Remove the link itself first: removing a worktree must never follow it into this checkout's dependencies.
    await unlink(link).catch(() => rmdir(link).catch(() => {}));
    git('worktree', 'remove', '--force', dir);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

// The rollback server, on the new server's port and data, with no remote flag (it has none).
async function launchRollback(t, root, server) {
  const env = { ...process.env, ...server.backend.env, DATABASE_URL: server.backend.env.DATABASE_URL || '', ENVOI_PORT: String(server.port), ENVOI_AUTH_MODE: 'development', ENVOI_DATA_DIR: server.dataDir, ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true', ENVOI_PUBLIC_URL: server.origin };
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rollback server start timed out: ${stderr}`)), 20000);
    child.once('exit', code => reject(new Error(`rollback server exited ${code}: ${stderr}`)));
    child.stdout.on('data', chunk => { if (/listening on/.test(chunk.toString())) { clearTimeout(timer); resolve(); } });
  });
  // A child killed by a signal has exitCode null but a signalCode, and its 'exit' has already fired: stopping twice must not wait for it.
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }); };
  t.after(stop);
  return { baseUrl: server.baseUrl, stop, get stderr() { return stderr; } };
}

for (const backend of backends) {
  test(`[${backend.name}] source rollback: the release before agent-remote-auth refuses the tokens, lists and revokes the installation, and its cleanup leaves orphans this server sweeps`, { timeout: 300000 }, async t => {
    const root = await rollbackCheckout(t);
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);
    const live = async () => {
      const who = await freshOwner(server);
      const grant = await connect(server, who);
      const tokens = assertTokenResponse(await exchange(server, grant));
      const { registration } = await stored(docs, grant.registrationId);
      return { who, grant, tokens, registration };
    };
    const first = await live();
    const rotated = assertTokenResponse(await tokenPost(server, refreshParams(publicClient, first.tokens.refresh_token)));
    const second = await live();
    const pendingWho = await freshOwner(server);
    const pending = await connect(server, pendingWho);
    const all = [
      { registrationId: first.grant.registrationId, code: first.grant.code, handle: first.grant.handle },
      { registrationId: second.grant.registrationId, code: second.grant.code, handle: second.grant.handle },
      { registrationId: pending.registrationId, code: pending.code, handle: pending.handle }
    ];

    await server.stop(true);
    const old = await launchRollback(t, root, server);
    const stoppedServer = server;

    // The rollback server's credential check refuses oauth_ tokens everywhere, and revokes nothing by trying.
    for (const token of [first.tokens.access_token, rotated.access_token]) {
      assert.equal((await api(old.baseUrl, '/api/agent/status', { token })).status, 401);
      assert.equal((await api(old.baseUrl, '/mcp', { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { accept: 'application/json, text/event-stream' } })).status, 401);
      assert.equal((await api(old.baseUrl, `/api/inboxes/${first.registration.agentInboxId}/messages`, { token })).status, 401);
    }
    const atRefresh = await api(old.baseUrl, '/api/agent-token', { body: { agentRefreshToken: rotated.refresh_token, rotationId: 'rotation-id-for-test' } });
    assert.equal(atRefresh.status, 401);
    assert.equal(atRefresh.payload.code, 'REFRESH_TOKEN_INVALID');
    assert.equal((await docs.get(familyParts(first.registration.agentInboxId, first.registration.agentId, first.registration.credentialFamilyId))).revokedAt, null, 'trying revoked nothing');

    // Owner views come from the same documents: the installation, and the approvals.
    const viewed = await installationView(old, first.who, first.registration);
    assert.deepEqual([viewed.status, viewed.connectionRoute, viewed.deliveryMode], ['active', 'remote_mcp_oauth', 'on_demand']);
    const claims = await api(old.baseUrl, '/api/agent-claims', { session: pendingWho.session });
    assert.ok(claims.payload.claims.some(item => item.registrationId === pending.registrationId && item.status === 'approved'), 'the unexchanged approval is listed');
    // The owner's revoke ends the installation as revoked, at the family's revokedAt.
    const revoke = await api(old.baseUrl, `/api/inboxes/${second.registration.agentInboxId}/agents/${second.registration.agentId}/installations/${second.registration.installationId}/revoke`, { session: second.who.session, body: {} });
    assert.equal(revoke.status, 200, revoke.text);
    const ended = await installationView(old, second.who, second.registration);
    const family = await docs.get(familyParts(second.registration.agentInboxId, second.registration.agentId, second.registration.credentialFamilyId));
    assert.deepEqual([ended.status, ended.endedReason, ended.endedAt], ['ended', 'revoked', family.revokedAt]);
    assert.equal(family.audience, stoppedServer.resource, 'the rollback server kept the fields it does not know');
    await old.stop();

    // The rollback release's registration cleanup, run over these records a day on, deletes the registrations and leaves
    // their code index and consent decision behind.
    // Run by the rollback release's own code in its own process, over the same data.
    const later = new Date(Date.now() + 26 * 3_600_000);
    const script = `
      import { FileStore } from './src/storage.js';
      import { PostgresStore } from './src/postgres-storage.js';
      import { createAgentRegistrations } from './src/agent-registration.js';
      const store = process.env.DATABASE_URL ? new PostgresStore(process.env.DATABASE_URL) : new FileStore(process.env.ENVOI_DATA_DIR);
      await store.init();
      const noop = async () => {};
      const registrations = createAgentRegistrations({
        store, flags: { registration: true, installations: true }, codeKey: Buffer.from('rollback-key'), limits: {}, pollLimiter: {}, agentSlots: {}, installations: {},
        withInboxMutation: noop, canManageLive: noop, normalizeLocalPart: value => value, addressForLocalPart: value => value, identityTaken: noop, semanticDigest: value => value
      });
      console.log(JSON.stringify({ deleted: await registrations.cleanup(new Date(Number(process.env.CLEANUP_AT))) }));
      await store.close?.();
    `;
    const cleaned = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, encoding: 'utf8', env: { ...process.env, DATABASE_URL: stoppedServer.backend.env.DATABASE_URL || '', ENVOI_DATA_DIR: stoppedServer.dataDir, CLEANUP_AT: String(later.getTime()) }
    });
    assert.equal(cleaned.status, 0, cleaned.stderr);
    const lines = cleaned.stdout.trim().split(String.fromCharCode(10));
    assert.ok(JSON.parse(lines.at(-1)).deleted >= 3, 'the three registrations are deleted');
    const noop = async () => {};
    const store = await openStore(t, stoppedServer);
    for (const item of all) {
      assert.equal(await docs.get(registrationParts(item.registrationId)), null, 'the registration is deleted');
      assert.ok(await docs.get(['auth', 'oauth-codes', `${sha256Hex(item.code)}.json`]), 'the code index is left behind');
      assert.ok(await docs.get(['auth', 'oauth-consent-decisions', `${sha256Hex(item.handle)}.json`]), 'and so is the consent decision');
    }
    // This release treats them as orphans (§14.6) and sweeps them.
    const newer = createAgentRegistrations({
      store, flags: { registration: true, installations: true }, codeKey: verificationCodeKey(Buffer.from('rollback-key')), limits: createRegistrationLimits({ store }), pollLimiter: createPollLimiter(), agentSlots: createAgentSlots({ store }),
      installations: createInstallationReader({ store, agentCredentialFamilyPath: (inboxId, agentId, familyId) => path.join('auth', 'agent-credential-families', inboxId, agentId, `${familyId}.json`) }),
      withInboxMutation: noop, canManageLive: noop, normalizeLocalPart: value => value, addressForLocalPart: value => value, identityTaken: noop, semanticDigest: value => value, log: () => {}
    });
    // The sweep is bounded per run and resumes from its cursor (registration §14.6; RA-A1 part 2 backfill). On PostgreSQL the
    // shared test database can hold a cursor an earlier test file left part-way through a backfill, so run it until this
    // test's six records are gone: deterministic, no waiting, at most 20 bounded runs.
    const remaining = async () => (await Promise.all(all.flatMap(item => [
      docs.get(['auth', 'oauth-codes', `${sha256Hex(item.code)}.json`]), docs.get(['auth', 'oauth-consent-decisions', `${sha256Hex(item.handle)}.json`])
    ]))).filter(Boolean).length;
    let swept = 0;
    for (let run = 0; run < 20 && await remaining() > 0; run += 1) swept += await newer.sweepOAuthCleanup(later);
    assert.equal(await remaining(), 0, 'both children of every registration are swept');
    assert.ok(swept >= 6, 'by this release, not by anything else');
    for (const item of all) {
      assert.equal(await docs.get(['auth', 'oauth-codes', `${sha256Hex(item.code)}.json`]), null);
      assert.equal(await docs.get(['auth', 'oauth-consent-decisions', `${sha256Hex(item.handle)}.json`]), null);
    }
  });
}
