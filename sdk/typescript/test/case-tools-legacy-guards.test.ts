import { describe, expect, it } from 'vitest';
import { workPrompt } from '../../../integrations/agent-bridges/bridge';
import { authorizedHermesReply } from '../../../integrations/hermes/lease-write';
import { contractRegistry, loadContractFixture } from '../../../integrations/contract-fixtures/setup';
import type { WorkMessage } from '../src/connector';

const contract = contractRegistry.contracts.find(entry => entry.id === 'case-session')!;
const work = () => (loadContractFixture(contract, 'claimed-human-decision.json') as Record<string, any>).response.body.work;

describe('legacy runtime protection for new human decisions', () => {
  it('never stitches the private decision envelope into a legacy model prompt', () => {
    expect(() => workPrompt(work().message as WorkMessage)).toThrow('Human decisions require the scoped tool runtime');
  });

  it('never converts a human decision into a legacy sender-address write', () => {
    const message = work().message as WorkMessage;
    expect(authorizedHermesReply({ message, signal: new AbortController().signal }, 'envoi_send_message', {
      idempotencyKey: `bridge:${message.id}:reply:1`, caseId: message.caseId, recipientAddress: message.counterpartyAddress
    })).toBe(false);
  });
});
