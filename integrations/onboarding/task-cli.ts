import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { readConnection } from '../connector/core';
import { queryControl, sendTaskControl } from '../connector/control';
import { HostTaskError, readHostTask, validateHostTask, type HostTaskIdentity, type HostTaskRequest } from '../connector/host-task';

export type TaskPrompt = (identity: HostTaskIdentity, signal: AbortSignal, saved?: HostTaskRequest) => Promise<HostTaskRequest | false | null>;

/** Only a human at the private host terminal confirms an outbound task. */
export const nativeTaskPrompt: TaskPrompt = async (identity, signal, saved) => {
  if (!stdin.isTTY || !stderr.isTTY) return null;
  const prompt = createInterface({ input: stdin, output: stderr });
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
  try {
    stderr.write(`\nStart a task through ${identity.address}\nEnvoi: ${identity.apiUrl}\n`);
    const request = validateHostTask(saved ?? { requestId: randomUUID(),
      recipientAddress: (await prompt.question('Recipient Envoi address: ', { signal: bounded })).trim().toLowerCase(),
      text: await prompt.question('Task: ', { signal: bounded }) });
    stderr.write(`\nFrom: ${identity.address}\nTo: ${request.recipientAddress}\nTask: ${request.text}\nRetry ID: ${request.requestId}\n`);
    return (await prompt.question('Type yes to send this task: ', { signal: bounded })).trim().toLowerCase() === 'yes' ? request : false;
  } catch (error) { if (bounded.aborted) return false; throw error; }
  finally { prompt.close(); }
};

export async function runHostTaskCommand(directory: string, expected: { apiUrl: string; runtime: string }, signal: AbortSignal,
  options: { retryId?: string; prompt?: TaskPrompt; write?: (value: Record<string, any>) => void } = {}) {
  const connection = await readConnection(directory);
  if (connection.apiUrl !== expected.apiUrl || connection.runtime !== expected.runtime) throw new HostTaskError('TASK_IDENTITY_MISMATCH');
  const live = await queryControl(directory, 'status');
  if (live.apiUrl !== connection.apiUrl || live.runtime !== connection.runtime || live.address !== connection.address
    || live.runtimeChecks !== 'passed' || live.status !== 'running') throw new HostTaskError('CONNECTOR_NOT_READY');
  const identity: HostTaskIdentity = { apiUrl: connection.apiUrl, runtime: connection.runtime, address: connection.address };
  const record = options.retryId ? await readHostTask(directory, identity, options.retryId) : null;
  if (options.retryId && !record) throw new HostTaskError('TASK_STATE_INVALID');
  signal.throwIfAborted();
  const approved = await (options.prompt ?? nativeTaskPrompt)(identity, signal, record?.request);
  let result: Record<string, any>;
  if (!approved) result = { state: approved === false ? 'cancelled' : 'needs_help',
    nextAction: approved === false ? 'No task was sent.' : 'Run this command in an interactive terminal on the connected agent host. No task was sent.' };
  else {
    const request = validateHostTask(approved);
    if (record && JSON.stringify(request) !== JSON.stringify(record.request)) throw new HostTaskError('TASK_IDEMPOTENCY_CONFLICT');
    signal.throwIfAborted();
    try {
      result = await sendTaskControl(directory, request);
      if (result.senderAddress !== identity.address) throw new HostTaskError('TASK_IDENTITY_MISMATCH');
      result = { ...result, nextAction: `Open ${identity.apiUrl}/app to follow the task and reply.` };
    } catch {
      result = { state: 'needs_help', requestId: request.requestId,
        nextAction: `Delivery is not confirmed. Preserve the saved connection. From the reviewed helper folder, retry with node ./envoi-link.mjs task ${identity.apiUrl} --runtime ${identity.runtime} --retry ${request.requestId}.` };
    }
  }
  options.write?.(result);
  return result;
}
