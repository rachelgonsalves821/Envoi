import { enrollConnector, SinaloaConnector } from '../../sdk/typescript/src/connector';
import { bridgeHandler } from '../agent-bridges/bridge';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { xaiTurn } from '../agent-bridges/providers';

async function main() {
  const apiUrl = process.env.SINALOA_API_URL;
  const stateDir = process.env.SINALOA_STATE_DIR;
  const apiKey = process.env.XAI_API_KEY;
  if (!apiUrl || !stateDir || !apiKey) throw new Error('SINALOA_API_URL, SINALOA_STATE_DIR and XAI_API_KEY are required');
  const store = new FileBridgeStore(stateDir);
  await store.init();
  if (!await store.load()) {
    const code = process.env.SINALOA_ENROLLMENT_TOKEN;
    if (!code) throw new Error('SINALOA_ENROLLMENT_TOKEN is required for first enrollment');
    await enrollConnector(apiUrl, code, store, { name: process.env.SINALOA_AGENT_NAME || 'Grok bridge' });
  }
  let connector: SinaloaConnector;
  const turn = xaiTurn({
    apiKey, model: process.env.XAI_MODEL || 'grok-4.7',
    history: caseId => connector.listCaseMessages(caseId, 20),
    ...(process.env.SINALOA_MCP_URL ? { mcp: {
      serverUrl: process.env.SINALOA_MCP_URL,
      // The five-minute token is limited to this case and read tools; the refresh token stays local.
      accessToken: async caseId => (await connector.mintMcpReadToken(caseId)).mcpAccessToken
    } } : {})
  });
  connector = new SinaloaConnector(apiUrl, store, { handler: bridgeHandler(store, turn) });
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  await connector.run(stop.signal);
}

main().catch(() => { process.stderr.write('Grok bridge stopped; inspect local configuration, provider health and credential status.\n'); process.exitCode = 1; });
