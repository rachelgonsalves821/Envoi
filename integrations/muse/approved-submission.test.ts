import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { approvedProviderFixture as fixture } from '../contract-fixtures/approved-provider-fixture';

const packet = readFileSync(new URL('./CONNECTOR-SUBMISSION-READINESS.md', import.meta.url), 'utf8');
describe('Muse packet consumes approved classification rather than inventing a new action contract', () => {
  const schema = fixture('provider-connector-tools', 'schemas');
  it('includes every exact minimum tool and the chosen honest grant option', () => {
    for (const name of schema['x-minimum-submission-set'].tools) expect(packet).toContain(`\`${name}\``);
    expect(packet).toContain('**option A**'); expect(packet).toContain('**not read-only**');
    expect(packet).toContain('optional `envoi.send`');
    expect(packet).toContain('**no additional provider action contract is needed for this set**');
  });
  it('calls claim/settlement writes and outward replies sensitive writes without bypassing prompts', () => {
    const classification = schema['x-tool-classification'];
    expect(classification.find((tool: any) => tool.name === 'envoi_send_message').effect).toBe('sensitive_write');
    for (const name of ['envoi_claim_work', 'envoi_renew_work', 'envoi_complete_work']) {
      expect(classification.find((tool: any) => tool.name === name).effect).toBe('write');
    }
    expect(packet).toContain('A provider approval never satisfies an Envoi human decision.');
    expect(packet).toContain('M1:'); expect(packet).toContain('M5:'); expect(packet).toContain('**UNPROVEN**');
  });
});
