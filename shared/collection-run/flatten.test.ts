import { describe, expect, it } from 'vitest';
import type { AuthConfig, CollectionItem } from '../types';
import { flattenCollection } from './flatten';

const bearer = (token: string): AuthConfig => ({ type: 'bearer', bearer: { token } });

function req(name: string, extra: Record<string, unknown> = {}): CollectionItem {
  return {
    id: `id-${name}`,
    name,
    type: 'request',
    request: {
      id: `id-${name}`,
      name,
      type: 'http',
      method: 'GET',
      url: 'https://x',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
      ...extra,
    },
  } as CollectionItem;
}

function folder(name: string, items: CollectionItem[], extra: Partial<CollectionItem> = {}) {
  return { id: `id-${name}`, name, type: 'folder', items, ...extra } as CollectionItem;
}

const opts = { sender: 'Restura', guardOwner: 'name' } as const;

describe('flattenCollection — inheritance contract', () => {
  it('walks leaves in preorder with their folder path', () => {
    const leaves = flattenCollection(
      [req('a'), folder('F', [req('b'), folder('G', [req('c')])]), req('d')],
      opts
    );
    expect(leaves.map((l) => [l.item.name, l.folderPath])).toEqual([
      ['a', []],
      ['b', ['F']],
      ['c', ['F', 'G']],
      ['d', []],
    ]);
  });

  it('combines scripts collection -> folder -> request, parent first', () => {
    const [leaf] = flattenCollection(
      [
        folder('F', [req('r', { preRequestScript: 'REQ', testScript: 'REQ_T' })], {
          preRequestScript: 'FOLDER',
          testScript: 'FOLDER_T',
        }),
      ],
      { ...opts, rootScripts: { preRequestScript: 'ROOT', testScript: 'ROOT_T' } }
    );
    expect(leaf?.preRequestScript).toBe('{\nROOT\n}\n{\nFOLDER\n}\n{\nREQ\n}');
    expect(leaf?.testScript).toBe('{\nROOT_T\n}\n{\nFOLDER_T\n}\n{\nREQ_T\n}');
  });

  it('leaves a script undefined when no level has one', () => {
    const [leaf] = flattenCollection([req('r')], opts);
    expect(leaf?.preRequestScript).toBeUndefined();
    expect(leaf?.testScript).toBeUndefined();
  });

  it('inherits the nearest ancestor auth, falling back to the root auth', () => {
    const leaves = flattenCollection(
      [
        folder(
          'Outer',
          [
            req('inOuter'),
            folder('Inner', [req('inInner')], { auth: bearer('INNER') }),
            folder('Plain', [req('inPlain')]),
          ],
          { auth: bearer('OUTER') }
        ),
        req('atRoot'),
      ],
      { ...opts, rootAuth: bearer('ROOT') }
    );
    const tokens = Object.fromEntries(
      leaves.map((l) => [l.item.name, l.inheritedAuth?.bearer?.token])
    );
    expect(tokens).toEqual({
      inOuter: 'OUTER',
      inInner: 'INNER',
      inPlain: 'OUTER',
      atRoot: 'ROOT',
    });
  });

  it('an unconfigured folder auth never masks an ancestor auth', () => {
    const [leaf] = flattenCollection([folder('F', [req('r')], { auth: { type: 'none' } })], {
      ...opts,
      rootAuth: bearer('ROOT'),
    });
    expect(leaf?.inheritedAuth?.bearer?.token).toBe('ROOT');
  });

  it('lists folder variables outermost first, only for folders that declare any', () => {
    const outer = [{ id: 'o', key: 'host', value: 'outer', enabled: true }];
    const inner = [{ id: 'i', key: 'host', value: 'inner', enabled: true }];
    const leaves = flattenCollection(
      [
        folder('Outer', [folder('Mid', [folder('Inner', [req('r')], { variables: inner })])], {
          variables: outer,
        }),
      ],
      opts
    );
    expect(leaves[0]?.folderVariables).toEqual([outer, inner]);
  });

  it('skips a leaf the host classifies as skip, and a folder it drops', () => {
    const seen: string[] = [];
    const leaves = flattenCollection(
      [req('keep'), req('drop'), folder('Gone', [req('inGone')]), folder('Kept', [req('inKept')])],
      {
        ...opts,
        leafAction: (item, path) => {
          seen.push(path);
          return item.name === 'drop' ? 'skip' : 'run';
        },
        skipFolder: (f) => f.name === 'Gone',
      }
    );
    expect(leaves.map((l) => l.item.name)).toEqual(['keep', 'inKept']);
    expect(seen).toEqual(['keep', 'drop', 'Kept/inKept']);
  });

  describe('folder run', () => {
    const tree = [
      req('outside'),
      folder(
        'F',
        [req('a'), folder('G', [req('b')], { preRequestScript: 'G_PRE', auth: bearer('G') })],
        { preRequestScript: 'F_PRE', auth: bearer('F') }
      ),
    ];

    it('runs only the subtree, still inheriting scripts and auth from folders above', () => {
      const leaves = flattenCollection(tree, {
        ...opts,
        folderId: 'id-G',
        rootScripts: { preRequestScript: 'ROOT' },
      });
      expect(leaves.map((l) => l.item.name)).toEqual(['b']);
      expect(leaves[0]?.folderPath).toEqual(['F', 'G']);
      expect(leaves[0]?.preRequestScript).toBe('{\nROOT\n}\n{\nF_PRE\n}\n{\nG_PRE\n}');
      expect(leaves[0]?.inheritedAuth?.bearer?.token).toBe('G');
    });

    it('returns nothing for an unknown folder id', () => {
      expect(flattenCollection(tree, { ...opts, folderId: 'nope' })).toEqual([]);
    });
  });

  describe('Postman send guard', () => {
    const noauthFolder = folder('NF', [req('child')], {
      _postman: { noauth: true },
    } as Partial<CollectionItem>);

    it('blocks a request below an explicit noauth folder when an auth would be substituted', () => {
      const [leaf] = flattenCollection([noauthFolder], { ...opts, rootAuth: bearer('ROOT') });
      expect(leaf?.blocked).toMatch(/inherited from "NF"/);
      expect(leaf?.blocked).toMatch(/Restura will not send/);
    });

    it('names the refusing sender', () => {
      const [leaf] = flattenCollection([noauthFolder], {
        ...opts,
        sender: 'the CLI',
        rootAuth: bearer('ROOT'),
      });
      expect(leaf?.blocked).toMatch(/the CLI will not send/);
    });

    it('names the owning folder by its name or by its path, per host', () => {
      const nested = [folder('Outer', [noauthFolder])];
      const byName = flattenCollection(nested, { ...opts, rootAuth: bearer('ROOT') });
      const byPath = flattenCollection(nested, {
        ...opts,
        guardOwner: 'path',
        rootAuth: bearer('ROOT'),
      });
      expect(byName[0]?.blocked).toMatch(/inherited from "NF"/);
      expect(byPath[0]?.blocked).toMatch(/inherited from "Outer\/NF"/);
    });

    it('blocks nothing without a configured auth above', () => {
      expect(flattenCollection([noauthFolder], opts)[0]?.blocked).toBeUndefined();
    });

    it('still reports the inherited auth of a blocked leaf (hosts decide what to do with it)', () => {
      const [leaf] = flattenCollection([noauthFolder], { ...opts, rootAuth: bearer('ROOT') });
      expect(leaf?.inheritedAuth?.bearer?.token).toBe('ROOT');
    });
  });
});
