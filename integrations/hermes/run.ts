import { enrollConnector } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { createHermesBridge } from './runtime';
import { migrateConnectionDirectory } from '../connector/migrate';
import { pathToFileURL } from 'node:url';
import { privateDirectory, acquireConnectorLock } from '../connector/store';
import { saveHermesScopedMode, selectScopedHermes, hermesHost } from './scoped-runtime';
import { connectHermesHost } from './scoped-host';

export async function prepareHermesRun(env: NodeJS.ProcessEnv = process.env) {
  const apiUrl = env.ENVOI_API_URL;
  const requested = env.ENVOI_STATE_DIR;
  if (!apiUrl || !requested) throw new Error('ENVOI_API_URL and ENVOI_STATE_DIR are required');
  const scoped = await selectScopedHermes({ env, stateDir: requested });
  const hermesUrl = env.HERMES_API_URL ?? '';
  const hermesKey = env.HERMES_API_KEY ?? '';
  const relayToken = env.HERMES_MCP_RELAY_TOKEN;
  const writeFlag = env.HERMES_MCP_WRITE_ENABLED;
  if (!scoped && (!hermesUrl || !hermesKey)) throw new Error('HERMES_API_URL and HERMES_API_KEY are required for legacy Hermes');
  if (writeFlag && writeFlag !== 'true') throw new Error('HERMES_MCP_WRITE_ENABLED must be true when set');
  if ((env.HERMES_MCP_RELAY_PORT || writeFlag) && !relayToken) throw new Error('HERMES_MCP_RELAY_TOKEN is required when MCP relay or writes are configured');
  return { apiUrl, requested, scoped, hermesUrl, hermesKey, relayToken, writeFlag };
}

async function main() {
  const { apiUrl, requested, scoped, hermesUrl, hermesKey, relayToken, writeFlag } = await prepareHermesRun();
  if (scoped) {
    const wire = await connectHermesHost(hermesHost(scoped), AbortSignal.timeout(15000));
    wire.close();
  }
  const stateDir = requested ? await migrateConnectionDirectory(requested) : undefined;
  if (!stateDir) throw new Error('Missing Hermes state directory');
  await privateDirectory(stateDir);
  const unlock = await acquireConnectorLock(stateDir);
  try {
    if (scoped) await saveHermesScopedMode(stateDir, scoped);
    const store = new FileBridgeStore(stateDir);
    await store.init();
    if (!await store.load()) {
      const token = process.env.ENVOI_ENROLLMENT_TOKEN;
      if (!token) throw new Error('ENVOI_ENROLLMENT_TOKEN is required for first enrollment');
      await enrollConnector(apiUrl, token, store, { name: process.env.ENVOI_AGENT_NAME || 'Hermes bridge' });
    }
    delete process.env.ENVOI_ENROLLMENT_TOKEN;
    const bridge = await createHermesBridge({ apiUrl, stateDir, hermesUrl, hermesKey, ...(scoped ? { runtime: scoped } : { relayToken,
      relayPort: process.env.HERMES_MCP_RELAY_PORT ? Number(process.env.HERMES_MCP_RELAY_PORT) : 8789,
      writeEnabled: writeFlag === 'true' }) });
    const session = await store.load();
    const stop = new AbortController();
    const onStop = () => stop.abort();
    process.once('SIGINT', onStop);
    process.once('SIGTERM', onStop);
    try {
      if (relayToken && writeFlag === 'true') {
        const catalog = await bridge.connector.forwardMcpRequest(JSON.stringify({ jsonrpc: '2.0', id: 'hermes-setup', method: 'tools/list' }));
        if (!catalog.ok) throw new Error(`Envoi MCP tool check failed with HTTP ${catalog.status}`);
        const payload = await catalog.json() as { result?: { tools?: Array<{ name?: string }> } };
        const names = new Set(payload.result?.tools?.map(tool => tool.name));
        if (!names.has('envoi_start_case') || !names.has('envoi_send_message')) throw new Error('This enrolled agent lacks Envoi send permission. Enable Send agent messages for it before reconnecting.');
      }
      process.stdout.write(`Hermes connected to Envoi as ${session?.address}. Listening for work.${bridge.relayUrl ? ' MCP send tools available on loopback.' : ''}\n`);
      await bridge.connector.run(stop.signal);
    } finally { process.removeListener('SIGINT', onStop); process.removeListener('SIGTERM', onStop); await bridge.close(); }
  } finally { await unlock(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  const message = error instanceof Error ? error.message : '';
  const reason = message.startsWith('This enrolled agent lacks Envoi send permission') || /^Envoi MCP tool check failed with HTTP \d{3}$/.test(message) ? ` ${message}` : '';
  process.stderr.write(`Hermes bridge stopped; inspect local configuration, Hermes readiness and credential status.${reason}\n`);
  process.exitCode = 1;
});
