import { describe, expect, it } from 'vitest';
import type { AuthConfig, Collection, CollectionItem } from '../../types';
import { exportPostmanV21 } from './export-v2';
import { exportPostmanV3Tree } from './export-v3';

/**
 * Q28: a node whose Postman auth was an explicit `noauth` (`_postman.noauth`,
 * set by the parser) must export as an explicit `noauth` block — omitting it
 * means inherit, so Postman / Newman would sign it with an ancestor credential.
 */

function req(name: string, auth: AuthConfig, sidecar?: object): CollectionItem {
  const item: CollectionItem = {
    id: name,
    name,
    type: 'request',
    request: {
      id: name,
      name,
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com/x',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth,
    },
  };
  if (sidecar) Object.assign(item, { _postman: sidecar });
  return item;
}

function folder(name: string, children: CollectionItem[], sidecar: object): CollectionItem {
  const f: CollectionItem = { id: name, name, type: 'folder', items: children };
  Object.assign(f, { _postman: sidecar });
  return f;
}

const hawk = { auth: { type: 'hawk', hawk: [{ key: 'authId', value: 'id' }] } };

type V21Node = { auth?: unknown; request?: { auth?: unknown }; item?: V21Node[] };
type V3Node = { auth?: unknown; items?: V3Node[] };

const collection = (): Collection => ({
  id: 'c',
  name: 'C',
  auth: { type: 'bearer', bearer: { token: 'col' } },
  items: [
    folder(
      'Hawk',
      [req('Explicit none', { type: 'none' }, { noauth: true }), req('Inherits', { type: 'none' })],
      hawk
    ),
    folder(
      'Open folder',
      [req('Child', { type: 'none' }), req('Signed', { type: 'bearer', bearer: { token: 'col' } })],
      { noauth: true }
    ),
    req('Edited', { type: 'basic', basic: { username: 'u', password: 'p' } }, { noauth: true }),
  ],
});

describe('explicit Postman noauth export (Q28)', () => {
  it('v2.1: explicit noauth request / folder blocks are written; children inherit it; edits win', () => {
    const doc = exportPostmanV21(collection()).collection as unknown as { item: V21Node[] };
    const [h, open, edited] = doc.item;
    expect(h?.item?.[0]?.request?.auth).toEqual({ type: 'noauth' });
    expect(h?.item?.[1]?.request).not.toHaveProperty('auth');
    expect(open?.auth).toEqual({ type: 'noauth' });
    expect(open?.item?.[0]?.request).not.toHaveProperty('auth');
    expect(open?.item?.[1]?.request?.auth).toMatchObject({ type: 'bearer' });
    expect(edited?.request?.auth).toMatchObject({ type: 'basic' });
  });

  it('v3: the same', () => {
    const tree = exportPostmanV3Tree(collection()).tree as unknown as { items: V3Node[] };
    const [h, open, edited] = tree.items;
    expect(h?.items?.[0]?.auth).toEqual({ type: 'noauth' });
    expect(h?.items?.[1]).not.toHaveProperty('auth');
    expect(open?.auth).toEqual({ type: 'noauth' });
    expect(open?.items?.[0]).not.toHaveProperty('auth');
    expect(open?.items?.[1]?.auth).toMatchObject({ type: 'bearer' });
    expect(edited?.auth).toMatchObject({ type: 'basic' });
  });

  it('a root marked noauth writes noauth (v2.1 and v3)', () => {
    const c: Collection = { id: 'c', name: 'C', items: [req('R', { type: 'none' })] };
    Object.assign(c, { _postman: { noauth: true } });
    expect(exportPostmanV21(c).collection.auth).toEqual({ type: 'noauth' });
    expect((exportPostmanV3Tree(c).tree as { auth?: unknown }).auth).toEqual({ type: 'noauth' });
  });
});
