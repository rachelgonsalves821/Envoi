// Controlled local handler; production core, connector and HTTP semantics are unchanged.
import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startConnection } from '../connector/core';
import { EnvoiConnector } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from '../agent-bridges/file-store';

const directory = process.argv[2];
const controller = new AbortController();
let connector: EnvoiConnector;
let release: (() => void) | undefined;
let hold = false;
const emit = (value: unknown) => process.send?.(value);
const observedFetch: typeof fetch = async (input, init) => {
  const request = { method: init?.method || 'GET', path: new URL(String(input)).pathname, body: init?.body };
  try {
    const response = await fetch(input, init);
    const body = await response.clone().text();
    emit({ type: 'http', request, response: { status: response.status, headers: Object.fromEntries(response.headers), body } });
    return response;
  } catch (error) { emit({ type: 'network', request, error: String(error) }); throw error; }
};
process.on('message', async (message: any) => {
  if (message.command === 'stop') { controller.abort(); return; }
  if (message.command === 'hold') { hold = true; emit({ type: 'held-handler-enabled' }); return; }
  if (message.command === 'release') { release?.(); return; }
  try {
    if (message.command === 'refresh') await connector.currentAccessToken(300_000);
    if (message.command === 'mcp') await connector.forwardMcpRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    if (message.command === 'claim') await connector.processWorkOnce();
    emit({ type: 'command', command: message.command, ok: true });
  } catch (error: any) { emit({ type: 'command', command: message.command, ok: false, code: error.code, error: error.message }); }
});
const run = startConnection(directory, controller.signal, () => ({
  runtime: 'hermes',
  discover: async (_options, previous) => previous || { controlledGateHandler: true },
  preflight: async () => {},
  describe: () => ({ handler: 'controlled local GA3 handler' }),
  createBridge: async (_config, context) => {
    const store = new FileBridgeStore(directory); await store.init();
    connector = new EnvoiConnector(context.apiUrl, store, { fetch: observedFetch, pollIntervalMs: 100,
      onState: lifecycle => emit({ type: 'lifecycle', lifecycle }),
      handler: {
        admit: message => store.admit(message),
        process: async (message, work) => {
          emit({ type: 'processing', id: message.id });
          if (hold) {
            await new Promise<void>(resolve => { release = resolve; work.signal.addEventListener('abort', resolve, { once: true }); });
            emit({ type: 'late-handler', id: message.id, aborted: work.signal.aborted });
          } else {
            await writeFile(path.join(directory, 'work', `${message.id}.processed.json`), JSON.stringify({ id: message.id }));
            await appendFile(path.join(directory, 'processed.log'), message.id + '\n');
          }
        }
      }
    });
    return { connector, close: async () => {} };
  }
}), { fetch: observedFetch, pollIntervalMs: 100, onReady: () => emit({ type: 'ready' }), onWaiting: code => emit({ type: 'waiting', code }) });
run.then(() => emit({ type: 'ended' }), (error: any) => emit({ type: 'ended', code: error.code, error: error.message }));
