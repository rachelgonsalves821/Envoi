import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExchangeLedgerEvent, ProposalHistory, ReceiptCard } from '../src/App';
import type { HumanView, WorkCase } from '../src/types';

describe('two-owner native case presentation', () => {
  it('shows identical structured terms, decision and final outcome to both owners', () => {
    const workCase = {
      id: 'case_shared', state: 'completed', actingAgent: 'agent_alice', participants: ['agent_alice', 'agent_bob'],
      proposals: [{ id: 'proposal_1', kind: 'negotiation', status: 'accepted', expiresAt: null,
        options: [
          { id: 'option_42', value: { answer: '42', currency: 'CAD' }, sourceConfidence: 'enteredForCase', expired: true },
          { id: 'option_43', value: { answer: '43', currency: 'CAD' }, sourceConfidence: 'enteredForCase', expired: false }
        ] }],
      receipt: { id: 'receipt_1', result: 'Joint answer 43 complete', authorityBasis: 'action_approved', humanApprovalStatus: 'approved', createdAt: '2026-09-29T12:00:00Z' },
      events: [{ id: 'evt_decision', type: 'decision', actor: 'agent_alice', createdAt: '2026-09-29T11:00:00Z',
        payload: { messageType: 'decision', data: { decision: { kind: 'accept', proposalMessageId: 'msg_counter' } }, proposalId: 'proposal_1' }, linkedPolicyEvaluation: null, precedingEventRef: null }]
    } as WorkCase;
    const agents = [
      { id: 'agent_alice', name: 'Alice agent', address: 'alice@agents.sinaloa-inbox.com' },
      { id: 'agent_bob', name: 'Bob agent', address: 'bob@agents.sinaloa-inbox.com' }
    ];
    for (const ownerAgentId of ['agent_alice', 'agent_bob']) {
      const view = { agents, participantDirectory: {}, inbox: { ownerAgentId } } as HumanView;
      const proposal = renderToStaticMarkup(createElement(ProposalHistory, { workCase, view, events: workCase.events }));
      const decision = renderToStaticMarkup(createElement(ExchangeLedgerEvent, { event: workCase.events[0], view, workCase }));
      const receipt = renderToStaticMarkup(createElement(ReceiptCard, { workCase }));
      expect(proposal).toContain('Offers and counteroffers');
      expect(proposal).toContain('Accepted');
      expect(proposal).toContain('Answer');
      expect(proposal).toContain('42');
      expect(proposal).toContain('43');
      expect(proposal).toContain('CAD');
      expect(decision).toContain('Decision: Accept');
      expect(receipt).toContain('Joint answer 43 complete');
      expect(receipt).toContain('Human approval');
      expect(receipt).toContain('Approved');
    }
  });
});
