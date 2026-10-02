import { SinaloaConnector, type ConnectorOptions } from '../../sdk/typescript/src/connector';
import { bridgeHandler } from '../agent-bridges/bridge';
import { loadAssetManifest, manifestAssetExchange } from '../agent-bridges/asset-manifest';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { startOpenClawMcpRelay } from './mcp-relay';
import { mcpReplyMessageId, openClawTurn, withRecordedMcpReply } from './turn';

export interface BridgeConfiguration {
  apiUrl: string;
  stateDir: string;
  gatewayUrl: string;
  gatewayToken: string;
  agentId: string;
}

/** Legacy setup and Quick Connect share the durable work and reply implementation. */
export async function createOpenClawBridge(config: BridgeConfiguration, options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; pollIntervalMs?: number } = {}) {
  const env = options.env ?? process.env;
  const relayToken = env.OPENCLAW_MCP_RELAY_TOKEN;
  if (env.OPENCLAW_MCP_RELAY_PORT && !relayToken) throw new Error('OPENCLAW_MCP_RELAY_TOKEN is required when the relay port is configured');
  if (env.OPENCLAW_MCP_WRITE_ENABLED && env.OPENCLAW_MCP_WRITE_ENABLED !== 'true') throw new Error('OPENCLAW_MCP_WRITE_ENABLED must be true when set');
  if (env.OPENCLAW_MCP_WRITE_ENABLED && !relayToken) throw new Error('OPENCLAW_MCP_RELAY_TOKEN is required for MCP writes');
  const store = new FileBridgeStore(config.stateDir);
  await store.init();
  if (!await store.load()) throw new Error('No connector credentials were saved. Run setup first');
  let connector: SinaloaConnector;
  const approvedAssets = await loadAssetManifest(env.SINALOA_ASSET_MANIFEST_PATH);
  const writeEnabled = env.OPENCLAW_MCP_WRITE_ENABLED === 'true';
  const gatewayTurn = openClawTurn({
    gatewayUrl: config.gatewayUrl, gatewayToken: config.gatewayToken, agentId: config.agentId,
    allowSinaloaMcpWrites: writeEnabled,
    assetHandles: [...approvedAssets.values()].map(({ handle, filename }) => ({ handle, filename })),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    history: caseId => connector.listCaseMessages(caseId, 20)
  });
  const turn = writeEnabled ? withRecordedMcpReply(gatewayTurn, messageId => store.mcpReplySent(messageId)) : gatewayTurn;
  const connectorOptions: ConnectorOptions = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
    handler: bridgeHandler(store, turn, approvedAssets.size
      ? (message, reply, key, signal) => manifestAssetExchange(approvedAssets, connector)(message, reply, key, signal) : undefined)
  };
  connector = new SinaloaConnector(config.apiUrl, store, connectorOptions);
  const relay = relayToken ? await startOpenClawMcpRelay({
    connector, bearerToken: relayToken,
    port: env.OPENCLAW_MCP_RELAY_PORT ? Number(env.OPENCLAW_MCP_RELAY_PORT) : 8788,
    allowCollaborationWrites: writeEnabled,
    ...(writeEnabled ? { onSuccessfulWrite: async (name: string, args: Record<string, unknown>) => {
      const messageId = mcpReplyMessageId(name, args);
      if (messageId) await store.markMcpReplySent(messageId);
    } } : {})
  }) : null;
  return { connector, store, close: async () => { await relay?.close(); } };
}
