import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const requiredContracts = ['case-session-v1', 'case-tools-v1', 'http-wake-v1'];

export const clientSurfaces = [
  'sdk/typescript/src/connector.ts',
  'sdk/typescript/src/lifecycle.ts',
  'sdk/typescript/src/index.ts',
  'sdk/python/envoi_protocol/__init__.py',
  'integrations/connector/adapter.ts',
  'integrations/agent-bridges/mcp-relay.ts',
  'integrations/agent-bridges/bridge.ts',
  'integrations/agent-bridges/providers.ts',
  'integrations/hermes/runtime.ts',
  'integrations/hermes/adapter.ts',
  'integrations/hermes/turn.ts',
  'integrations/hermes/lease-write.ts',
  'integrations/openclaw/runtime.ts',
  'integrations/openclaw/adapter.ts',
  'integrations/openclaw/turn.ts',
  'integrations/openclaw/mcp-relay.ts',
  'integrations/grok/runtime.ts',
  'integrations/grok/adapter.ts',
  'frontend/src/api.ts',
  'frontend/src/App.tsx',
  'frontend/src/model.ts',
  'frontend/src/conversation-timeline.ts'
];

async function fingerprint(root, relativePath) {
  try {
    const bytes = await readFile(path.join(root, relativePath));
    return { path: relativePath, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return { path: relativePath, status: 'unreadable' };
  }
}

export async function inspectSourceReadiness(root) {
  let entries;
  try {
    const registry = JSON.parse(await readFile(path.join(root, 'test/contract-fixtures/index.json'), 'utf8'));
    if (registry.version !== 1 || !Array.isArray(registry.contracts)) throw new Error();
    entries = registry.contracts;
  } catch {
    return { status: 'blocked', reason: 'contract_registry_unreadable', contracts: [], surfaces: [] };
  }

  const contracts = requiredContracts.map(id => {
    const matches = entries.filter(entry => entry?.id === id);
    if (!matches.length) return { id, status: 'missing' };
    if (matches.length !== 1) return { id, status: 'ambiguous' };
    const entry = matches[0];
    if (!Number.isSafeInteger(entry.version) || entry.version < 1
      || !['published', 'approved'].includes(entry.status)
      || !Array.isArray(entry.fixtures) || !entry.fixtures.length
      || !entry.fixtures.every(fixture => typeof fixture === 'string' && fixture.endsWith('.json'))) {
      return { id, status: 'invalid' };
    }
    return { id, status: 'requires_contract_review', version: entry.version, fixtureCount: entry.fixtures.length };
  });
  const surfaces = await Promise.all(clientSurfaces.map(relativePath => fingerprint(root, relativePath)));
  const blocked = contracts.some(contract => contract.status !== 'requires_contract_review')
    || surfaces.some(surface => surface.status === 'unreadable');
  return {
    status: blocked ? 'blocked' : 'review_required',
    reason: blocked ? 'missing_or_invalid_source_dependencies' : 'verify_contract_publication_approval_and_fixtures',
    scope: 'local_source_inventory_only',
    contracts,
    surfaces
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../../../', import.meta.url));
  const result = await inspectSourceReadiness(root);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'blocked' ? 2 : 0;
}
