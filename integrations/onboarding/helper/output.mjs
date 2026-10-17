import { readFile } from 'node:fs/promises';

export async function loadContract(supplied) {
  if (supplied) return supplied;
  // Source development reads the canonical publication; the distribution injects
  // this same JSON at build time rather than maintaining a second policy table.
  return JSON.parse(await readFile(new URL('../../../test/contract-fixtures/agent-registration/schemas.json', import.meta.url), 'utf8'));
}

export function safeOutput(contract, values, secrets = []) {
  const policy = contract['x-model-visible'];
  const allowed = new Set([...Object.keys(policy.serverDerived), ...Object.keys(policy.helperDerived)]);
  const result = {};
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key) || value === undefined) continue;
    const strings = Array.isArray(value) ? value : [value];
    if (strings.some(item => typeof item === 'string' && (
      /[\u0000-\u001f\u007f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(item)
      || (key !== 'state' && /envoi_(?:reg|agent_access|agent_refresh|mcp)_|(?:registration|installation|credential_family|inbox|agent)_[A-Za-z0-9]/.test(item))
      || secrets.some(secret => typeof secret === 'string' && secret.length >= 8 && item.includes(secret))
      || (key !== 'agentAddress' && /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(item))
    ))) throw new Error('UNSAFE_PROJECTION');
    if (['agentName', 'workspaceName'].includes(key) && (typeof value !== 'string' || !value || value.length > 80)) throw new Error('INVALID_PROJECTION');
    const rule = policy.helperDerived[key];
    if (rule?.enum && !rule.enum.includes(value)) throw new Error('INVALID_PROJECTION');
    if (rule?.maxLength && (typeof value !== 'string' || value.length > rule.maxLength)) throw new Error('INVALID_PROJECTION');
    result[key] = value;
  }
  return result;
}

export function failureOutput(contract, state = 'needs_help', guidance = 'update_helper') {
  return safeOutput(contract, { schemaVersion: '1', state, guidance,
    nextAction: state === 'degraded' ? 'Envoi is unavailable. Resume this saved setup after its retry delay.'
      : 'Setup needs attention. Preserve the private state and ask the owner to review the connection.' });
}
