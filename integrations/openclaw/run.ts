import { enrollConnector } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { createOpenClawBridge } from './runtime';

async function main() {
  const apiUrl = process.env.ENVOI_API_URL || process.env.SINALOA_API_URL;
  const stateDir = process.env.ENVOI_STATE_DIR || process.env.SINALOA_STATE_DIR;
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const agentId = process.env.OPENCLAW_AGENT_ID;
  if (!apiUrl || !stateDir || !gatewayUrl || !gatewayToken || !agentId) {
    throw new Error('ENVOI_API_URL, ENVOI_STATE_DIR, OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN and OPENCLAW_AGENT_ID are required');
  }
  const store = new FileBridgeStore(stateDir);
  await store.init();
  if (!await store.load()) {
    const code = process.env.ENVOI_ENROLLMENT_TOKEN || process.env.SINALOA_ENROLLMENT_TOKEN;
    if (!code) throw new Error('ENVOI_ENROLLMENT_TOKEN is required for first enrollment');
    await enrollConnector(apiUrl, code, store, { name: process.env.ENVOI_AGENT_NAME || process.env.SINALOA_AGENT_NAME || 'OpenClaw bridge' });
  }
  const bridge = await createOpenClawBridge({ apiUrl, stateDir, gatewayUrl, gatewayToken, agentId });
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  try { await bridge.connector.run(stop.signal); }
  finally { await bridge.close(); }
}

main().catch(() => {
  process.stderr.write('OpenClaw bridge stopped; inspect local configuration, Gateway health and credential status.\n');
  process.exitCode = 1;
});
