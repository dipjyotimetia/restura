import { describe, expect, it } from 'vitest';
import type { Collection, CollectionItem } from '@/types';
import { internalToOC } from '../from-internal';
import { parseOpenCollectionYAML, serializeOpenCollectionYAML } from '../serializer';
import { ocToInternal } from '../to-internal';

/**
 * Folder variables round-trip through OpenCollection `Folder.request.variables`
 * (RequestDefaults), with the same import / verbatim / edit-then-export
 * staleness contract as folder auth and scripts. Before this mapping they were
 * neither imported nor exported, so any folder edit (which strips the folder's
 * `_oc` bag) silently dropped them from the next export.
 */

const SOURCE_YAML = `opencollection: 1.0.0
info:
  name: Folder Vars
items:
  - info:
      name: Users
    request:
      variables:
        - name: userPath
          value: /v2/users
        - name: apiKey
          secret: true
      scripts:
        - type: before-request
          code: rs.environment.set('folder', 1)
    items:
      - info:
          type: http
          name: List
        http:
          method: GET
          url: https://api.example.com{{userPath}}
`;

type OCFolder = Record<string, unknown> & {
  request?: { variables?: unknown[]; scripts?: unknown[] };
};

const importDoc = () =>
  ocToInternal(parseOpenCollectionYAML(SOURCE_YAML)) as Collection & { _oc?: unknown };
const folderOf = (c: Collection) => c.items.find((i) => i.type === 'folder') as CollectionItem;
const outFolder = (c: Collection) =>
  (internalToOC(c).items as OCFolder[]).find(
    (i) => (i.info as { name?: string })?.name === 'Users'
  );

describe('OpenCollection folder variables', () => {
  it('imports folder variables, secret values empty', () => {
    const folder = folderOf(importDoc());
    expect(folder.variables?.map((v) => [v.key, v.value, v.secret ?? false])).toEqual([
      ['userPath', '/v2/users', false],
      ['apiKey', '', true],
    ]);
  });

  it('round-trips byte-stable when nothing was edited', () => {
    const oc = parseOpenCollectionYAML(SOURCE_YAML);
    expect(serializeOpenCollectionYAML(internalToOC(importDoc()))).toBe(
      serializeOpenCollectionYAML(oc)
    );
  });

  it('edit-then-export: an edited folder variable reaches the output, scripts kept', () => {
    const internal = importDoc();
    const folder = folderOf(internal);
    folder.variables = folder.variables!.map((v) =>
      v.key === 'userPath' ? { ...v, value: '/v3/users' } : v
    );
    const out = outFolder(internal);
    expect(out?.request?.variables).toEqual([
      { name: 'userPath', value: '/v3/users' },
      { secret: true, name: 'apiKey' },
    ]);
    expect(out?.request?.scripts).toHaveLength(1);
  });

  it('leaves private folder variables out, and drops request.variables when none remain', () => {
    const internal = importDoc();
    const folder = folderOf(internal);
    folder.variables = folder.variables!.map((v) => ({ ...v, private: true }));
    const out = outFolder(internal);
    expect(out?.request?.variables).toBeUndefined();
    expect(out?.request?.scripts).toHaveLength(1);
  });

  it('exports variables of a folder created in-app (no _oc)', () => {
    const internal: Collection = {
      id: 'c',
      name: 'Native',
      items: [
        {
          id: 'f',
          name: 'Users',
          type: 'folder',
          items: [],
          variables: [{ id: 'v', key: 'page', value: '1', enabled: true }],
        },
      ],
    };
    expect(outFolder(internal)?.request?.variables).toEqual([{ name: 'page', value: '1' }]);
  });
});
