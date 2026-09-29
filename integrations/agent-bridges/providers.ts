import type { WorkMessage } from '../../sdk/typescript/src/connector';
import { parseAgentReply, workPrompt, type AgentTurn } from './bridge';

type History = (caseId: string) => Promise<Array<Record<string, unknown>>>;

type RemoteMcp = { serverUrl: string; accessToken: (caseId: string | null) => Promise<string>; allowedTools?: string[] };

export function xaiTurn(options: { apiKey: string; model: string; history?: History; fetch?: typeof fetch; endpoint?: string; mcp?: RemoteMcp }): AgentTurn {
  if (!options.apiKey || !options.model) throw new TypeError('xAI API key and model are required');
  const endpoint = options.endpoint || 'https://api.x.ai/v1/responses';
  const target = new URL(endpoint);
  if (!(target.protocol === 'https:' && target.hostname === 'api.x.ai') && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname))) {
    throw new TypeError('xAI endpoint must be api.x.ai (or local test server)');
  }
  if (options.mcp) {
    const server = new URL(options.mcp.serverUrl);
    if (server.pathname !== '/mcp' || !((server.protocol === 'https:') || (server.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(server.hostname)))) {
      throw new TypeError('MCP server must be an HTTPS /mcp endpoint (or local test server)');
    }
  }
  return async (message: WorkMessage, signal: AbortSignal) => {
    const history = message.caseId && options.history ? await options.history(message.caseId) : [];
    const requiredRead = message.caseId ? 'sinaloa_read_case' : 'sinaloa_agent_info';
    const prompt = workPrompt(message, history);
    const body: Record<string, unknown> = { model: options.model,
      input: options.mcp ? `${prompt}\n\nBefore responding, call ${requiredRead} through the Sinaloa MCP server${message.caseId ? ` for caseId ${JSON.stringify(message.caseId)}` : ''}. If the read fails, do not guess a reply.` : prompt,
      store: false };
    if (options.mcp) {
      const token = await options.mcp.accessToken(message.caseId || null);
      if (!token || /[\r\n]/.test(token)) throw new Error('Current Sinaloa MCP read token is unavailable');
      body.tools = [{
        type: 'mcp', server_url: options.mcp.serverUrl, server_label: 'sinaloa',
        authorization: `Bearer ${token}`,
        allowed_tools: options.mcp.allowedTools || (message.caseId
          ? ['sinaloa_agent_info', 'sinaloa_read_case', 'sinaloa_list_messages']
          : ['sinaloa_agent_info'])
      }];
    }
    let response: Response;
    try {
      response = await (options.fetch || fetch)(endpoint, {
        method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), redirect: 'error',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch { throw new Error('xAI request could not be completed'); }
    if (!response.ok) throw new Error(`xAI response failed with HTTP ${response.status}`);
    let data: Record<string, unknown>;
    try { data = await response.json() as Record<string, unknown>; }
    catch { throw new Error('xAI returned an invalid response'); }
    if (data.status !== 'completed' || !Array.isArray(data.output)) throw new Error('xAI response was not completed');
    if (options.mcp && !(data.output as Array<Record<string, unknown>>).some(item =>
      item.type === 'mcp_call' && (item.name === requiredRead || item.name === `sinaloa.${requiredRead}`) &&
      (item.server_label === undefined || item.server_label === 'sinaloa') &&
      item.status === 'completed' && item.error == null)) {
      throw new Error(`xAI did not complete the required Sinaloa MCP ${requiredRead} call`);
    }
    const text = (data.output as Array<Record<string, unknown>>)
      .filter(item => item.type === 'message' && Array.isArray(item.content))
      .flatMap(item => item.content as Array<Record<string, unknown>>)
      .filter(item => item.type === 'output_text' && typeof item.text === 'string')
      .map(item => item.text as string).join('\n').trim();
    return parseAgentReply(text);
  };
}
