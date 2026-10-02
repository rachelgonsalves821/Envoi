import { enrollConnector } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { createHermesBridge } from './runtime';

async function main() {
  const apiUrl = process.env.ENVOI_API_URL || process.env.SINALOA_API_URL;
  const stateDir = process.env.ENVOI_STATE_DIR || process.env.SINALOA_STATE_DIR;
  const hermesUrl = process.env.HERMES_API_URL;
  const hermesKey = process.env.HERMES_API_KEY;
  if (!apiUrl || !stateDir || !hermesUrl || !hermesKey) throw new Error('ENVOI_API_URL, ENVOI_STATE_DIR, HERMES_API_URL and HERMES_API_KEY are required');
  const store = new FileBridgeStore(stateDir);
  await store.init();
  if (!await store.load()) {
    const token = process.env.ENVOI_ENROLLMENT_TOKEN || process.env.SINALOA_ENROLLMENT_TOKEN;
    if (!token) throw new Error('ENVOI_ENROLLMENT_TOKEN is required for first enrollment');
    await enrollConnector(apiUrl, token, store, { name: process.env.ENVOI_AGENT_NAME || process.env.SINALOA_AGENT_NAME || 'Hermes bridge' });
  }
  delete process.env.ENVOI_ENROLLMENT_TOKEN;
  delete process.env.SINALOA_ENROLLMENT_TOKEN;
  const relayToken = process.env.HERMES_MCP_RELAY_TOKEN;
  const writeFlag = process.env.HERMES_MCP_WRITE_ENABLED;
  if (writeFlag && writeFlag !== 'true') throw new Error('HERMES_MCP_WRITE_ENABLED must be true when set');
  if ((process.env.HERMES_MCP_RELAY_PORT || writeFlag) && !relayToken) throw new Error('HERMES_MCP_RELAY_TOKEN is required when MCP relay or writes are configured');
  const bridge = await createHermesBridge({ apiUrl, stateDir, hermesUrl, hermesKey, relayToken,
    relayPort: process.env.HERMES_MCP_RELAY_PORT ? Number(process.env.HERMES_MCP_RELAY_PORT) : 8789,
    writeEnabled: writeFlag === 'true' });
  const session = await store.load();
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  try {
    if (relayToken && writeFlag === 'true') {
      const catalog = await bridge.connector.forwardMcpRequest(JSON.stringify({ jsonrpc: '2.0', id: 'hermes-setup', method: 'tools/list' }));
      if (!catalog.ok) throw new Error(`Envoi MCP tool check failed with HTTP ${catalog.status}`);
      const payload = await catalog.json() as { result?: { tools?: Array<{ name?: string }> } };
      const names = new Set(payload.result?.tools?.map(tool => tool.name));
      if (!names.has('sinaloa_start_case') || !names.has('sinaloa_send_message')) throw new Error('This enrolled agent lacks Envoi send permission. Enable Send agent messages for it before reconnecting.');
    }
    process.stdout.write(`Hermes connected to Envoi as ${session?.address}. Listening for work.${bridge.relayUrl ? ' MCP send tools available on loopback.' : ''}\n`);
    await bridge.connector.run(stop.signal);
  } finally { await bridge.close(); }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : '';
  const reason = message.startsWith('This enrolled agent lacks Envoi send permission') || /^Envoi MCP tool check failed with HTTP \d{3}$/.test(message) ? ` ${message}` : '';
  process.stderr.write(`Hermes bridge stopped; inspect local configuration, Hermes readiness and credential status.${reason}\n`);
  process.exitCode = 1;
});
