import { enrollConnector, SinaloaConnector } from '../../sdk/typescript/src/connector';
import { bridgeHandler, mcpReplyMessageId, withRecordedMcpReply } from '../agent-bridges/bridge';
import { loadAssetManifest, manifestAssetExchange } from '../agent-bridges/asset-manifest';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { startMcpRelay } from '../agent-bridges/mcp-relay';
import { HermesRunStore } from './run-store';
import { hermesTurn } from './turn';
import type { WorkMessage } from '../../sdk/typescript/src/connector';
import { authorizedHermesWrite } from './lease-write';

async function main() {
  const apiUrl = process.env.SINALOA_API_URL;
  const stateDir = process.env.SINALOA_STATE_DIR;
  const hermesUrl = process.env.HERMES_API_URL;
  const hermesKey = process.env.HERMES_API_KEY;
  if (!apiUrl || !stateDir || !hermesUrl || !hermesKey) {
    throw new Error('SINALOA_API_URL, SINALOA_STATE_DIR, HERMES_API_URL and HERMES_API_KEY are required');
  }
  const store = new FileBridgeStore(stateDir);
  await store.init();
  if (!await store.load()) {
    const token = process.env.SINALOA_ENROLLMENT_TOKEN;
    if (!token) throw new Error('SINALOA_ENROLLMENT_TOKEN is required for first enrollment');
    await enrollConnector(apiUrl, token, store, { name: process.env.SINALOA_AGENT_NAME || 'Hermes bridge' });
  }
  delete process.env.SINALOA_ENROLLMENT_TOKEN;
  const session = await store.load();
  if (!session) throw new Error('Sinaloa enrollment did not create a connector session');
  const runs = new HermesRunStore(stateDir);
  const approvedAssets = await loadAssetManifest(process.env.SINALOA_ASSET_MANIFEST_PATH);
  const relayToken = process.env.HERMES_MCP_RELAY_TOKEN;
  const writeFlag = process.env.HERMES_MCP_WRITE_ENABLED;
  if (writeFlag && writeFlag !== 'true') throw new Error('HERMES_MCP_WRITE_ENABLED must be true when set');
  if ((process.env.HERMES_MCP_RELAY_PORT || writeFlag) && !relayToken) {
    throw new Error('HERMES_MCP_RELAY_TOKEN is required when MCP relay or writes are configured');
  }
  const writeEnabled = writeFlag === 'true';
  let active: { message: WorkMessage; signal: AbortSignal } | null = null;
  let connector: SinaloaConnector;
  const provider = hermesTurn({
    apiUrl: hermesUrl, apiKey: hermesKey, agentId: session.agentId, runs, replies: store,
    allowSinaloaMcpWrites: writeEnabled,
    mcpReplySent: writeEnabled ? id => store.mcpReplySent(id) : undefined,
    assetHandles: [...approvedAssets.values()].map(({ handle, filename }) => ({ handle, filename })),
    history: caseId => connector.listCaseMessages(caseId, 20),
    onActive(message, signal) { active = signal ? { message, signal } : null; }
  });
  const turn = writeEnabled ? withRecordedMcpReply(provider, id => store.mcpReplySent(id)) : provider;
  connector = new SinaloaConnector(apiUrl, store, { handler: bridgeHandler(store, turn,
    approvedAssets.size ? (message, reply, key, signal) => manifestAssetExchange(approvedAssets, connector)(message, reply, key, signal) : undefined) });
  const relay = relayToken ? await startMcpRelay({
    connector, bearerToken: relayToken,
    port: process.env.HERMES_MCP_RELAY_PORT ? Number(process.env.HERMES_MCP_RELAY_PORT) : 8789,
    allowCollaborationWrites: writeEnabled,
    collaborationToolNames: ['sinaloa_start_case', 'sinaloa_send_message', 'sinaloa_send_proposal', 'sinaloa_send_decision'],
    authorizeWrite: (name, args) => authorizedHermesWrite(active, name, args),
    onSuccessfulWrite: async (name, args) => {
      const id = mcpReplyMessageId(name, args);
      if (id) await store.markMcpReplySent(id);
    }
  }) : null;
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  try {
    if (relay && writeEnabled) {
      const catalog = await connector.forwardMcpRequest(JSON.stringify({ jsonrpc: '2.0', id: 'hermes-setup', method: 'tools/list' }));
      if (!catalog.ok) throw new Error(`Sinaloa MCP tool check failed with HTTP ${catalog.status}`);
      const payload = await catalog.json() as { result?: { tools?: Array<{ name?: string }> } };
      const names = new Set(payload.result?.tools?.map(tool => tool.name));
      if (!names.has('sinaloa_start_case') || !names.has('sinaloa_send_message')) {
        throw new Error('This enrolled agent lacks Sinaloa send permission. Enable Send agent messages for it before reconnecting.');
      }
    }
    process.stdout.write(`Hermes connected to Sinaloa as ${session.address}. Listening for work.${relay ? ' MCP send tools ready on loopback.' : ''}\n`);
    await connector.run(stop.signal);
  }
  finally { await relay?.close(); }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : '';
  const reason = message.startsWith('This enrolled agent lacks Sinaloa send permission')
    || /^Sinaloa MCP tool check failed with HTTP \d{3}$/.test(message)
    ? ` ${message}` : '';
  process.stderr.write(`Hermes bridge stopped; inspect local configuration, Hermes readiness and credential status.${reason}\n`);
  process.exitCode = 1;
});
