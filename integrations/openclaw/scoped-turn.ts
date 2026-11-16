import { responsesScopedTurn } from '../agent-bridges/responses-turn';
import type { ScopedRunStore } from '../grok/scoped-store';

const conditionalToolDescriptions: Readonly<Record<string, string>> = {
  envoi_case_list_assets: 'List assets with optional limit and before, or inspect one asset with assetRef. Use includeContent only with assetRef. Omit limit and before when using assetRef.',
  envoi_case_decide: 'For accept, supply optionRef and authorityRef and omit terms. For counter, supply terms and omit optionRef and authorityRef. For reject, omit all three.',
  envoi_authority_check: 'For accept_proposal, supply proposalRef and optionRef and omit result. For complete_case, supply result and omit proposalRef and optionRef.',
};

function providerTool(tool: { type: string; name: string; parameters: Readonly<Record<string, unknown>> }) {
  // The Anthropic transport rejects root combinators in custom tool schemas.
  // This projects the model's schema only. CaseToolsClient still validates
  // every call against the complete canonical schema before forwarding it.
  const { allOf, anyOf, oneOf, ...parameters } = tool.parameters;
  if (allOf === undefined && anyOf === undefined && oneOf === undefined) return tool;
  const description = conditionalToolDescriptions[tool.name];
  if (!description || anyOf !== undefined || oneOf !== undefined) throw new TypeError('Unsupported OpenClaw case tool schema');
  return { ...tool, description, parameters };
}

export function openClawScopedTurn(options: {
  gatewayUrl: string;
  gatewayToken: string;
  agentId: string;
  store: ScopedRunStore;
  fetch?: typeof fetch;
}) {
  const gateway = new URL(options.gatewayUrl);
  if (gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== '/'
    || !(gateway.protocol === 'https:' || gateway.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname))) {
    throw new TypeError('OpenClaw scoped Gateway must be an HTTPS or loopback HTTP origin');
  }
  if (!options.gatewayToken || /[\r\n]/.test(options.gatewayToken)) throw new TypeError('OpenClaw Gateway token is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.agentId)) throw new TypeError('A configured OpenClaw agent ID is required');
  const model = `openclaw/${options.agentId}`;
  return responsesScopedTurn({
    model, identity: `openclaw:${gateway.origin}:${options.agentId}`, label: 'OpenClaw', store: options.store, maxCallsPerResponse: 16,
    request: (body, signal) => (options.fetch ?? fetch)(`${gateway.origin}/v1/responses`, {
      method: 'POST', redirect: 'error', signal,
      headers: { authorization: `Bearer ${options.gatewayToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: body.model, store: false, stream: false, max_output_tokens: body.max_output_tokens,
        tools: (body.tools as Parameters<typeof providerTool>[0][]).map(providerTool),
        input: (body.input as Array<Record<string, unknown>>).map(item => item.type === undefined && typeof item.role === 'string'
          ? { type: 'message', ...item } : item)
      })
    })
  });
}
