import path from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { ConnectorSetupError, type AdapterContext, type ConnectorAdapter } from '../connector/adapter';
import { privateJson } from '../openclaw/quick-connect-store';
import { discoverHermes, hermesServerName, mergeMcpConfiguration, optionalText, replaceConfiguration, setEnvValue, type HermesConfiguration } from './config';
import { boundedHermesRun, preflightHermes } from './api';
import { createHermesBridge } from './runtime';

interface RelayState { version: 1; port: number; token: string; serverName: string }

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new ConnectorSetupError('RELAY_UNAVAILABLE', 'Could not allocate a private Hermes MCP relay port.');
  return address.port;
}

async function relayState(context: AdapterContext): Promise<RelayState> {
  const filename = path.join(context.stateDir, 'hermes-relay.json');
  const text = await optionalText(filename);
  if (text !== null) {
    let stored: RelayState;
    try { stored = JSON.parse(text) as RelayState; }
    catch { throw new ConnectorSetupError('STATE_INVALID', 'Hermes relay state is unreadable. Restore its private saved configuration.'); }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || stored.version !== 1 || !Number.isSafeInteger(stored.port) || stored.port < 1 || stored.port > 65535
      || !/^[a-f0-9]{64}$/.test(stored.token) || !/^sinaloa_[a-f0-9]{16}$/.test(stored.serverName)) {
      throw new ConnectorSetupError('STATE_INVALID', 'Hermes relay state is invalid. Restore its private saved configuration.');
    }
    return stored;
  }
  const serverName = hermesServerName(context.stateDir);
  const state: RelayState = { version: 1, port: await availablePort(), token: randomBytes(32).toString('hex'), serverName };
  await privateJson(filename, state);
  return state;
}

export async function configureHermes(config: HermesConfiguration, context: AdapterContext) {
  const relay = await relayState(context);
  const variable = `SINALOA_MCP_${relay.serverName.slice(8).toUpperCase()}`;
  const original = await optionalText(config.configPath);
  const block = [
    `  ${relay.serverName}:`, `    url: "http://127.0.0.1:${relay.port}/mcp"`, '    headers:',
    `      Authorization: "Bearer \${${variable}}"`, '    tools:',
    '      include: [sinaloa_agent_info, sinaloa_start_case, sinaloa_send_message, sinaloa_send_proposal, sinaloa_send_decision, sinaloa_list_cases, sinaloa_read_case, sinaloa_list_messages, sinaloa_list_assets, sinaloa_asset_download]',
    '      resources: false', '      prompts: false'
  ];
  const updated = mergeMcpConfiguration(original ?? '', relay.serverName, block);
  const envPath = path.join(config.home, '.env');
  const originalEnv = await optionalText(envPath);
  await replaceConfiguration(envPath, originalEnv, setEnvValue(originalEnv ?? '', variable, relay.token));
  await replaceConfiguration(config.configPath, original, updated);
}

export const hermesAdapter: ConnectorAdapter<HermesConfiguration> = {
  runtime: 'hermes', discover: discoverHermes, preflight: preflightHermes, configure: configureHermes,
  async createBridge(config, context) {
    const relay = await relayState(context);
    let observedInfo = 0;
    let bridge: Awaited<ReturnType<typeof createHermesBridge>>;
    try {
      bridge = await createHermesBridge({
        apiUrl: context.apiUrl, stateDir: context.stateDir, hermesUrl: config.apiUrl, hermesKey: config.apiKey,
        relayToken: relay.token, relayPort: relay.port, writeEnabled: true
      }, { env: { ...(context.env ?? process.env), SINALOA_ASSET_MANIFEST_PATH: config.assetManifestPath }, fetch: context.fetch, pollIntervalMs: context.pollIntervalMs,
        onSuccessfulToolCall(name) { if (name === 'sinaloa_agent_info') observedInfo++; }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new ConnectorSetupError('RELAY_UNAVAILABLE', 'This Hermes connection relay port is occupied. Stop its prior connector or the conflicting process, then retry with the same state directory.');
      throw error;
    }
    return { connector: bridge.connector, close: bridge.close, async verify() {
      const before = observedInfo;
      await boundedHermesRun(config,
        `Envoi setup verification. Call the sinaloa_agent_info MCP tool from server ${relay.serverName} exactly once, then finish. Use its discovered tool name. Do not send messages, invoke terminal commands, or change files.`, context);
      if (observedInfo <= before) throw new ConnectorSetupError('TOOLS_NOT_READY', 'Hermes did not invoke the configured Envoi identity tool. Start a fresh API session, or restart the selected profile Gateway from a separate terminal to load its MCP configuration, then rerun setup using the same state directory. Enrollment is saved; do not create another token.');
    } };
  },
  describe(config) { return { runtime: 'hermes', profile: config.profile, gatewayUrl: config.apiUrl, configPath: config.configPath }; }
};
