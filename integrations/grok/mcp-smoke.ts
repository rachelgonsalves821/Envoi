import { pathToFileURL } from 'node:url';
import { SinaloaConnector } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from '../agent-bridges/file-store';

export interface XaiMcpProbeOptions {
  apiKey: string;
  model: string;
  mcpUrl: string;
  accessToken: string;
  expectedAddress: string;
  fetch?: typeof fetch;
  endpoint?: string;
}

export interface XaiCaseAssetProbeOptions extends Omit<XaiMcpProbeOptions, 'expectedAddress'> {
  caseId: string;
  expectedAssetId: string;
}

/** Checks provider execution evidence, not merely the outgoing MCP request shape. */
export async function probeXaiMcp(options: XaiMcpProbeOptions): Promise<void> {
  await runProbe(options, 'sinaloa_agent_info',
    'Call the sinaloa_agent_info MCP tool now. Then report the exact agent address returned by that tool. Do not guess an address.',
    options.expectedAddress, 'agent address');
}

/** The expected asset ID is kept out of the model request and checked only on return. */
export async function probeXaiCaseAssetMcp(options: XaiCaseAssetProbeOptions): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.caseId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(options.expectedAssetId)) {
    throw new TypeError('A valid case ID and expected asset ID are required');
  }
  await runProbe(options, 'sinaloa_list_messages',
    `Call sinaloa_list_messages for case ${options.caseId}. Find the native message announcing a shared file, then report its exact asset ID. Do not guess an ID.`,
    options.expectedAssetId, 'asset ID');
}

async function runProbe(options: Omit<XaiMcpProbeOptions, 'expectedAddress'>, tool: string,
  prompt: string, expected: string | undefined, resultName: string): Promise<void> {
  const target = new URL(options.mcpUrl);
  if (target.pathname !== '/mcp' || !(
    target.protocol === 'https:' ||
    (target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname))
  )) throw new TypeError('MCP URL must be an HTTPS /mcp endpoint');
  if (!options.apiKey || !options.accessToken || /[\r\n]/.test(options.accessToken) || !expected) {
    throw new TypeError('Live xAI and current Sinaloa agent credentials are required');
  }
  const endpoint = options.endpoint || 'https://api.x.ai/v1/responses';
  const xai = new URL(endpoint);
  if (!(xai.protocol === 'https:' && xai.hostname === 'api.x.ai') && !(
    xai.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(xai.hostname)
  )) throw new TypeError('xAI endpoint must be api.x.ai');

  let response: Response;
  try {
    response = await (options.fetch || fetch)(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model, store: false,
        input: prompt,
        tools: [{ type: 'mcp', server_url: options.mcpUrl, server_label: 'sinaloa',
          authorization: `Bearer ${options.accessToken}`, allowed_tools: [tool] }]
      })
    });
  } catch { throw new Error('xAI MCP probe request could not be completed'); }
  if (!response.ok) throw new Error(`xAI MCP probe failed with HTTP ${response.status}`);
  let data: Record<string, unknown>;
  try { data = await response.json() as Record<string, unknown>; }
  catch { throw new Error('xAI MCP probe returned invalid JSON'); }
  if (data.status !== 'completed' || !Array.isArray(data.output)) throw new Error('xAI MCP probe did not complete');
  const output = data.output as Array<Record<string, unknown>>;
  const calls = output.filter(item => item.type === 'mcp_call');
  const invoked = calls.some(item =>
    typeof item.name === 'string' && (item.name === tool || item.name === `sinaloa.${tool}`) &&
    (item.server_label === undefined || item.server_label === 'sinaloa') &&
    item.error == null && item.status === 'completed'
  );
  if (!invoked) throw new Error(`xAI returned no successful ${tool} MCP call`);
  const answer = output.filter(item => item.type === 'message' && Array.isArray(item.content))
    .flatMap(item => item.content as Array<Record<string, unknown>>)
    .filter(item => item.type === 'output_text' && typeof item.text === 'string')
    .map(item => item.text as string).join('\n');
  if (!answer.includes(expected)) throw new Error(`xAI did not report the ${resultName} returned by MCP`);
}

async function main() {
  const apiUrl = process.env.SINALOA_API_URL;
  const stateDir = process.env.SINALOA_STATE_DIR;
  const apiKey = process.env.XAI_API_KEY;
  const mcpUrl = process.env.SINALOA_MCP_URL;
  if (!apiUrl || !stateDir || !apiKey || !mcpUrl) {
    throw new Error('SINALOA_API_URL, SINALOA_STATE_DIR, XAI_API_KEY and SINALOA_MCP_URL are required');
  }
  const store = new FileBridgeStore(stateDir);
  await store.init();
  const connector = new SinaloaConnector(apiUrl, store);
  const caseId = process.env.SINALOA_CASE_ID;
  const expectedAssetId = process.env.SINALOA_EXPECTED_ASSET_ID;
  if (Boolean(caseId) !== Boolean(expectedAssetId)) {
    throw new Error('SINALOA_CASE_ID and SINALOA_EXPECTED_ASSET_ID must be set together');
  }
  const accessToken = (await connector.mintMcpReadToken(caseId || null)).mcpAccessToken;
  const session = await store.load();
  if (!session?.address) throw new Error('Enrolled Sinaloa session is required');
  const base = { apiKey, model: process.env.XAI_MODEL || 'grok-4.7', mcpUrl, accessToken };
  if (caseId && expectedAssetId) {
    await probeXaiCaseAssetMcp({ ...base, caseId, expectedAssetId });
    process.stdout.write('xAI read the case file announcement through hosted MCP and returned its asset ID.\n');
  } else {
    await probeXaiMcp({ ...base, expectedAddress: session.address });
    process.stdout.write('xAI invoked Sinaloa agent_info through hosted MCP and returned the enrolled agent address.\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('xAI MCP invocation probe failed; inspect provider access, hosted /mcp reachability and credential status.\n');
    process.exitCode = 1;
  });
}
