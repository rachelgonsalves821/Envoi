import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReceiptCard } from '../src/App';
import type { WorkCase } from '../src/types';

const workCase = (changes: Partial<WorkCase> = {}): WorkCase => ({
  id: 'case_one', state: 'inProgress', createdAt: '2026-10-17T12:00:00Z', receipt: null, ...changes
});
const render = (value: WorkCase) => renderToStaticMarkup(createElement(ReceiptCard, { workCase: value }));

describe('canonical case outcome presentation', () => {
  it.each(['inProgress', 'completed', 'waitingForHuman'] as const)('does not fabricate an outcome from %s or a processed work receipt', state => {
    const value = workCase({ state, events: [{ id: 'event_processed', type: 'receipt', actor: 'agent_one',
      createdAt: '2026-10-17T12:01:00Z', payload: { deliveryState: 'processed', messageId: 'message_one' },
      linkedPolicyEvaluation: null, precedingEventRef: null }] });
    expect(render(value)).toBe('');
  });

  it.each(['', '   '])('does not offer an export for an empty canonical result %j', result => {
    expect(render(workCase({ receipt: { id: 'receipt_one', result, authorityBasis: 'action_one', humanApprovalStatus: 'approved' } }))).toBe('');
  });

  it('renders the recorded result and evidence without claiming external execution or extra approval', () => {
    const value = workCase({ state: 'completed', receipt: { id: 'receipt_one', result: 'Agreement recorded',
      authorityBasis: 'action_approved', humanApprovalStatus: 'approved', evidenceRefs: ['asset_one'], createdAt: '2026-10-17T12:02:00Z' } });
    const html = render(value);
    expect(html).toContain('Agreement recorded');
    expect(html).toContain('Approved');
    expect(html).toContain('asset_one');
    expect(html).toContain('Not recorded');
    expect(html).toContain('Export');
    expect(html).not.toMatch(/Pay now|Approve again|Payment succeeded/);
  });

  it('treats untrusted outcome text as text rather than executable markup', () => {
    const html = render(workCase({ receipt: { id: 'receipt_one', result: '<script>steal()</script>', authorityBasis: 'action_one', humanApprovalStatus: 'notRequired' } }));
    expect(html).toContain('&lt;script&gt;steal()&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
});
