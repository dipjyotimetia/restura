import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CollectionItem, HttpRequest } from '@/types';
import { CollectionTreeItems, handleTreeKeyDown, type TreeActions } from '../CollectionTree';

const http = (id: string): HttpRequest => ({
  id,
  name: id,
  type: 'http',
  method: 'GET',
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
    items: [{ id: 'a', name: 'List users', type: 'request', request: http('ra') }],
  },
  { id: 'b', name: 'Health', type: 'request', request: http('rb') },
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

function renderTree(actions: TreeActions) {
  const state = {
    renamingItemId: null,
    renameValue: '',
    dropTargetId: null,
    collapsedFolders: new Set<string>(),
    selectedKeys: new Set(['c:b']),
  };
  render(
    <div
      role="tree"
      aria-label="Collections"
      onKeyDown={(e) => handleTreeKeyDown(e, actions, state.collapsedFolders)}
    >
      <CollectionTreeItems collectionId="c" items={items} state={state} actions={actions} />
    </div>
  );
}

describe('collection tree a11y', () => {
  it('exposes treeitems with level, expanded and selected state, and one tab stop', () => {
    renderTree(makeActions());
    const rows = screen.getAllByRole('treeitem');
    expect(rows.map((row) => row.getAttribute('aria-level'))).toEqual(['2', '3', '2']);
    expect(rows[0]).toHaveAttribute('aria-expanded', 'true');
    expect(rows[2]).toHaveAttribute('aria-selected', 'true');
    expect(rows[1]).toHaveAttribute('aria-selected', 'false');
    expect(rows.every((row) => row.tabIndex === -1)).toBe(true);
    expect(screen.getByRole('group', { name: 'Users items' })).toBeInTheDocument();
  });

  it('moves focus with arrows, renames with F2 and deletes with Delete', () => {
    const actions = makeActions();
    renderTree(actions);
    const rows = screen.getAllByRole('treeitem');
    rows[0]?.focus();
    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
    expect(rows[1]?.tabIndex).toBe(0);
    expect(rows[0]?.tabIndex).toBe(-1);

    fireEvent.keyDown(rows[1]!, { key: 'F2' });
    expect(actions.startRename).toHaveBeenCalledWith('a', 'List users');

    fireEvent.keyDown(rows[1]!, { key: 'Delete' });
    expect(actions.deleteItem).toHaveBeenCalledWith('c', 'a');
  });

  it('selects a range on shift-click', () => {
    const actions = makeActions();
    renderTree(actions);
    fireEvent.click(screen.getAllByRole('treeitem')[1]!, { shiftKey: true });
    expect(actions.selectRange).toHaveBeenCalledWith('c', 'a');
    expect(actions.openItem).not.toHaveBeenCalled();
  });
});
