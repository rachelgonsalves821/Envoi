import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectorSession } from '../../sdk/typescript/src/connector';

const probe = vi.hoisted(() => ({
  renameCalls: 0,
  releaseAfterFailure: null as null | (() => Promise<void>),
  permanentError: null as null | NodeJS.ErrnoException
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    probe.renameCalls++;
    if (probe.permanentError) throw probe.permanentError;
    try { return await actual.rename(...args); }
    catch (error) {
      if (probe.releaseAfterFailure) {
        const release = probe.releaseAfterFailure;
        probe.releaseAfterFailure = null;
        await release();
      }
      throw error;
    }
  } };
});
import { FileBridgeStore } from './file-store';

let directory = '';
afterEach(async () => {
  probe.renameCalls = 0;
  probe.releaseAfterFailure = null;
  probe.permanentError = null;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

const session = (id: string) => ({
  agentId: 'agent_one', inboxId: 'inbox_one', address: 'one@agents.example',
  agentApiToken: `access_${id}`, agentRefreshToken: `refresh_${id}`,
  agentTokenExpiresAt: '2030-01-01T00:00:00.000Z',
  agentRefreshTokenExpiresAt: '2031-01-01T00:00:00.000Z',
  pendingRotation: { rotationId: `rotation_${id}` },
  _onboarding: { completionId: `completion_${id}` }
}) as unknown as ConnectorSession;

it.skipIf(process.platform !== 'win32')('recovers a Windows reader-held session replacement and keeps valid complete JSON', async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'envoi-session-replace-'));
  const store = new FileBridgeStore(directory); await store.init();
  await store.save(session('prior'));
  probe.renameCalls = 0;
  const held = await open(path.join(directory, 'session.json'), 'r');
  probe.releaseAfterFailure = () => held.close();
  try {
    await store.save(session('next'));
    expect(probe.renameCalls).toBeGreaterThan(1);
    expect(await store.load()).toEqual(session('next'));
    expect(JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8'))).toEqual(session('next'));
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  } finally { await held.close(); }
});

it.skipIf(process.platform !== 'win32')('exhausts bounded replacement attempts without losing a session or reply ledger', async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'envoi-session-replace-'));
  const store = new FileBridgeStore(directory); await store.init();
  await store.save(session('prior'));
  await store.saveReply('message_one', { text: 'Prior reply', intent: 'message' });
  probe.renameCalls = 0;
  const held = await open(path.join(directory, 'session.json'), 'r');
  try {
    await expect(store.save(session('next'))).rejects.toMatchObject({ code: 'EPERM', syscall: 'rename' });
    expect(probe.renameCalls).toBe(4);
    expect(await store.load()).toEqual(session('prior'));
    expect(await store.replyFor('message_one')).toEqual({ text: 'Prior reply', intent: 'message' });
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  } finally { await held.close(); }
});

it.skipIf(process.platform !== 'win32')('recovers a reader-held reply ledger replacement using the same atomic path', async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'envoi-session-replace-'));
  const store = new FileBridgeStore(directory); await store.init();
  await store.saveReply('message_one', { text: 'Prior reply', intent: 'message' });
  probe.renameCalls = 0;
  const filename = path.join(directory, 'work', 'message_one.reply.json');
  const held = await open(filename, 'r');
  probe.releaseAfterFailure = () => held.close();
  try {
    await store.saveReply('message_one', { text: 'Next reply', intent: 'message' });
    expect(probe.renameCalls).toBeGreaterThan(1);
    expect(await store.replyFor('message_one')).toEqual({ text: 'Next reply', intent: 'message' });
    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual({ text: 'Next reply', intent: 'message' });
    expect((await readdir(path.dirname(filename))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  } finally { await held.close(); }
});

it.each(['ENOSPC', 'EACCES'])('does not retry permanent %s or alter saved session and reply records', async code => {
  directory = await mkdtemp(path.join(tmpdir(), 'envoi-session-replace-'));
  const store = new FileBridgeStore(directory); await store.init();
  await store.save(session('prior'));
  await store.saveReply('message_one', { text: 'Prior reply', intent: 'message' });
  probe.renameCalls = 0;
  const error = Object.assign(new Error('permanent replacement failure'), { code, syscall: 'rename' });
  probe.permanentError = error;
  await expect(store.save(session('next'))).rejects.toBe(error);
  expect(probe.renameCalls).toBe(1);
  expect(await store.load()).toEqual(session('prior'));
  expect(await store.replyFor('message_one')).toEqual({ text: 'Prior reply', intent: 'message' });
  expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
});
