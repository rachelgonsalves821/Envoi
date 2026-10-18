import { describe, expect, it } from 'vitest';
import schema from '../src/case-tools-schema.json';
import { contractRegistry, loadContractFixture } from '../../../integrations/contract-fixtures/setup';

describe('approved case-tool client schema artifact', () => {
  it('is exactly the model-schema closure of the canonical publication, not a fixture copy', () => {
    const contract = contractRegistry.contracts.find(entry => entry.id === 'case-tools')!;
    const canonical = loadContractFixture(contract, contract.schemas!) as Record<string, any>;
    const definitions: Record<string, any> = {};
    const include = (value: any) => {
      if (!value || typeof value !== 'object') return;
      if (value.$ref) {
        const name = value.$ref.split('/').pop();
        if (!definitions[name]) { definitions[name] = canonical.definitions[name]; include(definitions[name]); }
      }
      for (const child of Object.values(value)) include(child);
    };
    const tools = canonical['x-tools'].map((tool: any) => {
      if (!definitions[tool.resultSchema]) { definitions[tool.resultSchema] = canonical.definitions[tool.resultSchema]; include(definitions[tool.resultSchema]); }
      include(tool.inputSchema);
      return { name: tool.name, inputSchema: tool.inputSchema, resultSchema: tool.resultSchema, writes: tool.writes };
    });
    for (const name of ['toolErrorEnvelope', 'mcpToolCallResult', 'jsonRpcError']) { definitions[name] = canonical.definitions[name]; include(definitions[name]); }
    expect(schema).toEqual({ contract: 'case-tools', version: 1, publicationSha: '15fff09f336fe941858287511471b07b9f5184f8', tools,
      schema: { $schema: 'http://json-schema.org/draft-07/schema#', definitions } });
    expect(schema.schema.definitions).not.toHaveProperty('fixture');
    expect(Object.keys(schema.schema.definitions).some(name => name.startsWith('fixture'))).toBe(false);
    for (const tool of schema.tools) expect(tool.inputSchema.properties).not.toHaveProperty('authorization');
  });
});
