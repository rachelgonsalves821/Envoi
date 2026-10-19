import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { contractRegistryPath, loadContractFixture, loadContractRegistry } from '../../integrations/contract-fixtures/setup';
import { ClaimPage, type ClaimPageProps } from '../src/onboarding/ClaimPage';
import { AgentInstallations } from '../src/onboarding/AgentInstallations';
import { ClaimController, InstallationsController } from '../src/onboarding/claim-state';
import { canReconnectAgent, type ClaimAgent, type OnboardingApi } from '../src/onboarding/types';

// Like the other owner-control tests, exercise the real form handlers in Node.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next; }];
    },
    useMemo: (factory: () => unknown) => factory(),
    useEffect: () => {},
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot()
  };
});

const source = process.env.ENVOI_CONTRACT_FIXTURES_ROOT ?? path.dirname(contractRegistryPath);
const contract = loadContractRegistry(source).contracts.find(item => item.id === 'agent-registration')!;
const fixture = (name: string): any => loadContractFixture(contract, `${name}.json`, source);
const scenario = fixture('owner-reconnect-after-installation-revoke');
const [revokedStep, frozenStep, approvalStep] = scenario.steps;
const revoked: ClaimAgent = { ...revokedStep.response.body[0], inboxId: 'inbox_example' };
const frozen: ClaimAgent = { ...frozenStep.response.body[0], inboxId: 'inbox_frozen' };
const now = () => Date.parse('2026-10-12T12:04:00Z');
const api = (): OnboardingApi => ({
  lookup: vi.fn().mockResolvedValue(fixture('claim-lookup').response.body),
  approve: vi.fn().mockResolvedValue(approvalStep.response.body),
  installations: vi.fn().mockResolvedValue({ agentId: revoked.id, installations: [] }),
  reject: vi.fn(), claims: vi.fn(), withdraw: vi.fn(), revoke: vi.fn()
});
type Control = ReactElement<{ children?: ReactNode; value?: string; type?: string; disabled?: boolean;
  onChange?: (event: { target: { value?: string; checked?: boolean } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => Promise<void> }>;
function controls(tree: ReactNode, type: string): Control[] {
  const found: Control[] = [];
  Children.forEach(tree, child => {
    if (!isValidElement(child)) return;
    const element = child as Control;
    if (element.type === type) found.push(element);
    found.push(...controls(element.props.children, type));
  });
  return found;
}
function renderClaim(props: ClaimPageProps) {
  hooks.cursor = 0;
  const session = ClaimPage(props);
  return (session.type as (props: ClaimPageProps) => ReactElement)(session.props);
}
beforeEach(() => { hooks.values = []; hooks.cursor = 0; });

describe('revision 4 owner reconnect after installation revoke', () => {
  it('lists the canonical revoked identity and active/paused identities, excluding frozen/pending/rejected ones', async () => {
    expect([revoked, frozen].filter(canReconnectAgent).map(agent => agent.id)).toEqual(revokedStep.client.reconnectOffered);
    const agents: ClaimAgent[] = [revoked, frozen,
      ...(['active', 'paused'] as const).map(status => ({ ...revoked, id: status, name: status, status, credentialRevoked: false })),
      ...(['pending', 'rejected'] as const).map(onboardingStatus => ({ ...revoked, id: onboardingStatus, name: onboardingStatus, onboardingStatus }))];
    const controller = new ClaimController(api(), now); await controller.lookup('F7KQ-PM4D');
    const props: ClaimPageProps = { humanId: 'human_example', workspaces: [], agents, controller };
    const tree = renderClaim(props);
    controls(tree, 'input').find(item => item.props.value === 'existing_agent')!.props.onChange!({ target: {} });
    const options = controls(renderClaim(props), 'option').map(item => item.props.value).filter(Boolean);
    expect(options).toEqual([revoked.id, 'active', 'paused']);
    expect(canReconnectAgent({ ...revoked, credentialRevoked: false })).toBe(false);
  });

  it('selects the revoked identity and submits the canonical existing_agent target with no installation replacement', async () => {
    const client = api(); const controller = new ClaimController(client, now); await controller.lookup('F7KQ-PM4D');
    const props: ClaimPageProps = { humanId: 'human_example', workspaces: [], agents: [revoked], controller };
    controls(renderClaim(props), 'input').find(item => item.props.value === 'existing_agent')!.props.onChange!({ target: {} });
    controls(renderClaim(props), 'select')[0].props.onChange!({ target: { value: revoked.id } });
    await vi.waitFor(() => expect(controller.getSnapshot().installations).toEqual([]));
    const tree = renderClaim(props);
    expect(renderToStaticMarkup(tree)).toContain('Revoked · Access revoked');
    controls(tree, 'input').find(item => item.props.type === 'checkbox')!.props.onChange!({ target: { checked: true } });
    await controls(renderClaim(props), 'form')[0].props.onSubmit!({ preventDefault: vi.fn() });
    expect(client.approve).toHaveBeenCalledWith(approvalStep.response.body.registrationId,
      expect.objectContaining({ target: approvalStep.request.body.target }), expect.any(AbortSignal));
    expect(approvalStep.request.body.target).toEqual({ kind: 'existing_agent', agentId: revoked.id, replacesInstallationId: null });
  });

  it.each([revoked, frozen])('shows reconnect only for the unfrozen canonical owner identity $id', async agent => {
    const controller = new InstallationsController(api(), agent.inboxId, agent.id, now); await controller.load();
    const html = renderToStaticMarkup(AgentInstallations({ humanId: 'human_example', inboxId: agent.inboxId,
      agent, canManage: true, onReconnect: vi.fn(), controller }));
    expect(html).toContain('Revoked · Access revoked');
    expect(html.includes('Reconnect this identity')).toBe(agent.id === revoked.id);
    expect(html.includes('frozen by agent-wide revocation')).toBe(agent.id === frozen.id);
  });
});
