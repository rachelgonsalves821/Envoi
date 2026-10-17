import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectorSession } from '../../sdk/typescript/src/connector';
const probe = vi.hoisted(() => ({ events: [] as string[], fail: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return { writeFile: handle.writeFile.bind(handle), close: handle.close.bind(handle), sync: async () => {
        probe.events.push('sync'); if (probe.fail) throw new Error('flush failed'); return handle.sync();
      } };
    },
    rename: async (...args: Parameters<typeof actual.rename>) => { probe.events.push('rename'); return actual.rename(...args); }
  };
});
import { FileBridgeStore } from './file-store';
let directory = '';
afterEach(async () => { probe.fail = false; probe.events.length = 0; if (directory) await rm(directory, { recursive: true, force: true }); });
it('flushes private session bytes before atomic commit and preserves the completion marker', async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'envoi-private-session-'));
  const store = new FileBridgeStore(directory); await store.init();
  const session = { agentId: 'agent_example', _onboarding: { completionId: 'completion_private' } } as unknown as ConnectorSession;
  await store.save(session);
  expect(probe.events.slice(0, 2)).toEqual(['sync', 'rename']);
  expect(await store.load()).toEqual(session);
  expect((await readdir(directory)).filter(file => file.endsWith('.tmp'))).toEqual([]);
});
it('failed durability barrier preserves previous credentials and removes incomplete temporary bytes', async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'envoi-private-session-'));
  const store = new FileBridgeStore(directory); await store.init();
  await store.save({ agentId: 'prior' } as ConnectorSession);
  probe.fail = true;
  await expect(store.save({ agentId: 'successor' } as ConnectorSession)).rejects.toThrow('flush failed');
  expect(JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8'))).toEqual({ agentId: 'prior' });
  expect((await readdir(directory)).filter(file => file.endsWith('.tmp'))).toEqual([]);
});
