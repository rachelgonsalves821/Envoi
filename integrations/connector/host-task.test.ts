import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createHostTaskSender, readHostTask, validateHostTask, type HostTaskRequest } from './host-task';
import { privateJson } from './store';
import { queryControl, sendTaskControl, startControl } from './control';
import { runLocalLink } from '../onboarding/cli';
import { nativeTaskPrompt } from '../onboarding/task-cli';

const identity = { apiUrl: 'https://envoi.example', runtime: 'hermes', address: 'alice@agents.envoi.example' };
const task = (): HostTaskRequest => ({ requestId: randomUUID(), recipientAddress: 'rachel@agents.envoi.example', text: 'Please propose two meeting times.' });
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'envoi-host-task-')); directories.push(directory);
  const effects = new Map<string, any>();
  const startCase = vi.fn(async (key: string, input: any): Promise<any> => {
    if (!effects.has(key)) effects.set(key, { ...input, id: `msg_${effects.size}`, transport: 'native', status: 'queued' });
    return effects.get(key);
  });
  const sender = () => createHostTaskSender(directory, identity, () => ({ startCase }));
  return { directory, effects, startCase, sender };
}

it('persists before sending and deduplicates concurrent requests and process restarts', async () => {
  const f = await fixture(), request = task(), send = f.sender();
  f.startCase.mockImplementationOnce(async (key, input) => {
    expect(await readHostTask(f.directory, identity, request.requestId)).toMatchObject({ state: 'prepared', caseId: input.caseId });
    f.effects.set(key, { ...input, id: 'msg_one', transport: 'native' }); return f.effects.get(key);
  });
  const results = await Promise.all([send(request), send(request)]);
  expect(results[0]).toEqual(results[1]); expect(f.startCase).toHaveBeenCalledTimes(1);
  expect(await f.sender()(request)).toMatchObject({ state: 'accepted', replayed: true });
  expect(f.startCase).toHaveBeenCalledTimes(1);
  await expect(send({ ...request, text: 'Changed request' })).rejects.toMatchObject({ code: 'TASK_IDEMPOTENCY_CONFLICT' });
});

it('reuses the original case and key after the upstream accepted a send but its response was lost', async () => {
  const f = await fixture(), request = task();
  const ordinary = f.startCase.getMockImplementation()!;
  f.startCase.mockImplementationOnce(async (key, input) => { await ordinary(key, input); throw new Error('lost response private-token'); });
  await expect(f.sender()(request)).rejects.toThrow('lost response');
  expect((await readHostTask(f.directory, identity, request.requestId))?.state).toBe('prepared');
  expect(await f.sender()(request)).toMatchObject({ state: 'accepted', replayed: false });
  expect(f.effects.size).toBe(1);
  expect(f.startCase.mock.calls[0]).toEqual(f.startCase.mock.calls[1]);
});

it('does not send if intent persistence fails, and recovers a lost receipt save without a second effect', async () => {
  const f = await fixture(), request = task();
  await expect(createHostTaskSender(f.directory, identity, () => ({ startCase: f.startCase }), async () => { throw new Error('disk full'); })(request)).rejects.toThrow();
  expect(f.startCase).not.toHaveBeenCalled();
  let writes = 0;
  const send = createHostTaskSender(f.directory, identity, () => ({ startCase: f.startCase }), async (filename, value) => {
    if (++writes === 2) throw new Error('receipt save lost');
    await privateJson(filename, value);
  });
  await expect(send(request)).rejects.toThrow('receipt save');
  await f.sender()(request); expect(f.effects.size).toBe(1);
});

it('copies only public sender binding into the journal, excluding private adapter configuration', async () => {
  const f = await fixture(), request = task();
  const installed = { ...identity, configuration: { privateKey: 'private-adapter-key' }, activationSetup: { completionId: 'private-completion' } };
  await createHostTaskSender(f.directory, installed, () => ({ startCase: f.startCase }))(request);
  expect((await readHostTask(f.directory, identity, request.requestId))?.identity).toEqual(identity);
  expect(await readFile(path.join(f.directory, `host-task-${request.requestId}.json`), 'utf8')).not.toMatch(/private-adapter-key|private-completion/);
});

it.each(['AGENT_PAUSED', 'CREDENTIAL_REVOKED', 'PERMISSION_DENIED'])('preserves server denial %s without accepting a task', async code => {
  const f = await fixture(), request = task();
  f.startCase.mockRejectedValue(Object.assign(new Error('denied'), { code }));
  await expect(f.sender()(request)).rejects.toMatchObject({ code });
  expect((await readHostTask(f.directory, identity, request.requestId))?.state).toBe('prepared');
  expect(f.effects.size).toBe(0);
});

it('refuses mismatched identity, corrupt journal and request scope injection before sending', async () => {
  const f = await fixture(), request = task();
  for (const value of [{ ...request, senderAgentId: 'other' }, { ...request, recipientAddress: 'https://evil.test' }, { ...request, text: '\x1b[31mspoof' }, { ...request, requestId: '../session' }]) {
    expect(() => validateHostTask(value)).toThrow();
  }
  await expect(f.sender()({ ...request, recipientAddress: identity.address })).rejects.toMatchObject({ code: 'TASK_SELF_RECIPIENT' });
  await writeFile(path.join(f.directory, `host-task-${request.requestId}.json`), '{}');
  await expect(f.sender()(request)).rejects.toMatchObject({ code: 'TASK_STATE_INVALID' });
  expect(f.startCase).not.toHaveBeenCalled();
});

it('authenticates task control, rejects browser origins, bounds the body and redacts errors', async () => {
  const f = await fixture(), request = task();
  const send = vi.fn(f.sender());
  const control = await startControl(f.directory, identity, () => {}, () => ({ status: 'running', runtimeChecks: 'passed' }), send);
  try {
    const record = JSON.parse(await readFile(path.join(f.directory, 'control.json'), 'utf8'));
    const url = `http://127.0.0.1:${record.port}/tasks`;
    const headers = { authorization: `Bearer ${record.secret}`, 'content-type': 'application/json' };
    expect((await fetch(url, { method: 'POST', body: JSON.stringify(request) })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers: { ...headers, origin: identity.apiUrl }, body: JSON.stringify(request) })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers, body: 'x'.repeat(65_537) })).status).toBe(413);
    expect(send).not.toHaveBeenCalled();
    expect(await sendTaskControl(f.directory, request)).toMatchObject({ state: 'accepted', senderAddress: identity.address });
    send.mockRejectedValueOnce(new Error('envoi_agent_access_PRIVATE /private/session.json'));
    const failure = await fetch(url, { method: 'POST', headers, body: JSON.stringify(task()) });
    expect(failure.status).toBe(503);
    expect(await failure.text()).toBe('{"code":"TASK_SEND_UNCERTAIN"}');
    expect(await queryControl(f.directory, 'doctor')).toMatchObject({ runtime: 'hermes' });
  } finally { await control.close(); }
});

it('uses the live helper without discovering, enrolling or reading rotating credentials; retry restores the exact task', async () => {
  const f = await fixture(), request = task();
  await privateJson(path.join(f.directory, 'connection.json'), { version: 1, ...identity, agentName: 'Alice', configuration: {} });
  const control = await startControl(f.directory, identity, () => {}, () => ({ status: 'running', runtimeChecks: 'passed' }), f.sender());
  try {
    const prompt = vi.fn(async () => request), write = vi.fn(), discover = vi.fn();
    const args = ['task', identity.apiUrl, '--runtime', identity.runtime];
    const options = { stateDir: f.directory, taskPrompt: prompt, write, resolveAdapter: discover };
    expect(await runLocalLink(args, new AbortController().signal, options)).toMatchObject({ state: 'accepted' });
    expect(discover).not.toHaveBeenCalled(); expect(f.startCase).toHaveBeenCalledTimes(1);
    await expect(runLocalLink(['task', 'https://other.envoi.example', '--runtime', identity.runtime], new AbortController().signal, options))
      .rejects.toMatchObject({ code: 'TASK_IDENTITY_MISMATCH' });
    expect(prompt).toHaveBeenCalledTimes(1);
    await runLocalLink([...args, '--retry', request.requestId], new AbortController().signal, options);
    expect(prompt.mock.calls[1]?.[2]).toEqual(request);
    expect(write.mock.calls[1][0]).toMatchObject({ replayed: true });
    expect(JSON.stringify(write.mock.calls)).not.toMatch(/agentApiToken|refresh|case_|msg_|control\.json/);
    expect(f.startCase).toHaveBeenCalledTimes(1);
    const declined = await runLocalLink(args, new AbortController().signal, { ...options, taskPrompt: async () => false });
    expect(declined.state).toBe('cancelled'); expect(f.startCase).toHaveBeenCalledTimes(1);
    await expect(runLocalLink([...args, '--token', 'secret'], new AbortController().signal, options)).rejects.toThrow();
  } finally { await control.close(); }
});

it('does not manufacture host confirmation for noninteractive model/tool execution', async () => {
  if (!process.stdin.isTTY || !process.stderr.isTTY) expect(await nativeTaskPrompt(identity, new AbortController().signal)).toBeNull();
});
