import { enrollConnector, SinaloaConnector } from '../../sdk/typescript/src/connector';
import { bridgeHandler } from '../agent-bridges/bridge';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { openClawTurn } from './turn';

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
  const turn = openClawTurn({
    gatewayUrl,
    gatewayToken,
    agentId,
    history: caseId => connector.listCaseMessages(caseId, 20)
  });
  connector = new SinaloaConnector(apiUrl, store, { handler: bridgeHandler(store, turn) });

  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  await connector.run(stop.signal);
}

main().catch(() => {
  process.stderr.write('OpenClaw bridge stopped; inspect local configuration, Gateway health and credential status.\n');
  process.exitCode = 1;
});
