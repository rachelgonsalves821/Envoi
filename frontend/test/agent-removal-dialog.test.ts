import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRemovalDialogContent, type AgentRemovalDialogProps } from '../src/AgentRemovalDialog';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useId: () => 'removal-test',
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = initial;
      return [hooks.values[index], (next: unknown) => { hooks.values[index] = next; }];
    }
  };
});

type Control = ReactElement<{
  children?: ReactNode;
  value?: string;
  disabled?: boolean;
  onChange?: (event: { target: { value: string } }) => void;
  onClick?: () => void;
  onKeyDown?: (event: { key: string; stopPropagation: () => void }) => void;
}>;

function controls(tree: ReactNode, type: string): Control[] {
  const matches: Control[] = [];
  Children.forEach(tree, child => {
    if (!isValidElement(child)) return;
    const element = child as Control;
    if (element.type === type) matches.push(element);
    matches.push(...controls(element.props.children, type));
  });
  return matches;
}

function setup() {
  const props: AgentRemovalDialogProps = { agentName: 'Research / Planner', busy: false, error: '', onClose: vi.fn(), onConfirm: vi.fn() };
  function render(changes: Partial<AgentRemovalDialogProps> = {}) {
    Object.assign(props, changes);
    hooks.cursor = 0;
    return AgentRemovalDialogContent(props);
  }
  return { props, render };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; });

describe('AgentRemovalDialogContent with a node-only stateful hook harness', () => {
  it('defaults to a labeled native archive dropdown without an overlay', () => {
    const { render, props } = setup();
    const tree = render();
    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain('for="removal-test-history"');
    expect(markup).toContain('id="removal-test-history"');
    expect(markup).toContain('Keep history as a read-only archive');
    expect(markup).toContain('Delete my history and files');
    expect(markup).not.toContain('type="radio"');
    expect(markup).not.toContain('role="dialog"');
    expect(controls(tree, 'select')[0].props.value).toBe('keep');
    expect(controls(tree, 'input')).toHaveLength(0);
    controls(tree, 'button')[1].props.onClick!();
    expect(props.onConfirm).toHaveBeenCalledWith(false, '');
  });

  it('preserves the delete choice and a partially typed draft across busy, error and callback changes', () => {
    const { render } = setup();
    controls(render(), 'select')[0].props.onChange!({ target: { value: 'delete' } });
    controls(render(), 'input')[0].props.onChange!({ target: { value: 'Research / Pla' } });
    const busy = render({ busy: true, onClose: vi.fn(), onConfirm: vi.fn() });
    expect(controls(busy, 'select')[0].props.value).toBe('delete');
    expect(controls(busy, 'input')[0].props.value).toBe('Research / Pla');
    expect(controls(busy, 'input')[0].props.disabled).toBe(true);
    const retry = render({ busy: false, error: 'Removal failed' });
    expect(controls(retry, 'select')[0].props.value).toBe('delete');
    expect(controls(retry, 'input')[0].props.value).toBe('Research / Pla');
    expect(renderToStaticMarkup(retry)).toContain('role="alert">Removal failed');
  });

  it('requires the full exact name for destructive confirmation and submits the draft', () => {
    const { render, props } = setup();
    controls(render(), 'select')[0].props.onChange!({ target: { value: 'delete' } });
    for (const confirmation of ['', 'Research / Pla', 'research / planner', 'Research / Planner ']) {
      controls(render(), 'input')[0].props.onChange!({ target: { value: confirmation } });
      const button = controls(render(), 'button')[1];
      expect(button.props.disabled).toBe(true);
      button.props.onClick!();
    }
    expect(props.onConfirm).not.toHaveBeenCalled();
    controls(render(), 'input')[0].props.onChange!({ target: { value: props.agentName } });
    const tree = render();
    expect(renderToStaticMarkup(tree)).toContain('aria-describedby="removal-test-warning"');
    expect(renderToStaticMarkup(tree)).toContain('This cannot be undone.');
    expect(controls(tree, 'button')[1].props.disabled).toBe(false);
    controls(tree, 'button')[1].props.onClick!();
    expect(props.onConfirm).toHaveBeenCalledWith(true, props.agentName);
  });

  it('blocks removal while busy and preserves a draft when switching history choices', () => {
    const { render, props } = setup();
    controls(render(), 'select')[0].props.onChange!({ target: { value: 'delete' } });
    controls(render(), 'input')[0].props.onChange!({ target: { value: props.agentName } });
    controls(render(), 'select')[0].props.onChange!({ target: { value: 'keep' } });
    expect(controls(render(), 'input')).toHaveLength(0);
    controls(render(), 'select')[0].props.onChange!({ target: { value: 'delete' } });
    expect(controls(render(), 'input')[0].props.value).toBe(props.agentName);
    const busy = render({ busy: true });
    expect(controls(busy, 'select')[0].props.disabled).toBe(true);
    expect(controls(busy, 'button').every(button => button.props.disabled)).toBe(true);
    controls(busy, 'button')[1].props.onClick!();
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(busy)).toContain('Removing…');
  });

  it('contains slash shortcuts on editable controls without blocking Tab or Escape', () => {
    const { render } = setup();
    controls(render(), 'select')[0].props.onChange!({ target: { value: 'delete' } });
    const tree = render();
    for (const control of [...controls(tree, 'select'), ...controls(tree, 'input')]) {
      const stopPropagation = vi.fn();
      control.props.onKeyDown!({ key: '/', stopPropagation });
      expect(stopPropagation).toHaveBeenCalledTimes(1);
      for (const key of ['Tab', 'Escape', 'a']) control.props.onKeyDown!({ key, stopPropagation });
      expect(stopPropagation).toHaveBeenCalledTimes(1);
    }
  });

  it('calls the supplied close handler on cancel', () => {
    const { render, props } = setup();
    controls(render(), 'button')[0].props.onClick!();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onConfirm).not.toHaveBeenCalled();
  });
});
