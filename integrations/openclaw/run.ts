import { enrollConnector, SinaloaConnector } from '../../sdk/typescript/src/connector';
import { bridgeHandler } from '../agent-bridges/bridge';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { startOpenClawMcpRelay } from './mcp-relay';
import { mcpReplyMessageId, openClawTurn, withRecordedMcpReply } from './turn';

async function main() {
  const apiUrl = process.env.SINALOA_API_URL;
  const stateDir = process.env.SINALOA_STATE_DIR;
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const agentId = process.env.OPENCLAW_AGENT_ID;
  if (!apiUrl || !stateDir || !gatewayUrl || !gatewayToken || !agentId) {
    throw new Error('SINALOA_API_URL, SINALOA_STATE_DIR, OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN and OPENCLAW_AGENT_ID are required');
  }

  const store = new FileBridgeStore(stateDir);
  await store.init();
  if (!await store.load()) {
    const code = process.env.SINALOA_ENROLLMENT_TOKEN;
    if (!code) throw new Error('SINALOA_ENROLLMENT_TOKEN is required for first enrollment');
    await enrollConnector(apiUrl, code, store, { name: process.env.SINALOA_AGENT_NAME || 'OpenClaw bridge' });
  }

  let connector: SinaloaConnector;
  const writeEnabled = process.env.OPENCLAW_MCP_WRITE_ENABLED === 'true';
  const gatewayTurn = openClawTurn({
    gatewayUrl,
    gatewayToken,
    agentId,
    allowSinaloaMcpWrites: writeEnabled,
    history: caseId => connector.listCaseMessages(caseId, 20)
  });
  const turn = writeEnabled ? withRecordedMcpReply(gatewayTurn, messageId => store.mcpReplySent(messageId)) : gatewayTurn;
  connector = new SinaloaConnector(apiUrl, store, { handler: bridgeHandler(store, turn) });

  const relayToken = process.env.OPENCLAW_MCP_RELAY_TOKEN;
  if (process.env.OPENCLAW_MCP_RELAY_PORT && !relayToken) throw new Error('OPENCLAW_MCP_RELAY_TOKEN is required when the relay port is configured');
  if (process.env.OPENCLAW_MCP_WRITE_ENABLED && process.env.OPENCLAW_MCP_WRITE_ENABLED !== 'true') throw new Error('OPENCLAW_MCP_WRITE_ENABLED must be true when set');
  if (process.env.OPENCLAW_MCP_WRITE_ENABLED && !relayToken) throw new Error('OPENCLAW_MCP_RELAY_TOKEN is required for MCP writes');
  const relay = relayToken ? await startOpenClawMcpRelay({
    connector,
    bearerToken: relayToken,
    port: process.env.OPENCLAW_MCP_RELAY_PORT ? Number(process.env.OPENCLAW_MCP_RELAY_PORT) : 8788,
    allowCollaborationWrites: writeEnabled,
    ...(writeEnabled ? { onSuccessfulWrite: async (name: string, args: Record<string, unknown>) => {
      const messageId = mcpReplyMessageId(name, args);
      if (messageId) await store.markMcpReplySent(messageId);
    } } : {})
  }) : null;

  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  try { await connector.run(stop.signal); }
  finally { await relay?.close(); }
}

main().catch(() => {
  process.stderr.write('OpenClaw bridge stopped; inspect local configuration, Gateway health and credential status.\n');
  process.exitCode = 1;
});
