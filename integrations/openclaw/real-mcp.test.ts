import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { describe, expect, it } from 'vitest';
import { enrollConnector, SinaloaConnector } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { BrowserSession } from '../../test/browser-session.js';
import { startOpenClawMcpRelay } from './mcp-relay';

type Session = InstanceType<typeof BrowserSession>;
type Relay = Awaited<ReturnType<typeof startOpenClawMcpRelay>>;
const relaySecret = 'integration-relay-secret-at-least-32-characters';

async function startSinaloa(dataDir: string): Promise<{ baseUrl: string; child: ChildProcess }> {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0', SINALOA_AUTH_MODE: 'development', SINALOA_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local Sinaloa MCP server start timed out')), 15_000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Local Sinaloa server exited with ${code}`)); });
    child.stdout?.on('data', chunk => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  return { baseUrl, child };
}

async function api(baseUrl: string, pathname: string, options: { session?: Session; body?: unknown } = {}) {
  const method = options.body === undefined ? 'GET' : 'POST';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.session?.headers(baseUrl, method) || {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  options.session?.capture(response);
  return { status: response.status, payload: await response.json() as Record<string, any> };
}

async function owner(baseUrl: string, suffix: string, store: FileBridgeStore) {
  const session = new BrowserSession();
  const started = await api(baseUrl, '/api/auth/phone/start', { session,
    body: { phoneNumber: `+14165550${suffix}`, displayName: `Owner ${suffix}` } });
  expect(started.status).toBe(201);
  const verified = await api(baseUrl, '/api/auth/phone/verify', { session,
    body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  expect(verified.status).toBe(200);
  const setup = await api(baseUrl, '/api/auth/totp/setup', { session, body: {} });
  expect(setup.status).toBe(201);
  const mfa = await api(baseUrl, '/api/auth/totp/verify', { session,
    body: { code: generateSync({ secret: setup.payload.secret }) } });
  expect(mfa.status).toBe(200);
  const workspace = await api(baseUrl, '/api/inboxes', { session, body: { name: `Relay workspace ${suffix}` } });
  expect(workspace.status).toBe(201);
  const enrollment = await api(baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, {
    session, body: { permissions: ['send_agent_messages', 'receive_agent_messages'] }
  });
  expect(enrollment.status).toBe(201);
  const enrolled = await enrollConnector(baseUrl, enrollment.payload.enrollmentToken, store, { name: `Relay agent ${suffix}` });
  return { session, inboxId: enrolled.inboxId, agentId: enrolled.agentId, address: enrolled.address };
}

async function call(relay: Relay, name: string, args: Record<string, unknown> = {}, token = relaySecret) {
  const response = await fetch(relay.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  });
  const payload = await response.json() as Record<string, any>;
  const value = payload.result?.content?.[0]?.text ? JSON.parse(payload.result.content[0].text) : null;
  return { status: response.status, payload, value };
}

describe('OpenClaw relay against the real Sinaloa MCP handler', () => {
  it('enrolls two owners, sends typed cases idempotently across restart, and denies revoked access', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sinaloa-relay-real-mcp-'));
    let app: Awaited<ReturnType<typeof startSinaloa>> | null = null;
    let aliceRelay: Relay | null = null;
    let bobRelay: Relay | null = null;
    try {
      app = await startSinaloa(path.join(root, 'server'));
      const aliceStore = new FileBridgeStore(path.join(root, 'alice'));
      const bobStore = new FileBridgeStore(path.join(root, 'bob'));
      await Promise.all([aliceStore.init(), bobStore.init()]);
      const alice = await owner(app.baseUrl, '7101', aliceStore);
      const bob = await owner(app.baseUrl, '7102', bobStore);
      aliceRelay = await startOpenClawMcpRelay({ connector: new SinaloaConnector(app.baseUrl, aliceStore),
        bearerToken: relaySecret, port: 0, allowCollaborationWrites: true });
      bobRelay = await startOpenClawMcpRelay({ connector: new SinaloaConnector(app.baseUrl, bobStore),
        bearerToken: relaySecret, port: 0, allowCollaborationWrites: true });

      const firstArgs = { recipientAddress: bob.address, text: 'Case one', idempotencyKey: 'relay-case-one' };
      const first = await call(aliceRelay, 'sinaloa_start_case', firstArgs);
      expect(first.status).toBe(200);
      expect(first.value.status).toBe(202);
      const firstReplay = await call(aliceRelay, 'sinaloa_start_case', firstArgs);
      expect(firstReplay.value.payload.id).toBe(first.value.payload.id);
      expect(firstReplay.value.payload.caseId).toBe(first.value.payload.caseId);
      const second = await call(aliceRelay, 'sinaloa_start_case', {
        recipientAddress: bob.address, text: 'Case two', idempotencyKey: 'relay-case-two'
      });
      expect(second.value.payload.caseId).not.toBe(first.value.payload.caseId);

      const message = await call(aliceRelay, 'sinaloa_send_message', { recipientAddress: bob.address,
        caseId: first.value.payload.caseId, text: 'A typed follow-up', intent: 'clarify', idempotencyKey: 'relay-follow-up' });
      expect(message.value.payload.intent).toBe('clarify');
      const proposalArgs = { recipientAddress: bob.address, caseId: first.value.payload.caseId,
        text: 'Propose answer 42', proposal: { answer: 42 }, idempotencyKey: 'relay-proposal' };
      const proposal = await call(aliceRelay, 'sinaloa_send_proposal', proposalArgs);
      expect(proposal.value.payload.payload.proposal).toEqual({ answer: 42 });
      const decision = await call(bobRelay, 'sinaloa_send_decision', { recipientAddress: alice.address,
        caseId: first.value.payload.caseId, text: 'Accepted', decision: 'accept',
        proposalMessageId: proposal.value.payload.id, idempotencyKey: 'relay-decision' });
      expect(decision.value.payload.payload.decision.proposalMessageId).toBe(proposal.value.payload.id);

      await aliceRelay.close();
      aliceRelay = null;
      const beforeRotation = await aliceStore.load();
      await aliceStore.save({ ...beforeRotation!, agentTokenExpiresAt: new Date(Date.now() - 1_000).toISOString() });
      aliceRelay = await startOpenClawMcpRelay({ connector: new SinaloaConnector(app.baseUrl, aliceStore),
        bearerToken: relaySecret, port: 0, allowCollaborationWrites: true });
      const replayAfterRestart = await call(aliceRelay, 'sinaloa_send_proposal', proposalArgs);
      expect(replayAfterRestart.value.payload.id).toBe(proposal.value.payload.id);
      expect((await aliceStore.load())?.agentRefreshToken).not.toBe(beforeRotation?.agentRefreshToken);
      const conflictingReplay = await call(aliceRelay, 'sinaloa_send_proposal', {
        ...proposalArgs, proposal: { answer: 'different' }
      });
      expect(conflictingReplay.value.status).toBe(409);

      const revoked = await api(app.baseUrl, `/api/inboxes/${alice.inboxId}/agents/${alice.agentId}/credentials/revoke`,
        { session: alice.session, body: {} });
      expect(revoked.status).toBe(200);
      const afterRevocation = await call(aliceRelay, 'sinaloa_send_message', { recipientAddress: bob.address,
        caseId: first.value.payload.caseId, text: 'Must not send', idempotencyKey: 'relay-revoked-send' });
      expect(afterRevocation.status).toBe(502);
      expect(JSON.stringify(afterRevocation.payload)).not.toContain('agentRefreshToken');
    } finally {
      await Promise.allSettled([aliceRelay?.close(), bobRelay?.close()]);
      if (app?.child && app.child.exitCode === null) {
        const child = app.child;
        await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM'); });
      }
      if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir())) throw new Error('Unsafe test cleanup path');
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
