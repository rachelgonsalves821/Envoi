import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownerAgentEvidence, downloadOwnerEvidence } from '../src/agent-evidence';
import { OwnerAgentExport } from '../src/OwnerAgentExport';
import type { Agent } from '../src/types';

const agent: Agent = {
  id: 'agent_example', name: 'Disposable', address: 'test@example.com', principalHumanId: 'human_owner',
  status: 'active', onboardingStatus: 'approved', permissions: [], paused: false, credentialRevoked: false,
  connection: { state: 'seen_recently', asOf: '2026-10-15T14:00:00Z', recentWindowSeconds: 300,
    seenAt: '2026-10-15T13:59:00Z', credentialExpiresAt: '2026-11-14T13:00:00Z',
    presence: { lastSeenAt: '2026-10-15T13:59:00Z', lastSuccessfulRefreshAt: '2026-10-15T13:00:00Z', lastWorkClaimAt: null, lastProcessedAt: null } }
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('owner agent evidence export', () => {
  it('preserves exact owner presence timestamps and nulls in an extractor-compatible array', () => {
    const result = JSON.parse(ownerAgentEvidence([agent], agent.id));
    expect(result[0].connection.presence).toEqual(agent.connection?.presence);
    expect(result[0].connection.credentialExpiresAt).toBe(agent.connection?.credentialExpiresAt);
    expect(result[0].paused).toBe(false);
  });
  it('excludes unrelated agents, unknown fields and operational credentials', () => {
    const extended = { ...agent, agentApiToken: 'PRIVATE', cookie: 'PRIVATE', connection: { ...agent.connection!, token: 'PRIVATE' } };
    const contents = ownerAgentEvidence([{ ...agent, id: 'other_agent' }, extended], agent.id);
    expect(contents).not.toContain('PRIVATE');
    expect(contents).not.toContain('other_agent');
    expect(contents).not.toContain('principalHumanId');
  });
  it('refuses missing agents and non-owner projections rather than fabricating presence', () => {
    expect(() => ownerAgentEvidence([], agent.id)).toThrow();
    expect(() => ownerAgentEvidence([{ ...agent, connection: undefined }], agent.id)).toThrow();
    expect(() => ownerAgentEvidence([agent], '../unsafe')).toThrow();
  });
  it('hides the export control from non-managers and exposes it to owners', () => {
    const props = { inboxId: 'inbox_example', agentId: agent.id, notify: vi.fn() };
    expect(renderToStaticMarkup(createElement(OwnerAgentExport, { ...props, allowed: false }))).toBe('');
    expect(renderToStaticMarkup(createElement(OwnerAgentExport, { ...props, allowed: true }))).toContain('Download owner evidence JSON');
  });
  it('downloads a local JSON blob and releases its temporary browser URL', () => {
    vi.useFakeTimers();
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
    const appendChild = vi.fn();
    vi.stubGlobal('document', { createElement: vi.fn(() => anchor), body: { appendChild } });
    const createObjectURL = vi.fn(() => 'blob:private-test');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    downloadOwnerEvidence(ownerAgentEvidence([agent], agent.id), agent.id);
    expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(anchor.download).toMatch(/^agents-agent_example-.*\.json$/);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:private-test');
  });
});
