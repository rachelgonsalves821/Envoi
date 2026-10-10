import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { describe, expect, it, vi } from 'vitest';
import { enrollConnector, EnvoiConnector, type WorkMessage } from '../../sdk/typescript/src/connector';
import { newCaseId } from '../../sdk/typescript/src/index';
import { BrowserSession } from '../../test/browser-session.js';
import { FileBridgeStore } from './file-store';
import { shareCaseAsset } from './asset-exchange';
import { loadAssetManifest, manifestAssetExchange } from './asset-manifest';
import { bridgeHandler, parseAgentReply, type BridgeDecision } from './bridge';

const serverEntry = process.env.SINALOA_P2_SERVER_ENTRY;
const test = serverEntry ? it : it.skip;

async function startServer(dataDir: string, scannerUrl: string): Promise<{ baseUrl: string; child: ChildProcess }> {
  const child = spawn(process.execPath, [serverEntry!], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: '', ENVOI_PORT: '0',
      ENVOI_AUTH_MODE: 'development', ENVOI_DATA_DIR: dataDir,
      ENVOI_MALWARE_SCANNER_URL: scannerUrl }, stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const baseUrl = await new Promise<string>((resolve, reject) => {
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-2_000); });
      const timer = setTimeout(() => reject(new Error('P2 server start timed out')), 15_000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`P2 server exited with ${code}: ${stderr}`)); });
      child.stdout?.on('data', chunk => {
        const match = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
      });
    });
    return { baseUrl, child };
  } catch (error) { child.kill('SIGTERM'); throw error; }
}

async function request(baseUrl: string, pathname: string, session: BrowserSession, body?: unknown) {
  const method = body === undefined ? 'GET' : 'POST';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...session.headers(baseUrl, method) }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  session.capture(response);
  return { status: response.status, payload: await response.json() as Record<string, any> };
}

async function humanAction(baseUrl: string, inboxId: string, caseId: string, session: BrowserSession,
  actionKey: 'pause' | 'resume') {
  const response = await fetch(`${baseUrl}/api/inboxes/${inboxId}/cases/${caseId}/actions`, {
    method: 'POST', headers: { ...session.headers(baseUrl, 'POST'), 'content-type': 'application/json',
      'Idempotency-Key': `test-${actionKey}-${caseId}` },
    body: JSON.stringify({ actionKey })
  });
  session.capture(response);
  return response;
}

async function owner(baseUrl: string, suffix: string, root: string, permissions: string[]) {
  const session = new BrowserSession();
  const started = await request(baseUrl, '/api/auth/phone/start', session,
    { phoneNumber: `+14165550${suffix}`, displayName: `P2 owner ${suffix}` });
  expect(started.status).toBe(201);
  expect((await request(baseUrl, '/api/auth/phone/verify', session,
    { challengeId: started.payload.challengeId, code: started.payload.developmentCode })).status).toBe(200);
  const setup = await request(baseUrl, '/api/auth/totp/setup', session, {});
  expect(setup.status).toBe(201);
  expect((await request(baseUrl, '/api/auth/totp/verify', session,
    { code: generateSync({ secret: setup.payload.secret }) })).status).toBe(200);
  const workspace = await request(baseUrl, '/api/inboxes', session, { name: `P2 inbox ${suffix}` });
  expect(workspace.status).toBe(201);
  const enrollment = await request(baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`,
    session, { permissions });
  expect(enrollment.status).toBe(201);
  const store = new FileBridgeStore(path.join(root, suffix));
  await store.init();
  const enrolled = await enrollConnector(baseUrl, enrollment.payload.enrollmentToken, store,
    { name: `P2 agent ${suffix}` });
  return { ...enrolled, session, connector: new EnvoiConnector(baseUrl, store) };
}

describe('P2 clean case asset exchange against a real local server', () => {
  test('grants only the bound recipient a clean file and replays its grant safely', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'envoi-p2-client-'));
    let app: Awaited<ReturnType<typeof startServer>> | null = null;
    const scanner = http.createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume the uploaded bytes */ }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'clean', engine: 'test-scanner' }));
    });
    try {
      scanner.listen(0, '127.0.0.1');
      await once(scanner, 'listening');
      const address = scanner.address();
      if (!address || typeof address === 'string') throw new Error('Test scanner address unavailable');
      app = await startServer(path.join(root, 'server'), `http://127.0.0.1:${address.port}/scan`);
      const alice = await owner(app.baseUrl, '8101', root,
        ['send_agent_messages', 'receive_agent_messages', 'create_assets', 'execute_cases']);
      const bob = await owner(app.baseUrl, '8102', root,
        ['send_agent_messages', 'receive_agent_messages']);
      const stranger = await owner(app.baseUrl, '8103', root,
        ['send_agent_messages', 'receive_agent_messages']);
      const caseId = newCaseId();
      await alice.connector.startCase('p2-case-start', { caseId,
        recipientEmail: bob.address, text: 'Please review the attached result' });
      const deadline = Date.now() + 10_000;
      while (!(await bob.connector.listCaseMessages(caseId)).some(message => message.status === 'delivered')) {
        if (Date.now() > deadline) throw new Error('Case start was not delivered before file exchange');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const offer = await bob.connector.sendCaseEvent('p1-offer-one', { caseId,
        recipientEmail: alice.address, intent: 'offer', text: 'I propose the clean result',
        payload: { proposal: { answer: 'clean result' } } });
      while (!(await alice.connector.getCase(caseId) as any).proposals?.some((item: any) => item.options?.some((option: any) => option.value.answer === 'clean result'))) {
        if (Date.now() > deadline) throw new Error('Typed offer was not delivered');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await alice.connector.sendCaseEvent('p1-accept-one', { caseId,
        recipientEmail: bob.address, intent: 'accept', text: 'Accepted',
        payload: { decision: { kind: 'accept', proposalMessageId: offer.id } } });
      while ((await bob.connector.getCase(caseId) as any).state !== 'waitingForHuman') {
        if (Date.now() > deadline) throw new Error('Typed decision was not delivered');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const aliceCase = await alice.connector.getCase(caseId) as any;
      const bobCase = await bob.connector.getCase(caseId) as any;
      expect(aliceCase).toEqual(bobCase);
      expect(aliceCase.proposals[0].status).toBe('accepted');
      expect(aliceCase.events.find((event: any) => event.type === 'decision')?.payload.data.decision.kind).toBe('accept');
      await expect(stranger.connector.sendCaseEvent('p1-inject-one', { caseId,
        recipientEmail: alice.address, text: 'Third-party injection' })).rejects.toMatchObject({ status: 403 });
      const secondCaseId = newCaseId();
      await alice.connector.startCase('p1-second-case', { caseId: secondCaseId,
        recipientEmail: bob.address, text: 'A separate active case' });
      while (!(await bob.connector.listCaseMessages(secondCaseId)).some(message => message.status === 'delivered')) {
        if (Date.now() > deadline) throw new Error('Second case was not delivered');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const bytes = new TextEncoder().encode('clean two-owner case evidence');
      const result = await shareCaseAsset({ connector: alice.connector, caseId,
        recipientAgentId: bob.agentId, recipientAddress: bob.address,
        filename: 'result.txt', mimeType: 'text/plain', bytes,
        idempotencyKey: 'p2-case-file-one', text: 'The clean file is ready' });
      expect(result.asset.state).toBe('clean');
      expect(result.grant.recipientAgentId).toBe(bob.agentId);
      expect(result.message.artifactRefs).toContain(result.asset.id);
      const replay = await alice.connector.grantCaseAsset(result.asset.id, caseId, bob.agentId, 'p2-case-file-one:grant');
      expect(replay.id).toBe(result.grant.id);
      const visible = await bob.connector.listAssets();
      expect(visible.some(asset => asset.id === result.asset.id)).toBe(true);
      const aliceView = await request(app.baseUrl, `/api/inboxes/${alice.inboxId}/human-view`, alice.session);
      const bobView = await request(app.baseUrl, `/api/inboxes/${bob.inboxId}/human-view`, bob.session);
      expect(aliceView.payload.assets.some((asset: { id: string }) => asset.id === result.asset.id)).toBe(true);
      expect(aliceView.payload.recentEvents.filter((event: { type: string; assetId?: string }) => event.type === 'asset.granted' && event.assetId === result.asset.id)).toHaveLength(1);
      expect(bobView.payload.assets.some((asset: { id: string }) => asset.id === result.asset.id)).toBe(true);
      expect(bobView.payload.history.assets.total).toBeGreaterThanOrEqual(1);
      const download = await bob.connector.getCleanAssetDownload(result.asset.id);
      const actual = await fetch(download.download.url, { headers: download.download.headers });
      expect(new Uint8Array(await actual.arrayBuffer())).toEqual(bytes);
      const blocked = await request(app.baseUrl, `/api/inboxes/${bob.inboxId}/contacts/${alice.agentId}/block`, bob.session, {});
      expect(blocked.status).toBe(200);
      expect(blocked.payload.blocked).toBe(true);
      expect((await bob.connector.listAssets()).some(asset => asset.id === result.asset.id)).toBe(false);
      await expect(bob.connector.getCleanAssetDownload(result.asset.id)).rejects.toMatchObject({ status: 403 });
      expect((await fetch(download.download.url, { headers: download.download.headers })).status).toBe(403);
      expect((await alice.connector.getCase(caseId) as any).state).toBe('waitingForHuman');
      await expect(alice.connector.sendCaseEvent('p3-blocked-send', { caseId,
        recipientEmail: bob.address, text: 'This must be blocked' })).rejects.toMatchObject({ status: 403 });
      const unblocked = await request(app.baseUrl, `/api/inboxes/${bob.inboxId}/contacts/${alice.agentId}/unblock`, bob.session, {});
      expect(unblocked.status).toBe(200);
      expect((await alice.connector.getCase(caseId) as any).proposals[0].status).toBe('accepted');
      expect((await bob.connector.listAssets()).some(asset => asset.id === result.asset.id)).toBe(true);
      expect((await humanAction(app.baseUrl, alice.inboxId, caseId, alice.session, 'pause')).status).toBe(201);
      const pausedView = await request(app.baseUrl, `/api/inboxes/${bob.inboxId}/human-view`, bob.session);
      expect(pausedView.payload.cases.find((item: { id: string }) => item.id === caseId).state).toBe('paused');
      expect((await bob.connector.getCase(caseId) as any).state).toBe('paused');
      await expect(alice.connector.sendCaseEvent('p3-paused-send', { caseId,
        recipientEmail: bob.address, text: 'This must be paused' })).rejects.toMatchObject({ status: 409 });
      await expect(bob.connector.getCleanAssetDownload(result.asset.id)).rejects.toMatchObject({ status: 404 });
      expect((await humanAction(app.baseUrl, alice.inboxId, caseId, alice.session, 'resume')).status).toBe(201);
      expect((await bob.connector.getCase(caseId) as any).state).toBe('waitingForHuman');
      expect((await bob.connector.listAssets()).some(asset => asset.id === result.asset.id)).toBe(true);
      expect((await stranger.connector.listAssets()).some(asset => asset.id === result.asset.id)).toBe(false);
      const strangerView = await request(app.baseUrl, `/api/inboxes/${stranger.inboxId}/human-view`, stranger.session);
      expect(strangerView.payload.assets.some((asset: { id: string }) => asset.id === result.asset.id)).toBe(false);
      await expect(stranger.connector.getCleanAssetDownload(result.asset.id)).rejects.toMatchObject({ status: 404 });
      const approval = await fetch(`${app.baseUrl}/api/inboxes/${alice.inboxId}/cases/${caseId}/actions`, {
        method: 'POST', headers: { ...alice.session.headers(app.baseUrl, 'POST'), 'content-type': 'application/json', 'Idempotency-Key': `p2-approve-${caseId}` },
        body: JSON.stringify({ actionKey: 'approveOnce', externalRefs: { requestedAction: 'case.complete', result: 'Clean result agreed' } })
      });
      expect(approval.status).toBe(201);
      const approved = await approval.json() as { action: { id: string } };
      await bob.connector.sendCaseEvent('p2-completion', { caseId, recipientEmail: alice.address,
        intent: 'receipt', type: 'completion', text: 'Clean result agreed',
        payload: { completion: { result: 'Clean result agreed', authorityBasis: approved.action.id } } });
      while ((await alice.connector.getCase(caseId) as any).state !== 'completed') {
        if (Date.now() > deadline) throw new Error('Typed completion was not delivered');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const finishedA = await alice.connector.getCase(caseId) as any;
      const finishedB = await bob.connector.getCase(caseId) as any;
      expect(finishedA.state).toBe('completed');
      expect(finishedB.state).toBe('completed');
      expect(finishedA.receipt).toEqual(finishedB.receipt);
      expect(finishedA.receipt.humanApprovalStatus).toBe('approved');
      expect((await bob.connector.getCase(secondCaseId) as any).state).toBe('inProgress');
      const approvedBytes = Buffer.from('agent selected approved report');
      await writeFile(path.join(root, 'report.txt'), approvedBytes);
      const manifestPath = path.join(root, 'approved-files.json');
      await writeFile(manifestPath, JSON.stringify({ files: [{ handle: 'report', path: 'report.txt',
        mimeType: 'text/plain', sha256: createHash('sha256').update(approvedBytes).digest('hex') }] }));
      const manifest = await loadAssetManifest(manifestPath);
      const requested = await bob.connector.sendCaseEvent('p2-request-approved-file', {
        caseId: secondCaseId, recipientEmail: alice.address, text: 'Please share the approved report' });
      const workMessage = { id: requested.id, caseId: secondCaseId, senderAgentId: bob.agentId,
        recipientAgentId: alice.agentId, from: { agentId: bob.agentId, address: bob.address }, text: requested.text } as WorkMessage;
      const saved = new Map<string, BridgeDecision>();
      const turn = vi.fn(async () => parseAgentReply('{"text":"Approved report attached","intent":"message","assetHandle":"report"}'));
      const handler = bridgeHandler({ admit: async () => {}, replyFor: async id => saved.get(id) || null,
        saveReply: async (id, reply) => { saved.set(id, reply); } }, turn,
      manifestAssetExchange(manifest, alice.connector));
      const context = { signal: new AbortController().signal, reply: vi.fn() };
      await handler.process(workMessage, context);
      await handler.process(workMessage, context);
      expect(turn).toHaveBeenCalledTimes(1);
      expect(context.reply).not.toHaveBeenCalled();
      const approvedAsset = (await bob.connector.listAssets()).find(asset => asset.filename === 'report.txt');
      expect(approvedAsset?.state).toBe('clean');
      let announcements = await bob.connector.listCaseMessages(secondCaseId);
      const announcementDeadline = Date.now() + 10_000;
      while (!announcements.some(message => message.artifactRefs?.includes(approvedAsset!.id))) {
        if (Date.now() > announcementDeadline) throw new Error('Approved file announcement was not delivered');
        await new Promise(resolve => setTimeout(resolve, 50));
        announcements = await bob.connector.listCaseMessages(secondCaseId);
      }
      expect(announcements.filter(message => message.artifactRefs?.includes(approvedAsset!.id))).toHaveLength(1);
    } finally {
      if (app?.child && app.child.exitCode === null) {
        const child = app.child;
        await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM'); });
      }
      await new Promise<void>(resolve => scanner.close(() => resolve()));
      if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir())) throw new Error('Unsafe test cleanup path');
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
