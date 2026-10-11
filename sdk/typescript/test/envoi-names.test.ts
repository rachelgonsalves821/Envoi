import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as protocol from '../src/index';
import * as connector from '../src/connector';
import { xaiTurn } from '../../../integrations/agent-bridges/providers';
import { loadContractFixture, contractRegistry } from '../../../integrations/contract-fixtures/setup';
// Exercise the real credential parser and rejected old credentials with all eight fixtures.
import '../reviews/envoi-names.review';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const contract = contractRegistry.contracts.find(item => item.id === 'envoi-names')!;
const schemas = loadContractFixture(contract, contract.schemas!) as any;
const names = new Set<string>(Object.values(schemas['x-tool-names']));
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'dist' ? [] : sources(filename);
    return /\.(ts|ps1|md)$/.test(entry.name) && !entry.name.includes('.test.') ? [filename] : [];
  });
}
describe('Envoi clean-cutover clients', () => {
  it('exports only the new package and class names', () => {
    expect(JSON.parse(readFileSync(path.join(root, 'sdk/typescript/package.json'), 'utf8')).name).toBe('@envoi/protocol');
    expect(protocol.EnvoiClient.name).toBe('EnvoiClient'); expect(protocol.EnvoiError.name).toBe('EnvoiError');
    expect(connector.EnvoiConnector.name).toBe('EnvoiConnector');
    expect('SinaloaClient' in protocol || 'SinaloaError' in protocol || 'SinaloaConnector' in connector).toBe(false);
  });
  it('uses only the published tool names in all adapters, prompts, relays and guides', () => {
    const suffixes = [...names].map(name => name.slice('envoi_'.length)).join('|');
    const matcher = new RegExp(`(?:sinaloa|envoi)_(?:${suffixes})\\b`, 'g');
    let count = 0;
    for (const runtime of ['agent-bridges', 'hermes', 'openclaw', 'grok']) {
      for (const filename of sources(path.join(root, 'integrations', runtime))) {
        for (const match of readFileSync(filename, 'utf8').matchAll(matcher)) { expect(names.has(match[0]), filename).toBe(true); count++; }
      }
    }
    expect(count).toBeGreaterThan(30);
  });
  it('rejects retired and unknown provider tool names before sending a request', () => {
    for (const name of ['sinaloa_agent_info', 'envoi_unknown', 'envoi_send_message'])
      expect(() => xaiTurn({ apiKey: 'local-key', model: 'local-model', mcp: { serverUrl: 'https://api.example/mcp', accessToken: async () => 'access', allowedTools: [name] } })).toThrow('published Envoi names');
  });
});
