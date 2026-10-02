import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SinaloaConnector } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { startOpenClawMcpRelay } from './mcp-relay';

export interface OpenClawMcpProbeOptions {
  connector: SinaloaConnector;
  expectedAddress: string;
  gatewayUrl: string;
  gatewayToken: string;
  agentId: string;
  relayToken: string;
  relayPort?: number;
  dispatchGateway?: (url: string, init: RequestInit, relayUrl: string) => Promise<Response>;
}

/** A local relay observation plus the Gateway's answer prove an internal MCP invocation. */
export async function probeOpenClawMcp(options: OpenClawMcpProbeOptions): Promise<void> {
  const gateway = new URL(options.gatewayUrl);
  if (gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== '/' || !(
    gateway.protocol === 'https:' || (gateway.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname))
  )) throw new TypeError('OpenClaw Gateway must be an HTTPS origin or loopback HTTP origin');
  if (!options.gatewayToken || !options.expectedAddress || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.agentId)) {
    throw new TypeError('OpenClaw Gateway credentials, agent ID and enrolled address are required');
  }
  let observed = 0;
  const relay = await startOpenClawMcpRelay({
    connector: options.connector, bearerToken: options.relayToken, port: options.relayPort,
    onSuccessfulToolCall: name => { if (name === 'sinaloa_agent_info') observed += 1; }
  });
  try {
    let response: Response;
    try {
      response = await (options.dispatchGateway || ((url, init) => fetch(url, init)))(
        `${gateway.origin}/v1/chat/completions`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
          headers: { authorization: `Bearer ${options.gatewayToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: `openclaw/${options.agentId}`, user: `sinaloa-mcp-probe:${randomUUID()}`,
            stream: false, messages: [{ role: 'user', content:
              'Call the sinaloa_agent_info MCP tool now, then report the exact agent address returned by that tool. Do not guess an address.' }] })
        }, relay.url
      );
    } catch { throw new Error('OpenClaw MCP probe could not reach the Gateway'); }
    if (!response.ok) throw new Error(`OpenClaw MCP probe failed with HTTP ${response.status}`);
    let payload: Record<string, unknown>;
    try { payload = await response.json() as Record<string, unknown>; }
    catch { throw new Error('OpenClaw MCP probe returned invalid JSON'); }
    const choices = payload.choices;
    const first = Array.isArray(choices) ? choices[0] as Record<string, unknown> | undefined : undefined;
    const message = first?.message as Record<string, unknown> | undefined;
    if (first?.finish_reason !== 'stop' || typeof message?.content !== 'string') {
      throw new Error('OpenClaw MCP probe did not return a completed answer');
    }
    if (observed < 1) throw new Error('Gateway answer had no successful Envoi MCP invocation through the relay');
    if (!message.content.includes(options.expectedAddress)) {
      throw new Error('Gateway did not report the address returned by Envoi MCP');
    }
  } finally { await relay.close(); }
}

async function main() {
  const apiUrl = process.env.SINALOA_API_URL;
  const stateDir = process.env.SINALOA_STATE_DIR;
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const agentId = process.env.OPENCLAW_AGENT_ID;
  const relayToken = process.env.OPENCLAW_MCP_RELAY_TOKEN;
  if (!apiUrl || !stateDir || !gatewayUrl || !gatewayToken || !agentId || !relayToken) {
    throw new Error('SINALOA_API_URL, SINALOA_STATE_DIR, OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN, OPENCLAW_AGENT_ID and OPENCLAW_MCP_RELAY_TOKEN are required');
  }
  const store = new FileBridgeStore(stateDir);
  await store.init();
  const session = await store.load();
  if (!session?.address) throw new Error('Enrolled Envoi session is required');
  await probeOpenClawMcp({ connector: new SinaloaConnector(apiUrl, store), expectedAddress: session.address,
    gatewayUrl, gatewayToken, agentId, relayToken,
    relayPort: process.env.OPENCLAW_MCP_RELAY_PORT ? Number(process.env.OPENCLAW_MCP_RELAY_PORT) : 8788 });
  process.stdout.write('OpenClaw Gateway invoked Envoi agent_info through the local MCP relay and returned the enrolled agent address.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('OpenClaw MCP invocation probe failed; inspect Gateway MCP configuration, loopback relay reachability and credential status.\n');
    process.exitCode = 1;
  });
}
