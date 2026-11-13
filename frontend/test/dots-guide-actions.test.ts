import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DotsPermissionRecovery, DotsSetupGuide } from '../src/onboarding/DotsSetupGuide';
import { dotsMessageAccessPrompt, dotsSetupPrompt } from '../src/quick-connect';

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
const render = (reconnect = false, messageAccess = false) => { hooks.cursor = 0; return DotsSetupGuide({ origin, name, address, reconnect, messageAccess }); };
beforeEach(() => { hooks.values = []; hooks.cursor = 0; });
afterEach(() => vi.unstubAllGlobals());

it.each([
  { reconnect: false, messageAccess: false, expected: dotsSetupPrompt(origin, name, address) },
  { reconnect: true, messageAccess: false, expected: dotsSetupPrompt(origin, name, address, true) },
  { reconnect: false, messageAccess: true, expected: dotsMessageAccessPrompt(address) }
])('copies one prompt for the selected flow ($reconnect, $messageAccess)', async ({ reconnect, messageAccess, expected }) => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const buttons = elements(render(reconnect, messageAccess)).filter(item => item.type === 'button');
  expect(buttons).toHaveLength(1);
  const [button] = buttons;
  expect(button.props.children).toBe(messageAccess ? 'Copy message access prompt' : 'Copy setup prompt');
  button.props.onClick(); await Promise.resolve(); await Promise.resolve();
  expect(writeText.mock.calls).toEqual([[expected]]);
  expect(elements(render(reconnect, messageAccess)).some(item => item.props.role === 'status')).toBe(true);
});

it.each([false, true])('links troubleshooting to the guide (reconnect: %s)', reconnect => {
  const tree = elements(render(reconnect));
  expect(tree.find(item => item.type === 'a')?.props).toMatchObject({ href: '/docs/dots/', children: 'Stuck? Dots setup guide' });
  expect(tree.filter(item => ['details', 'textarea', 'input'].includes(item.type as string))).toHaveLength(0);
});

it('makes the primary prompt selectable when clipboard permission fails', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('unavailable')) } });
  elements(render()).find(item => item.type === 'button' && item.props.className === 'button primary')!.props.onClick();
  await Promise.resolve(); await Promise.resolve();
  const tree = elements(render());
  expect(tree.find(item => item.props.role === 'alert')?.props.children).toContain('Select the prompt');
  expect(tree.find(item => item.type === 'textarea')?.props).toMatchObject({ readOnly: true, value: dotsSetupPrompt(origin, name, address) });
});

it('opens recovery for the selected existing agent and drops it when that identity is no longer offered', () => {
  const agent = { id: 'agent_example', name: 'Example', address: 'example@envoi.example', principalHumanId: 'owner', status: 'active', onboardingStatus: 'approved', permissions: ['receive_agent_messages'] };
  const draw = (agents = [agent]) => { hooks.cursor = 0; return DotsPermissionRecovery({ agents, origin }); };
  elements(draw()).find(item => item.type === 'select')!.props.onChange({ target: { value: agent.id } });
  const guide = elements(draw()).find(item => item.type === DotsSetupGuide)!;
  expect(guide.props).toMatchObject({ address: agent.address, messageAccess: true });
  expect(draw([])).toBeNull();
});
