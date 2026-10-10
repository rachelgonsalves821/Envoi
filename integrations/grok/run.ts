import { enrollConnector } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { createGrokBridge } from './runtime';
import { migrateConnectionDirectory } from '../connector/migrate';

async function main() {
  const apiUrl = process.env.ENVOI_API_URL;
  const requested = process.env.ENVOI_STATE_DIR;
  const stateDir = requested ? await migrateConnectionDirectory(requested) : undefined;
  const apiKey = process.env.XAI_API_KEY;
  if (!apiUrl || !stateDir || !apiKey) throw new Error('ENVOI_API_URL, ENVOI_STATE_DIR and XAI_API_KEY are required');
  const store = new FileBridgeStore(stateDir);
  await store.init();
  if (!await store.load()) {
    const code = process.env.ENVOI_ENROLLMENT_TOKEN;
    if (!code) throw new Error('ENVOI_ENROLLMENT_TOKEN is required for first enrollment');
    await enrollConnector(apiUrl, code, store, { name: process.env.ENVOI_AGENT_NAME || 'Grok bridge' });
  }
  const bridge = await createGrokBridge({ apiUrl, stateDir, apiKey, model: process.env.XAI_MODEL || 'grok-4.7' });
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  try { await bridge.connector.run(stop.signal); }
  finally { await bridge.close(); }
}

main().catch(() => { process.stderr.write('Grok bridge stopped; inspect local configuration, provider health and credential status.\n'); process.exitCode = 1; });
