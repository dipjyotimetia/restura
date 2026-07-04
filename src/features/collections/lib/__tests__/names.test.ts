import { describe, it, expect } from 'vitest';
import type { Collection } from '@/types';
import {
  isNameTaken,
  uniqueName,
  siblingNamesForParent,
  siblingNamesOfItem,
  folderPathTo,
  parentFolderIdOf,
  moveWouldCollide,
} from '../names';

const collection: Collection = {
  id: 'col-1',
  name: 'Col',
  items: [
    {
      id: 'f-1',
      name: 'Auth',
      type: 'folder',
      items: [{ id: 'r-1', name: 'Login', type: 'request' }],
    },
    { id: 'r-2', name: 'Ping', type: 'request' },
  ],
} as Collection;

describe('isNameTaken', () => {
  it('matches case-insensitively and trims', () => {
    expect(isNameTaken('auth', ['Auth'])).toBe(true);
    expect(isNameTaken('  Auth  ', ['auth'])).toBe(true);
    expect(isNameTaken('Users', ['Auth'])).toBe(false);
  });
});

describe('uniqueName', () => {
  it('returns the desired name when free', () => {
    expect(uniqueName('New Folder', ['Auth'])).toBe('New Folder');
  });

  it('suffixes with the first free counter', () => {
    expect(uniqueName('New Folder', ['New Folder'])).toBe('New Folder 2');
    expect(uniqueName('New Folder', ['New Folder', 'New Folder 2'])).toBe('New Folder 3');
  });

  it('is case-insensitive about collisions', () => {
    expect(uniqueName('new folder', ['New Folder'])).toBe('new folder 2');
  });
});

describe('siblingNamesForParent', () => {
  it('returns root item names without a parent', () => {
    expect(siblingNamesForParent(collection)).toEqual(['Auth', 'Ping']);
  });

  it('returns folder children names for a parent id', () => {
    expect(siblingNamesForParent(collection, 'f-1')).toEqual(['Login']);
  });

  it('returns empty for an unknown parent', () => {
    expect(siblingNamesForParent(collection, 'nope')).toEqual([]);
  });
});

describe('siblingNamesOfItem', () => {
  it('excludes the item itself at root level', () => {
    expect(siblingNamesOfItem(collection, 'r-2')).toEqual(['Auth']);
  });

  it('finds siblings inside nested folders', () => {
    expect(siblingNamesOfItem(collection, 'r-1')).toEqual([]);
  });

  it('returns empty for an unknown item', () => {
    expect(siblingNamesOfItem(collection, 'nope')).toEqual([]);
  });
});

describe('parentFolderIdOf', () => {
  it('returns the containing folder id for a nested item', () => {
    expect(parentFolderIdOf(collection.items, 'r-1')).toBe('f-1');
  });

  it('returns undefined for a root-level item', () => {
    expect(parentFolderIdOf(collection.items, 'r-2')).toBeUndefined();
  });

  it('returns undefined for an unknown item', () => {
    expect(parentFolderIdOf(collection.items, 'nope')).toBeUndefined();
  });
});

describe('folderPathTo', () => {
  const nested: Collection = {
    id: 'col-3',
    name: 'Col3',
    items: [
      {
        id: 'f-outer',
        name: 'Outer',
        type: 'folder',
        items: [{ id: 'f-inner', name: 'Inner', type: 'folder', items: [] }],
      },
    ],
  } as Collection;

  it('returns the ancestor chain including the folder itself', () => {
    expect(folderPathTo(nested.items, 'f-inner')).toEqual(['f-outer', 'f-inner']);
  });

  it('returns a single id for a root folder', () => {
    expect(folderPathTo(nested.items, 'f-outer')).toEqual(['f-outer']);
  });

  it('returns empty for an unknown folder', () => {
    expect(folderPathTo(nested.items, 'nope')).toEqual([]);
  });
});

describe('moveWouldCollide', () => {
  // Tree: root [Auth(folder){Login}, Ping], plus a folder holding "Ping" twin.
  const col: Collection = {
    id: 'col-2',
    name: 'Col2',
    items: [
      {
        id: 'f-1',
        name: 'Auth',
        type: 'folder',
        items: [{ id: 'r-1', name: 'Ping', type: 'request' }],
      },
      { id: 'r-2', name: 'Ping', type: 'request' },
      { id: 'r-3', name: 'Status', type: 'request' },
    ],
  } as Collection;

  it('flags moving into a folder with a same-named child', () => {
    expect(moveWouldCollide(col, 'r-2', { parentId: 'f-1' })).toBe(true);
  });

  it('flags moving to a root with a same-named item', () => {
    expect(moveWouldCollide(col, 'r-1', {})).toBe(true);
  });

  it('allows a same-level reorder past a same-named check', () => {
    expect(moveWouldCollide(col, 'r-2', { beforeId: 'r-3' })).toBe(false);
  });

  it('allows moves with no name conflict', () => {
    expect(moveWouldCollide(col, 'r-3', { parentId: 'f-1' })).toBe(false);
  });

  it('flags a beforeId drop into a level with a same-named sibling', () => {
    expect(moveWouldCollide(col, 'r-2', { beforeId: 'r-1' })).toBe(true);
  });
});
