import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { describe, expect, it } from 'vitest';
import { enrollConnector, SinaloaConnector } from '../../sdk/typescript/src/connector';
import { newCaseId } from '../../sdk/typescript/src/index';
import { BrowserSession } from '../../test/browser-session.js';
import { FileBridgeStore } from './file-store';
import { shareCaseAsset } from './asset-exchange';

const serverEntry = process.env.SINALOA_P2_SERVER_ENTRY;
const test = serverEntry ? it : it.skip;

async function startServer(dataDir: string): Promise<{ baseUrl: string; child: ChildProcess }> {
  const child = spawn(process.execPath, [serverEntry!], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: '', SINALOA_PORT: '0',
      SINALOA_AUTH_MODE: 'development', SINALOA_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe']
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
  return { ...enrolled, session, connector: new SinaloaConnector(baseUrl, store) };
}

describe('P2 clean case asset exchange against a real local server', () => {
  test('grants only the bound recipient a clean file and replays its grant safely', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sinaloa-p2-client-'));
    let app: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      app = await startServer(path.join(root, 'server'));
      const alice = await owner(app.baseUrl, '8101', root,
        ['send_agent_messages', 'receive_agent_messages', 'create_assets']);
      const bob = await owner(app.baseUrl, '8102', root,
        ['send_agent_messages', 'receive_agent_messages']);
      const stranger = await owner(app.baseUrl, '8103', root,
        ['send_agent_messages', 'receive_agent_messages']);
      const caseId = newCaseId();
      await alice.connector.startCase('p2-case-start', { caseId,
        recipientEmail: bob.address, text: 'Please review the attached result' });
      const bytes = new TextEncoder().encode('clean two-owner case evidence');
      const result = await shareCaseAsset({ connector: alice.connector, caseId,
        recipientAgentId: bob.agentId, recipientAddress: bob.address,
        filename: 'result.txt', mimeType: 'text/plain', bytes,
        idempotencyKey: 'p2-case-file-one', text: 'The clean file is ready' });
      expect(result.asset.state).toBe('clean');
      expect(result.grant.recipientAgentId).toBe(bob.agentId);
      expect(result.message.artifactRefs).toContain(result.asset.id);
      const replay = await alice.connector.grantCaseAsset(result.asset.id, bob.agentId, 'p2-case-file-one:grant');
      expect(replay.id).toBe(result.grant.id);
      const visible = await bob.connector.listAssets();
      expect(visible.find(asset => asset.id === result.asset.id)?.grant?.recipientAgentId).toBe(bob.agentId);
      const download = await bob.connector.getCleanAssetDownload(result.asset.id);
      const actual = await fetch(download.download.url);
      expect(new Uint8Array(await actual.arrayBuffer())).toEqual(bytes);
      expect((await stranger.connector.listAssets()).some(asset => asset.id === result.asset.id)).toBe(false);
      await expect(stranger.connector.getCleanAssetDownload(result.asset.id)).rejects.toMatchObject({ status: 404 });
    } finally {
      if (app?.child && app.child.exitCode === null) {
        const child = app.child;
        await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM'); });
      }
      if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir())) throw new Error('Unsafe test cleanup path');
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
