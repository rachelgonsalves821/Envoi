import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPermissionPicker, EnrollmentDialog, RuntimePicker } from '../src/App';
import { api, ApiError } from '../src/api';
import { DotsSetupGuide } from '../src/onboarding/DotsSetupGuide';
import { SavedSetupProgress } from '../src/onboarding/SavedSetupProgress';
import { savedSetupApi } from '../src/onboarding/saved-setup';
import { dotsSetupPrompt, setupPrompt, type EnrollmentResult, type EnrollmentStatus } from '../src/quick-connect';
import type { Agent, Inbox } from '../src/types';
import type { QuickConnectHandoff } from '../../sdk/typescript/src/quick-connect';

const hooks = vi.hoisted(() => ({
  cursor: 0,
  values: new Map<number, unknown>(),
  effects: new Map<number, { deps: readonly unknown[]; cleanup?: () => void }>(),
  pending: [] as (() => void)[]
}));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState(initial: unknown) {
      const index = hooks.cursor++;
      if (!hooks.values.has(index)) hooks.values.set(index, initial);
      return [hooks.values.get(index), (next: unknown) => hooks.values.set(index, typeof next === 'function' ? next(hooks.values.get(index)) : next)];
    },
    useRef(initial: unknown) {
      const index = hooks.cursor++;
      if (!hooks.values.has(index)) hooks.values.set(index, { current: initial });
      return hooks.values.get(index);
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const index = hooks.cursor++;
      const previous = hooks.effects.get(index);
      if (previous && deps.every((value, i) => Object.is(previous.deps[i], value))) return;
      hooks.pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: cleanup || undefined });
      });
    }
  };
});

function elements(tree: ReactNode): ReactElement<any>[] {
  const result: ReactElement<any>[] = [];
  Children.forEach(tree, child => {
    if (isValidElement<{ children?: ReactNode }>(child)) result.push(child, ...elements(child.props.children));
  });
  return result;
}

const origin = 'https://envoi.example';
const handoff: QuickConnectHandoff = {
  version: 1, runtime: 'openclaw', apiUrl: origin, enrollmentToken: 'one_time_token_1234567890',
  expiresAt: '2026-11-12T12:30:00Z', agentName: 'Milo', address: 'milo@envoi-agents.com'
};
const enrollment: EnrollmentResult = {
  enrollmentId: 'enrollment_1', enrollmentToken: handoff.enrollmentToken, enrollmentUrl: '/?enroll=private',
  expiresAt: handoff.expiresAt, quickConnect: handoff
};
const status = (phase: EnrollmentStatus['phase']): EnrollmentStatus => ({
  enrollmentId: enrollment.enrollmentId!, phase, expiresAt: enrollment.expiresAt,
  ...(phase === 'error' ? { errorCode: 'GATEWAY_UNREACHABLE' } : {})
});
const workspace = { id: 'inbox_1' } as Inbox;

function wizard(initialResult: EnrollmentResult | null = null, reconnectAgent?: Agent) {
  let result = initialResult;
  const setResult = vi.fn((next: EnrollmentResult | null) => { result = next; });
  const onClose = vi.fn();
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const draw = () => {
    hooks.cursor = 0;
    const tree = EnrollmentDialog({ workspace, result, setResult, onClose, onRefresh, reconnectAgent });
    for (const effect of hooks.pending.splice(0)) effect();
    return elements(tree);
  };
  const submit = async (tree: ReturnType<typeof draw>) => {
    const form = tree.find(node => node.type === 'form')!;
    await form.props.onSubmit({ preventDefault: vi.fn() });
    return draw();
  };
  return { draw, submit, setResult };
}

function expectStep(tree: ReactElement<any>[], number: number) {
  const current = tree.find(node => node.props['aria-current'] === 'step');
  expect(current?.props.children[0]).toBe(number);
  expect(tree.filter(node => node.type === 'button' && node.props.className === 'button primary')).toHaveLength(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
  vi.stubGlobal('window', { location: { origin } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  vi.spyOn(api, 'agentAddressAvailability').mockResolvedValue({ available: true, localPart: 'milo', address: handoff.address });
});

afterEach(() => {
  for (const effect of hooks.effects.values()) effect.cleanup?.();
  hooks.effects.clear();
  hooks.values.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(['openclaw', 'hermes', 'grok', 'dots'] as const)('uses the same three steps for %s', async runtime => {
  const create = vi.spyOn(api, 'enrollmentToken').mockResolvedValue({
    ...enrollment, quickConnect: { ...handoff, runtime: runtime === 'dots' ? 'openclaw' : runtime }
  });
  vi.spyOn(api, 'enrollmentStatus').mockResolvedValue(status('waiting'));
  const save = vi.spyOn(savedSetupApi, 'create').mockRejectedValue(new ApiError('Disabled', 404, 'FEATURE_DISABLED'));
  const dialog = wizard();
  const first = dialog.draw();
  expectStep(first, 1);
  expect(first.some(node => node.type === 'details')).toBe(false);
  const picker = first.find(node => node.type === RuntimePicker)!;
  if (runtime === 'dots') picker.props.onSelectDots();
  else picker.props.onChange(runtime);

  const second = await dialog.submit(dialog.draw());
  expectStep(second, 2);
  expect(second.some(node => node.type === 'details')).toBe(false);
  const permissions = second.find(node => node.type === AgentPermissionPicker)!;
  const toggles = elements(AgentPermissionPicker(permissions.props)).filter(node => node.props.type === 'checkbox');
  expect(toggles.map(node => [node.props.checked, node.props.disabled])).toEqual([
    [true, true], [true, false], [false, false], [false, false]
  ]);
  const name = second.find(node => node.props.name === 'name')!;
  name.props.onChange({ target: { value: 'Milo' } });
  dialog.draw();
  await vi.advanceTimersByTimeAsync(250);
  if (runtime !== 'dots') toggles[2].props.onChange({ target: { checked: true } });

  const third = await dialog.submit(dialog.draw());
  if (runtime === 'dots') {
    expect(create).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(workspace.id, { name: 'Milo', localPart: 'milo', permissions: ['receive_agent_messages', 'send_agent_messages'] }, expect.any(AbortSignal));
    const guide = third.find(node => node.type === DotsSetupGuide)!;
    expect(guide.props).toMatchObject({ name: 'Milo', address: handoff.address, reconnect: false, savedSetup: false });
    expectStep([...third, ...elements(DotsSetupGuide(guide.props))], 3);
    expect(third.some(node => node.props.title === 'Dots connection is off here')).toBe(true);
    expect(third.some(node => node.type === SavedSetupProgress)).toBe(false);
  } else {
    expect(create).toHaveBeenCalledWith(workspace.id, 'Milo', 'milo', ['receive_agent_messages', 'send_agent_messages', 'create_assets'], runtime);
    expectStep(third, 3);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    third.find(node => node.type === 'button' && node.props.className === 'button primary')!.props.onClick();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(setupPrompt({ ...handoff, runtime }));
  }
});

it('saves the edited Dots permissions and opens progress for the returned setup', async () => {
  const saved = {
    setupId: 'setup_example', workspaceInboxId: workspace.id, workspaceName: 'Workspace',
    name: 'Milo', localPart: 'milo', address: handoff.address, runtime: 'dots', status: 'waiting',
    permissions: ['receive_agent_messages'], createdAt: '2026-11-12T12:00:00.000Z', expiresAt: '2026-11-12T12:30:00.000Z'
  } as const;
  const save = vi.spyOn(savedSetupApi, 'create').mockResolvedValue({ ...saved, permissions: [...saved.permissions] });
  const dialog = wizard();
  dialog.draw().find(node => node.type === RuntimePicker)!.props.onSelectDots();
  const second = await dialog.submit(dialog.draw());
  second.find(node => node.props.name === 'name')!.props.onChange({ target: { value: 'Milo' } });
  const picker = second.find(node => node.type === AgentPermissionPicker)!;
  const options = elements(AgentPermissionPicker(picker.props)).filter(node => node.props.type === 'checkbox');
  options[1].props.onChange({ target: { checked: false } });
  dialog.draw();
  await vi.advanceTimersByTimeAsync(250);

  const third = await dialog.submit(dialog.draw());
  expect(save).toHaveBeenCalledExactlyOnceWith(workspace.id, {
    name: 'Milo', localPart: 'milo', permissions: ['receive_agent_messages']
  }, expect.any(AbortSignal));
  expect(third.find(node => node.type === SavedSetupProgress)?.props.setup).toEqual(saved);
  const guide = third.find(node => node.type === DotsSetupGuide)!;
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  elements(DotsSetupGuide(guide.props)).find(node => node.type === 'button' && node.props.className === 'button primary')!.props.onClick();
  const prompt = dotsSetupPrompt(origin, saved.name, saved.address, false, true);
  expect(writeText).toHaveBeenCalledExactlyOnceWith(prompt);
  expect(prompt).not.toContain(saved.setupId);
});

describe('setup progress', () => {
  it.each([
    { phase: 'waiting', line: 'Waiting for your agent to start', detail: 'The code works until', milestones: 0, action: undefined },
    { phase: 'enrolled', line: 'Your agent is connected and finishing setup', detail: 'This can take a few minutes.', milestones: 1, action: undefined },
    { phase: 'ready', line: 'Milo is ready', detail: 'Setup checks passed. Send it a message to try it.', milestones: 2, action: undefined },
    { phase: 'expired', line: 'This code expired before your agent used it', detail: 'Nothing was set up yet.', milestones: 0, action: 'Create new prompt' },
    { phase: 'revoked', line: 'This connection was revoked', detail: 'Review agent connections before trying again.', milestones: 0, action: 'Create new prompt' },
    { phase: 'error', line: 'Setup needs attention', detail: 'Ask your agent what failed. It has the details.', milestones: 1, action: 'Check again' },
    { phase: 'unavailable', line: "Can't check progress right now", detail: 'Your agent can keep going.', milestones: 0, action: 'Check again' }
  ] as const)('shows the $phase report and recovery action', async ({ phase, line, detail, milestones, action }) => {
    const request = vi.spyOn(api, 'enrollmentStatus');
    if (phase === 'unavailable') request.mockRejectedValue({ status: 403 });
    else request.mockResolvedValue(status(phase));
    const dialog = wizard(enrollment);
    dialog.draw();
    await vi.advanceTimersByTimeAsync(0);
    const tree = dialog.draw();
    const row = tree.find(node => node.props.onCheckAgain)!;
    const progress = (row.type as (props: any) => ReactElement)(row.props);
    const html = renderToStaticMarkup(progress);
    expect(html).toContain('role="status"');
    expect(html).toContain(line.replace("'", '&#x27;'));
    expect(html).toContain(detail);
    expect(elements(progress).filter(node => node.type === 'li' && node.props.className === 'complete')).toHaveLength(milestones);
    expect(html.includes('GATEWAY_UNREACHABLE')).toBe(phase === 'error');
    const buttons = elements(progress).filter(node => node.type === 'button');
    expect(buttons.map(node => node.props.children)).toEqual(action ? [action] : []);
    if (action === 'Create new prompt') {
      buttons[0].props.onClick();
      expect(dialog.setResult).toHaveBeenCalledWith(null);
      expectStep(dialog.draw(), 2);
    } else if (action === 'Check again') {
      request.mockResolvedValue(status('ready'));
      buttons[0].props.onClick();
      dialog.draw();
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(2);
      expect(dialog.draw().find(node => node.props.onCheckAgain)?.props.phase).toBe('ready');
    }
  });
});

it.each([false, true])('keeps the same agent when reconnecting (re-enroll: %s)', async reenroll => {
  const agent = {
    id: 'agent_1', name: handoff.agentName, address: handoff.address, status: reenroll ? 'revoked' : 'active',
    permissions: ['receive_agent_messages']
  } as Agent;
  const reconnect = vi.spyOn(api, 'reconnectAgentToken').mockResolvedValue(enrollment);
  vi.spyOn(api, 'enrollmentStatus').mockResolvedValue(status('waiting'));
  const dialog = wizard(null, agent);
  const second = await dialog.submit(dialog.draw());
  const picker = second.find(node => node.type === AgentPermissionPicker)!;
  expect(Boolean(picker.props.onChange)).toBe(reenroll);
  expect(picker.props.selected).toEqual(reenroll ? ['receive_agent_messages', 'send_agent_messages'] : agent.permissions);
  expect(second.some(node => node.props.name === 'name')).toBe(false);
  await dialog.submit(second);
  expect(reconnect).toHaveBeenCalledWith(workspace.id, agent.id, 'openclaw', reenroll ? ['receive_agent_messages', 'send_agent_messages'] : undefined);
});
