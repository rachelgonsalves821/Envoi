import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateInboxFolderContent, MoveInboxCaseContent, type CreateInboxFolderContentProps, type MoveInboxCaseContentProps } from '../src/InboxFolderDialogs';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useId: () => 'folder-test',
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
  maxLength?: number;
  disabled?: boolean;
  onChange?: (event: { target: { value: string } }) => void;
  onClick?: () => void;
  onSubmit?: (event: { preventDefault: () => void }) => void;
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

function setupCreate() {
  const props: CreateInboxFolderContentProps = { busy: false, error: '', onClose: vi.fn(), onCreate: vi.fn() };
  function render(changes: Partial<CreateInboxFolderContentProps> = {}) {
    Object.assign(props, changes);
    hooks.cursor = 0;
    return CreateInboxFolderContent(props);
  }
  return { props, render };
}

function setupMove(currentFolderId: string | null = 'folder_1') {
  const props: MoveInboxCaseContentProps = {
    folders: [{ id: 'folder_1', name: 'Research / Planning' }, { id: 'folder_2', name: 'Travel & expenses' }],
    currentFolderId, busy: false, error: '', onClose: vi.fn(), onMove: vi.fn()
  };
  function render(changes: Partial<MoveInboxCaseContentProps> = {}) {
    Object.assign(props, changes);
    hooks.cursor = 0;
    return MoveInboxCaseContent(props);
  }
  return { props, render };
}

function submit(tree: ReactNode) {
  const preventDefault = vi.fn();
  controls(tree, 'form')[0].props.onSubmit!({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; });

describe('CreateInboxFolderContent', () => {
  it('labels the bounded input and submits a trimmed nonempty name without an overlay', () => {
    const { props, render } = setupCreate();
    const markup = renderToStaticMarkup(render());
    expect(markup).toContain('for="folder-test-name"');
    expect(markup).toContain('id="folder-test-name"');
    expect(markup).not.toContain('role="dialog"');
    expect(controls(render(), 'input')[0].props.maxLength).toBe(80);
    submit(render());
    controls(render(), 'input')[0].props.onChange!({ target: { value: '   ' } });
    expect(controls(render(), 'button')[1].props.disabled).toBe(true);
    submit(render());
    expect(props.onCreate).not.toHaveBeenCalled();
    controls(render(), 'input')[0].props.onChange!({ target: { value: '  Research / Planning  ' } });
    submit(render());
    expect(props.onCreate).toHaveBeenCalledWith('Research / Planning');
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('bounds pasted names to 80 characters', () => {
    const { props, render } = setupCreate();
    controls(render(), 'input')[0].props.onChange!({ target: { value: 'Folder'.repeat(20) } });
    expect(controls(render(), 'input')[0].props.value).toHaveLength(80);
    submit(render());
    expect(props.onCreate).toHaveBeenCalledWith('Folder'.repeat(20).slice(0, 80));
  });

  it('preserves drafts across callback, busy and error changes and blocks busy submissions', () => {
    const { render } = setupCreate();
    controls(render(), 'input')[0].props.onChange!({ target: { value: 'Research / Pla' } });
    const onCreate = vi.fn();
    const busy = render({ busy: true, onCreate, onClose: vi.fn() });
    expect(controls(busy, 'input')[0].props.value).toBe('Research / Pla');
    expect(controls(busy, 'input')[0].props.disabled).toBe(true);
    expect(controls(busy, 'button').every(button => button.props.disabled)).toBe(true);
    submit(busy);
    expect(onCreate).not.toHaveBeenCalled();
    const retry = render({ busy: false, error: 'Creation failed' });
    expect(controls(retry, 'input')[0].props.value).toBe('Research / Pla');
    expect(renderToStaticMarkup(retry)).toContain('role="alert">Creation failed');
    submit(retry);
    expect(onCreate).toHaveBeenCalledWith('Research / Pla');
  });
});

describe('MoveInboxCaseContent', () => {
  it('renders a labeled native select with the current folder and No folder', () => {
    const { render, props } = setupMove();
    const tree = render();
    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain('for="folder-test-folder"');
    expect(markup).toContain('id="folder-test-folder"');
    expect(markup).toContain('<option value="">No folder</option>');
    expect(markup).toContain('Travel &amp; expenses');
    expect(markup).not.toContain('role="dialog"');
    expect(controls(tree, 'select')[0].props.value).toBe('folder_1');
    submit(tree);
    expect(props.onMove).toHaveBeenCalledWith('folder_1');
    controls(tree, 'select')[0].props.onChange!({ target: { value: '' } });
    submit(render());
    expect(props.onMove).toHaveBeenLastCalledWith(null);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('starts unfiled cases at No folder', () => {
    const { render, props } = setupMove(null);
    expect(controls(render(), 'select')[0].props.value).toBe('');
    submit(render({ folders: [] }));
    expect(props.onMove).toHaveBeenCalledWith(null);
  });

  it('preserves the selection across parent updates and blocks busy or unavailable moves', () => {
    const { render, props } = setupMove();
    controls(render(), 'select')[0].props.onChange!({ target: { value: 'folder_2' } });
    const onMove = vi.fn();
    const busy = render({ busy: true, onMove, onClose: vi.fn(), folders: [...props.folders] });
    expect(controls(busy, 'select')[0].props.value).toBe('folder_2');
    expect(controls(busy, 'select')[0].props.disabled).toBe(true);
    expect(controls(busy, 'button').every(button => button.props.disabled)).toBe(true);
    submit(busy);
    expect(onMove).not.toHaveBeenCalled();
    const retry = render({ busy: false, error: 'Move failed' });
    expect(controls(retry, 'select')[0].props.value).toBe('folder_2');
    expect(renderToStaticMarkup(retry)).toContain('role="alert">Move failed');
    submit(retry);
    expect(onMove).toHaveBeenCalledWith('folder_2');
    onMove.mockClear();
    const unavailable = render({ folders: [] });
    expect(controls(unavailable, 'button')[1].props.disabled).toBe(true);
    submit(unavailable);
    expect(onMove).not.toHaveBeenCalled();
  });
});

it('keeps slash entry local, leaves Tab and Escape available, and cancels without submitting', () => {
  const create = setupCreate();
  const move = setupMove();
  const createTree = create.render();
  hooks.values = [];
  const moveTree = move.render();
  for (const control of [...controls(createTree, 'input'), ...controls(moveTree, 'select')]) {
    const stopPropagation = vi.fn();
    control.props.onKeyDown!({ key: '/', stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
    for (const key of ['Tab', 'Escape', 'a']) control.props.onKeyDown!({ key, stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
  }
  controls(createTree, 'button')[0].props.onClick!();
  controls(moveTree, 'button')[0].props.onClick!();
  expect(create.props.onClose).toHaveBeenCalledOnce();
  expect(move.props.onClose).toHaveBeenCalledOnce();
  expect(create.props.onCreate).not.toHaveBeenCalled();
  expect(move.props.onMove).not.toHaveBeenCalled();
});
