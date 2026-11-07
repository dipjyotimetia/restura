import { fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { CollectionItem, HttpRequest } from '@/types';
import {
  CollectionTreeItems,
  handleTreeKeyDown,
  setRovingRow,
  type TreeActions,
  type TreeState,
} from '../CollectionTree';

const http = (id: string, method = 'GET'): HttpRequest => ({
  id,
  name: id,
  type: 'http',
  method: method as HttpRequest['method'],
  url: 'https://x.test',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
});

const items: CollectionItem[] = [
  {
    id: 'f',
    name: 'Users',
    type: 'folder',
    items: [
      { id: 'a', name: 'List users', type: 'request', request: http('ra', 'POST') },
      { id: 'sub', name: 'Admin', type: 'folder', items: [] },
    ],
  },
  { id: 'b', name: 'Health', type: 'request', request: http('rb') },
  {
    id: 'g',
    name: 'Query',
    type: 'request',
    request: { ...http('rg'), type: 'graphql' } as unknown as HttpRequest,
  },
  {
    id: 'u',
    name: 'Mystery',
    type: 'request',
    request: { ...http('ru'), type: 'unknownproto' } as unknown as HttpRequest,
  },
  { id: 'n', name: 'No request', type: 'request' },
];

function makeActions(): TreeActions {
  const fn = () => vi.fn();
  return {
    openItem: fn(),
    addRequest: fn(),
    addFolder: fn(),
    duplicateItem: fn(),
    deleteItem: fn(),
    deleteSelected: fn(),
    runFolder: fn(),
    openFolderSettings: fn(),
    startRename: fn(),
    commitRename: fn(),
    cancelRename: fn(),
    setRenameValue: fn(),
    renameInputRef: createRef<HTMLInputElement>(),
    toggleCollapse: fn(),
    toggleSelect: fn(),
    selectRange: fn(),
    clearSelection: fn(),
    dragStart: fn(),
    dragEnd: fn(),
    setDropTarget: fn(),
    dropIntoFolder: fn(),
    dropBeforeItem: fn(),
    moveToFolder: fn(),
  };
}

function state(over: Partial<TreeState> = {}): TreeState {
  return {
    renamingItemId: null,
    renameValue: '',
    dropTargetId: null,
    collapsedFolders: new Set<string>(),
    selectedKeys: new Set<string>(),
    ...over,
  };
}

function renderItems(actions: TreeActions, s: TreeState = state(), list = items) {
  return render(<CollectionTreeItems collectionId="c" items={list} state={s} actions={actions} />);
}

const row = (name: string) => screen.getByText(name).closest('[data-tree-row]') as HTMLElement;

describe('CollectionTreeItems rows', () => {
  beforeEach(() => {
    useCollectionStore.setState({ collections: [{ id: 'c', name: 'C', items }] });
  });

  it('labels requests by method, protocol, or a REQ fallback', () => {
    renderItems(makeActions());
    expect(within(row('List users')).getByText('POST')).toBeTruthy();
    expect(within(row('Health')).getByText('GET')).toBeTruthy();
    expect(within(row('Query')).getByText('GQL')).toBeTruthy();
    expect(within(row('Mystery')).getByText('REQ')).toBeTruthy();
    expect(within(row('No request')).getByText('REQ')).toBeTruthy();
  });

  it('folder click toggles collapse, shift selects a range, ctrl/meta toggle selection', () => {
    const actions = makeActions();
    renderItems(actions);
    fireEvent.click(row('Users'));
    expect(actions.clearSelection).toHaveBeenCalledTimes(1);
    expect(actions.toggleCollapse).toHaveBeenCalledWith('f');
    fireEvent.click(row('Users'), { shiftKey: true });
    expect(actions.selectRange).toHaveBeenCalledWith('c', 'f');
    fireEvent.click(row('Users'), { ctrlKey: true });
    fireEvent.click(row('Users'), { metaKey: true });
    expect(actions.toggleSelect).toHaveBeenCalledTimes(2);
    expect(actions.toggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('request click opens it, with ctrl/meta toggling selection instead', () => {
    const actions = makeActions();
    renderItems(actions);
    fireEvent.click(row('Health'));
    expect(actions.clearSelection).toHaveBeenCalled();
    expect(actions.openItem).toHaveBeenCalledWith(items[1]);
    fireEvent.click(row('Health'), { metaKey: true });
    fireEvent.click(row('Health'), { ctrlKey: true });
    expect(actions.toggleSelect).toHaveBeenCalledWith('c', 'b');
    expect(actions.openItem).toHaveBeenCalledTimes(1);
  });

  it('folder Enter/Space toggle and other keys bubble', () => {
    const actions = makeActions();
    renderItems(actions);
    fireEvent.keyDown(row('Users'), { key: 'Enter' });
    fireEvent.keyDown(row('Users'), { key: ' ' });
    fireEvent.keyDown(row('Users'), { key: 'a' });
    expect(actions.toggleCollapse).toHaveBeenCalledTimes(2);
  });

  it('collapsed folders hide children and show a child count', () => {
    renderItems(makeActions(), state({ collapsedFolders: new Set(['f', 'sub']) }));
    expect(screen.queryByText('List users')).toBeNull();
    expect(row('Users').getAttribute('aria-expanded')).toBe('false');
    expect(within(row('Users')).getByText('2')).toBeTruthy();
  });

  it('empty folders render no group even when expanded', () => {
    renderItems(makeActions());
    expect(screen.queryByRole('group', { name: 'Admin items' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Users items' })).toBeTruthy();
  });

  it('marks selection and drop targets', () => {
    renderItems(
      makeActions(),
      state({ selectedKeys: new Set(['c:f', 'other:b']), dropTargetId: 'b' })
    );
    expect(row('Users').getAttribute('aria-selected')).toBe('true');
    expect(row('Health').getAttribute('aria-selected')).toBe('false');
    expect(row('Health').className).toContain('border-t-2');
  });

  it('wires drag and drop for folders and requests', () => {
    const actions = makeActions();
    renderItems(actions);
    const folder = row('Users');
    const request = row('Health');
    expect(folder.getAttribute('draggable')).toBe('true');

    fireEvent.dragStart(folder);
    fireEvent.dragStart(request);
    expect(actions.dragStart).toHaveBeenCalledTimes(2);
    expect(vi.mocked(actions.dragStart).mock.calls.map((c) => c.slice(1))).toEqual([
      ['c', 'f'],
      ['c', 'b'],
    ]);
    fireEvent.dragEnd(folder);
    fireEvent.dragEnd(request);
    expect(actions.dragEnd).toHaveBeenCalledTimes(2);

    fireEvent.dragOver(folder, { dataTransfer: { dropEffect: '' } });
    fireEvent.dragOver(request, { dataTransfer: { dropEffect: '' } });
    expect(vi.mocked(actions.setDropTarget).mock.calls).toEqual([['f'], ['b']]);
    // Leaving a row that is not the drop target is a no-op.
    fireEvent.dragLeave(folder);
    fireEvent.dragLeave(request);
    expect(actions.setDropTarget).toHaveBeenCalledTimes(2);

    fireEvent.drop(folder);
    fireEvent.drop(request);
    expect(vi.mocked(actions.dropIntoFolder).mock.calls[0]?.slice(1)).toEqual(['c', 'f']);
    expect(vi.mocked(actions.dropBeforeItem).mock.calls[0]?.slice(1)).toEqual(['c', 'b']);
  });

  it('clears the drop target when leaving the current target rows', () => {
    const actions = makeActions();
    const { unmount } = renderItems(actions, state({ dropTargetId: 'f' }));
    fireEvent.dragOver(row('Users'), { dataTransfer: { dropEffect: '' } });
    expect(actions.setDropTarget).not.toHaveBeenCalled();
    fireEvent.dragLeave(row('Users'));
    expect(actions.setDropTarget).toHaveBeenCalledWith(null);
    unmount();

    const a2 = makeActions();
    renderItems(a2, state({ dropTargetId: 'b' }));
    fireEvent.dragOver(row('Health'), { dataTransfer: { dropEffect: '' } });
    expect(a2.setDropTarget).not.toHaveBeenCalled();
    fireEvent.dragLeave(row('Health'));
    expect(a2.setDropTarget).toHaveBeenCalledWith(null);
  });

  it('renames a folder inline: typing, Enter, Escape and blur', () => {
    const actions = makeActions();
    renderItems(actions, state({ renamingItemId: 'f', renameValue: 'People' }));
    const input = screen.getByRole('textbox', { name: 'Rename folder' }) as HTMLInputElement;
    expect(input.value).toBe('People');
    const folder = input.closest('[data-tree-row]') as HTMLElement;
    expect(folder.getAttribute('draggable')).toBe('false');

    fireEvent.change(input, { target: { value: 'Peeps' } });
    expect(actions.setRenameValue).toHaveBeenCalledWith('Peeps');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(actions.commitRename).toHaveBeenCalledWith('c', 'f');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(actions.cancelRename).toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'x' });
    fireEvent.blur(input);
    expect(actions.commitRename).toHaveBeenCalledTimes(2);

    // Clicks and Enter on the row while renaming do nothing.
    fireEvent.click(input);
    fireEvent.click(folder);
    fireEvent.keyDown(folder, { key: 'Enter' });
    expect(actions.toggleCollapse).not.toHaveBeenCalled();
    expect(actions.clearSelection).not.toHaveBeenCalled();
  });

  it('renames a request inline and ignores row clicks meanwhile', () => {
    const actions = makeActions();
    renderItems(actions, state({ renamingItemId: 'b', renameValue: 'Ping' }));
    const input = screen.getByRole('textbox', { name: 'Rename request' }) as HTMLInputElement;
    expect(input.value).toBe('Ping');
    fireEvent.click(input.closest('[data-tree-row]')!);
    expect(actions.openItem).not.toHaveBeenCalled();
  });
});

describe('row menus', () => {
  beforeEach(() => {
    useCollectionStore.setState({ collections: [{ id: 'c', name: 'C', items }] });
  });

  const openContext = (name: string) => {
    fireEvent.contextMenu(row(name));
    return screen.getByRole('menu');
  };

  it('folder context menu dispatches each action', () => {
    const actions = makeActions();
    renderItems(actions);
    const folder = items[0]!;
    const cases: Array<[string, () => void]> = [
      ['Run folder', () => expect(actions.runFolder).toHaveBeenCalledWith('c', 'f')],
      ['New request', () => expect(actions.addRequest).toHaveBeenCalledWith('c', 'f')],
      ['New subfolder', () => expect(actions.addFolder).toHaveBeenCalledWith('c', 'f')],
      ['Rename', () => expect(actions.startRename).toHaveBeenCalledWith('f', 'Users')],
      [
        'Folder settings',
        () => expect(actions.openFolderSettings).toHaveBeenCalledWith('c', folder),
      ],
      ['Delete', () => expect(actions.deleteItem).toHaveBeenCalledWith('c', 'f')],
    ];
    for (const [label, check] of cases) {
      const menu = openContext('Users');
      fireEvent.click(within(menu).getByRole('menuitem', { name: label }));
      check();
    }
  });

  it('request context menu renames, duplicates and deletes', () => {
    const actions = makeActions();
    renderItems(actions);
    fireEvent.click(within(openContext('Health')).getByRole('menuitem', { name: 'Rename' }));
    expect(actions.startRename).toHaveBeenCalledWith('b', 'Health');
    fireEvent.click(within(openContext('Health')).getByRole('menuitem', { name: 'Duplicate' }));
    expect(actions.duplicateItem).toHaveBeenCalledWith('c', items[1]);
    fireEvent.click(within(openContext('Health')).getByRole('menuitem', { name: 'Delete' }));
    expect(actions.deleteItem).toHaveBeenCalledWith('c', 'b');
  });

  it('moves a request into a folder through the submenu', () => {
    const actions = makeActions();
    renderItems(actions);
    const menu = openContext('Health');
    const trigger = within(menu).getByRole('menuitem', { name: 'Move to folder' });
    fireEvent.keyDown(trigger, { key: 'ArrowRight' });
    const sub = screen.getAllByRole('menu').at(-1)!;
    const admin = within(sub).getByRole('menuitem', { name: 'Admin' });
    expect((admin as HTMLElement).style.paddingLeft).toBe('20px');
    fireEvent.click(admin);
    expect(actions.moveToFolder).toHaveBeenCalledWith('c', 'b', 'sub');
  });

  it('hides "Move to folder" when the collection has no folders', () => {
    const flat: CollectionItem[] = [items[1]!];
    useCollectionStore.setState({ collections: [{ id: 'c', name: 'C', items: flat }] });
    renderItems(makeActions(), state(), flat);
    const menu = openContext('Health');
    expect(within(menu).queryByRole('menuitem', { name: 'Move to folder' })).toBeNull();
  });

  it('hides "Move to folder" for an unknown collection', () => {
    useCollectionStore.setState({ collections: [] });
    renderItems(makeActions());
    expect(within(openContext('Health')).queryByText('Move to folder')).toBeNull();
  });

  it('offers bulk delete when the row is part of a multi-selection', () => {
    const actions = makeActions();
    renderItems(actions, state({ selectedKeys: new Set(['c:b', 'c:f']) }));
    const menu = openContext('Health');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete selected (2)' }));
    expect(actions.deleteSelected).toHaveBeenCalledWith('c');
    expect(actions.deleteItem).not.toHaveBeenCalled();
  });

  it('a single selected row still deletes just itself', () => {
    const actions = makeActions();
    renderItems(actions, state({ selectedKeys: new Set(['c:b']) }));
    fireEvent.click(within(openContext('Health')).getByRole('menuitem', { name: 'Delete' }));
    expect(actions.deleteItem).toHaveBeenCalledWith('c', 'b');
  });

  it('opens the same actions from the three-dots options buttons', () => {
    const actions = makeActions();
    renderItems(actions);
    const folderOptions = screen.getAllByRole('button', { name: 'Folder options' })[0]!;
    fireEvent.keyDown(folderOptions, { key: 'Enter' });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Run folder' }));
    expect(actions.runFolder).toHaveBeenCalledWith('c', 'f');

    const requestOptions = screen.getAllByRole('button', { name: 'Request options' })[1]!;
    fireEvent.keyDown(requestOptions, { key: 'Enter' });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Duplicate' }));
    expect(actions.duplicateItem).toHaveBeenCalledWith('c', items[1]);
  });
});

describe('handleTreeKeyDown', () => {
  function Tree({
    actions,
    collapsed = new Set<string>(),
    extras,
  }: {
    actions: Pick<TreeActions, 'toggleCollapse' | 'startRename' | 'deleteItem'>;
    collapsed?: Set<string>;
    extras?: Parameters<typeof handleTreeKeyDown>[3];
  }) {
    return (
      <div role="tree" onKeyDown={(e) => handleTreeKeyDown(e, actions, collapsed, extras)}>
        <div
          role="treeitem"
          data-tree-row
          data-item-id="col"
          data-item-type="collection"
          tabIndex={0}
        >
          Col
        </div>
        <div
          role="treeitem"
          data-tree-row
          data-item-id="fold"
          data-item-type="folder"
          data-item-name="Fold"
          data-collection-id="col"
          tabIndex={-1}
        >
          Fold
        </div>
        <div
          role="treeitem"
          data-tree-row
          data-item-id="req"
          data-item-type="request"
          data-collection-id="col"
          tabIndex={-1}
        >
          Req
        </div>
        <div role="treeitem" data-tree-row data-item-type="request" tabIndex={-1}>
          NoId
        </div>
        <input aria-label="rename" />
      </div>
    );
  }

  const keyActions = () => ({
    toggleCollapse: vi.fn(),
    startRename: vi.fn(),
    deleteItem: vi.fn(),
  });

  const press = (name: string, key: string) => {
    const el = screen.getByText(name);
    el.focus();
    fireEvent.keyDown(el, { key });
  };

  it('navigates with arrows, Home and End, clamping at the edges', () => {
    render(<Tree actions={keyActions()} />);
    press('Col', 'ArrowUp');
    expect(document.activeElement).toBe(screen.getByText('Col'));
    press('Col', 'End');
    expect(document.activeElement).toBe(screen.getByText('NoId'));
    press('NoId', 'ArrowDown');
    expect(document.activeElement).toBe(screen.getByText('NoId'));
    press('NoId', 'ArrowUp');
    expect(document.activeElement).toBe(screen.getByText('Req'));
    press('Req', 'Home');
    expect(document.activeElement).toBe(screen.getByText('Col'));
    expect(screen.getByText('Col').tabIndex).toBe(0);
    expect(screen.getByText('Req').tabIndex).toBe(-1);
  });

  it('expands and collapses folders and collections with arrows, Enter and Space', () => {
    const actions = keyActions();
    const toggleCollectionCollapse = vi.fn();
    const { rerender } = render(<Tree actions={actions} extras={{ toggleCollectionCollapse }} />);
    // Expanded: → does nothing, ← collapses.
    press('Fold', 'ArrowRight');
    press('Col', 'ArrowRight');
    expect(actions.toggleCollapse).not.toHaveBeenCalled();
    expect(toggleCollectionCollapse).not.toHaveBeenCalled();
    press('Fold', 'ArrowLeft');
    press('Col', 'ArrowLeft');
    expect(actions.toggleCollapse).toHaveBeenCalledWith('fold');
    expect(toggleCollectionCollapse).toHaveBeenCalledWith('col');

    // Collapsed: → expands, ← does nothing.
    rerender(
      <Tree
        actions={actions}
        collapsed={new Set(['fold'])}
        extras={{ toggleCollectionCollapse, collapsedCollections: new Set(['col']) }}
      />
    );
    press('Fold', 'ArrowRight');
    press('Col', 'ArrowRight');
    press('Fold', 'ArrowLeft');
    press('Col', 'ArrowLeft');
    expect(actions.toggleCollapse).toHaveBeenCalledTimes(2);
    expect(toggleCollectionCollapse).toHaveBeenCalledTimes(2);

    press('Fold', 'Enter');
    press('Col', ' ');
    expect(actions.toggleCollapse).toHaveBeenCalledTimes(3);
    expect(toggleCollectionCollapse).toHaveBeenCalledTimes(3);

    // Request rows: arrows and Enter are left to the browser.
    press('Req', 'ArrowRight');
    press('Req', 'ArrowLeft');
    press('Req', 'Enter');
    expect(actions.toggleCollapse).toHaveBeenCalledTimes(3);
  });

  it('tolerates missing collection extras', () => {
    const actions = keyActions();
    render(<Tree actions={actions} />);
    press('Col', 'ArrowLeft');
    press('Col', 'Enter');
    press('Col', 'F2');
    press('Col', 'Delete');
    expect(actions.startRename).not.toHaveBeenCalled();
    expect(actions.deleteItem).not.toHaveBeenCalled();
  });

  it('renames and deletes rows and collections', () => {
    const actions = keyActions();
    const renameCollection = vi.fn();
    const deleteCollection = vi.fn();
    render(<Tree actions={actions} extras={{ renameCollection, deleteCollection }} />);
    press('Col', 'F2');
    press('Col', 'Delete');
    expect(renameCollection).toHaveBeenCalledWith('col');
    expect(deleteCollection).toHaveBeenCalledWith('col');
    press('Fold', 'F2');
    expect(actions.startRename).toHaveBeenCalledWith('fold', 'Fold');
    press('Req', 'F2');
    expect(actions.startRename).toHaveBeenLastCalledWith('req', '');
    press('Req', 'Delete');
    expect(actions.deleteItem).toHaveBeenCalledWith('col', 'req');
  });

  it('ignores rows without an id and unknown keys', () => {
    const actions = keyActions();
    render(<Tree actions={actions} />);
    press('NoId', 'F2');
    press('NoId', 'Delete');
    press('NoId', 'Enter');
    press('Fold', 'x');
    expect(actions.startRename).not.toHaveBeenCalled();
    expect(actions.deleteItem).not.toHaveBeenCalled();
    expect(actions.toggleCollapse).not.toHaveBeenCalled();
  });

  it('a request row without a collection id is not deleted', () => {
    const actions = keyActions();
    render(
      <div role="tree" onKeyDown={(e) => handleTreeKeyDown(e, actions, new Set())}>
        <div role="treeitem" data-tree-row data-item-id="r" data-item-type="request" tabIndex={0}>
          Orphan
        </div>
      </div>
    );
    press('Orphan', 'Delete');
    expect(actions.deleteItem).not.toHaveBeenCalled();
  });

  it('leaves keys alone in inputs, after preventDefault, and in empty trees', () => {
    const actions = keyActions();
    render(<Tree actions={actions} />);
    const input = screen.getByRole('textbox', { name: 'rename' });
    input.focus();
    fireEvent.keyDown(input, { key: 'Delete' });
    expect(actions.deleteItem).not.toHaveBeenCalled();

    const req = screen.getByText('Req');
    req.focus();
    req.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
    fireEvent.keyDown(req, { key: 'Delete' });
    expect(actions.deleteItem).not.toHaveBeenCalled();

    const onKeyDown = vi.fn((e) => handleTreeKeyDown(e, actions, new Set()));
    render(
      <div role="tree" aria-label="empty" onKeyDown={onKeyDown}>
        <button type="button">only</button>
      </div>
    );
    const only = screen.getByRole('button', { name: 'only' });
    only.focus();
    fireEvent.keyDown(only, { key: 'Home' });
    expect(onKeyDown).toHaveBeenCalled();
    expect(document.activeElement).toBe(only);
  });

  it('setRovingRow ignores a missing row', () => {
    const a = document.createElement('div');
    a.tabIndex = 0;
    setRovingRow([a], undefined);
    expect(a.tabIndex).toBe(0);
  });
});
