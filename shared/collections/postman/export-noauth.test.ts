import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
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

describe('a guard-only unsupported bag with no parameters (#1228 after a child edit)', () => {
  const validator = (version: string) =>
    new Ajv({ strict: false, allErrors: true }).compile(
      JSON.parse(
        readFileSync(resolve(process.cwd(), `vendor/postman/${version}/schema.json`), 'utf8')
      ) as object
    );
  const collection = (type: string): Collection => ({
    id: 'c',
    name: 'C',
    auth: { type: 'bearer', bearer: { token: 'col' } },
    items: [folder('Guarded', [req('Child', { type: 'none' })], { auth: { type } })],
  });

  for (const type of ['hawk', 'jwt']) {
    it(`${type}: v2.1 and v3 export without a crash, schema-valid`, () => {
      const v21 = exportPostmanV21(collection(type));
      const v21Doc = JSON.parse(JSON.stringify(v21.collection)) as { item: V21Node[] };
      const v21Valid = validator('v2.1.0');
      expect(v21Valid(v21Doc) ? [] : v21Valid.errors).toEqual([]);
      const v3 = exportPostmanV3Tree(collection(type));
      const v3Valid = validator('v3.0.0');
      expect(v3Valid(v3.tree) ? [] : v3Valid.errors).toEqual([]);
      const v3Folder = (v3.tree as unknown as { items: V3Node[] }).items[0];
      if (type === 'hawk') {
        // Type-only: Postman keeps signing the children with hawk (re-entered there).
        expect(v21Doc.item[0]?.auth).toEqual({ type: 'hawk', hawk: [] });
        expect(v3Folder?.auth).toEqual({ type: 'hawk', credentials: [] });
      } else {
        // No v2.1 jwt type: noauth + a report entry; children stay explicitly unsigned.
        expect(v21Doc.item[0]?.auth).toEqual({ type: 'noauth' });
        expect(v21Doc.item[0]?.item?.[0]?.request?.auth).toEqual({ type: 'noauth' });
        expect(v21.report.entries.map((e) => e.construct)).toContain('auth-unsupported-for-kind');
        expect(v3Folder?.auth).toEqual({ type: 'jwt', credentials: [] });
      }
    });
  }
});
