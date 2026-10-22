import { enrollConnector } from '../../sdk/typescript/src/connector';
import { pathToFileURL } from 'node:url';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { createOpenClawBridge } from './runtime';
import { migrateConnectionDirectory } from '../connector/migrate';
import { assertOpenClawScopedAdmission, openClawRuntimeEnvironment, saveOpenClawScopedMode } from './scoped-admission';
import { parseHostedWakeConfig, runHostedWake } from '../connector/hosted-wake-runner';
import { acquireConnectorLock, privateDirectory } from '../connector/store';

export async function runOpenClaw() {
  assertOpenClawScopedAdmission(process.env);
  const apiUrl = process.env.ENVOI_API_URL;
  const requested = process.env.ENVOI_STATE_DIR;
  const stateDir = requested ? await migrateConnectionDirectory(requested) : undefined;
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const agentId = process.env.OPENCLAW_AGENT_ID;
  if (!apiUrl || !stateDir || !gatewayUrl || !gatewayToken || !agentId) {
    throw new Error('ENVOI_API_URL, ENVOI_STATE_DIR, OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN and OPENCLAW_AGENT_ID are required');
  }
  const env = await openClawRuntimeEnvironment(stateDir, process.env);
  const wake = parseHostedWakeConfig(process.env);
  if (wake && env.ENVOI_SCOPED_TOOLS !== 'true') throw new Error('Hosted wake requires the scoped OpenClaw runtime');
  await privateDirectory(stateDir);
  const unlock = await acquireConnectorLock(stateDir);
  try {
    const store = new FileBridgeStore(stateDir);
    await store.init();
    await saveOpenClawScopedMode(stateDir, env);
    if (!await store.load()) {
      const code = process.env.ENVOI_ENROLLMENT_TOKEN;
      if (!code) throw new Error('ENVOI_ENROLLMENT_TOKEN is required for first enrollment');
      await enrollConnector(apiUrl, code, store, { name: process.env.ENVOI_AGENT_NAME || 'OpenClaw bridge' });
    }
    delete process.env.ENVOI_ENROLLMENT_TOKEN;
    const bridge = await createOpenClawBridge({ apiUrl, stateDir, gatewayUrl, gatewayToken, agentId }, { env });
    const stop = new AbortController();
    const onStop = () => stop.abort();
    process.once('SIGINT', onStop);
    process.once('SIGTERM', onStop);
    try {
      if (wake) {
        const session = await store.load();
        if (!session) throw new Error('Hosted wake requires saved connector identity');
        await runHostedWake({ connector: bridge.connector, session, stateDir, config: wake, signal: stop.signal });
      } else await bridge.connector.run(stop.signal);
    }
    finally { process.removeListener('SIGINT', onStop); process.removeListener('SIGTERM', onStop); await bridge.close(); }
  }
  finally { await unlock(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runOpenClaw().catch(() => {
  process.stderr.write('OpenClaw bridge stopped; inspect local configuration, Gateway health and credential status.\n');
  process.exitCode = 1;
});
