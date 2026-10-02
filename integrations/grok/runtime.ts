import { SinaloaConnector, type ConnectorOptions } from '../../sdk/typescript/src/connector';
import { bridgeHandler } from '../agent-bridges/bridge';
import { loadAssetManifest, manifestAssetExchange } from '../agent-bridges/asset-manifest';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { xaiTurn } from '../agent-bridges/providers';

export interface GrokBridgeConfiguration {
  apiUrl: string;
  stateDir: string;
  apiKey: string;
  model: string;
  mcpUrl?: string;
  assetManifestPath?: string;
}

/** Manual setup and the unified installer use the same durable claim/reply pipeline. */
export async function createGrokBridge(config: GrokBridgeConfiguration,
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; pollIntervalMs?: number } = {}) {
  const env = options.env ?? process.env;
  const store = new FileBridgeStore(config.stateDir);
  await store.init();
  if (!await store.load()) throw new Error('No connector credentials were saved. Run setup first');
  let connector: SinaloaConnector;
  const approvedAssets = await loadAssetManifest(config.assetManifestPath ?? env.SINALOA_ASSET_MANIFEST_PATH);
  const mcpUrl = config.mcpUrl ?? env.ENVOI_MCP_URL ?? env.SINALOA_MCP_URL;
  const turn = xaiTurn({
    apiKey: config.apiKey, model: config.model,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    history: caseId => connector.listCaseMessages(caseId, 20),
    assetHandles: [...approvedAssets.values()].map(({ handle, filename }) => ({ handle, filename })),
    ...(mcpUrl ? { mcp: {
      serverUrl: mcpUrl,
      // Only the five-minute, case-scoped read token goes to the provider.
      accessToken: async caseId => (await connector.mintMcpReadToken(caseId)).mcpAccessToken
    } } : {})
  });
  const connectorOptions: ConnectorOptions = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
    handler: bridgeHandler(store, turn, approvedAssets.size
      ? (message, reply, key, signal) => manifestAssetExchange(approvedAssets, connector)(message, reply, key, signal) : undefined)
  };
  connector = new SinaloaConnector(config.apiUrl, store, connectorOptions);
  return { connector, store, close: async () => {} };
}
