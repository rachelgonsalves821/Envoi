import { responsesScopedTurn } from '../agent-bridges/responses-turn';
import type { ScopedRunStore } from './scoped-store';

export function xaiScopedTurn(options: { apiKey: string; model: string; store: ScopedRunStore; fetch?: typeof fetch }) {
  if (!options.apiKey || /[\r\n]/.test(options.apiKey) || !options.model) throw new TypeError('xAI credentials and model are required');
  return responsesScopedTurn({
    model: options.model, label: 'xAI', store: options.store,
    request: (body, signal) => (options.fetch ?? fetch)('https://api.x.ai/v1/responses', {
      method: 'POST', redirect: 'error', signal,
      headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  });
}
