import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DotsPermissionRecovery, DotsSetupGuide } from '../src/onboarding/DotsSetupGuide';
import { dotsDiagnosticPrompt, dotsMessageAccessPrompt, dotsMonitoringPrompt, dotsSetupPrompt, dotsVerificationPrompt } from '../src/quick-connect';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next; }];
  } };
});
function elements(tree: ReactNode): ReactElement<any>[] {
  const found: ReactElement<any>[] = [];
  Children.forEach(tree, child => { if (isValidElement(child)) { found.push(child); found.push(...elements((child.props as any).children)); } });
  return found;
}
const origin = 'https://envoi.example';
const name = 'Example';
const address = 'example@envoi.example';
const render = (reconnect = false) => { hooks.cursor = 0; return DotsSetupGuide({ origin, name, address, reconnect }); };
beforeEach(() => { hooks.values = []; hooks.cursor = 0; });
afterEach(() => vi.unstubAllGlobals());

it.each([
  { reconnect: false, expected: dotsSetupPrompt(origin, name, address) },
  { reconnect: true, expected: dotsMessageAccessPrompt(address) }
])('copies the unchanged primary prompt (reconnect: $reconnect)', async ({ reconnect, expected }) => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const buttons = elements(render(reconnect)).filter(item => item.type === 'button' && item.props.className === 'button primary');
  expect(buttons).toHaveLength(1);
  const [button] = buttons;
  button.props.onClick(); await Promise.resolve(); await Promise.resolve();
  expect(writeText.mock.calls).toEqual([[expected]]);
  expect(elements(render(reconnect)).some(item => item.props.role === 'status')).toBe(true);
});

it.each([false, true])('places every alternative inside the single closed help entry (reconnect: %s)', async reconnect => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const tree = elements(render(reconnect));
  const help = tree.filter(item => item.type === 'details');
  expect(help).toHaveLength(1);
  expect(help[0].props.open).toBeFalsy();
  const alternatives = elements(help[0].props.children).filter(item => item.type === 'button');
  expect(tree.filter(item => item.type === 'button')).toHaveLength(alternatives.length + 1);
  for (const button of alternatives) button.props.onClick();
  await Promise.resolve();
  expect(writeText.mock.calls.flat()).toEqual([
    dotsVerificationPrompt(address),
    reconnect ? dotsSetupPrompt(origin, name, address, true) : dotsMessageAccessPrompt(address),
    dotsMonitoringPrompt,
    dotsDiagnosticPrompt(address),
    `${origin}/mcp`
  ]);
});

it('keeps the endpoint and prompt selectable when clipboard permission fails', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('unavailable')) } });
  elements(render()).find(item => item.type === 'button' && item.props.className === 'button primary')!.props.onClick();
  await Promise.resolve(); await Promise.resolve();
  const tree = elements(render());
  expect(tree.find(item => item.props.role === 'alert')?.props.children).toContain('Stuck? Other ways to connect');
  const help = elements(tree.find(item => item.type === 'details')?.props.children);
  expect(help.find(item => item.type === 'input')?.props).toMatchObject({ readOnly: true, value: `${origin}/mcp` });
  expect(help.find(item => item.type === 'textarea')?.props).toMatchObject({ readOnly: true, value: dotsSetupPrompt(origin, name, address) });
});

it('opens recovery for the selected existing agent and drops it when that identity is no longer offered', () => {
  const agent = { id: 'agent_example', name: 'Example', address: 'example@envoi.example', principalHumanId: 'owner', status: 'active', onboardingStatus: 'approved', permissions: ['receive_agent_messages'] };
  const draw = (agents = [agent]) => { hooks.cursor = 0; return DotsPermissionRecovery({ agents, origin }); };
  elements(draw()).find(item => item.type === 'select')!.props.onChange({ target: { value: agent.id } });
  const guide = elements(draw()).find(item => item.type === DotsSetupGuide)!;
  expect(guide.props).toMatchObject({ address: agent.address, reconnect: true });
  expect(draw([])).toBeNull();
});
