import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { expect, it } from 'vitest';
import { launch, api, eventually } from '../../../test/a3-harness.js';
import { register, approveBody, approveRequest } from '../../../test/agent-registration-harness.js';
import { BrowserSession } from '../../../test/browser-session.js';
import { EnvoiConnector } from '../../../sdk/typescript/src/connector';
import { CaseToolsClient } from '../../../sdk/typescript/src/case-tools';
import { FileBridgeStore } from '../../agent-bridges/file-store';
import { adoptActivatedConnection, startConnection } from '../../connector/core';
import type { ConnectorAdapter } from '../../connector/adapter';
import { runLocalLink } from '../cli';

// Real local Envoi HTTP/persistence/control/claims/case tools, inert host adapters, no models or hosted traffic.
it('onboards two independent owners and initiates a task in each direction through their running scoped connectors', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'envoi-task-rehearsal-'));
  const app = await launch({ ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true', ENVOI_CASE_SESSIONS_V1: 'true' });
  const stop = new AbortController();
  const running: Promise<void>[] = [];
  const handled: string[] = [];
  const secureDirectory = async (directory: string) => { await mkdir(directory, { recursive: true }); return path.resolve(directory); };
  try {
    async function connect(suffix: string, runtime: 'hermes' | 'openclaw') {
      const browser = new BrowserSession();
      const phone = await api(app.baseUrl, '/api/auth/phone/start', { session: browser, body: { phoneNumber: `+14165550${suffix}`, displayName: `Demo owner ${suffix}` } });
      const human = await api(app.baseUrl, '/api/auth/phone/verify', { session: browser, body: { challengeId: phone.payload.challengeId, code: phone.payload.developmentCode } });
      expect(human.status).toBe(200);
      const setup = await api(app.baseUrl, '/api/auth/totp/setup', { session: browser, body: {} });
      expect((await api(app.baseUrl, '/api/auth/totp/verify', { session: browser, body: { code: generateSync({ secret: setup.payload.secret }) } })).status).toBe(200);
      const workspace = await api(app.baseUrl, '/api/inboxes', { session: browser, body: { name: `Demo workspace ${suffix}` } });
      expect(workspace.status).toBe(201);
      const registered = await register(app.baseUrl, { runtime: { type: runtime, version: 'synthetic' } });
      expect(registered.status).toBe(201);
      const permissions = ['receive_agent_messages', 'send_agent_messages', 'execute_cases'];
      // An actual browser owner approves the exact registration; confirmation is synthetic in this automated test.
      const claim = await approveRequest(app.baseUrl, { session: browser }, registered.payload.registrationId,
        approveBody(registered.payload.claim.verificationCode, { kind: 'new_agent', workspaceInboxId: workspace.payload.id,
          name: `Demo ${runtime}`, localPart: `demo-${suffix}` }, permissions));
      expect(claim.status, claim.text).toBe(200);
      const activationId = `activation_${randomUUID()}`;
      const activation = await api(app.baseUrl, '/api/agent-installations/activate', { token: registered.payload.bootstrapToken,
        body: { registrationId: registered.payload.registrationId, activationId, deliveryMode: 'envoi_link' } });
      expect(activation.status, activation.text).toBe(201);
      const stateDir = path.join(root, runtime);
      const adapter: ConnectorAdapter<any> = { runtime, discover: async () => ({}), preflight: async () => {},
        describe: () => ({ runtime }), async createBridge(_config, context) {
          const connector = new EnvoiConnector(context.apiUrl, new FileBridgeStore(context.stateDir), { fetch: context.fetch,
            caseSessionHandler: { admit: async () => {}, process: async channel => {
              const tools = new CaseToolsClient(channel);
              const snapshot = await tools.snapshot();
              const incoming = snapshot.requestedResponse;
              if (incoming?.intent === 'request') {
                handled.push(incoming.text);
                await tools.reply({ text: `Confirmed: ${incoming.text}`, idempotencyKey: `reply-${incoming.ref}` });
              }
            } } });
          return { connector, close: async () => {}, verify: async () => {} };
        } };
      const resolver = () => adapter;
      await adoptActivatedConnection(app.baseUrl, runtime, activation.payload, resolver, { stateDir, completionId: activationId, secureDirectory });
      await new Promise<void>((resolve, reject) => {
        const operation = startConnection(stateDir, stop.signal, resolver, { secureDirectory, onReady: resolve });
        running.push(operation); void operation.catch(reject);
      });
      return { browser, stateDir, runtime, activation: activation.payload, workspace: workspace.payload };
    }
    const alice = await connect('7611', 'hermes');
    const rachel = await connect('7612', 'openclaw');
    const writes: Record<string, any>[] = [];
    for (const [sender, recipient, text] of [[alice, rachel, 'Please send two meeting times.'], [rachel, alice, 'Please review the agenda.']] as const) {
      const request = { requestId: randomUUID(), recipientAddress: recipient.activation.agent.address, text };
      const args = ['task', app.baseUrl, '--runtime', sender.runtime];
      const options = { stateDir: sender.stateDir, taskPrompt: async () => request, write: (value: Record<string, any>) => writes.push(value) };
      expect(await runLocalLink(args, stop.signal, options)).toMatchObject({ state: 'accepted', replayed: false });
      const view = await eventually(async () => {
        const own = await api(app.baseUrl, `/api/inboxes/${sender.activation.inboxId}/human-view`, { session: sender.browser });
        return own.payload?.messages?.some((m: any) => m.text === `Confirmed: ${text}` && m.status === 'processed') ? own.payload : null;
      }, { timeoutMs: 12_000 });
      expect(view.messages.filter((m: any) => m.text === text)).toHaveLength(1);
      expect(view.messages.filter((m: any) => m.text === `Confirmed: ${text}`)).toHaveLength(1);
      expect(await runLocalLink([...args, '--retry', request.requestId], stop.signal, options)).toMatchObject({ replayed: true });
      const peerView = await api(app.baseUrl, `/api/inboxes/${recipient.activation.inboxId}/human-view`, { session: recipient.browser });
      expect(peerView.payload.messages.some((m: any) => m.text === text && m.status === 'processed')).toBe(true);
      const cross = await api(app.baseUrl, `/api/inboxes/${recipient.activation.inboxId}/human-view`, { session: sender.browser });
      expect([401, 403]).toContain(cross.status);
    }
    expect(handled).toHaveLength(2);
    expect(JSON.stringify(writes)).not.toMatch(/agentApiToken|agentRefreshToken|leaseToken|bootstrapToken|case_|msg_/);
    // A remote owner pause is still authoritative for the host-only initiation path.
    expect((await api(app.baseUrl, `/api/inboxes/${alice.activation.inboxId}/agents/${alice.activation.agent.id}/pause`, { session: alice.browser, body: {} })).status).toBe(200);
    const denied = await runLocalLink(['task', app.baseUrl, '--runtime', alice.runtime], stop.signal,
      { stateDir: alice.stateDir, taskPrompt: async () => ({ requestId: randomUUID(), recipientAddress: rachel.activation.agent.address, text: 'Must not be sent' }) }).catch(() => ({ state: 'needs_help' }));
    expect(denied.state).toBe('needs_help');
    const messages = await api(app.baseUrl, `/api/inboxes/${rachel.activation.inboxId}/human-view`, { session: rachel.browser });
    expect(messages.payload.messages.some((m: any) => m.text === 'Must not be sent')).toBe(false);
  } finally {
    stop.abort(); await Promise.allSettled(running); await app.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
