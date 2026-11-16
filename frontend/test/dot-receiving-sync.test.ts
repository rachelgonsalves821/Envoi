import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentWorkModeSetting } from '../src/AgentWorkModeSetting';
import { DotReceivingSync } from '../src/DotReceivingSync';
import { Modal } from '../src/Modal';
import { WorkModeHelp, workModeHelp } from '../src/WorkModeHelp';
import { api } from '../src/api';
import type { Agent, AgentWorkMode } from '../src/types';

const hooks = vi.hoisted(() => ({ cursor: 0, values: new Map<number, unknown>() }));

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState(initial: unknown) {
      const index = hooks.cursor++;
      if (!hooks.values.has(index)) hooks.values.set(index, initial);
      return [hooks.values.get(index), (value: unknown) => hooks.values.set(index, value)];
    },
    useRef(initial: unknown) {
      const index = hooks.cursor++;
      if (!hooks.values.has(index)) hooks.values.set(index, { current: initial });
      return hooks.values.get(index);
    },
    useId: () => 'work-mode-help',
    useEffect: () => {}
  };
});

function elements(tree: ReactNode): ReactElement<any>[] {
  const result: ReactElement<any>[] = [];
  Children.forEach(tree, item => {
    if (isValidElement<{ children?: ReactNode }>(item)) result.push(item, ...elements(item.props.children));
  });
  return result;
}

const dot: Agent = {
  id: 'dot', name: 'Mark', address: 'mark@example.com', principalHumanId: 'owner',
  status: 'active', onboardingStatus: 'approved', permissions: [],
  workMode: { mode: 'off', updatedAt: '2026-11-15T18:00:00Z' },
  backgroundReceiving: { state: 'off', since: null, endedReason: 'ended_by_owner', lastAlertAt: null,
    waiting: { count: 0, more: false, oldestAt: null } }
};

const enabled = (agent: Agent, mode: AgentWorkMode): Agent => ({
  ...agent, workMode: { mode, updatedAt: '2026-11-15T18:01:00Z' }
});

const draw = (agent = dot, onRefresh = vi.fn()) => {
  hooks.cursor = 0;
  return elements(AgentWorkModeSetting({ agent, inboxId: 'inbox_mark', canManage: true, onRefresh }));
};

beforeEach(() => hooks.values.clear());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['routine', 'ask'] as const)('opens the Dot dialog after Envoi confirms %s', async mode => {
  let confirm!: (agent: Agent) => void;
  const save = vi.spyOn(api, 'setAgentWorkMode').mockReturnValue(new Promise(resolve => { confirm = resolve; }));
  const refresh = vi.fn().mockResolvedValue(undefined);
  draw(dot, refresh).find(item => item.type === 'input' && item.props.value === mode)!.props.onChange();
  expect(save).toHaveBeenCalledWith('inbox_mark', dot.id, mode, expect.any(AbortSignal));
  expect(draw().some(item => item.type === Modal)).toBe(false);

  confirm(enabled(dot, mode));
  await Promise.resolve();
  const dialog = draw().find(item => item.type === Modal);
  expect(dialog?.props.title).toBe('One more step to turn it on');
  expect(dialog?.props.children.props).toMatchObject({ agent: enabled(dot, mode), showChatGPTLink: true });
  expect(refresh).toHaveBeenCalledOnce();
  dialog?.props.onClose();
  expect(draw().some(item => item.type === Modal)).toBe(false);
});

it('keeps a failed save or a connector change out of the Dot dialog', async () => {
  const save = vi.spyOn(api, 'setAgentWorkMode').mockRejectedValueOnce(new Error('Try again'));
  draw().find(item => item.type === 'input' && item.props.value === 'routine')!.props.onChange();
  await Promise.resolve();
  expect(draw().some(item => item.type === Modal)).toBe(false);
  expect(draw().find(item => item.props.role === 'alert')?.props.children).toBe('Try again');

  hooks.values.clear();
  const connector: Agent = { ...dot, backgroundReceiving: { ...dot.backgroundReceiving!, state: 'connector' } };
  save.mockResolvedValueOnce(enabled(connector, 'ask'));
  const refresh = vi.fn().mockResolvedValue(undefined);
  draw(connector, refresh).find(item => item.type === 'input' && item.props.value === 'ask')!.props.onChange();
  await Promise.resolve();
  expect(draw(connector).some(item => item.type === Modal)).toBe(false);
  expect(refresh).toHaveBeenCalledOnce();
});

it('copies only the sync line and links to ChatGPT in the dialog', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  hooks.cursor = 0;
  const content = elements(DotReceivingSync({ agent: dot, showChatGPTLink: true }));
  expect(content.find(item => item.type === 'a')?.props).toMatchObject({
    href: 'https://chatgpt.com/', target: '_blank', children: 'Open ChatGPT'
  });
  content.find(item => item.type === 'button' && item.props.children === 'Copy message')!.props.onClick();
  await Promise.resolve();
  expect(writeText).toHaveBeenCalledExactlyOnceWith('Sync with Envoi for mark@example.com');
});

it('opens help on tap and closes it on Escape without changing the work mode', () => {
  const draw = () => {
    hooks.cursor = 0;
    return WorkModeHelp({ label: 'Off', description: workModeHelp.off });
  };
  const trigger = () => elements(draw()).find(item => item.type === 'button')!;
  expect(trigger().props['aria-describedby']).toBe('work-mode-help');
  trigger().props.onClick();
  expect(draw().props['data-visibility']).toBe('open');
  trigger().props.onKeyDown({ key: 'Escape' });
  expect(draw().props['data-visibility']).toBe('dismissed');
});
