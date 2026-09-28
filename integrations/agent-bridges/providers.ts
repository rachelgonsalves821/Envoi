import type { WorkMessage } from '../../sdk/typescript/src/connector';
import { parseAgentReply, workPrompt, type AgentTurn } from './bridge';

type History = (caseId: string) => Promise<Array<Record<string, unknown>>>;

export function xaiTurn(options: { apiKey: string; model: string; history?: History; fetch?: typeof fetch; endpoint?: string }): AgentTurn {
  if (!options.apiKey || !options.model) throw new TypeError('xAI API key and model are required');
  const endpoint = options.endpoint || 'https://api.x.ai/v1/responses';
  const target = new URL(endpoint);
  if (!(target.protocol === 'https:' && target.hostname === 'api.x.ai') && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname))) {
    throw new TypeError('xAI endpoint must be api.x.ai (or local test server)');
  }
  return async (message: WorkMessage, signal: AbortSignal) => {
    const history = message.caseId && options.history ? await options.history(message.caseId) : [];
    let response: Response;
    try {
      response = await (options.fetch || fetch)(endpoint, {
        method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), redirect: 'error',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: options.model, input: workPrompt(message, history), store: false })
      });
    } catch { throw new Error('xAI request could not be completed'); }
    if (!response.ok) throw new Error(`xAI response failed with HTTP ${response.status}`);
    let data: Record<string, unknown>;
    try { data = await response.json() as Record<string, unknown>; }
    catch { throw new Error('xAI returned an invalid response'); }
    if (data.status !== 'completed' || !Array.isArray(data.output)) throw new Error('xAI response was not completed');
    const text = (data.output as Array<Record<string, unknown>>)
      .filter(item => item.type === 'message' && Array.isArray(item.content))
      .flatMap(item => item.content as Array<Record<string, unknown>>)
      .filter(item => item.type === 'output_text' && typeof item.text === 'string')
      .map(item => item.text as string).join('\n').trim();
    return parseAgentReply(text);
  };
}
