import { responsesScopedTurn } from '../agent-bridges/responses-turn';
import type { ScopedRunStore } from '../grok/scoped-store';

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
        tools: body.tools,
        input: (body.input as Array<Record<string, unknown>>).map(item => item.type === undefined && typeof item.role === 'string'
          ? { type: 'message', ...item } : item)
      })
    })
  });
}
