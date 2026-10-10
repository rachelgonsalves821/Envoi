// Bundled against the exact target tree, never the runner branch's SDK.
import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EnvoiConnector } from '@ga4/connector';
import { startConnection } from '@ga4/core';
import { FileBridgeStore } from '@ga4/store';

const directory = process.argv[2];
const stop = new AbortController();
const emit = value => process.send?.({ at: Date.now(), ...value });
let failNext = false;
process.on('message', message => {
  if (message.command === 'stop') stop.abort();
  if (message.command === 'fail-next') { failNext = true; emit({ type: 'fail-next-ready' }); }
});
const observedFetch = async (input, init) => {
  const route = new URL(String(input)).pathname;
  try {
    const response = await fetch(input, init);
    // A stream must be returned immediately; cloning/text-reading it would stall run().
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const body = await response.clone().json().catch(() => null);
      emit({ type: 'http', route, status: response.status, state: body?.state,
        workId: body?.work?.workId, hint: body?.nextAvailableInMs,
        receiptState: body?.receipt?.state });
    } else emit({ type: 'sse-open' });
    return response;
  } catch (error) { emit({ type: 'network', route }); throw error; }
};
const run = startConnection(directory, stop.signal, () => ({
  runtime: 'hermes', discover: async (_options, previous) => previous,
  preflight: async () => {}, describe: () => ({ handler: 'controlled local GA4 handler' }),
  createBridge: async (_configuration, context) => {
    const store = new FileBridgeStore(directory); await store.init();
    const connector = new EnvoiConnector(context.apiUrl, store, {
      fetch: observedFetch,
      onEvent: event => emit({ type: 'event', eventType: event.type }),
      handler: {
        admit: message => store.admit(message),
        process: async message => {
          if (failNext) {
            failNext = false;
            await appendFile(path.join(directory, 'attempts.log'), JSON.stringify({ id: message.id, outcome: 'failed-before-effect' }) + '\n');
            emit({ type: 'failed-once', id: message.id });
            throw new Error('GA4 controlled retryable failure before effect');
          }
          // Exclusive create detects another successful processing attempt; it does not hide it.
          await appendFile(path.join(directory, 'attempts.log'), JSON.stringify({ id: message.id, outcome: 'processing' }) + '\n');
          await writeFile(path.join(directory, 'work', `${message.id}.effect.json`), JSON.stringify({ id: message.id }), { flag: 'wx', mode: 0o600 });
          emit({ type: 'effect', id: message.id });
        }
      }
    });
    return { connector, close: async () => {} };
  }
}), { fetch: observedFetch, control: false, onReady: () => emit({ type: 'ready' }) });
run.then(() => emit({ type: 'ended' }), error => { emit({ type: 'ended', error: error.message, code: error.code }); process.exitCode = 1; });
